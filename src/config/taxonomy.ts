export const categories = [
	{ slug: 'ai', name: '人工智能', description: '模型、工具，以及技术变化中的判断。' },
	{ slug: 'technology', name: '技术实践', description: '可复用的方法、工具与工程经验。' },
	{ slug: 'systems', name: '系统开发', description: '架构、实现与长期维护中的取舍。' },
	{ slug: 'management', name: '管理思考', description: '协作、决策，以及如何让事情发生。' },
	{ slug: 'reading', name: '阅读随笔', description: '从阅读与日常观察中整理认知。' },
] as const;

export const tags = [
	{ slug: 'artificial-intelligence', name: '人工智能' },
	{ slug: 'critical-thinking', name: '独立思考' },
	{ slug: 'workflow', name: '工作方法' },
	{ slug: 'writing', name: '写作' },
	{ slug: 'astro', name: 'Astro' },
	{ slug: 'markdown', name: 'Markdown' },
	{ slug: 'reading-notes', name: '读书笔记' },
	{ slug: 'demo', name: '排版演示' },
] as const;

export const categorySlugs = categories.map((category) => category.slug) as [
	(typeof categories)[number]['slug'],
	...(typeof categories)[number]['slug'][],
];
export const tagSlugs = tags.map((tag) => tag.slug) as [
	(typeof tags)[number]['slug'],
	...(typeof tags)[number]['slug'][],
];

export type CategorySlug = (typeof categories)[number]['slug'];
export type TagSlug = (typeof tags)[number]['slug'];

export const getCategory = (slug: string) =>
	categories.find((category) => category.slug === slug) ?? categories[1];
export const getTag = (slug: string) => tags.find((tag) => tag.slug === slug);
