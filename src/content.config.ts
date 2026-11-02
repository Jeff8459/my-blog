import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';
import { categorySlugs, tagSlugs } from './config/taxonomy';
import { site } from './config/site';

const blog = defineCollection({
	loader: glob({ base: './src/content/blog', pattern: '**/*.{md,mdx}' }),
	schema: ({ image }) =>
		z.object({
			title: z.string().min(1),
			description: z.string().min(1).max(180),
			pubDate: z.coerce.date(),
			updatedDate: z.coerce.date().optional(),
			category: z.enum(categorySlugs).default('technology'),
			tags: z.array(z.enum(tagSlugs)).default([]),
			cover: image().optional(),
			coverAlt: z.string().optional(),
			// 兼容 Blog Starter 的 heroImage 字段。
			heroImage: image().optional(),
			featured: z.boolean().default(false),
			draft: z.boolean().default(false),
			demo: z.boolean().default(false),
			author: z.string().default(site.author.name),
			seoTitle: z.string().optional(),
			seoDescription: z.string().max(180).optional(),
		}),
});

export const collections = { blog };
