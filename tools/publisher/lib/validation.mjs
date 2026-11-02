import fs from 'node:fs/promises';
import path from 'node:path';
import { categories, tags } from './config.mjs';
import { assertSlug, resolveInside } from './paths.mjs';

const categorySlugs = new Set(categories.map((category) => category.slug));
const tagSlugs = new Set(tags.map((tag) => tag.slug));

function normalisePath(value) {
	try {
		return decodeURIComponent(value.replaceAll('&amp;', '&')).replace(/[?#].*$/, '');
	} catch {
		return value.replace(/[?#].*$/, '');
	}
}

function extractMarkdownTargets(body) {
	const images = [...body.matchAll(/!\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+["'][^"']*["'])?\s*\)/g)].map((match) => match[1]);
	const links = [...body.matchAll(/(?<!!)\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+["'][^"']*["'])?\s*\)/g)].map((match) => match[1]);
	const htmlImages = [...body.matchAll(/<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi)].map((match) => match[1]);
	return { images: [...images, ...htmlImages], links };
}

function linkTargetId(href) {
	try {
		const url = new URL(href, 'https://local.invalid/blog/current/');
		if (url.host !== 'local.invalid') return null;
		const segments = url.pathname.split('/').filter(Boolean);
		if (segments[0] !== 'blog' || !segments[1]) return null;
		return segments[1].replace(/\.mdx?$/i, '');
	} catch {
		return null;
	}
}

export async function validateArticle(article, allArticles, paths) {
	const errors = [];
	const warnings = [];
	const metadata = article.metadata;
	if (!metadata.title?.trim()) errors.push('标题不能为空。');
	if (!metadata.description?.trim()) errors.push('摘要不能为空。');
	else if (metadata.description.length > 180) errors.push('摘要不能超过 180 个字符。');
	if (!categorySlugs.has(metadata.category)) errors.push(`分类「${metadata.category}」不存在。`);
	for (const tag of metadata.tags ?? []) {
		if (!tagSlugs.has(tag)) errors.push(`标签「${tag}」尚未在 taxonomy 中注册。`);
	}
	if (new Set(metadata.tags ?? []).size !== (metadata.tags ?? []).length) warnings.push('标签存在重复项。');
	if (!/^\d{4}-\d{2}-\d{2}$/.test(String(metadata.pubDate))) errors.push('发布日期格式应为 YYYY-MM-DD。');
	if (metadata.seoDescription && metadata.seoDescription.length > 180) errors.push('SEO 描述不能超过 180 个字符。');
	if (metadata.coverAlt && !metadata.cover) warnings.push('填写了封面替代文字，但没有设置封面路径。');
	if (metadata.draft) warnings.push('当前仍是草稿；确认发布会将其标记为正式文章。');
	try {
		assertSlug(article.slug);
	} catch (error) {
		errors.push(error.message);
	}

	const articleDirectory = path.dirname(path.join(paths.root, article.file));
	const known = new Map(allArticles.map((item) => [item.slug, item]));
	const { images, links } = extractMarkdownTargets(article.body);
	for (const href of links) {
		if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:')) continue;
		const targetId = linkTargetId(href);
		if (!targetId) continue;
		const target = known.get(targetId);
		if (!target) errors.push(`站内链接目标不存在：/blog/${targetId}/`);
		else if (target.metadata?.draft && target.slug !== article.slug) warnings.push(`站内链接目标「${target.metadata.title}」仍是草稿，正式环境可能返回 404。`);
	}

	const managedAssets = [];
	for (const raw of images) {
		if (!raw || /^(https?:|data:)/i.test(raw)) continue;
		const clean = normalisePath(raw);
		if (!clean) continue;
		let target;
		try {
			if (clean.startsWith('/')) target = resolveInside(paths.public, clean.replace(/^\/+/, ''));
			else target = resolveInside(paths.root, path.relative(paths.root, path.resolve(articleDirectory, clean)));
			if (!clean.startsWith('/')) {
				// 只允许文章自身资源目录或已存在的共享资源，防止发布流程误带其他文件。
				const relative = path.relative(paths.root, target);
				if (relative.startsWith('src/assets/publisher/')) managedAssets.push(relative);
			}
			await fs.access(target);
		} catch {
			errors.push(`图片资源不存在：${raw}`);
		}
	}
	for (const [field, value] of [['cover', metadata.cover], ['heroImage', metadata.heroImage]]) {
		if (!value || /^(https?:|data:)/i.test(value)) continue;
		try {
			const target = value.startsWith('/')
				? resolveInside(paths.public, value.replace(/^\/+/, ''))
				: resolveInside(articleDirectory, value);
			await fs.access(target);
		} catch {
			errors.push(`${field} 图片不存在：${value}`);
		}
	}

	return {
		ok: errors.length === 0,
		errors,
		warnings,
		managedAssets,
		summary: {
			title: metadata.title,
			category: metadata.category,
			tags: metadata.tags,
			draft: metadata.draft,
			url: `/blog/${article.slug}/`,
			readingTime: article.readingTime,
		},
	};
}
