import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeObsidianNote, normaliseImportedBody } from '../lib/obsidian.mjs';
import { PNG_1PX } from './helpers.mjs';

const existing = [
	{
		slug: 'existing-note',
		file: 'src/content/blog/existing-note.md',
		body: '已有正文。',
		metadata: { title: '已有笔记', draft: false, category: 'technology', tags: ['writing'] },
	},
];

test('导入中文标题、frontmatter、Wikilink 别名与章节锚点', () => {
	const analysis = analyzeObsidianNote({
		note: {
			name: '中文笔记.md',
			path: '我的知识库/中文笔记.md',
			content: `---
title: "一篇中文笔记"
tags: [写作, 工作方法]
category: 阅读随笔
created: 2025-08-01
---
# 一篇中文笔记

关联 [[已有笔记|旧文章]]，章节 [[已有笔记#第一节]]，缺失 [[不存在]]。
`,
		},
		articles: existing,
	});
	assert.equal(analysis.metadata.title, '一篇中文笔记');
	assert.equal(analysis.metadata.category, 'reading');
	assert.deepEqual(analysis.metadata.tags, ['writing', 'workflow']);
	assert.equal(analysis.metadata.draft, true);
	assert.match(analysis.body, /\[旧文章\]\(\/blog\/existing-note\/\)/);
	assert.match(analysis.body, /\[已有笔记\]\(\/blog\/existing-note\/#第一节\)/);
	assert.match(analysis.body, /缺失/);
	assert.ok(analysis.warnings.some((warning) => warning.includes('不存在')));
	assert.equal(analysis.isNew, true);
	assert.ok(/^note-\d{8}$/.test(analysis.slug) || /^[a-z0-9-]+$/.test(analysis.slug));
});

test('导入 Obsidian 图片和相对 Markdown 图片并只规划引用附件', () => {
	const analysis = analyzeObsidianNote({
		note: {
			name: 'with-images.md',
			path: 'vault/with-images.md',
			content: `---
title: "带图片的笔记"
category: technology
---
![[附件 图片.png|示意图]]

![第二张](attachments/second.jpg)

未引用图片不应进入计划。
`,
		},
		files: [
			{ name: '附件 图片.png', path: 'vault/assets/附件 图片.png', base64: PNG_1PX, size: 68 },
			{ name: 'second.jpg', path: 'vault/attachments/second.jpg', base64: PNG_1PX, size: 68 },
			{ name: 'unused.png', path: 'vault/unused.png', base64: PNG_1PX, size: 68 },
		],
		articles: existing,
	});
	assert.equal(analysis.attachments.length, 2);
	assert.ok(analysis.attachments.some((file) => file.targetName === '附件-图片.png'));
	assert.match(analysis.body, /__ASSET__\/附件-图片\.png/);
	assert.match(analysis.body, /__ASSET__\/second\.jpg/);
	const normalized = normaliseImportedBody(analysis.body, 'with-images');
	assert.match(normalized, /\.\.\/\.\.\/assets\/publisher\/with-images\/附件-图片\.png/);
	assert.ok(!analysis.attachments.some((file) => file.originalPath.includes('unused')));
});

test('同名标题识别为更新，保留已有 slug 并生成正文差异', () => {
	const analysis = analyzeObsidianNote({
		note: {
			name: 'some-other-name.md', path: 'vault/some-other-name.md',
			content: `---
title: "已有笔记"
category: technology
tags: [写作]
---
新的正文内容。
`,
		},
		articles: existing,
	});
	assert.equal(analysis.existing.slug, 'existing-note');
	assert.equal(analysis.slug, 'existing-note');
	assert.equal(analysis.isNew, false);
	assert.ok(analysis.diff.some((part) => part.removed));
	assert.ok(analysis.diff.some((part) => part.added));
});

test('文件名冲突时使用稳定后缀，且附件名不能逃逸资源目录', () => {
	const analysis = analyzeObsidianNote({
		note: { name: 'notes.md', path: 'vault/notes.md', content: '![[../../evil.png]]\n\n![[a/same.png]]\n\n![[b/same.png]]' },
		files: [
			{ name: '../../evil.png', path: 'vault/assets/evil.png', base64: PNG_1PX, size: 68 },
			{ name: 'same.png', path: 'vault/a/same.png', base64: PNG_1PX, size: 68 },
			{ name: 'same.png', path: 'vault/b/same.png', base64: PNG_1PX, size: 68 },
		],
		articles: existing,
	});
	assert.equal(analysis.attachments[0].targetName, 'evil.png');
	assert.equal(analysis.attachments[1].targetName, 'same.png');
	assert.equal(analysis.attachments[2].targetName, 'same-1.png');
	for (const file of analysis.attachments) assert.ok(!file.targetName.includes('/'));
});
