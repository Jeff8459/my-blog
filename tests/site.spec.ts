import { test, expect } from '@playwright/test';

const routes = ['/', '/blog/', '/categories/', '/categories/ai/', '/tags/critical-thinking/', '/topics/', '/topics/better-thinking/', '/about/', '/search/'];

test('主要路由、标题、语言与 canonical 正常', async ({ page }) => {
	for (const route of routes) {
		const response = await page.goto(route);
		expect(response?.status(), route).toBe(200);
		await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
		await expect(page.locator('title')).not.toBeEmpty();
		await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', `https://my-blog-2hf.pages.dev${route}`);
	}
});

test('文章阅读器包含目录、代码复制、相关文章与 SEO', async ({ page }) => {
	await page.goto('/blog/markdown-style-guide/');
	await expect(page.locator('h1')).toHaveText('中文博客 Markdown 排版示例');
	await expect(page.locator('.desktop-toc a')).not.toHaveCount(0);
	await expect(page.locator('.code-copy').first()).toBeVisible();
	await expect(page.locator('.related-grid article')).not.toHaveCount(0);
	expect(await page.locator('script[type="application/ld+json"]').textContent()).toContain('BlogPosting');
	await expect(page.locator('meta[property="article:published_time"]')).toHaveCount(1);
	await page.locator('.code-copy').first().click();
	await expect(page.locator('.code-copy').first()).toHaveText('已复制');
});

test('Pagefind 中文搜索、高亮、摘要与无结果状态正常', async ({ page }) => {
	await page.goto('/search/');
	const input = page.locator('#search-input');
	await expect(input).toBeVisible();
	await input.fill('判断力');
	await expect(page.locator('.search-result-link').first()).toBeVisible();
	await expect(page.locator('.search-result-link').first()).toContainText('人工智能时代');
	await expect(page.locator('.search-result-excerpt').first()).not.toBeEmpty();
	await expect(page.locator('.search-result-excerpt mark').first()).toBeVisible();
	await input.fill('zzqxy98765');
	await expect(page.locator('#search-status')).toContainText('没有找到');
	await expect(page.locator('.search-result-link')).toHaveCount(0);
});

test('主题三选项、持久化和系统跟随正常', async ({ page }) => {
	await page.goto('/');
	await page.locator('.theme-menu summary').click();
	await page.locator('[data-theme-choice="dark"]').click();
	await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
	await page.reload();
	await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
	await page.locator('.theme-menu summary').click();
	await page.locator('[data-theme-choice="light"]').click();
	await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
	await page.locator('.theme-menu summary').click();
	await page.locator('[data-theme-choice="system"]').click();
	await expect(page.locator('html')).toHaveAttribute('data-theme-preference', 'system');
});

test('移动端菜单键盘状态与 404 正常', async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto('/');
	const toggle = page.locator('.menu-toggle');
	await toggle.click();
	await expect(toggle).toHaveAttribute('aria-expanded', 'true');
	await expect(page.locator('#primary-navigation')).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(toggle).toHaveAttribute('aria-expanded', 'false');
	const response = await page.goto('/this-page-does-not-exist/');
	expect(response?.status()).toBe(404);
	await expect(page.locator('h1')).toHaveText('这一页，暂时空白。');
});

for (const width of [360, 390, 768, 1024, 1440]) {
	test(`${width}px 首页、归档和文章无横向溢出`, async ({ page }) => {
		await page.setViewportSize({ width, height: 900 });
		for (const route of ['/', '/blog/', '/blog/markdown-style-guide/']) {
			await page.goto(route);
			const dimensions = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
			expect(dimensions.scroll, `${route} at ${width}px`).toBeLessThanOrEqual(dimensions.client + 1);
		}
	});
}

test('RSS、Sitemap 与 robots 只发布正式内容', async ({ request }) => {
	const rss = await request.get('/rss.xml');
	expect(rss.status()).toBe(200);
	const rssText = await rss.text();
	expect(rssText.match(/<item>/g)).toHaveLength(6);
	expect(rssText).toContain('人工智能时代，如何保留判断力');
	const sitemap = await request.get('/sitemap-0.xml');
	const sitemapText = await sitemap.text();
	expect(sitemapText).toContain('/blog/second-post/');
	expect(sitemapText).not.toContain('/search/');
	const robots = await request.get('/robots.txt');
	expect(await robots.text()).toContain('sitemap-index.xml');
});

test('保存桌面、深色和移动端视觉验收截图', async ({ page }) => {
	await page.goto('/');
	await page.screenshot({ path: 'test-results/home-desktop.png', fullPage: true });
	await page.locator('.theme-menu summary').click();
	await page.locator('[data-theme-choice="dark"]').click();
	await page.screenshot({ path: 'test-results/home-dark.png', fullPage: true });
	await page.goto('/blog/second-post/');
	await page.screenshot({ path: 'test-results/article-dark.png', fullPage: true });
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto('/');
	await page.screenshot({ path: 'test-results/home-mobile.png', fullPage: true });
});
