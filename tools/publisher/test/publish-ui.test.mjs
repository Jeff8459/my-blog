import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { makeFixture, runGit } from './helpers.mjs';
import { createPublisherServer } from '../server.mjs';

test('发布确认界面展示构建、差异、推送和部署核验', async (t) => {
	const fixture = await makeFixture();
	const app = await createPublisherServer({
		root: fixture.root,
		token: 'publish-ui-token',
		buildRunner: async () => ({ ok: true, output: 'Astro build complete\nPagefind indexed 1 page', durationMs: 18, exitCode: 0 }),
		deployVerifier: async () => ({ status: 'deployed', detail: 'mock production match', httpStatus: 200 }),
	});
	const address = await app.listen(0);
	const base = `http://127.0.0.1:${address.port}`;
	const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
	t.after(async () => {
		await browser.close();
		await app.close();
		await fixture.cleanup();
	});
	const created = await fetch(base + '/api/articles', {
		method: 'POST',
		headers: { 'x-publisher-token': app.token, 'content-type': 'application/json' },
		body: JSON.stringify({ slug: 'publish-ui', title: '界面发布确认', description: '验证完整发布流程。', category: 'technology', tags: ['workflow'], body: '## 发布正文\n\n这是发布检查内容。' }),
	});
	assert.equal(created.status, 201);
	const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
	const errors = [];
	page.on('pageerror', (error) => errors.push(error.message));
	page.on('dialog', (dialog) => dialog.accept());
	await page.goto(`${base}/#/publish/publish-ui`);
	await page.locator('button', { hasText: '运行发布检查' }).waitFor();
	await page.locator('button', { hasText: '运行发布检查' }).click();
	await page.waitForSelector('.result-banner.success');
	await page.waitForSelector('.file-list li');
	assert.equal(await page.locator('.loading-state').count(), 0);
	assert.match(await page.locator('.file-list').innerText(), /publish-ui\.md/);
	await page.locator('details.build-log summary', { hasText: '查看本次文本差异' }).click();
	assert.match(await page.locator('details.build-log .diff-view').innerText(), /\+## 发布正文/);
	await page.locator('details.build-log summary', { hasText: '查看构建日志' }).click();
	assert.match(await page.locator('details.build-log pre').last().innerText(), /Astro build complete/);
	await fs.mkdir('test-results', { recursive: true });
	await page.screenshot({ path: 'test-results/publisher-publish-check.png', fullPage: true });
	await page.locator('button', { hasText: '确认发布到 main' }).click();
	await page.waitForSelector('text=已推送 GitHub');
	await page.waitForSelector('text=线上部署已核验', { timeout: 15000 });
	const remoteHead = await runGit(`${fixture.root}/../${fixture.root.split('/').pop()}-remote.git`, ['rev-parse', 'refs/heads/main']);
	assert.match(remoteHead, /^[0-9a-f]{40}$/);
	await page.screenshot({ path: 'test-results/publisher-published.png', fullPage: true });
	assert.deepEqual(errors, []);
});
