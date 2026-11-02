import fs from 'node:fs/promises';
import path from 'node:path';
import matter from 'gray-matter';
import { PublisherError, articlePathForSlug, archivePathForName, assetDirForSlug, assertSlug, resolveInside } from './paths.mjs';
import { atomicWrite, backupFile, ensureDir } from './atomic.mjs';
import { getReadingTime } from './reading-time.mjs';

const FRONTMATTER_FIELDS = [
	'title', 'description', 'pubDate', 'updatedDate', 'category', 'tags',
	'cover', 'coverAlt', 'heroImage', 'featured', 'draft', 'demo', 'author',
	'seoTitle', 'seoDescription',
];

function dateValue(value) {
	if (!value) return undefined;
	const date = value instanceof Date ? value : new Date(value);
	if (Number.isNaN(date.valueOf())) return undefined;
	return date.toISOString().slice(0, 10);
}

function normaliseArray(value) {
	if (Array.isArray(value)) return value.map(String).map((item) => item.trim()).filter(Boolean);
	if (typeof value === 'string') return value.split(',').map((item) => item.trim()).filter(Boolean);
	return [];
}

function normaliseFrontmatter(data) {
	const extra = data.extra && typeof data.extra === 'object' && !Array.isArray(data.extra) ? { ...data.extra } : {};
	for (const [key, value] of Object.entries(data)) {
		if (!FRONTMATTER_FIELDS.includes(key) && key !== 'extra') extra[key] = value;
	}
	return {
		title: String(data.title ?? '').trim(),
		description: String(data.description ?? '').trim(),
		pubDate: dateValue(data.pubDate) ?? dateValue(new Date()),
		updatedDate: dateValue(data.updatedDate),
		category: data.category,
		tags: normaliseArray(data.tags),
		cover: data.cover ? String(data.cover) : undefined,
		coverAlt: data.coverAlt ? String(data.coverAlt) : undefined,
		heroImage: data.heroImage ? String(data.heroImage) : undefined,
		featured: Boolean(data.featured),
		draft: data.draft === true,
		demo: Boolean(data.demo),
		author: data.author ? String(data.author) : undefined,
		seoTitle: data.seoTitle ? String(data.seoTitle) : undefined,
		seoDescription: data.seoDescription ? String(data.seoDescription) : undefined,
		extra,
	};
}

/** 使用固定字段顺序序列化，避免每次保存都产生无关 frontmatter diff。 */
export function serializeArticle(metadata, body) {
	const lines = ['---'];
	const put = (key, value) => {
		if (value === undefined || value === null || value === '') return;
		lines.push(`${key}: ${JSON.stringify(value)}`);
	};
	put('title', metadata.title);
	put('description', metadata.description);
	put('pubDate', dateValue(metadata.pubDate));
	put('updatedDate', dateValue(metadata.updatedDate));
	put('category', metadata.category);
	put('tags', metadata.tags?.length ? metadata.tags : undefined);
	put('cover', metadata.cover);
	put('coverAlt', metadata.coverAlt);
	put('heroImage', metadata.heroImage);
	lines.push(`featured: ${Boolean(metadata.featured)}`);
	lines.push(`draft: ${Boolean(metadata.draft)}`);
	lines.push(`demo: ${Boolean(metadata.demo)}`);
	put('author', metadata.author);
	put('seoTitle', metadata.seoTitle);
	put('seoDescription', metadata.seoDescription);
	for (const [key, value] of Object.entries(metadata.extra ?? {})) {
		if (FRONTMATTER_FIELDS.includes(key)) continue;
		put(key, value);
	}
	lines.push('---', '', body.replace(/^\s*\n/, '').replace(/\s+$/, ''), '');
	return lines.join('\n');
}

export class ArticleStore {
	constructor(paths) {
		this.paths = paths;
		this.queues = new Map();
	}

	async withLock(key, task) {
		const previous = this.queues.get(key) ?? Promise.resolve();
		const current = previous.then(task, task);
		this.queues.set(key, current.catch(() => undefined));
		return current;
	}

	absolutePath(article) {
		return path.join(this.paths.root, article.file);
	}

	async findFile(slug) {
		assertSlug(slug);
		for (const extension of ['md', 'mdx']) {
			const filePath = articlePathForSlug(this.paths, slug, extension);
			try {
				const stat = await fs.stat(filePath);
				if (stat.isFile()) return { filePath, extension, stat };
			} catch (error) {
				if (error.code !== 'ENOENT') throw error;
			}
		}
		return null;
	}

	async read(slug) {
		const found = await this.findFile(slug);
		if (!found) throw new PublisherError('文章不存在。', 404);
		const raw = await fs.readFile(found.filePath, 'utf8');
		const parsed = matter(raw);
		const metadata = normaliseFrontmatter(parsed.data);
		return {
			slug,
			extension: found.extension,
			file: path.relative(this.paths.root, found.filePath),
			version: found.stat.mtimeMs,
			body: parsed.content,
			metadata,
			readingTime: getReadingTime(parsed.content),
			url: `/blog/${slug}/`,
		};
	}

