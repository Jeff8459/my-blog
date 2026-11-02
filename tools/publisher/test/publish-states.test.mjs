import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { makeFixture, runGit } from './helpers.mjs';
import { createPaths } from '../lib/paths.mjs';
import { ArticleStore } from '../lib/articles.mjs';
import { HistoryStore } from '../lib/history.mjs';
import { PublishService, verifyProduction, verifyRemoval } from '../lib/publish.mjs';

const successBuild = async () => ({ ok: true, output: 'build ok', durationMs: 8, exitCode: 0 });

function withFetch(impl, fn) {
	const original = globalThis.fetch;
	globalThis.fetch = impl;
	return fn().finally(() => { globalThis.fetch = original; });
}

function htmlResponse(status, body) {
	return Promise.resolve(new Response(body, { status, headers: { 'content-type': 'text/html' } }));
}

test('线上核验区分已部署、未更新、404 与网络不可达', async () => {
	const record = { url: 'https://example.invalid/blog/post/', revision: 'a'.repeat(64), title: '标题' };
	await withFetch(() => htmlResponse(200, `<meta name="article-revision" content="${'a'.repeat(64)}">`), async () => {
		const result = await verifyProduction(record);
		assert.equal(result.status, 'deployed');
	});
	await withFetch(() => htmlResponse(200, '<meta name="article-revision" content="' + 'b'.repeat(64) + '">'), async () => {
		const result = await verifyProduction(record);
		assert.equal(result.status, 'pending');
		assert.match(result.detail, /尚未更新/);
	});
	await withFetch(() => htmlResponse(404, 'not found'), async () => {
		assert.equal((await verifyProduction(record)).status, 'pending');
		assert.equal((await verifyRemoval(record)).status, 'deployed');
	});
	await withFetch(() => htmlResponse(200, '<html></html>'), async () => {
		const result = await verifyRemoval(record);
		assert.equal(result.status, 'pending');
		assert.match(result.detail, /仍可访问/);
	});
	await withFetch(() => Promise.reject(new Error('network down')), async () => {
		const result = await verifyProduction(record);
		assert.equal(result.status, 'unconfirmed');
		assert.match(result.detail, /无法访问线上站点/);
	});
});

test('重复点击发布只会产生一个提交，第二次请求被拒绝', async (t) => {
	const fixture = await makeFixture();
	t.after(fixture.cleanup);
	const paths = createPaths(fixture.root);
	const store = new ArticleStore(paths);
	const history = new HistoryStore(paths.history);
	await store.create({ slug: 'double-click', title: '重复点击发布', description: '摘要', category: 'technology', tags: [], body: '正文内容。' });
	const service = new PublishService({
		paths,
		store,
		history,
		buildRunner: successBuild,
		deployVerifier: async () => ({ status: 'deployed', detail: 'mock', httpStatus: 200 }),
	});
	const check = await service.check('double-click');
	const headBefore = await runGit(fixture.root, ['rev-parse', 'HEAD']);
	const results = await Promise.allSettled([
		service.publish(check.checkId),
		service.publish(check.checkId),
	]);
	const fulfilled = results.filter((item) => item.status === 'fulfilled');
	const rejected = results.filter((item) => item.status === 'rejected');
	assert.equal(fulfilled.length, 1);
	assert.equal(rejected.length, 1);
	assert.equal(rejected[0].reason.status, 409);
	const commits = await runGit(fixture.root, ['rev-list', '--count', `${headBefore}..HEAD`]);
	assert.equal(commits, '1');
	const remote = await runGit(path.join(fixture.root, '..', `${path.basename(fixture.root)}-remote.git`), ['rev-parse', 'refs/heads/main']);
	assert.equal(remote, await runGit(fixture.root, ['rev-parse', 'HEAD']));
	const records = await history.read();
	assert.equal(records.length, 1);
	assert.equal(records[0].push.ok, true);
});

test('部署状态可反复核验并写回历史，未确认状态不会被改写成已部署', async (t) => {
	const fixture = await makeFixture();
	t.after(fixture.cleanup);
	const paths = createPaths(fixture.root);
	const store = new ArticleStore(paths);
	const history = new HistoryStore(paths.history);
	const deployStates = [
		{ status: 'pending', detail: '线上返回 HTTP 404。', httpStatus: 404 },
		{ status: 'deployed', detail: '线上正文修订指纹已核验。', httpStatus: 200 },
	];
	const service = new PublishService({
		paths,
		store,
		history,
		buildRunner: successBuild,
		deployVerifier: async () => deployStates.shift(),
	});
	await store.create({ slug: 'deploy-retry', title: '部署重试', description: '摘要', category: 'technology', tags: [], body: '正文内容。' });
	const check = await service.check('deploy-retry');
	const published = await service.publish(check.checkId);
	const first = await service.verifyDeployment(published.commit);
	assert.equal(first.status, 'pending');
	assert.equal((await history.read())[0].deployment.status, 'pending');
	const second = await service.verifyDeployment(published.commit);
	assert.equal(second.status, 'deployed');
	assert.equal((await history.read())[0].deployment.status, 'deployed');
});
