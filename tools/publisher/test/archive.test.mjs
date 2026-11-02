import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { makeFixture, runGit } from './helpers.mjs';
import { createPaths } from '../lib/paths.mjs';
import { ArticleStore } from '../lib/articles.mjs';
import { HistoryStore } from '../lib/history.mjs';
import { PublishService } from '../lib/publish.mjs';
import { createPublisherServer } from '../server.mjs';

const successBuild = async () => ({ ok: true, output: 'build ok', durationMs: 12, exitCode: 0 });
const failedBuild = async () => ({ ok: false, output: 'synthetic build error', durationMs: 5, exitCode: 1 });

function setup(fixture, options = {}) {
	const paths = createPaths(fixture.root);
	const store = new ArticleStore(paths);
	const history = new HistoryStore(paths.history);
	const service = new PublishService({
		paths,
		store,
		history,
		buildRunner: options.buildRunner ?? successBuild,
		removalVerifier: async () => ({ status: 'deployed', detail: 'mock removal', httpStatus: 404 }),
	});
	return { paths, store, history, service };
}

function remoteOf(root) {
	return path.join(root, '..', `${path.basename(root)}-remote.git`);
}

test('归档走检查、构建、确认与推送，文件移入 archive 目录', async (t) => {
	const fixture = await makeFixture();
	t.after(fixture.cleanup);
	const { paths, service, history } = setup(fixture);
	const check = await service.checkArchive('existing-note', '已有笔记');
	assert.equal(check.ok, true);
	assert.equal(check.action, 'archive');
	assert.ok(check.files.some((file) => file.path === 'src/content/archive/existing-note.md' && file.label === '新增'));
	assert.ok(check.files.some((file) => file.path === 'src/content/blog/existing-note.md' && file.label === '删除'));
	await assert.rejects(() => fs.access(path.join(paths.blog, 'existing-note.md')));
	assert.ok(await fs.access(path.join(paths.archive, 'existing-note.md')).then(() => true));

	const published = await service.publish(check.checkId);
	assert.equal(published.ok, true);
	assert.equal(published.action, 'archive');
	assert.equal(await runGit(remoteOf(fixture.root), ['rev-parse', 'refs/heads/main']), published.commit);

	const changes = await runGit(fixture.root, ['show', '--pretty=format:', '--name-status', '--no-renames', 'HEAD']);
	assert.match(changes, /D\tsrc\/content\/blog\/existing-note\.md/);
	assert.match(changes, /A\tsrc\/content\/archive\/existing-note\.md/);

	const records = await history.read();
	assert.equal(records[0].action, 'archive');
	assert.equal(records[0].push.ok, true);
	assert.equal(records[0].revision, null);
});

test('归档时生产构建失败会自动移回文章，且不产生提交', async (t) => {
	const fixture = await makeFixture();
	t.after(fixture.cleanup);
	const { paths, service } = setup(fixture, { buildRunner: failedBuild });
	const headBefore = await runGit(fixture.root, ['rev-parse', 'HEAD']);
	const result = await service.checkArchive('existing-note', '已有笔记');
	assert.equal(result.ok, false);
	assert.equal(result.stage, 'build');
	assert.equal(result.checkId, null);
	assert.ok(await fs.access(path.join(paths.blog, 'existing-note.md')).then(() => true));
	await assert.rejects(() => fs.access(path.join(paths.archive, 'existing-note.md')));
	assert.equal(await runGit(fixture.root, ['rev-parse', 'HEAD']), headBefore);
});

test('归档标题确认不匹配时直接拒绝，文件保持原位', async (t) => {
	const fixture = await makeFixture();
	t.after(fixture.cleanup);
	const { paths, service } = setup(fixture);
	await assert.rejects(() => service.checkArchive('existing-note', '错误的标题'), (error) => error.status === 400);
	assert.ok(await fs.access(path.join(paths.blog, 'existing-note.md')).then(() => true));
	await assert.rejects(() => fs.access(path.join(paths.archive, 'existing-note.md')));
});

test('取消归档检查会把文件移回，且不产生任何提交', async (t) => {
	const fixture = await makeFixture();
	t.after(fixture.cleanup);
	const { paths, service } = setup(fixture);
	const headBefore = await runGit(fixture.root, ['rev-parse', 'HEAD']);
	const check = await service.checkArchive('existing-note', '已有笔记');
	assert.equal(check.ok, true);
	const cancelled = await service.cancelMove(check.checkId);
	assert.equal(cancelled.ok, true);
	assert.ok(await fs.access(path.join(paths.blog, 'existing-note.md')).then(() => true));
	await assert.rejects(() => fs.access(path.join(paths.archive, 'existing-note.md')));
	assert.equal(await runGit(fixture.root, ['rev-parse', 'HEAD']), headBefore);
	await assert.rejects(() => service.publish(check.checkId), (error) => error.status === 409);
});

