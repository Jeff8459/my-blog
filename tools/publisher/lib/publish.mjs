import path from 'node:path';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { categoryName, tagName, site } from './config.mjs';
import { assetDirForSlug } from './paths.mjs';
import { validateArticle } from './validation.mjs';
import { getDiff, getGitState, checkRepositorySafety, stageAndCommit, pushMain } from './git.mjs';
import { runProductionBuild } from './build.mjs';

const CHECK_TTL = 30 * 60_000;

function articleRelative(article) {
	return article.file.replaceAll('\\', '/');
}

async function exists(filePath) {
	try {
		await fs.access(filePath);
		return true;
	} catch {
		return false;
	}
}

function statusLabel(change) {
	if (change.index === '?' || change.worktree === '?') return '新增';
	if (change.index === 'A') return '已暂存';
	if (change.worktree === 'M' || change.index === 'M') return '修改';
	if (change.worktree === 'D' || change.index === 'D') return '删除';
	return '变更';
}

export class PublishService {
	constructor({ paths, store, history, buildRunner = runProductionBuild, deployVerifier = verifyProduction, removalVerifier = verifyRemoval }) {
		this.paths = paths;
		this.store = store;
		this.history = history;
		this.buildRunner = buildRunner;
		this.deployVerifier = deployVerifier;
		this.removalVerifier = removalVerifier;
		this.checks = new Map();
		this.active = Promise.resolve();
	}

