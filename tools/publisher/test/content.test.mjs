import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import matter from 'gray-matter';
import { makeFixture } from './helpers.mjs';
import { createPaths, PublisherError } from '../lib/paths.mjs';
import { ArticleStore } from '../lib/articles.mjs';

test('新建草稿、保存、重新打开、备份、复制和归档', async (t) => {
	const fixture = await makeFixture({ git: false });
	t.after(fixture.cleanup);
	const paths = createPaths(fixture.root);
	const store = new ArticleStore(paths);
	const created = await store.create({
		slug: 'first-local-draft', title: '第一篇本地草稿', description: '这是一段摘要。',
		category: 'technology', tags: ['writing'], body: '## 第一节\n\n原始正文。',
	});
	assert.equal(created.metadata.draft, true);
	assert.equal(created.url, '/blog/first-local-draft/');
	assert.match(await fs.readFile(path.join(fixture.root, created.file), 'utf8'), /draft: true/);

	const saved = await store.save('first-local-draft', {
		version: created.version,
		metadata: { ...created.metadata, description: '修改后的摘要。', tags: ['writing', 'workflow'] },
		body: '## 第一节\n\n修改后的正文。',
	});
	assert.equal(saved.metadata.description, '修改后的摘要。');
	assert.deepEqual(saved.metadata.tags, ['writing', 'workflow']);
	const reopened = await store.read('first-local-draft');
	assert.match(reopened.body, /修改后的正文/);
	assert.match(await fs.readFile(path.join(fixture.root, reopened.file), 'utf8'), /tags: \["writing","workflow"\]/);
	const backups = await store.listBackups('first-local-draft');
	assert.equal(backups.length, 1);
	const restored = await store.restoreBackup('first-local-draft', backups[0].name);
	assert.match(restored.body, /原始正文/);

	const copy = await store.copy('first-local-draft');
	assert.equal(copy.slug, 'first-local-draft-copy');
	assert.equal(copy.metadata.draft, true);
	assert.equal(copy.metadata.title, '第一篇本地草稿（副本）');

	await assert.rejects(() => store.archive('first-local-draft', '错误标题'), PublisherError);
	const archived = await store.archive('first-local-draft', '第一篇本地草稿');
	assert.ok(archived.archived.startsWith('src/content/archive/'));
	await assert.rejects(() => store.read('first-local-draft'), PublisherError);
});

test('未显式设置 draft 的旧文章与 Astro 默认值一致，视为正式文章', async (t) => {
	const fixture = await makeFixture({ git: false });
	t.after(fixture.cleanup);
	const paths = createPaths(fixture.root);
	await fs.writeFile(path.join(paths.blog, 'legacy.md'), `---
title: "旧文章"
description: "旧文章摘要。"
pubDate: "2025-01-01"
category: "reading"
---
正文
`);
	const article = await new ArticleStore(paths).read('legacy');
	assert.equal(article.metadata.draft, false);
	assert.equal(article.metadata.featured, false);
});

test('并发保存会因版本过期被拒绝，避免静默覆盖', async (t) => {
	const fixture = await makeFixture({ git: false });
	t.after(fixture.cleanup);
	const paths = createPaths(fixture.root);
	const store = new ArticleStore(paths);
	const created = await store.create({ slug: 'merge-check', title: '并发保存', description: '摘要', category: 'reading', tags: [], body: 'A' });
	const first = store.save('merge-check', { version: created.version, metadata: created.metadata, body: 'B' });
	const second = store.save('merge-check', { version: created.version, metadata: created.metadata, body: 'C' });
	await first;
	await assert.rejects(second, PublisherError);
	const current = await store.read('merge-check');
	assert.equal(current.body.trim(), 'B');
});

test('路径序列化保持 frontmatter 稳定且保留未知字段', async (t) => {
	const fixture = await makeFixture({ git: false });
	t.after(fixture.cleanup);
	const paths = createPaths(fixture.root);
	const store = new ArticleStore(paths);
	const created = await store.create({ slug: 'frontmatter-test', title: '字段测试', description: '摘要', category: 'technology', tags: ['astro'], body: '正文' });
	const saved = await store.save('frontmatter-test', {
		version: created.version,
		metadata: { ...created.metadata, extra: { obsidianId: 'abc123' } },
		body: created.body,
	});
	const parsed = matter(await fs.readFile(path.join(fixture.root, saved.file), 'utf8'));
	assert.equal(parsed.data.obsidianId, 'abc123');
});