test('恢复归档笔记沿用原 slug，并只提交归档与文章目录的移动', async (t) => {
	const fixture = await makeFixture();
	t.after(fixture.cleanup);
	const { paths, service, history } = setup(fixture);
	const archived = `---
title: "恢复测试"
description: "从归档目录恢复的文章。"
pubDate: "2026-10-02"
category: "technology"
tags: ["writing"]
draft: false
---
恢复后的正文。
`;
	await fs.writeFile(path.join(paths.archive, 'restore-me.md'), archived);
	await runGit(fixture.root, ['add', 'src/content/archive/restore-me.md']);
	await runGit(fixture.root, ['commit', '-m', 'add archived note']);
	await runGit(fixture.root, ['push', 'origin', 'main']);

	const check = await service.checkRestore('restore-me');
	assert.equal(check.ok, true);
	assert.equal(check.files.length, 2);
	const published = await service.publish(check.checkId);
	assert.equal(published.ok, true);
	const changes = await runGit(fixture.root, ['show', '--pretty=format:', '--name-status', '--no-renames', 'HEAD']);
	assert.match(changes, /A\tsrc\/content\/blog\/restore-me\.md/);
	assert.match(changes, /D\tsrc\/content\/archive\/restore-me\.md/);
	const restored = await fs.readFile(path.join(paths.blog, 'restore-me.md'), 'utf8');
	assert.match(restored, /恢复后的正文/);
	const records = await history.read();
	assert.equal(records[0].action, 'restore');
	assert.match(records[0].revision, /^[a-f0-9]{64}$/);
});

test('恢复时博客已存在同 slug 文章会被阻止，不移动文件', async (t) => {
	const fixture = await makeFixture();
	t.after(fixture.cleanup);
	const { paths, service } = setup(fixture);
	await fs.writeFile(path.join(paths.archive, 'existing-note.md'), '---\ntitle: "重复"\n---\n正文\n');
	await assert.rejects(() => service.checkRestore('existing-note'), (error) => error.status === 409);
	assert.ok(await fs.access(path.join(paths.archive, 'existing-note.md')).then(() => true));
	assert.ok(await fs.access(path.join(paths.blog, 'existing-note.md')).then(() => true));
});

test('归档检查会提示仍引用该文章的其他笔记，并拒绝无关修改', async (t) => {
	const fixture = await makeFixture();
	t.after(fixture.cleanup);
	const { paths, service } = setup(fixture);
	await fs.writeFile(path.join(paths.blog, 'linker.md'), `---
title: "引用者"
description: "仍然链接到待归档文章。"
pubDate: "2026-10-03"
category: "technology"
tags: []
draft: false
---
参见 [已有笔记](/blog/existing-note/)。
`);
	await runGit(fixture.root, ['add', 'src/content/blog/linker.md']);
	await runGit(fixture.root, ['commit', '-m', 'add linker']);
	await runGit(fixture.root, ['push', 'origin', 'main']);

	const check = await service.checkArchive('existing-note', '已有笔记');
	assert.equal(check.ok, true);
	assert.ok(check.warnings.some((warning) => warning.includes('仍链接到 /blog/existing-note/')));
	assert.ok(check.warnings.some((warning) => warning.includes('引用者')));

	await fs.writeFile(path.join(fixture.root, 'unrelated.txt'), 'do not publish');
	await assert.rejects(() => service.publish(check.checkId), (error) => error.status === 409);
});

test('归档与恢复接口共用检查与确认流程，并可取消还原', async (t) => {
	const fixture = await makeFixture();
	t.after(fixture.cleanup);
	const app = await createPublisherServer({
		root: fixture.root,
		token: 'archive-test-token',
		buildRunner: successBuild,
		deployVerifier: async () => ({ status: 'deployed', detail: 'mock', httpStatus: 200 }),
		removalVerifier: async () => ({ status: 'deployed', detail: 'mock', httpStatus: 404 }),
	});
	const address = await app.listen(0);
	t.after(() => app.close());
	const base = `http://127.0.0.1:${address.port}`;
	const call = async (route, options = {}) => {
		const headers = new Headers(options.headers || {});
		headers.set('x-publisher-token', 'archive-test-token');
		let body = options.body;
		if (body && typeof body !== 'string') { headers.set('content-type', 'application/json'); body = JSON.stringify(body); }
		const response = await fetch(`${base}${route}`, { ...options, headers, body });
		const data = (response.headers.get('content-type') || '').includes('json') ? await response.json() : await response.text();
		return { response, data };
	};

	const wrong = await call('/api/archive/check', { method: 'POST', body: { slug: 'existing-note', confirmation: '错误的标题' } });
	assert.equal(wrong.response.status, 400);

	const check = await call('/api/archive/check', { method: 'POST', body: { slug: 'existing-note', confirmation: '已有笔记' } });
	assert.equal(check.response.status, 200);
	assert.equal(check.data.ok, true);
	const bootstrap = await call('/api/bootstrap');
	assert.equal(bootstrap.data.archives.length, 1);
	assert.equal(bootstrap.data.articles.length, 0);
	assert.equal(bootstrap.data.counts.archived, 1);

	const cancelled = await call('/api/archive/cancel', { method: 'POST', body: { checkId: check.data.checkId } });
	assert.equal(cancelled.response.status, 200);
	const afterCancel = await call('/api/bootstrap');
	assert.equal(afterCancel.data.archives.length, 0);
	assert.equal(afterCancel.data.articles.length, 1);

	const second = await call('/api/archive/check', { method: 'POST', body: { slug: 'existing-note', confirmation: '已有笔记' } });
	const published = await call('/api/publish/confirm', { method: 'POST', body: { checkId: second.data.checkId } });
	assert.equal(published.response.status, 200);
	assert.equal(published.data.action, 'archive');

	const restoreCheck = await call('/api/archive/restore/check', { method: 'POST', body: { slug: 'existing-note' } });
	assert.equal(restoreCheck.response.status, 200);
	assert.equal(restoreCheck.data.action, 'restore');
	const restored = await call('/api/publish/confirm', { method: 'POST', body: { checkId: restoreCheck.data.checkId } });
	assert.equal(restored.data.ok, true);
	const finalBootstrap = await call('/api/bootstrap');
	assert.equal(finalBootstrap.data.articles.length, 1);
	assert.equal(finalBootstrap.data.archives.length, 0);
});
