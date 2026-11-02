import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build as esbuild } from 'esbuild';
import {
	createPaths, PROJECT_ROOT, PublisherError, assertSlug, assetDirForSlug,
	resolveInside, safeAssetName, isImageFile, ASSET_MIME_TYPES,
} from './lib/paths.mjs';
import { categories, tags, site, categoryName, tagName } from './lib/config.mjs';
import { ArticleStore } from './lib/articles.mjs';
import { HistoryStore } from './lib/history.mjs';
import { getGitState } from './lib/git.mjs';
import { PublishService } from './lib/publish.mjs';
import { analyzeObsidianNote, normaliseImportedBody } from './lib/obsidian.mjs';
import { validateArticle } from './lib/validation.mjs';
import { atomicWrite, ensureDir, sha256 } from './lib/atomic.mjs';

const TOOL_DIR = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_DIR = path.join(TOOL_DIR, 'client');
const DEFAULT_PORT = 4322;
const MAX_JSON = 32 * 1024 * 1024;
const MAX_IMAGE = 15 * 1024 * 1024;
const importAnalyses = new Map();

function json(res, status, value) {
	const body = JSON.stringify(value);
	res.writeHead(status, {
		'content-type': 'application/json; charset=utf-8',
		'content-length': Buffer.byteLength(body),
		'cache-control': 'no-store',
	});
	res.end(body);
}

function text(res, status, value, type = 'text/plain; charset=utf-8') {
	res.writeHead(status, { 'content-type': type, 'content-length': Buffer.byteLength(value), 'cache-control': 'no-store' });
	res.end(value);
}

async function readBody(req, limit = MAX_JSON) {
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		size += chunk.length;
		if (size > limit) throw new PublisherError('请求内容过大。', 413);
		chunks.push(chunk);
	}
	return Buffer.concat(chunks);
}

async function readJson(req) {
	const body = await readBody(req);
	if (!body.length) return {};
	try {
		return JSON.parse(body.toString('utf8'));
	} catch {
		throw new PublisherError('请求 JSON 格式无效。', 400);
	}
}

function sameToken(expected, provided) {
	if (!provided || provided.length !== expected.length) return false;
	return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(provided));
}

function safeString(value, name, max = 20_000) {
	const textValue = String(value ?? '');
	if (textValue.length > max) throw new PublisherError(`${name}内容过长。`, 400);
	return textValue;
}

function statusForArticle(article, changes) {
	const entry = changes.find((change) => change.path === article.file);
	if (!entry) return { code: 'committed', label: '已提交' };
	if (entry.index === '?' || entry.worktree === '?') return { code: 'untracked', label: '未提交' };
	return { code: 'modified', label: '本地修改' };
}

function publicArticle(article, changes = [], records = []) {
	const record = records.find((item) => item.slug === article.slug);
	return {
		slug: article.slug,
		title: article.metadata?.title ?? article.slug,
		description: article.metadata?.description ?? '',
		category: article.metadata?.category,
		categoryName: article.metadata ? categoryName(article.metadata.category) : '',
		tags: (article.metadata?.tags ?? []).map((tag) => ({ slug: tag, name: tagName(tag) })),
		pubDate: article.metadata?.pubDate,
		updatedDate: article.metadata?.updatedDate,
		draft: article.metadata?.draft ?? true,
		demo: article.metadata?.demo ?? false,
		readingTime: article.readingTime,
		file: article.file,
		url: `${site.url.replace(/\/$/, '')}/blog/${article.slug}/`,
		git: article.broken ? { code: 'broken', label: '解析失败' } : statusForArticle(article, changes),
		lastPublish: record ? {
			commit: record.commit,
			pushed: Boolean(record.push?.ok),
			deployment: record.deployment?.status ?? 'unconfirmed',
			createdAt: record.createdAt,
		} : null,
		error: article.error,
	};
}