	async list() {
		await ensureDir(this.paths.blog);
		const entries = await fs.readdir(this.paths.blog, { withFileTypes: true });
		const articles = [];
		for (const entry of entries) {
			if (!entry.isFile() || !/\.(md|mdx)$/i.test(entry.name)) continue;
			const slug = entry.name.replace(/\.(md|mdx)$/i, '');
			try {
				articles.push(await this.read(slug));
			} catch (error) {
				articles.push({ slug, broken: true, error: error.message, file: path.join('src/content/blog', entry.name) });
			}
		}
		return articles.sort((a, b) => String(b.metadata?.pubDate ?? '').localeCompare(String(a.metadata?.pubDate ?? '')));
	}

	async create(input) {
		const slug = assertSlug(input.slug);
		return this.withLock(`article:${slug}`, async () => this.#createUnlocked(input));
	}

	async #createUnlocked(input) {
		const slug = assertSlug(input.slug);
		if (await this.findFile(slug)) throw new PublisherError(`slug「${slug}」已存在，请更换文章 URL。`, 409);
		const metadata = normaliseFrontmatter({
			title: input.title,
			description: input.description,
			pubDate: input.pubDate ?? new Date(),
			category: input.category,
			tags: input.tags,
			author: input.author,
			featured: false,
			draft: true,
			demo: false,
		});
		const body = String(input.body ?? '').trim() || '从这里开始写作。';
		const filePath = articlePathForSlug(this.paths, slug, 'md');
		await atomicWrite(filePath, serializeArticle(metadata, body));
		return this.read(slug);
	}

	async save(slug, input) {
		return this.withLock(`article:${slug}`, async () => this.#saveUnlocked(slug, input));
	}

	async #saveUnlocked(slug, input) {
		const current = await this.read(slug);
		if (input.version !== undefined && Math.abs(Number(input.version) - current.version) > 1) {
			throw new PublisherError('文章已在其他窗口被修改。请重新打开后再保存，避免覆盖较新的内容。', 409);
		}
		const metadata = normaliseFrontmatter({
			...current.metadata,
			...input.metadata,
			extra: { ...current.metadata.extra, ...(input.metadata?.extra ?? {}) },
		});
		if (metadata.draft === false) metadata.updatedDate = dateValue(new Date());
		await backupFile(this.absolutePath(current), this.paths.backups, slug);
		await atomicWrite(this.absolutePath(current), serializeArticle(metadata, String(input.body ?? '')));
		return this.read(slug);
	}

	async publishStatus(slug, draft = false) {
		return this.withLock(`article:${slug}`, async () => this.#publishStatusUnlocked(slug, draft));
	}

	async #publishStatusUnlocked(slug, draft = false) {
		const current = await this.read(slug);
		const metadata = {
			...current.metadata,
			draft,
			updatedDate: draft ? current.metadata.updatedDate : (current.metadata.draft ? dateValue(new Date()) : current.metadata.updatedDate),
		};
		await backupFile(this.absolutePath(current), this.paths.backups, slug);
		await atomicWrite(this.absolutePath(current), serializeArticle(metadata, current.body));
		return this.read(slug);
	}

	async copy(slug) {
		const source = await this.read(slug);
		let suffix = 1;
		let candidate;
		do {
			candidate = `${slug}-copy${suffix === 1 ? '' : `-${suffix}`}`;
			suffix += 1;
		} while (await this.findFile(candidate));
		const sourceAssets = assetDirForSlug(this.paths, slug);
		const targetAssets = assetDirForSlug(this.paths, candidate);
		try {
			await fs.cp(sourceAssets, targetAssets, { recursive: true, errorOnExist: false });
		} catch (error) {
			if (error.code !== 'ENOENT') throw error;
		}
		const body = source.body.replaceAll(`assets/publisher/${slug}/`, `assets/publisher/${candidate}/`);
		const metadata = {
			...source.metadata,
			title: `${source.metadata.title}（副本）`,
			pubDate: dateValue(new Date()),
			updatedDate: undefined,
			draft: true,
			featured: false,
		};
		await atomicWrite(articlePathForSlug(this.paths, candidate, 'md'), serializeArticle(metadata, body));
		return this.read(candidate);
	}

	async listBackups(slug) {
		assertSlug(slug);
		const directory = path.join(this.paths.backups, slug);
		try {
			const entries = await fs.readdir(directory, { withFileTypes: true });
			const files = [];
			for (const entry of entries) {
				if (!entry.isFile() || !entry.name.endsWith('.bak')) continue;
				const stat = await fs.stat(path.join(directory, entry.name));
				files.push({ name: entry.name, size: stat.size, createdAt: stat.mtime.toISOString() });
			}
			return files.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
		} catch (error) {
			if (error.code === 'ENOENT') return [];
			throw error;
		}
	}

