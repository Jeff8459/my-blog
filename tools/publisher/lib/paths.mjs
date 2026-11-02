import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const BLOG_DIR = 'src/content/blog';
export const ARCHIVE_DIR = 'src/content/archive';
export const ASSET_DIR = 'src/assets/publisher';
export const PUBLIC_DIR = 'public';
export const STATE_DIR = '.publisher';
export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function createPaths(root = PROJECT_ROOT) {
	const absoluteRoot = path.resolve(root);
	return {
		root: absoluteRoot,
		blog: path.join(absoluteRoot, BLOG_DIR),
		archive: path.join(absoluteRoot, ARCHIVE_DIR),
		assets: path.join(absoluteRoot, ASSET_DIR),
		public: path.join(absoluteRoot, PUBLIC_DIR),
		state: path.join(absoluteRoot, STATE_DIR),
		backups: path.join(absoluteRoot, STATE_DIR, 'backups'),
		generated: path.join(absoluteRoot, STATE_DIR, 'generated'),
		history: path.join(absoluteRoot, STATE_DIR, 'history.json'),
	};
}

export class PublisherError extends Error {
	constructor(message, status = 400, details = undefined) {
		super(message);
		this.name = 'PublisherError';
		this.status = status;
		this.details = details;
	}
}

export function assertSlug(slug) {
	if (typeof slug !== 'string' || !SLUG_PATTERN.test(slug) || slug.length > 100) {
		throw new PublisherError('文章 slug 只能包含小写字母、数字和单个连字符，且不能超过 100 个字符。', 400);
	}
	return slug;
}

/** 确保用户提供的路径仍然位于指定根目录内。 */
export function resolveInside(base, ...parts) {
	const target = path.resolve(base, ...parts);
	const relative = path.relative(path.resolve(base), target);
	if (relative.startsWith('..') || path.isAbsolute(relative)) {
		throw new PublisherError('路径超出了允许访问的目录。', 403);
	}
	return target;
}

export function articlePathForSlug(paths, slug, extension = 'md') {
	assertSlug(slug);
	return resolveInside(paths.blog, `${slug}.${extension}`);
}

/** 归档文件名同样只允许 slug 形式（可能带 -1、-2 去重后缀）。 */
export function archivePathForName(paths, name, extension = 'md') {
	assertSlug(name);
	return resolveInside(paths.archive, `${name}.${extension}`);
}

export function assetDirForSlug(paths, slug) {
	assertSlug(slug);
	return resolveInside(paths.assets, slug);
}

export function safeAssetName(input) {
	const normalized = String(input || '').normalize('NFC').replaceAll('\\', '/');
	const base = path.posix.basename(normalized).replace(/[\u0000-\u001f]/g, '');
	const cleaned = base
		.replace(/\s+/g, '-')
		.replace(/[^\p{L}\p{N}._-]/gu, '-')
		.replace(/-{2,}/g, '-')
		.replace(/^[.-]+/, '')
		.slice(-140);
	return cleaned || 'attachment';
}

export function isImageFile(fileName) {
	return /\.(png|jpe?g|gif|webp|avif)$/i.test(fileName);
}

export const ASSET_MIME_TYPES = {
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.gif': 'image/gif',
	'.webp': 'image/webp',
	'.avif': 'image/avif',
};