function publicArchive(entry) {
	return {
		slug: entry.slug,
		title: entry.title,
		description: entry.description ?? '',
		category: entry.category,
		categoryName: entry.category ? categoryName(entry.category) : '',
		tags: (entry.tags ?? []).map((tag) => ({ slug: tag, name: tagName(tag) })),
		pubDate: entry.pubDate,
		updatedDate: entry.updatedDate,
		archivedAt: entry.archivedAt,
		file: entry.file,
		size: entry.size,
		conflict: Boolean(entry.conflict),
		broken: Boolean(entry.broken),
		url: `${site.url.replace(/\/$/, '')}/blog/${entry.slug}/`,
	};
}

async function buildClientBundle(paths) {
	const outfile = path.join(paths.generated, 'app.js');
	await ensureDir(paths.generated);
	await esbuild({
		entryPoints: [path.join(CLIENT_DIR, 'app.js')],
		outfile,
		bundle: true,
		format: 'esm',
		target: ['es2022'],
		platform: 'browser',
		minify: false,
		sourcemap: false,
		logLevel: 'silent',
	});
	return outfile;
}

function contentDisposition(fileName) {
	return `inline; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

function normaliseMediaPath(paths, raw) {
	const clean = String(raw || '').replaceAll('\\', '/');
	const allowedRoots = [
		path.relative(paths.root, paths.assets).replaceAll('\\', '/'),
		path.relative(paths.root, paths.public).replaceAll('\\', '/'),
		path.relative(paths.root, path.join(paths.state, 'import-preview')).replaceAll('\\', '/'),
	];
	if (!allowedRoots.some((root) => clean.startsWith(`${root}/`))) throw new PublisherError('不允许读取该资源路径。', 403);
	return resolveInside(paths.root, clean);
}

export async function createPublisherServer(options = {}) {
	const paths = createPaths(options.root ?? PROJECT_ROOT);
	const store = new ArticleStore(paths);
	const history = new HistoryStore(paths.history);
	const token = options.token ?? crypto.randomBytes(24).toString('hex');
	const publishService = new PublishService({
		paths,
		store,
		history,
		buildRunner: options.buildRunner,
		deployVerifier: options.deployVerifier,
		removalVerifier: options.removalVerifier,
	});
	const bundlePath = await buildClientBundle(paths);
	await ensureDir(paths.state);
	await fs.rm(path.join(paths.state, 'import-preview'), { recursive: true, force: true });

	const server = http.createServer(async (req, res) => {
		res.setHeader('x-content-type-options', 'nosniff');
		res.setHeader('referrer-policy', 'no-referrer');
		res.setHeader('x-frame-options', 'DENY');
		res.setHeader('cross-origin-resource-policy', 'same-origin');
		try {
			const remote = req.socket.remoteAddress;
			if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote)) throw new PublisherError('仅允许本机访问。', 403);
			const host = String(req.headers.host || '');
			if (!/^(127\.0\.0\.1|localhost):\d+$/.test(host)) throw new PublisherError('Host 不受信任。', 403);
			const origin = req.headers.origin;
			if (origin && origin !== `http://${host}`) throw new PublisherError('跨站请求已被拒绝。', 403);
			const url = new URL(req.url || '/', `http://${host}`);

			if (url.pathname === '/api/media') {
				if (!sameToken(token, url.searchParams.get('token') ?? '')) throw new PublisherError('访问令牌无效。', 403);
				let decodedMediaPath;
				try { decodedMediaPath = decodeURIComponent(url.searchParams.get('path') ?? ''); }
				catch { throw new PublisherError('媒体路径编码无效。', 400); }
				const filePath = normaliseMediaPath(paths, decodedMediaPath);
				const extension = path.extname(filePath).toLowerCase();
				if (!ASSET_MIME_TYPES[extension]) throw new PublisherError('不支持的媒体格式。', 415);
				let data;
				try { data = await fs.readFile(filePath); } catch (error) { if (error.code === 'ENOENT') throw new PublisherError('图片不存在。', 404); throw error; }
				res.writeHead(200, {
					'content-type': ASSET_MIME_TYPES[extension],
					'content-length': data.length,
					'cache-control': 'private, max-age=60',
					'content-disposition': contentDisposition(path.basename(filePath)),
				});
				res.end(data);
				return;
			}

			if (url.pathname.startsWith('/api/')) {
				if (!sameToken(token, String(req.headers['x-publisher-token'] || ''))) throw new PublisherError('访问令牌无效，请刷新页面。', 403);
			}

			if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
				const template = await fs.readFile(path.join(CLIENT_DIR, 'index.html'), 'utf8');
				const html = template.replace('__PUBLISHER_TOKEN__', token);
				res.writeHead(200, {
					'content-type': 'text/html; charset=utf-8',
					'cache-control': 'no-store',
					'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
				});
				res.end(html);
				return;
			}
			if (req.method === 'GET' && url.pathname === '/app.css') {
				text(res, 200, await fs.readFile(path.join(CLIENT_DIR, 'app.css'), 'utf8'), 'text/css; charset=utf-8');
				return;
			}
			if (req.method === 'GET' && url.pathname === '/app.js') {
				text(res, 200, await fs.readFile(bundlePath, 'utf8'), 'text/javascript; charset=utf-8');
				return;
			}
			if (req.method === 'GET' && url.pathname === '/site.css') {
				text(res, 200, await fs.readFile(path.join(paths.root, 'src/styles/global.css'), 'utf8'), 'text/css; charset=utf-8');
				return;
			}
			if (req.method === 'GET' && url.pathname === '/favicon.svg') {
				text(res, 200, await fs.readFile(path.join(paths.public, 'favicon.svg'), 'utf8'), 'image/svg+xml');
				return;
			}

			if (req.method === 'GET' && url.pathname === '/api/bootstrap') {
				const [articles, archives] = await Promise.all([store.list(), store.listArchived()]);
				const [gitState, records] = await Promise.all([getGitState(paths.root), history.read()]);
				return json(res, 200, {
					articles: articles.map((article) => publicArticle(article, gitState.changes, records)),
					archives: archives.map(publicArchive),
					categories, tags,
					site: { name: site.name, url: site.url, github: site.github, author: site.author.name },
					git: { branch: gitState.branch, head: gitState.head, upstream: gitState.upstream, changeCount: gitState.changes.length },
					runtime: { node: process.version, supported: isNodeSupported() },
					counts: { total: articles.length, drafts: articles.filter((article) => article.metadata?.draft).length, archived: archives.length },
				});
			}

			if (req.method === 'GET' && url.pathname === '/api/archives') {
				return json(res, 200, { archives: (await store.listArchived()).map(publicArchive) });
			}

			if (req.method === 'GET' && url.pathname === '/api/history') {
				return json(res, 200, { records: await history.read() });
			}

			const articleMatch = url.pathname.match(/^\/api\/articles\/([a-z0-9-]+)$/);
			if (articleMatch && req.method === 'GET') {
				const article = await store.read(articleMatch[1]);
				const gitState = await getGitState(paths.root);
				return json(res, 200, {
					...article,
					public: publicArticle(article, gitState.changes),
					categories, tags,
				});
			}
			if (articleMatch && req.method === 'PUT') {
				const payload = await readJson(req);
				const metadata = payload.metadata ?? {};
				if (metadata.category && !categories.some((category) => category.slug === metadata.category)) throw new PublisherError('分类无效。', 400);
				if (metadata.tags && (!Array.isArray(metadata.tags) || metadata.tags.some((tag) => !tags.some((item) => item.slug === tag)))) throw new PublisherError('标签包含未注册项。', 400);
				const article = await store.save(articleMatch[1], {
					body: safeString(payload.body, '正文', 2_000_000),
					version: payload.version,
					metadata: {
						...metadata,
						title: safeString(metadata.title, '标题', 200),
						description: safeString(metadata.description, '摘要', 180),
					},
				});
				const validation = await validateArticle(article, await store.list(), paths);
				return json(res, 200, { article, validation });
			}

			if (req.method === 'POST' && url.pathname === '/api/articles') {
				const payload = await readJson(req);
				if (!categories.some((category) => category.slug === payload.category)) throw new PublisherError('分类无效。', 400);
				const payloadTags = Array.isArray(payload.tags) ? payload.tags : [];
				if (payloadTags.some((tag) => !tags.some((item) => item.slug === tag))) throw new PublisherError('标签包含未注册项。', 400);
				const article = await store.create({
					slug: payload.slug,
					title: safeString(payload.title, '标题', 200),
					description: safeString(payload.description, '摘要', 180),
					category: payload.category,
					tags: payloadTags,
					body: safeString(payload.body, '正文', 2_000_000),
				});
				return json(res, 201, { article });
			}

			const actionMatch = url.pathname.match(/^\/api\/articles\/([a-z0-9-]+)\/copy$/);
			if (actionMatch && req.method === 'POST') {
				return json(res, 201, { article: await store.copy(actionMatch[1]) });
			}

			if (req.method === 'POST' && url.pathname === '/api/archive/check') {
				const payload = await readJson(req);
				const result = await publishService.checkArchive(assertSlug(payload.slug), safeString(payload.confirmation, '确认', 300));
				return json(res, 200, result);
			}
			if (req.method === 'POST' && url.pathname === '/api/archive/restore/check') {
				const payload = await readJson(req);
				const result = await publishService.checkRestore(assertSlug(payload.slug));
				return json(res, 200, result);
			}
			if (req.method === 'POST' && url.pathname === '/api/archive/cancel') {
				const payload = await readJson(req);
				return json(res, 200, await publishService.cancelMove(safeString(payload.checkId, '检查 ID', 100)));
			}

			const backupMatch = url.pathname.match(/^\/api\/articles\/([a-z0-9-]+)\/backups$/);
			if (backupMatch && req.method === 'GET') {
				return json(res, 200, { backups: await store.listBackups(backupMatch[1]) });
			}
			if (backupMatch && req.method === 'POST') {
				const payload = await readJson(req);
				const article = await store.restoreBackup(backupMatch[1], safeString(payload.backup, '备份名称', 200));
				return json(res, 200, { article });
			}

			if (req.method === 'POST' && url.pathname === '/api/import/analyze') {
				const payload = await readJson(req);
				const note = {
					name: safeString(payload.note?.name, '文件名', 300),
					path: safeString(payload.note?.path, '文件路径', 3000),
					content: safeString(payload.note?.content, '笔记正文', 2_000_000),
				};
				const files = Array.isArray(payload.files) ? payload.files.slice(0, 200).map((file) => {
					const base64 = safeString(file.base64, '附件', 24_000_000);
					const size = Buffer.byteLength(base64, 'base64');
					if (size > MAX_IMAGE) throw new PublisherError(`附件 ${file.name} 过大。`, 413);
					if (!isImageFile(file.name)) throw new PublisherError(`不支持的附件格式：${file.name}`, 415);
					return { name: safeAssetName(file.name), path: safeString(file.path || file.name, '附件路径', 3000), base64, size };
				}) : [];
				const articles = await store.list();
				const analysis = analyzeObsidianNote({ note, files, articles });
				const id = crypto.randomUUID();
				const previewDir = path.join(paths.state, 'import-preview', id);
				await ensureDir(previewDir);
				const previewAttachments = [];
				for (const attachment of analysis.attachments) {
					const raw = analysis.rawAttachments.find((item) => item.originalPath === attachment.originalPath);
					if (!raw) continue;
					await atomicWrite(path.join(previewDir, attachment.targetName), Buffer.from(raw.base64, 'base64'));
					previewAttachments.push({ ...attachment, previewUrl: `/api/media?token=${token}&path=${encodeURIComponent(path.relative(paths.root, path.join(previewDir, attachment.targetName)).replaceAll('\\', '/'))}` });
				}
				importAnalyses.set(id, {
					analysis,
					attachments: analysis.rawAttachments,
					previewDir,
					createdAt: Date.now(),
					used: false,
				});
				for (const [key, value] of importAnalyses) if (Date.now() - value.createdAt > 60 * 60_000) importAnalyses.delete(key);
				const { rawAttachments, ...safeAnalysis } = analysis;
				return json(res, 200, {
					analysisId: id,
					...safeAnalysis,
					attachments: previewAttachments,
					previewBody: analysis.body,
					categories, tags,
				});
			}

			if (req.method === 'POST' && url.pathname === '/api/import/commit') {
				const payload = await readJson(req);
				const record = importAnalyses.get(safeString(payload.analysisId, '导入 ID', 100));
				if (!record || record.used) throw new PublisherError('导入分析不存在或已经使用，请重新分析。', 409);
				if (Date.now() - record.createdAt > 60 * 60_000) throw new PublisherError('导入分析已超过一小时，请重新导入。', 409);
				const existing = record.analysis.existing;
				const mode = existing ? 'update' : 'new';
				if (existing && payload.mode !== 'update') throw new PublisherError('检测到同名文章。请确认「更新已有文章」，不会创建重复文章。', 409);
				if (!existing && payload.mode === 'update') throw new PublisherError('没有可供更新的已有文章。', 400);
				const targetSlug = existing?.slug ?? assertSlug(payload.slug);
				if (!existing && await store.findFile(targetSlug)) throw new PublisherError('文章 URL 已存在，请更换 slug。', 409);
				const category = categories.some((item) => item.slug === payload.category) ? payload.category : record.analysis.metadata.category;
				const tagValues = Array.isArray(payload.tags) ? payload.tags.filter((tag) => tags.some((item) => item.slug === tag)) : record.analysis.metadata.tags;
				const assetDir = assetDirForSlug(paths, targetSlug);
				await ensureDir(assetDir);
				const nameMap = new Map();
				const createdAssets = [];
				for (const attachment of record.attachments) {
					let targetName = safeAssetName(attachment.targetName);
					const targetPath = resolveInside(assetDir, targetName);
					const bytes = Buffer.from(attachment.base64, 'base64');
					try {
						const existingData = await fs.readFile(targetPath);
						if (!existingData.equals(bytes)) {
							const extension = path.extname(targetName);
							targetName = `${path.basename(targetName, extension)}-${sha256(bytes).slice(0, 8)}${extension}`;
						}
					} catch (error) {
						if (error.code !== 'ENOENT') throw error;
					}
					const finalPath = resolveInside(assetDir, targetName);
					try {
						await fs.access(finalPath);
					} catch {
						await atomicWrite(finalPath, bytes);
						createdAssets.push(finalPath);
					}
					nameMap.set(attachment.targetName, targetName);
				}
				let body = record.analysis.body;
				for (const [original, final] of nameMap) body = body.replaceAll(`__ASSET__/${original}`, `__ASSET__/${final}`);
				body = normaliseImportedBody(body, targetSlug);
				const metadata = {
					...record.analysis.metadata,
					title: safeString(payload.title || record.analysis.metadata.title, '标题', 200),
					description: safeString(payload.description || record.analysis.metadata.description, '摘要', 180),
					category,
					tags: [...new Set(tagValues)],
				};
				let article;
				try {
					if (existing) {
						const current = await store.read(targetSlug);
						article = await store.save(targetSlug, {
							body,
							version: current.version,
							metadata: {
								...current.metadata,
								...metadata,
								pubDate: current.metadata.pubDate,
								draft: current.metadata.draft,
								cover: current.metadata.cover,
								coverAlt: current.metadata.coverAlt,
								extra: current.metadata.extra,
							},
						});
					} else {
						article = await store.create({
							slug: targetSlug,
							title: metadata.title,
							description: metadata.description,
							category: metadata.category,
							tags: metadata.tags,
							pubDate: metadata.pubDate,
							body,
						});
					}
				} catch (error) {
					for (const file of createdAssets) await fs.rm(file, { force: true });
					throw error;
				}
				record.used = true;
				return json(res, 200, {
					article,
					mode,
					url: `${site.url.replace(/\/$/, '')}/blog/${targetSlug}/`,
					warnings: record.analysis.warnings,
				});
			}

			const uploadMatch = url.pathname.match(/^\/api\/articles\/([a-z0-9-]+)\/upload$/);
			if (uploadMatch && req.method === 'POST') {
				const slug = assertSlug(uploadMatch[1]);
				if (!(await store.findFile(slug))) throw new PublisherError('请先保存文章，再插入图片。', 409);
				const fileName = safeAssetName(String(req.headers['x-filename'] || url.searchParams.get('filename') || ''));
				if (!isImageFile(fileName)) throw new PublisherError('只支持 PNG、JPEG、GIF、WebP 和 AVIF 图片。', 415);
				const data = await readBody(req, MAX_IMAGE);
				if (!data.length) throw new PublisherError('图片内容为空。', 400);
				const assetDir = assetDirForSlug(paths, slug);
				await ensureDir(assetDir);
				let finalName = fileName;
				let target = resolveInside(assetDir, finalName);
				try {
					const existing = await fs.readFile(target);
					if (!existing.equals(data)) {
						const extension = path.extname(fileName);
						finalName = `${path.basename(fileName, extension)}-${sha256(data).slice(0, 8)}${extension}`;
						target = resolveInside(assetDir, finalName);
					}
				} catch (error) {
					if (error.code !== 'ENOENT') throw error;
				}
				await atomicWrite(target, data);
				const relative = `../../assets/publisher/${slug}/${finalName}`;
				return json(res, 201, {
					path: relative,
					markdown: `![${path.basename(finalName, path.extname(finalName))}](${relative})`,
					previewUrl: `/api/media?token=${token}&path=${encodeURIComponent(path.relative(paths.root, target).replaceAll('\\', '/'))}`,
					size: data.length,
				});
			}

			if (req.method === 'POST' && url.pathname === '/api/publish/check') {
				const payload = await readJson(req);
				const result = await publishService.check(assertSlug(payload.slug));
				return json(res, 200, result);
			}
			if (req.method === 'POST' && url.pathname === '/api/publish/confirm') {
				const payload = await readJson(req);
				const result = await publishService.publish(safeString(payload.checkId, '检查 ID', 100));
				return json(res, 200, result);
			}
			if (req.method === 'POST' && url.pathname === '/api/deploy/verify') {
				const payload = await readJson(req);
				const result = await publishService.verifyDeployment(safeString(payload.commit, '提交', 64));
				return json(res, 200, result);
			}

			if (url.pathname.startsWith('/api/')) throw new PublisherError('API 不存在。', 404);
			throw new PublisherError('页面不存在。', 404);
		} catch (error) {
			const status = error instanceof PublisherError ? error.status : Number.isInteger(error.status) ? error.status : 500;
			if (status >= 500) console.error('[publisher]', error);
			if (!res.headersSent) json(res, status, { error: error.message || '本地发布中心发生错误。', details: error.details ?? null });
			else res.end();
		}
	});

	return {
		server,
		paths,
		token,
		store,
		history,
		publishService,
		async listen(port = 0, host = '127.0.0.1') {
			await new Promise((resolve, reject) => {
				server.once('error', reject);
				server.listen(port, host, resolve);
			});
			return server.address();
		},
		async close() {
			await new Promise((resolve) => server.close(resolve));
		},
	};
}

function isNodeSupported() {
	const [major, minor, patch] = process.versions.node.split('.').map(Number);
	return major > 22 || (major === 22 && (minor > 23 || (minor === 23 && patch >= 4)));
}

async function main() {
	if (!isNodeSupported()) {
		console.warn(`\n⚠️  当前 Node ${process.version} 低于 Astro 要求的 22.23.4。可以编辑，但生产构建可能失败。\n`);
	}
	const port = Number(process.env.PUBLISHER_PORT || DEFAULT_PORT);
	if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PUBLISHER_PORT 无效。');
	const app = await createPublisherServer();
	const address = await app.listen(port, '127.0.0.1');
	const url = `http://127.0.0.1:${address.port}/`;
	console.log(`\n  本地发布中心已启动\n  ${url}\n  按 Ctrl+C 安全关闭。\n`);
	if (process.env.PUBLISHER_OPEN === '1' && process.platform === 'darwin') {
		spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
	}
	const shutdown = async () => {
		console.log('\n正在关闭本地发布中心…');
		await app.close();
		process.exit(0);
	};
	process.on('SIGINT', shutdown);
	process.on('SIGTERM', shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch((error) => {
		console.error(error);
		process.exit(1);
	});
}
