import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { makeFixture, PNG_1PX } from './helpers.mjs';
import { createPublisherServer } from '../server.mjs';

async function startApp(fixture, options = {}) {
	const app = await createPublisherServer({
		root: fixture.root,
		token: 'integration-test-token',
		buildRunner: options.buildRunner ?? (async () => ({ ok: true, output: 'mock build ok', durationMs: 5, exitCode: 0 })),
		deployVerifier: async () => ({ status: 'deployed', detail: 'mock deployed', httpStatus: 200 }),
	});
	const address = await app.listen(0);
	return { app, base: `http://127.0.0.1:${address.port}`, token: app.token };
}

function request(base, token) {
	return async (route, options = {}) => {
		const headers = new Headers(options.headers || {});
		if (token) headers.set('x-publisher-token', token);
		let body = options.body;
		if (body && !(body instanceof Uint8Array) && typeof body !== 'string') { headers.set('content-type', 'application/json'); body = JSON.stringify(body); }
		const response = await fetch(`${base}${route}`, { ...options, headers, body });
		const type = response.headers.get('content-type') || '';
		const data = type.includes('json') ? await response.json() : await response.text();
		return { response, data };
	};
}

test('本地页面只监听本机，API 必须携带运行期令牌', async (t) => {
	const fixture = await makeFixture();
	t.after(fixture.cleanup);
	const { app, base } = await startApp(fixture);
	t.after(() => app.close());
	const page = await fetch(base + '/');
	assert.equal(page.status, 200);
	const html = await page.text();
	assert.match(html, /Notes Publisher/);
	assert.match(html, /publisher-token/);
	const unauthorized = await fetch(base + '/api/bootstrap');
	assert.equal(unauthorized.status, 403);
	const traversal = await fetch(`${base}/api/media?token=integration-test-token&path=${encodeURIComponent('src/assets/../../README.md')}`);
	assert.equal(traversal.status, 403);
	const call = request(base, 'integration-test-token');
	const bootstrap = await call('/api/bootstrap');
	assert.equal(bootstrap.response.status, 200);
	assert.equal(bootstrap.data.articles.length, 1);
	assert.equal(bootstrap.data.articles[0].draft, false);
});

test('创建、打开、保存并插入图片，保持 slug 和正文', async (t) => {
	const fixture = await makeFixture();
	t.after(fixture.cleanup);
	const { app, base } = await startApp(fixture);
	t.after(() => app.close());
	const call = request(base, 'integration-test-token');
	const created = await call('/api/articles', { method: 'POST', body: {
		slug: 'api-created', title: '接口创建', description: '接口摘要', category: 'reading', tags: ['writing'], body: '初始正文',
	} });
	assert.equal(created.response.status, 201);
	const opened = await call('/api/articles/api-created');
	assert.equal(opened.data.body.trim(), '初始正文');
	const saved = await call('/api/articles/api-created', { method: 'PUT', body: {
		version: opened.data.version,
		metadata: { ...opened.data.metadata, title: '接口创建（更新）', tags: ['reading-notes'] },
		body: '更新后的正文，URL 必须保持不变。',
	} });
	assert.equal(saved.response.status, 200);
	assert.equal(saved.data.article.slug, 'api-created');
	assert.equal(saved.data.article.metadata.title, '接口创建（更新）');
	const uploaded = await call('/api/articles/api-created/upload?filename=封面%20图.png', { method: 'POST', headers: { 'content-type': 'image/png' }, body: Buffer.from(PNG_1PX, 'base64') });
	assert.equal(uploaded.response.status, 201);
	assert.match(uploaded.data.markdown, /assets\/publisher\/api-created/);
	const mediaResponse = await fetch(`${base}${uploaded.data.previewUrl}`);
	assert.equal(mediaResponse.status, 200);
	assert.equal(mediaResponse.headers.get('content-type'), 'image/png');
	const backups = await call('/api/articles/api-created/backups');
	assert.ok(backups.data.backups.length >= 1);
});

