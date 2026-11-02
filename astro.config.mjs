// @ts-check
import mdx from '@astrojs/mdx';
import sitemap from '@astrojs/sitemap';
import { defineConfig } from 'astro/config';

export default defineConfig({
	site: 'https://my-blog-2hf.pages.dev/',
	integrations: [
		mdx(),
		sitemap({
			filter: (page) => !page.includes('/search') && !page.includes('/404'),
		}),
	],
	markdown: {
		shikiConfig: {
			themes: { light: 'github-light', dark: 'github-dark' },
			defaultColor: false,
		},
	},
});