	async restoreBackup(slug, backupName) {
		const current = await this.read(slug);
		const backups = await this.listBackups(slug);
		const backup = backups.find((item) => item.name === backupName);
		if (!backup) throw new PublisherError('备份不存在。', 404);
		await backupFile(this.absolutePath(current), this.paths.backups, slug);
		await atomicWrite(this.absolutePath(current), await fs.readFile(path.join(this.paths.backups, slug, backup.name)));
		return this.read(slug);
	}

	async archive(slug, confirmation) {
		const current = await this.read(slug);
		if (confirmation !== current.metadata.title) {
			throw new PublisherError('归档确认不匹配。请输入完整文章标题后再试。', 400);
		}
		await ensureDir(this.paths.archive);
		let target = path.join(this.paths.archive, `${slug}.${current.extension}`);
		let suffix = 1;
		while (true) {
			try {
				await fs.access(target);
				target = path.join(this.paths.archive, `${slug}-${suffix++}.${current.extension}`);
			} catch {
				break;
			}
		}
		await backupFile(this.absolutePath(current), this.paths.backups, slug);
		await fs.rename(this.absolutePath(current), target);
		return {
			slug,
			title: current.metadata.title,
			extension: current.extension,
			from: this.relativePath(this.absolutePath(current)),
			archived: this.relativePath(target),
			name: path.basename(target, path.extname(target)),
		};
	}

	relativePath(absolute) {
		return path.relative(this.paths.root, absolute).replaceAll('\\', '/');
	}

	/** 在博客目录与归档目录之间移动文件，路径必须位于这两个目录内。 */
	async moveRelative(fromRelative, toRelative) {
		const allowed = [this.relativePath(this.paths.blog), this.relativePath(this.paths.archive)];
		for (const value of [fromRelative, toRelative]) {
			const normal = String(value).replaceAll('\\', '/');
			if (!allowed.some((root) => normal.startsWith(`${root}/`)) || normal.includes('..')) {
				throw new PublisherError('归档或恢复路径不在允许范围内。', 403);
			}
		}
		const from = resolveInside(this.paths.root, fromRelative);
		const to = resolveInside(this.paths.root, toRelative);
		await ensureDir(path.dirname(to));
		await fs.rename(from, to);
		return { from: this.relativePath(from), to: this.relativePath(to) };
	}

	async findArchivedFile(name) {
		assertSlug(name);
		for (const extension of ['md', 'mdx']) {
			const filePath = archivePathForName(this.paths, name, extension);
			try {
				const stat = await fs.stat(filePath);
				if (stat.isFile()) return { filePath, extension, stat };
			} catch (error) {
				if (error.code !== 'ENOENT') throw error;
			}
		}
		return null;
	}

	/** 列出 src/content/archive 下的笔记，供恢复入口使用。 */
	async listArchived() {
		await ensureDir(this.paths.archive);
		const entries = await fs.readdir(this.paths.archive, { withFileTypes: true });
		const archived = [];
		for (const entry of entries) {
			if (!entry.isFile() || !/\.(md|mdx)$/i.test(entry.name)) continue;
			const name = entry.name.replace(/\.(md|mdx)$/i, '');
			if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) continue;
			const filePath = path.join(this.paths.archive, entry.name);
			try {
				const [raw, stat] = await Promise.all([fs.readFile(filePath, 'utf8'), fs.stat(filePath)]);
				const parsed = matter(raw);
				const metadata = normaliseFrontmatter(parsed.data);
				archived.push({
					slug: name,
					title: metadata.title || name,
					description: metadata.description,
					category: metadata.category,
					tags: metadata.tags,
					pubDate: metadata.pubDate,
					updatedDate: metadata.updatedDate,
					draft: metadata.draft,
					file: this.relativePath(filePath),
					extension: entry.name.split('.').pop(),
					archivedAt: stat.mtime.toISOString(),
					size: stat.size,
					conflict: Boolean(await this.findFile(name)),
				});
			} catch (error) {
				archived.push({ slug: name, title: name, file: this.relativePath(filePath), broken: true, error: error.message });
			}
		}
		return archived.sort((a, b) => String(b.archivedAt).localeCompare(String(a.archivedAt)));
	}

	/** 把归档笔记移回博客目录，保持 slug 不变，避免已上线地址发生变化。 */
	async restore(name) {
		const found = await this.findArchivedFile(name);
		if (!found) throw new PublisherError('归档笔记不存在。', 404);
		if (await this.findFile(name)) {
			throw new PublisherError(`博客中已存在 /blog/${name}/，无法直接恢复。请先处理同名文章。`, 409);
		}
		const raw = await fs.readFile(found.filePath, 'utf8');
		const title = normaliseFrontmatter(matter(raw).data).title || name;
		const target = articlePathForSlug(this.paths, name, found.extension);
		await fs.rename(found.filePath, target);
		return {
			slug: name,
			title,
			extension: found.extension,
			from: this.relativePath(found.filePath),
			to: this.relativePath(target),
		};
	}
}