test('Obsidian 导入可处理中文、Wikilink 与图片，并以更新方式避免重复文章', async (t) => {
	const fixture = await makeFixture();
	t.after(fixture.cleanup);
	const { app, base } = await startApp(fixture);
	t.after(() => app.close());
	const call = request(base, 'integration-test-token');
	const noteContent = `---
title: "导入的中文笔记"
tags: [写作]
category: 系统开发
---
关联 [[已有笔记|旧笔记]]。

![[示意图.png]]
`;
	const analysis = await call('/api/import/analyze', { method: 'POST', body: {
		note: { name: '导入的中文笔记.md', path: 'vault/导入的中文笔记.md', content: noteContent },
		files: [{ name: '示意图.png', path: 'vault/assets/示意图.png', base64: PNG_1PX, size: 68 }],
	} });
	assert.equal(analysis.response.status, 200);
	assert.match(analysis.data.body, /\/blog\/existing-note\//);
	assert.equal(analysis.data.attachments.length, 1);
	assert.equal(analysis.data.existing, null);
	const committed = await call('/api/import/commit', { method: 'POST', body: {
		analysisId: analysis.data.analysisId, mode: 'new', slug: analysis.data.slug,
		title: analysis.data.title, description: analysis.data.metadata.description,
		category: analysis.data.metadata.category, tags: analysis.data.metadata.tags,
	} });
	assert.equal(committed.response.status, 200);
	const file = path.join(fixture.root, 'src/content/blog', `${analysis.data.slug}.md`);
	const content = await fs.readFile(file, 'utf8');
	assert.match(content, /\.\.\/\.\.\/assets\/publisher\/.*\/示意图\.png/);
	assert.equal(await fs.stat(path.join(fixture.root, 'src/assets/publisher', analysis.data.slug, '示意图.png')).then(() => true), true);

	const duplicate = await call('/api/import/analyze', { method: 'POST', body: {
		note: { name: '任意文件名.md', path: 'vault/任意文件名.md', content: noteContent },
		files: [{ name: '示意图.png', path: 'vault/assets/示意图.png', base64: PNG_1PX, size: 68 }],
	} });
	assert.equal(duplicate.data.existing.slug, analysis.data.slug);
	const rejected = await call('/api/import/commit', { method: 'POST', body: {
		analysisId: duplicate.data.analysisId, mode: 'new', slug: 'should-not-duplicate',
	} });
	assert.equal(rejected.response.status, 409);
	const updated = await call('/api/import/commit', { method: 'POST', body: {
		analysisId: duplicate.data.analysisId, mode: 'update',
	} });
	assert.equal(updated.response.status, 200);
	assert.equal(updated.data.article.slug, analysis.data.slug);
	const articleFiles = await fs.readdir(path.join(fixture.root, 'src/content/blog'));
	assert.deepEqual(articleFiles.sort(), ['existing-note.md', `${analysis.data.slug}.md`].sort());
});

test('发布 API 执行本次文章白名单检查并成功发布', async (t) => {
	const fixture = await makeFixture();
	t.after(fixture.cleanup);
	const { app, base } = await startApp(fixture);
	t.after(() => app.close());
	const call = request(base, 'integration-test-token');
	await call('/api/articles', { method: 'POST', body: { slug: 'api-publish', title: '接口发布', description: '摘要', category: 'technology', tags: ['workflow'], body: '发布正文' } });
	await fs.writeFile(path.join(fixture.root, 'unrelated.tmp'), 'unrelated');
	const check = await call('/api/publish/check', { method: 'POST', body: { slug: 'api-publish' } });
	assert.equal(check.response.status, 200);
	assert.equal(check.data.ok, true);
	assert.ok(check.data.safety.errors.some((error) => error.includes('unrelated.tmp')));
	const rejected = await call('/api/publish/confirm', { method: 'POST', body: { checkId: check.data.checkId } });
	assert.equal(rejected.response.status, 409);
	await fs.rm(path.join(fixture.root, 'unrelated.tmp'));
	const second = await call('/api/publish/check', { method: 'POST', body: { slug: 'api-publish' } });
	assert.equal(second.data.ok, true);
	assert.deepEqual(second.data.safety.errors, []);
	const published = await call('/api/publish/confirm', { method: 'POST', body: { checkId: second.data.checkId } });
	assert.equal(published.response.status, 200);
	assert.equal(published.data.ok, true);
	assert.match(published.data.commit, /^[0-9a-f]{40}$/);
});
