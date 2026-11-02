import rss from '@astrojs/rss';
import { site } from '../config/site';
import { getPublishedPosts } from '../lib/content';

export async function GET(context) {
	const posts = await getPublishedPosts();
	return rss({
		title: `${site.name}｜${site.tagline}`,
		description: site.description,
		site: context.site ?? site.url,
		items: posts.map((post) => ({
			title: post.data.title,
			description: post.data.description,
			pubDate: post.data.pubDate,
			link: `/blog/${post.id}/`,
			author: post.data.author,
			categories: [post.data.category, ...post.data.tags],
		})),
		customData: `<language>zh-CN</language>`,
	});
}
