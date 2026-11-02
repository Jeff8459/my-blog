import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { makeFixture, PNG_1PX } from './helpers.mjs';
import { createPublisherServer } from '../server.mjs';

test('发布中心界面可新建、自动保存、预览、导入并适配手机', async (t) => {
	const fixture = await makeFixture();
	const app = await createPublisherServer({
		root: fixture.root,
		token: 'ui-test-token',
		buildRunner: async () => ({ ok: true, output: 'mock ui build', durationMs: 4, exitCode: 0 }),
	});
	const address = await app.listen(0);
	const base = `http://127.0.0.1:${address.port}`;
	const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
	t.after(async () => {
		await browser.close();
		await app.close();
		await fixture.cleanup();
	});
	const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
	const errors = [];
	page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
	page.on('pageerror', (error) => errors.push(error.message));
	await page.goto(base);
	await page.waitForSelector('.data-table');
	assert.equal(await page.locator('.data-table tbody tr').count(), 1);
	assert.equal(await page.locator('#view h1').textContent(), '文章管理');
	await fs.mkdir('test-results', { recursive: true });
	await page.screenshot({ path: 'test-results/publisher-dashboard.png', fullPage: true });

	await page.locator('.page-actions a[href="#/new"]').click();
	await page.waitForSelector('#new-title');
	await page.locator('#new-title').fill('界面自动保存测试');
	await page.locator('#new-desc').fill('通过发布中心界面创建的自动保存草稿。');
	await page.locator('#new-tags').fill('写作, 工作方法');
	await page.locator('form.form-panel button[type="submit"]').click();
	await page.waitForURL(/#\/edit\//);
	await page.waitForSelector('.cm-content');
	const slug = page.url().split('#/edit/')[1];
	await page.locator('.cm-content').click();
	await page.keyboard.press('Meta+a');
	await page.keyboard.type('## 自动保存\n\n实时预览与自动保存正文。');
	await page.waitForFunction(() => document.querySelector('.save-state')?.textContent?.includes('已保存'), null, { timeout: 8000 });
	await page.waitForFunction(() => document.querySelector('.preview-article h2')?.textContent === '自动保存');
	assert.match(await fs.readFile(path.join(fixture.root, 'src/content/blog', `${slug}.md`), 'utf8'), /实时预览与自动保存正文/);
	await page.locator('.editor-pane-main input[type="file"]').setInputFiles({ name: '编辑器图片.png', mimeType: 'image/png', buffer: Buffer.from(PNG_1PX, 'base64') });
	await page.waitForFunction(() => Boolean(document.querySelector('.preview-article img')));
	await page.waitForFunction(() => document.querySelector('.save-state')?.textContent?.includes('已保存'), null, { timeout: 8000 });
	assert.match(await fs.readFile(path.join(fixture.root, 'src/content/blog', `${slug}.md`), 'utf8'), /assets\/publisher\/.*\/编辑器图片\.png/);
	await page.screenshot({ path: 'test-results/publisher-editor.png', fullPage: true });
	await page.reload();
	await page.waitForSelector('.cm-content');
	assert.match(await page.locator('.cm-content').innerText(), /实时预览与自动保存正文/);

	await page.locator('.side-nav a[href="#/import"]').click();
	await page.waitForSelector('input[accept=".md,.markdown"]', { state: 'attached' });
	const note = `---
title: "界面导入的中文笔记"
tags: [写作]
category: 技术实践
---
关联 [[已有笔记]]。

![[界面图片.png]]
`;
	await page.locator('input[accept=".md,.markdown"]').setInputFiles({ name: '界面导入.md', mimeType: 'text/markdown', buffer: Buffer.from(note) });
	await page.locator('input[accept="image/*"]').setInputFiles({ name: '界面图片.png', mimeType: 'image/png', buffer: Buffer.from(PNG_1PX, 'base64') });
	await page.waitForSelector('.import-select');
	await page.locator('button', { hasText: '分析并预览导入' }).click();
	await page.waitForSelector('.import-preview');
	assert.match(await page.locator('.import-preview').innerText(), /关联/);
	await page.locator('button', { hasText: '导入为本地草稿' }).click();
	await page.waitForURL(/#\/edit\//);
	await page.waitForSelector('.cm-content');
	assert.match(await page.locator('.cm-content').innerText(), /已有笔记/);

	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto(base + '/#/');
	await page.waitForSelector('.data-table');
	const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
	assert.ok(overflow <= 1, `mobile horizontal overflow: ${overflow}px`);
	await expectVisible(page, '.publisher-mobile-nav');
	await page.screenshot({ path: 'test-results/publisher-mobile.png', fullPage: true });
	assert.deepEqual(errors, []);
});

async function expectVisible(page, selector) {
	assert.equal(await page.locator(selector).isVisible(), true, `${selector} should be visible`);
}
