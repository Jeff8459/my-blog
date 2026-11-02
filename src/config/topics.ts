export interface Topic {
	slug: string;
	title: string;
	englishTitle: string;
	description: string;
	posts: string[];
}

// 专题是跨分类的编辑策划，按文章稳定 slug 显式编排。
export const topics: Topic[] = [
	{
		slug: 'better-thinking',
		title: '更好地思考',
		englishTitle: 'BETTER THINKING',
		description: '在信息与技术加速变化时，练习判断、表达与复盘。',
		posts: ['second-post', 'first-post', 'third-post'],
	},
	{
		slug: 'publishing-notes',
		title: '写作与发布',
		englishTitle: 'ON PUBLISHING',
		description: '从一段文字到一篇文章：内容组织、排版与静态发布。',
		posts: ['markdown-style-guide', 'using-mdx', 'reading-notes-demo'],
	},
];

export const getTopic = (slug: string) => topics.find((topic) => topic.slug === slug);
