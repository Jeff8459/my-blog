import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { makeFixture } from './helpers.mjs';
import { createPaths } from '../lib/paths.mjs';
import { ArticleStore } from '../lib/articles.mjs';
import { validateArticle } from '../lib/validation.mjs';

test('发布校验能发现无效分类、标签、摘要、站内链接和缺失图片', async (t) => {
	const fixture = await makeFixture({ git: false });
	t.after(fixture.cleanup);
	const paths = createPaths(fixture.root);
	const store = new ArticleStore(paths);
	await store.create({
		slug: 'broken-validation', title: '问题文章', description: 'x'.repeat(181),
		category: 'technology', tags: [], body: `[缺失站内文章](/blog/missing-post/)\n\n![缺失图片](../../assets/publisher/broken-validation/missing.png)\n`,
	});
	const article = await store.read('broken-validation');
	article.metadata.category = 'unknown-category';
	article.metadata.tags = ['unknown-tag', 'writing'];
	const result = await validateArticle(article, await store.list(), paths);
	assert.equal(result.ok, false);
	assert.ok(result.errors.some((error) => error.includes('分类')));
	assert.ok(result.errors.some((error) => error.includes('标签')));
	assert.ok(result.errors.some((error) => error.includes('摘要')));
	assert.ok(result.errors.some((error) => error.includes('/blog/missing-post/')));
	assert.ok(result.errors.some((error) => error.includes('图片资源不存在')));
	assert.ok(result.warnings.some((warning) => warning.includes('草稿')));
});

test('有效文章通过校验，并正确解析带锚点与相对路径的站内链接', async (t) => {
	const fixture = await makeFixture({ git: false });
	t.after(fixture.cleanup);
	const paths = createPaths(fixture.root);
	const store = new ArticleStore(paths);
	await fs.mkdir(path.join(paths.assets, 'valid-note'), { recursive: true });
	await fs.writeFile(path.join(paths.assets, 'valid-note', 'image.png'), Buffer.from('fake'));
	const created = await store.create({
		slug: 'valid-note', title: '合法文章', description: '合法摘要。',
		category: 'technology', tags: ['writing'], body: `[已有](../existing-note/#段落)\n\n![图片](../../assets/publisher/valid-note/image.png)\n`,
	});
	const result = await validateArticle(created, await store.list(), paths);
	assert.equal(result.ok, true);
	assert.ok(result.managedAssets.includes('src/assets/publisher/valid-note/image.png'));
});
