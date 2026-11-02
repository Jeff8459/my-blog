import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { makeFixture, runGit } from './helpers.mjs';
import { createPaths } from '../lib/paths.mjs';
import { ArticleStore } from '../lib/articles.mjs';
import { HistoryStore } from '../lib/history.mjs';
import { PublishService } from '../lib/publish.mjs';
import { checkRepositorySafety } from '../lib/git.mjs';

const successBuild = async () => ({ ok: true, output: 'build ok', durationMs: 12, exitCode: 0 });

test('发布流水线只提交本次文章与附件，并推送到本地模拟远程', async (t) => {
	const fixture = await makeFixture();
	t.after(fixture.cleanup);
	const paths = createPaths(fixture.root);
	const store = new ArticleStore(paths);
	const history = new HistoryStore(paths.history);
	const article = await store.create({ slug: 'publish-me', title: '准备发布的文章', description: '摘要', category: 'technology', tags: ['writing'], body: '正文' });
	await fs.mkdir(path.join(paths.assets, 'publish-me'), { recursive: true });
	await fs.writeFile(path.join(paths.assets, 'publish-me', 'cover.png'), 'fake');
	const service = new PublishService({ paths, store, history, buildRunner: successBuild });
	const check = await service.check('publish-me');
	assert.equal(check.ok, true);
	assert.equal(check.article.draft, false);
	assert.ok(check.files.some((file) => file.path === 'src/content/blog/publish-me.md'));
	assert.ok(check.files.some((file) => file.path.includes('cover.png')));
	const published = await service.publish(check.checkId);
	assert.equal(published.ok, true);
	assert.match(published.commit, /^[0-9a-f]{40}$/);
	const remote = await runGit(path.join(fixture.root, '..', `${path.basename(fixture.root)}-remote.git`), ['rev-parse', 'refs/heads/main']);
	assert.equal(remote, published.commit);
	const committedFiles = await runGit(fixture.root, ['show', '--pretty=format:', '--name-only', 'HEAD']);
	assert.match(committedFiles, /src\/content\/blog\/publish-me\.md/);
	assert.match(committedFiles, /src\/assets\/publisher\/publish-me\/cover\.png/);
	assert.ok(!committedFiles.includes('existing-note.md'));
	const records = await history.read();
	assert.equal(records.length, 1);
	assert.equal(records[0].push.ok, true);
	assert.match(records[0].revision, /^[a-f0-9]{64}$/);
	assert.equal(article.metadata.draft, true);
});

test('构建失败时恢复草稿并保留正文，不产生提交', async (t) => {
	const fixture = await makeFixture();
	t.after(fixture.cleanup);
	const paths = createPaths(fixture.root);
	const store = new ArticleStore(paths);
	const history = new HistoryStore(paths.history);
	const article = await store.create({ slug: 'build-fails', title: '构建失败测试', description: '摘要', category: 'technology', tags: [], body: '必须保留的草稿正文。' });
	const headBefore = await runGit(fixture.root, ['rev-parse', 'HEAD']);
	const service = new PublishService({ paths, store, history, buildRunner: async () => ({ ok: false, output: 'synthetic build error', durationMs: 5, exitCode: 1 }) });
	const result = await service.check('build-fails');
	assert.equal(result.ok, false);
	assert.equal(result.stage, 'build');
	const current = await store.read('build-fails');
	assert.equal(current.metadata.draft, true);
	assert.match(current.body, /必须保留的草稿正文/);
	assert.equal(await runGit(fixture.root, ['rev-parse', 'HEAD']), headBefore);
	assert.ok(article.version);
});

test('推送失败时保留本地提交与文章内容，并记录未确认状态', async (t) => {
	const fixture = await makeFixture();
	t.after(fixture.cleanup);
	const remotePath = path.join(fixture.root, '..', `${path.basename(fixture.root)}-remote.git`);
	const hook = path.join(remotePath, 'hooks', 'pre-receive');
	await fs.writeFile(hook, '#!/bin/sh\necho "simulated rejection" >&2\nexit 1\n');
	await fs.chmod(hook, 0o755);
	const paths = createPaths(fixture.root);
	const store = new ArticleStore(paths);
	const history = new HistoryStore(paths.history);
	await store.create({ slug: 'push-fails', title: '推送失败测试', description: '摘要', category: 'technology', tags: [], body: '本地内容不能丢。' });
	const service = new PublishService({ paths, store, history, buildRunner: successBuild });
	const check = await service.check('push-fails');
	const result = await service.publish(check.checkId);
	assert.equal(result.ok, false);
	assert.equal(result.stage, 'push_failed');
	assert.match(result.commit, /^[0-9a-f]{40}$/);
	assert.equal(await runGit(fixture.root, ['rev-parse', 'HEAD']), result.commit);
	const current = await store.read('push-fails');
	assert.match(current.body, /本地内容不能丢/);
	const records = await history.read();
	assert.equal(records[0].push.ok, false);
	assert.equal(records[0].deployment.status, 'unconfirmed');
});

test('当前不在 main 时阻止发布，不自动切换分支', async (t) => {
	const fixture = await makeFixture();
	t.after(fixture.cleanup);
	await runGit(fixture.root, ['switch', '-c', 'topic/work']);
	const paths = createPaths(fixture.root);
	const store = new ArticleStore(paths);
	const article = await store.create({ slug: 'branch-check', title: '分支检查', description: '摘要', category: 'technology', tags: [], body: '正文' });
	const safety = await checkRepositorySafety(fixture.root, article.file, 'src/assets/publisher/branch-check', { fetchRemote: false });
	assert.ok(safety.errors.some((error) => error.includes('当前分支')));
	assert.equal(await runGit(fixture.root, ['branch', '--show-current']), 'topic/work');
});

test('存在无关修改时拒绝发布，不会把其他文件纳入提交', async (t) => {
	const fixture = await makeFixture();
	t.after(fixture.cleanup);
	const paths = createPaths(fixture.root);
	const store = new ArticleStore(paths);
	const article = await store.create({ slug: 'safety-check', title: '安全检查', description: '摘要', category: 'technology', tags: [], body: '正文' });
	await fs.writeFile(path.join(fixture.root, 'unrelated.txt'), 'do not publish');
	const safety = await checkRepositorySafety(fixture.root, article.file, 'src/assets/publisher/safety-check', { fetchRemote: false });
	assert.ok(safety.errors.some((error) => error.includes('unrelated.txt')));
});