	async check(slug) {
		return this.#queue(async () => {
			let article = await this.store.read(slug);
			const all = await this.store.list();
			const before = await validateArticle(article, all, this.paths);
			if (!before.ok) {
				return {
					ok: false,
					action: 'publish',
					stage: 'validation',
					errors: before.errors,
					warnings: before.warnings,
					article: publicArticle(article),
					build: null,
					files: [],
					diff: '',
					checkId: null,
				};
			}
			const originalDraft = article.metadata.draft;
			article = await this.store.publishStatus(slug, false);
			const validation = await validateArticle(article, all, this.paths);
			const assetDir = assetDirForSlug(this.paths, slug);
			const build = await this.buildRunner(this.paths.root);
			if (!build.ok) {
				await this.store.publishStatus(slug, originalDraft);
				const current = await this.store.read(slug);
				return {
					ok: false,
					action: 'publish',
					stage: 'build',
					errors: ['生产构建失败。草稿状态与正文已保留，请根据构建日志修复后重试。'],
					warnings: validation.warnings,
					article: publicArticle(current),
					build: { ...build, output: tail(build.output, 120) },
					files: [],
					diff: '',
					checkId: null,
				};
			}
			const state = await getGitState(this.paths.root);
			const files = state.changes
				.filter((change) => change.path === articleRelative(article) || change.path.startsWith(path.relative(this.paths.root, assetDir).replaceAll('\\', '/') + '/'))
				.map((change) => ({ path: change.path, label: statusLabel(change), staged: change.staged }));
			const diff = await getDiff(this.paths.root, [path.join(this.paths.root, articleRelative(article))]);
			const checkId = crypto.randomUUID();
			const content = await fs.readFile(path.join(this.paths.root, articleRelative(article)), 'utf8');
			const record = {
				checkId,
				kind: 'publish',
				slug,
				contentHash: crypto.createHash('sha256').update(content).digest('hex'),
				article: publicArticle(article),
				files,
				build: { ok: true, durationMs: build.durationMs, output: tail(build.output, 80) },
				warnings: validation.warnings,
				createdAt: Date.now(),
			};
			this.checks.set(checkId, record);
			const safety = await checkRepositorySafety(this.paths.root, articleRelative(article), path.relative(this.paths.root, assetDir), { fetchRemote: false });
			return {
				ok: true,
				action: 'publish',
				stage: 'ready',
				checkId,
				article: publicArticle(article),
				validation,
				build: record.build,
				files,
				diff,
				safety: { branch: safety.branch, errors: safety.errors },
				warnings: validation.warnings,
				changes: state.changes.map((change) => ({ path: change.path, label: statusLabel(change) })),
			};
		});
	}

	/** 归档检查：把文件移出博客目录并真实构建，构建失败会自动移回。 */
	async checkArchive(slug, confirmation) {
		return this.#queue(() => this.#checkArchive(slug, confirmation));
	}

	/** 恢复检查：把归档笔记移回博客目录并真实构建，失败会自动移回归档。 */
	async checkRestore(name) {
		return this.#queue(() => this.#checkRestore(name));
	}

	async #checkArchive(slug, confirmation) {
		const article = await this.store.read(slug);
		if (String(confirmation ?? '') !== article.metadata.title) {
			throw Object.assign(new Error('归档确认不匹配。请输入完整文章标题后再试。'), { status: 400 });
		}
		const warnings = await this.#inboundWarnings(article);
		const moved = await this.store.archive(slug, article.metadata.title);
		const build = await this.buildRunner(this.paths.root);
		if (!build.ok) {
			await this.store.moveRelative(moved.archived, moved.from);
			return {
				ok: false,
				action: 'archive',
				stage: 'build',
				errors: ['生产构建失败，文章已自动移回博客目录，未产生任何提交。'],
				warnings,
				move: { from: moved.from, to: moved.archived, title: moved.title, slug, action: 'archive' },
				article: publicArticle(article),
				build: { ...build, output: tail(build.output, 120) },
				files: [],
				diff: '',
				checkId: null,
			};
		}
		const state = await getGitState(this.paths.root);
		const files = state.changes
			.filter((change) => change.path === moved.from || change.path === moved.archived)
			.map((change) => ({ path: change.path, label: statusLabel(change), staged: change.staged }));
		const diff = await getDiff(this.paths.root, [path.join(this.paths.root, moved.from)]);
		const checkId = crypto.randomUUID();
		this.checks.set(checkId, {
			checkId,
			kind: 'archive',
			slug,
			move: { from: moved.from, to: moved.archived, title: moved.title, slug, action: 'archive' },
			files,
			build: { ok: true, durationMs: build.durationMs, output: tail(build.output, 80) },
			warnings,
			createdAt: Date.now(),
		});
		const safety = await checkRepositorySafety(this.paths.root, [moved.from, moved.archived], null, { fetchRemote: false, actionLabel: '归档' });
		return {
			ok: true,
			action: 'archive',
			stage: 'ready',
			checkId,
			article: publicArticle(article),
			move: { from: moved.from, to: moved.archived },
			build: { ok: true, durationMs: build.durationMs, output: tail(build.output, 80) },
			files,
			diff,
			safety: { branch: safety.branch, errors: safety.errors },
			warnings,
		};
	}

	async #checkRestore(name) {
		const archived = (await this.store.listArchived()).find((item) => item.slug === name);
		if (!archived) throw Object.assign(new Error('归档笔记不存在。'), { status: 404 });
		if (archived.conflict) {
			throw Object.assign(new Error(`博客中已存在 /blog/${name}/，请先归档或重命名该文章后再恢复。`), { status: 409 });
		}
		const moved = await this.store.restore(name);
		const article = await this.store.read(name);
		const all = await this.store.list();
		const validation = await validateArticle(article, all, this.paths);
		if (!validation.ok) {
			await this.store.moveRelative(moved.to, moved.from);
			return {
				ok: false,
				action: 'restore',
				stage: 'validation',
				errors: validation.errors,
				warnings: validation.warnings,
				article: publicArticle(article),
				build: null,
				files: [],
				diff: '',
				checkId: null,
			};
		}
		const build = await this.buildRunner(this.paths.root);
		if (!build.ok) {
			await this.store.moveRelative(moved.to, moved.from);
			return {
				ok: false,
				action: 'restore',
				stage: 'build',
				errors: ['生产构建失败，笔记已自动移回归档目录，未产生任何提交。'],
				warnings: validation.warnings,
				article: publicArticle(article),
				build: { ...build, output: tail(build.output, 120) },
				files: [],
				diff: '',
				checkId: null,
			};
		}
		const state = await getGitState(this.paths.root);
		const files = state.changes
			.filter((change) => change.path === moved.from || change.path === moved.to)
			.map((change) => ({ path: change.path, label: statusLabel(change), staged: change.staged }));
		const diff = await getDiff(this.paths.root, [path.join(this.paths.root, moved.to)]);
		const checkId = crypto.randomUUID();
		const revision = crypto.createHash('sha256').update(String(article.body).trim()).digest('hex');
		this.checks.set(checkId, {
			checkId,
			kind: 'restore',
			slug: name,
			revision,
			move: { from: moved.from, to: moved.to, title: moved.title, slug: name, action: 'restore' },
			files,
			build: { ok: true, durationMs: build.durationMs, output: tail(build.output, 80) },
			warnings: validation.warnings,
			createdAt: Date.now(),
		});
		const safety = await checkRepositorySafety(this.paths.root, [moved.from, moved.to], null, { fetchRemote: false, actionLabel: '恢复' });
		return {
			ok: true,
			action: 'restore',
			stage: 'ready',
			checkId,
			article: publicArticle(article),
			move: { from: moved.from, to: moved.to },
			build: { ok: true, durationMs: build.durationMs, output: tail(build.output, 80) },
			files,
			diff,
			safety: { branch: safety.branch, errors: safety.errors },
			warnings: validation.warnings,
		};
	}

	/** 放弃归档或恢复检查，把文件移回原位。 */
	async cancelMove(checkId) {
		return this.#queue(async () => {
			const check = this.checks.get(checkId);
			if (!check || check.kind === 'publish') throw Object.assign(new Error('没有可撤销的归档或恢复操作。'), { status: 404 });
			const { from, to } = check.move;
			if (!(await exists(path.join(this.paths.root, to)))) {
				this.checks.delete(checkId);
				throw Object.assign(new Error('文件已被移动或删除，无法自动还原。'), { status: 409 });
			}
			await this.store.moveRelative(to, from);
			this.checks.delete(checkId);
			return { ok: true, restored: from };
		});
	}

	async publish(checkId) {
		return this.#queue(async () => {
			const check = this.#validCheck(checkId);
			return check.kind === 'publish' ? this.#publishArticle(check) : this.#publishMove(check);
		});
	}

	#validCheck(checkId) {
		const check = this.checks.get(checkId);
		if (!check) throw Object.assign(new Error('发布检查不存在或已过期，请重新运行检查。'), { status: 409 });
		if (Date.now() - check.createdAt > CHECK_TTL) {
			this.checks.delete(checkId);
			throw Object.assign(new Error('发布检查已超过 30 分钟，请重新运行。'), { status: 409 });
		}
		return check;
	}

	async #publishArticle(check) {
		const article = await this.store.read(check.slug);
		const content = await fs.readFile(path.join(this.paths.root, articleRelative(article)), 'utf8');
		const hash = crypto.createHash('sha256').update(content).digest('hex');
		if (hash !== check.contentHash) throw Object.assign(new Error('检查后文章又被修改，请重新运行发布检查。'), { status: 409 });
		const assetDir = assetDirForSlug(this.paths, check.slug);
		const safety = await checkRepositorySafety(this.paths.root, articleRelative(article), path.relative(this.paths.root, assetDir));
		if (safety.errors.length) throw Object.assign(new Error(`发布前检查失败：${safety.errors.join(' ')}`), { status: 409, details: safety.errors });
		const all = await this.store.list();
		const validation = await validateArticle(article, all, this.paths);
		if (!validation.ok) throw Object.assign(new Error(`内容校验失败：${validation.errors.join(' ')}`), { status: 409 });
		const committed = await stageAndCommit(this.paths.root, articleRelative(article), path.relative(this.paths.root, assetDir), `post: publish ${article.metadata.title}`);
		const baseRecord = {
			id: crypto.randomUUID(),
			action: 'publish',
			slug: check.slug,
			title: article.metadata.title,
			url: `${site.url.replace(/\/$/, '')}/blog/${check.slug}/`,
			revision: crypto.createHash('sha256').update(article.body.trim()).digest('hex'),
			commit: committed.commit,
			files: committed.files,
			createdAt: new Date().toISOString(),
			push: { ok: false, output: '' },
			deployment: { status: 'unconfirmed', detail: '已提交，等待推送。' },
		};
		try {
			const pushed = await pushMain(this.paths.root);
			baseRecord.push = { ok: true, output: tail(pushed.output, 30) };
			baseRecord.deployment = { status: 'pending', detail: '已推送 GitHub，Cloudflare 部署尚未确认。' };
			await this.history.append(baseRecord);
			this.checks.delete(check.checkId);
			return { ok: true, action: 'publish', stage: 'pushed', commit: committed.commit, files: committed.files, push: baseRecord.push, deployment: baseRecord.deployment, record: baseRecord };
		} catch (error) {
			baseRecord.push = { ok: false, output: error.message };
			baseRecord.deployment = { status: 'unconfirmed', detail: 'Git 提交已创建，但推送失败。' };
			await this.history.append(baseRecord);
			return { ok: false, action: 'publish', stage: 'push_failed', commit: committed.commit, files: committed.files, push: baseRecord.push, deployment: baseRecord.deployment, error: error.message, record: baseRecord };
		}
	}

	async #publishMove(check) {
		const { from, to, title, slug, action } = check.move;
		const root = this.paths.root;
		if (!(await exists(path.join(root, to))) || (await exists(path.join(root, from)))) {
			this.checks.delete(check.checkId);
			throw Object.assign(new Error('文件已不在检查时的状态，请重新运行检查。'), { status: 409 });
		}
		const label = action === 'archive' ? '归档' : '恢复';
		const safety = await checkRepositorySafety(root, [from, to], null, { actionLabel: label });
		if (safety.errors.length) throw Object.assign(new Error(`${label}前检查失败：${safety.errors.join(' ')}`), { status: 409, details: safety.errors });
		const committed = await stageAndCommit(root, [from, to], null, `post: ${action} ${title}`);
		const baseRecord = {
			id: crypto.randomUUID(),
			action,
			slug,
			title,
			url: `${site.url.replace(/\/$/, '')}/blog/${slug}/`,
			revision: check.revision ?? null,
			commit: committed.commit,
			files: committed.files,
			createdAt: new Date().toISOString(),
			push: { ok: false, output: '' },
			deployment: { status: 'unconfirmed', detail: '已提交，等待推送。' },
		};
		try {
			const pushed = await pushMain(root);
			baseRecord.push = { ok: true, output: tail(pushed.output, 30) };
			baseRecord.deployment = {
				status: 'pending',
				detail: action === 'archive' ? '已推送 GitHub，等待线上文章地址返回 404。' : '已推送 GitHub，Cloudflare 部署尚未确认。',
			};
			await this.history.append(baseRecord);
			this.checks.delete(check.checkId);
			return { ok: true, action, stage: 'pushed', commit: committed.commit, files: committed.files, push: baseRecord.push, deployment: baseRecord.deployment, record: baseRecord };
		} catch (error) {
			baseRecord.push = { ok: false, output: error.message };
			baseRecord.deployment = { status: 'unconfirmed', detail: 'Git 提交已创建，但推送失败。' };
			await this.history.append(baseRecord);
			return { ok: false, action, stage: 'push_failed', commit: committed.commit, files: committed.files, push: baseRecord.push, deployment: baseRecord.deployment, error: error.message, record: baseRecord };
		}
	}

	/** 归档前检查其他已发布文章是否仍引用它，避免静默产生死链。 */
	async #inboundWarnings(article) {
		const others = (await this.store.list()).filter((item) => !item.broken && item.slug !== article.slug && !item.metadata?.draft);
		const needles = [`/blog/${article.slug}/`, `/blog/${article.slug})`];
		const hits = others.filter((item) => needles.some((needle) => String(item.body).includes(needle)));
		const warnings = [];
		if (hits.length) {
			warnings.push(`以下已发布文章仍链接到 /blog/${article.slug}/：${hits.map((item) => `「${item.metadata.title}」`).join('、')}。归档后这些链接会失效，建议先修改链接。`);
		}
		warnings.push('文章图片仍保留在 src/assets/publisher 中；恢复文章后可直接继续使用。');
		return warnings;
	}

	async verifyDeployment(commit) {
		const records = await this.history.read();
		const record = records.find((item) => item.commit === commit);
		if (!record) throw Object.assign(new Error('找不到对应的发布记录。'), { status: 404 });
		const verifier = record.action === 'archive' ? this.removalVerifier : this.deployVerifier;
		const result = await verifier(record);
		await this.history.updateDeployment(commit, result);
		return result;
	}

	historyList() {
		return this.history.read();
	}

	#queue(task) {
		const next = this.active.then(task, task);
		this.active = next.catch(() => undefined);
		return next;
	}
}

