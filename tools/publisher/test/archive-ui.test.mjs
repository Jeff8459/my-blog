import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { makeFixture, runGit } from './helpers.mjs';
import { createPublisherServer } from '../server.mjs';

test('归档与恢复在界面走完整的检查、推送与线上核验流程', async (t) => {
	const fixture = await makeFixture();
	const app = await createPublisherServer({
		root: fixture.root,
		token: 'archive-ui-token',
		buildRunner: async () => ({ ok: true, output: 'Astro build complete\nPagefind indexed 1 page', durationMs: 15, exitCode: 0 }),
		deployVerifier: async () => ({ status: 'deployed', detail: 'mock production match', httpStatus: 200 }),
		removalVerifier: async () => ({ status: 'deployed', detail: 'mock removal', httpStatus: 404 }),
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
	page.on('pageerror', (error) => errors.push(error.message));
	page.on('dialog', (dialog) => dialog.accept());

	// 文章列表 → 归档确认页
	await page.goto(`${base}/#/`);
	await page.locator('.data-table tbody tr').first().waitFor();
	await page.locator('button', { hasText: '归档' }).first().click();
	await page.waitForFunction(() => location.hash === '#/archive/existing-note');
	await page.locator('h1', { hasText: '归档确认' }).waitFor();
	assert.equal(await page.locator('.publish-steps li').count(), 4);

	// 标题确认与检查
	const checkButton = page.locator('button', { hasText: '运行归档检查' });
	await checkButton.click();
	assert.match(await page.locator('.toast').innerText(), /请输入完整文章标题/);
	await page.locator('input[aria-label="输入完整文章标题以确认归档"]').fill('已有笔记');
	await checkButton.click();
	await page.waitForSelector('.result-banner.success');
	const files = await page.locator('.file-list').innerText();
	assert.match(files, /src\/content\/blog\/existing-note\.md/);
	assert.match(files, /src\/content\/archive\/existing-note\.md/);
	assert.match(await page.locator('.warning-list').innerText(), /归档后这些链接会失效|图片仍保留/);
	await page.screenshot({ path: 'test-results/publisher-archive-check.png', fullPage: true });

	// 确认归档并推送
	await page.locator('button', { hasText: '确认归档并推送 main' }).click();
	await page.waitForSelector('text=已推送 GitHub');
	await page.waitForSelector('text=线上归档已核验', { timeout: 15000 });
	assert.match(await page.locator('.kv').last().innerText(), /main → origin\/main/);
	await page.screenshot({ path: 'test-results/publisher-archived.png', fullPage: true });
	await assert.rejects(() => fs.access(path.join(fixture.root, 'src/content/blog/existing-note.md')));
	assert.ok(await fs.access(path.join(fixture.root, 'src/content/archive/existing-note.md')).then(() => true));
	assert.match(await runGit(fixture.root, ['show', '--pretty=format:', '--name-status', '--no-renames', 'HEAD']), /D\tsrc\/content\/blog\/existing-note\.md/);

	// 归档列表 → 恢复
	await page.goto(`${base}/?reload=${Date.now()}#/archives`);
	await page.locator('.data-table.archives tbody tr').first().waitFor();
	assert.match(await page.locator('.data-table.archives').innerText(), /已有笔记/);
	await page.locator('.data-table.archives a', { hasText: '恢复' }).first().click();
	await page.waitForFunction(() => location.hash === '#/restore/existing-note');
	await page.locator('h1', { hasText: '恢复确认' }).waitFor();
	await page.locator('button', { hasText: '运行恢复检查' }).click();
	await page.waitForSelector('.result-banner.success');
	await page.locator('button', { hasText: '确认恢复并推送 main' }).click();
	await page.waitForSelector('text=已推送 GitHub');
	await page.waitForSelector('text=线上部署已核验', { timeout: 15000 });
	assert.ok(await fs.access(path.join(fixture.root, 'src/content/blog/existing-note.md')).then(() => true));

	// 移动端：五个导航项且无横向溢出
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto(`${base}/?reload=${Date.now()}#/archives`);
	await page.locator('.data-table.archives tbody tr').first().waitFor();
	const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
	assert.ok(overflow <= 1, `mobile horizontal overflow: ${overflow}px`);
	assert.equal(await page.locator('.publisher-mobile-nav a').count(), 5);
	assert.deepEqual(errors, []);
});
