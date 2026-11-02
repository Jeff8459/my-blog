import path from 'node:path';
import matter from 'gray-matter';
import { diffLines } from 'diff';
import { categories, normaliseCategory, normaliseTag, tags, categoryName } from './config.mjs';
import { SLUG_PATTERN, safeAssetName } from './paths.mjs';

const IMAGE_EXTENSION = /\.(png|jpe?g|gif|webp|avif)$/i;

function toDate(value) {
	if (!value) return null;
	const date = value instanceof Date ? value : new Date(value);
	return Number.isNaN(date.valueOf()) ? null : date.toISOString().slice(0, 10);
}

function stripMarkdown(value) {
	return String(value)
		.replace(/```[\s\S]*?```/g, ' ')
		.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
		.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
		.replace(/[#>*_`~\[\]]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

function normaliseLookup(value) {
	return String(value || '').normalize('NFC').trim().toLocaleLowerCase('zh-CN');
}

function headingAnchor(section) {
	return String(section || '').trim().replace(/^#+/, '').replace(/\s+/g, '-').replace(/[?？!！。，,：:；;]/g, '');
}

function slugifyFileBase(fileName) {
	return path.basename(fileName, path.extname(fileName))
		.normalize('NFKD')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 72);
}

function uniqueSlug(base, existingIds, reserved = new Set()) {
	const clean = SLUG_PATTERN.test(base) ? base : `note-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}`;
	let candidate = clean;
	let suffix = 2;
	while (existingIds.has(candidate) || reserved.has(candidate)) candidate = `${clean}-${suffix++}`;
	reserved.add(candidate);
	return candidate;
}

function findExisting(article, filename, articles) {
	const title = normaliseLookup(article.title);
	const base = normaliseLookup(path.basename(filename, path.extname(filename)));
	return articles.find((item) =>
		normaliseLookup(item.slug) === base ||
		normaliseLookup(item.metadata?.title) === title
	) ?? null;
}

function mapLinks(body, context) {
	const tokens = [];
	const attachments = [];
	const warnings = [];
	const reserve = (html) => {
		const marker = `@@PUBLISHER_OBSIDIAN_${tokens.length}@@`;
		tokens.push({ marker, html });
		return marker;
	};
	const attachmentFor = (target) => {
		const needle = normaliseLookup(target.replace(/^\.?\//, ''));
		const pathMatch = context.files.find((file) => {
			const filePath = normaliseLookup(file.path);
			return filePath === needle || filePath.endsWith(`/${needle}`);
		});
		if (pathMatch) return pathMatch;
		const byName = context.files.filter((file) => normaliseLookup(path.posix.basename(file.name)) === path.posix.basename(needle));
		if (byName.length > 1) warnings.push(`附件名「${path.posix.basename(needle)}」存在多个同名文件，已使用第一个，请确认。`);
		return byName[0];
	};
	const copyAttachment = (file) => {
		const existing = attachments.find((item) => item.originalPath === file.path);
		if (existing) return existing;
		let name = safeAssetName(file.name);
		let attempt = 1;
		while (attachments.some((item) => item.targetName === name && item.originalPath !== file.path)) {
			const extension = path.extname(name);
			name = `${path.basename(name, extension)}-${attempt++}${extension}`;
		}
		const item = { originalPath: file.path, targetName: name, base64: file.base64, size: file.size };
		attachments.push(item);
		return item;
	};
	const resolveNote = (target) => {
		const clean = target.replace(/^\.?\//, '').replace(/\.mdx?$/i, '').trim();
		const needle = normaliseLookup(clean);
		return context.articles.find((item) =>
			normaliseLookup(item.slug) === needle ||
			normaliseLookup(item.metadata?.title) === needle ||
			normaliseLookup(path.basename(item.file, path.extname(item.file))) === needle
		);
	};

	let output = body.replace(/!\[\[([^\]]+)\]\]/g, (_, raw) => {
		const [left, alias = ''] = raw.split('|');
		const [targetRaw, section = ''] = left.split('#');
		const target = targetRaw.trim();
		const file = attachmentFor(target);
		if (file && IMAGE_EXTENSION.test(file.name)) {
			const plan = copyAttachment(file);
			const alt = alias || path.basename(file.name, path.extname(file.name));
			if (alias && /^\d+$/.test(alias)) warnings.push(`图片 ${file.name} 的 Obsidian 宽度 ${alias} 未保留。`);
			return reserve(`![${alt}](__ASSET__/${plan.targetName})`);
		}
		if (IMAGE_EXTENSION.test(target)) {
			warnings.push(`找不到嵌入图片附件：${target}，已替换为占位文字。`);
			return reserve(`*[缺失图片：${target}]*`);
		}
		const targetArticle = resolveNote(target);
		if (!targetArticle) {
			warnings.push(`未找到嵌入笔记：${target}。`);
			return reserve(alias || target);
		}
		const anchor = section ? `#${headingAnchor(section)}` : '';
		return reserve(`[${alias || targetArticle.metadata.title}](/blog/${targetArticle.slug}/${anchor})`);
	});

	output = output.replace(/(?<!!)\[\[([^\]]+)\]\]/g, (_, raw) => {
		const [left, alias = ''] = raw.split('|');
		const [targetRaw, section = ''] = left.split('#');
		const target = targetRaw.trim();
		const targetArticle = resolveNote(target);
		if (!targetArticle) {
			warnings.push(`未找到 Wikilink 目标：${target}，已保留为纯文字。`);
			return reserve(alias || target);
		}
		const anchor = section ? `#${headingAnchor(section)}` : '';
		return reserve(`[${alias || targetArticle.metadata.title}](/blog/${targetArticle.slug}/${anchor})`);
	});

	output = output.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (full, alt, rawTarget) => {
		const target = rawTarget.trim().replace(/^<|>$/g, '');
		if (/^(https?:|data:|\/)/i.test(target)) return full;
		const file = attachmentFor(target);
		if (!file) {
			warnings.push(`正文图片未包含在导入文件中：${target}`);
			return full;
		}
		const plan = copyAttachment(file);
		return reserve(`![${alt || path.basename(file.name, path.extname(file.name))}](__ASSET__/${plan.targetName})`);
	});

	output = output.replace(/(?<!!)\[([^\]]+)\]\(([^)\s]+\.mdx?)(#[^)]+)?\)/gi, (_, label, target, anchor = '') => {
		const targetArticle = resolveNote(target);
		if (!targetArticle) {
			warnings.push(`相对 Markdown 链接目标不在已发布文章中：${target}`);
			return label;
		}
		return reserve(`[${label}](/blog/${targetArticle.slug}/${anchor.replace(/^#/, '#')})`);
	});

	return {
		body: output.replace(/@@PUBLISHER_OBSIDIAN_(\d+)@@/g, (_, index) => tokens[Number(index)].html),
		attachments,
		warnings,
	};
}

export function analyzeObsidianNote({ note, files = [], articles = [] }) {
	const parsed = matter(note.content ?? '');
	const filename = note.path || note.name;
	const links = mapLinks(parsed.content, { files, articles });
	const rawTags = Array.isArray(parsed.data.tags)
		? parsed.data.tags
		: typeof parsed.data.tags === 'string' ? parsed.data.tags.split(/[,，]/) : [];
	const mappedTags = [];
	const warnings = [...links.warnings];
	for (const rawTag of rawTags) {
		const tag = normaliseTag(rawTag);
		if (tag) mappedTags.push(tag);
		else warnings.push(`标签「${rawTag}」未注册，已忽略。`);
	}
	const title = String(parsed.data.title || path.basename(filename, path.extname(filename)) || '未命名笔记').trim();
	const categoryFromTags = categories.find((category) => rawTags.some((tag) => normaliseLookup(tag) === normaliseLookup(category.name)));
	const category = normaliseCategory(parsed.data.category)
		?? categoryFromTags?.slug
		?? categories[0].slug;
	const existing = findExisting({ title }, filename, articles);
	const proposedBase = String(parsed.data.slug || '').trim() || slugifyFileBase(filename);
	const slug = existing?.slug ?? uniqueSlug(proposedBase, new Set(articles.map((item) => item.slug)));
	const firstParagraph = stripMarkdown(parsed.content.split(/\n\s*\n/).find((paragraph) => paragraph.trim()) ?? '');
	const description = String(parsed.data.description || parsed.data.summary || firstParagraph || title).slice(0, 180);
	const pubDate = toDate(parsed.data.pubDate || parsed.data.date || parsed.data.created) ?? toDate(new Date());
	const updatedDate = toDate(parsed.data.updatedDate || parsed.data.modified);
	const metadata = {
		title,
		description,
		pubDate,
		updatedDate,
		category,
		tags: [...new Set(mappedTags)],
		author: parsed.data.author ? String(parsed.data.author) : undefined,
		draft: existing ? Boolean(existing.metadata?.draft) : true,
		demo: false,
		featured: false,
		extra: {},
	};
	const body = links.body;
	const diff = existing
		? diffLines(existing.body ?? '', body).map((part) => ({
			added: Boolean(part.added),
			removed: Boolean(part.removed),
			value: part.value,
		}))
		: null;
	return {
		title,
		filename,
		slug,
		metadata,
		categoryName: categoryName(category),
		body,
		attachments: links.attachments.map(({ base64, ...item }) => item),
		rawAttachments: links.attachments,
		warnings,
		existing: existing ? {
			slug: existing.slug,
			title: existing.metadata?.title,
			draft: Boolean(existing.metadata?.draft),
			url: `/blog/${existing.slug}/`,
		} : null,
		diff,
		isNew: !existing,
	};
}

export function normaliseImportedBody(body, slug) {
	return body.replaceAll('__ASSET__/', `../../assets/publisher/${slug}/`);
}

export function availableCategoryNames() {
	return categories.map((category) => ({ slug: category.slug, name: category.name }));
}

export function availableTagNames() {
	return tags.map((tag) => ({ slug: tag.slug, name: tag.name }));
}