function tail(value, lines = 60) {
	return String(value ?? '').split('\n').slice(-lines).join('\n').trim();
}

function publicArticle(article) {
	return {
		slug: article.slug,
		title: article.metadata.title,
		description: article.metadata.description,
		category: article.metadata.category,
		categoryName: categoryName(article.metadata.category),
		tags: article.metadata.tags.map((tag) => ({ slug: tag, name: tagName(tag) })),
		pubDate: article.metadata.pubDate,
		updatedDate: article.metadata.updatedDate,
		draft: article.metadata.draft,
		demo: article.metadata.demo,
		url: `${site.url.replace(/\/$/, '')}/blog/${article.slug}/`,
		file: article.file,
		version: article.version,
	};
}

export async function verifyProduction(record, options = {}) {
	const url = `${record.url}?publisher_check=${Date.now()}`;
	try {
		const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(options.timeout ?? 15_000), headers: { 'user-agent': 'my-blog-local-publisher/1.0' } });
		const html = await response.text();
		const revision = html.match(/<meta name="article-revision" content="([a-f0-9]{64})"/i)?.[1] ?? null;
		const revisionPresent = record.revision ? revision === record.revision : html.includes(record.title);
		if (response.ok && revisionPresent) {
			return { status: 'deployed', detail: '线上正文修订指纹已核验。', httpStatus: response.status, checkedAt: new Date().toISOString() };
		}
		return { status: 'pending', detail: response.ok ? '线上页面存在，但正文修订指纹尚未更新。' : `线上返回 HTTP ${response.status}。`, httpStatus: response.status, checkedAt: new Date().toISOString() };
	} catch (error) {
		return { status: 'unconfirmed', detail: `无法访问线上站点：${error.message}`, httpStatus: null, checkedAt: new Date().toISOString() };
	}
}

/** 归档核验：线上文章地址应当返回 404。 */
export async function verifyRemoval(record, options = {}) {
	const url = `${record.url}?publisher_check=${Date.now()}`;
	try {
		const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(options.timeout ?? 15_000), headers: { 'user-agent': 'my-blog-local-publisher/1.0' } });
		if (response.status === 404) {
			return { status: 'deployed', detail: '线上文章地址已返回 404，归档已生效。', httpStatus: 404, checkedAt: new Date().toISOString() };
		}
		if (response.ok) {
			return { status: 'pending', detail: '线上文章仍可访问，Cloudflare 可能尚未完成部署。', httpStatus: response.status, checkedAt: new Date().toISOString() };
		}
		return { status: 'pending', detail: `线上返回 HTTP ${response.status}。`, httpStatus: response.status, checkedAt: new Date().toISOString() };
	} catch (error) {
		return { status: 'unconfirmed', detail: `无法访问线上站点：${error.message}`, httpStatus: null, checkedAt: new Date().toISOString() };
	}
}
