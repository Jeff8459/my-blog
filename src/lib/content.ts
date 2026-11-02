import { getCollection, type CollectionEntry } from 'astro:content';

export type BlogPost = CollectionEntry<'blog'>;

export async function getPublishedPosts(): Promise<BlogPost[]> {
	const posts = await getCollection('blog', ({ data }) => !data.draft);
	return posts.sort((a, b) => b.data.pubDate.valueOf() - a.data.pubDate.valueOf());
}

export async function getFeaturedPost(posts?: BlogPost[]) {
	const allPosts = posts ?? (await getPublishedPosts());
	return allPosts.find((post) => post.data.featured) ?? allPosts[0];
}

export async function getPostsByCategory(category: string, posts?: BlogPost[]) {
	return (posts ?? (await getPublishedPosts())).filter((post) => post.data.category === category);
}

export async function getPostsByTag(tag: string, posts?: BlogPost[]) {
	return (posts ?? (await getPublishedPosts())).filter((post) => post.data.tags.includes(tag as never));
}

export function getRelatedPosts(current: BlogPost, posts: BlogPost[], limit = 3) {
	return posts
		.filter((post) => post.id !== current.id)
		.map((post) => ({
			post,
			score:
				(post.data.category === current.data.category ? 3 : 0) +
				post.data.tags.filter((tag) => current.data.tags.includes(tag)).length,
		}))
		.filter(({ score }) => score > 0)
		.sort((a, b) => b.score - a.score || b.post.data.pubDate.valueOf() - a.post.data.pubDate.valueOf())
		.slice(0, limit)
		.map(({ post }) => post);
}

export function getAdjacentPosts(current: BlogPost, posts: BlogPost[]) {
	const index = posts.findIndex((post) => post.id === current.id);
	return {
		newer: index > 0 ? posts[index - 1] : undefined,
		older: index >= 0 && index < posts.length - 1 ? posts[index + 1] : undefined,
	};
}

export function paginate<T>(items: T[], page: number, perPage: number) {
	const pageCount = Math.max(1, Math.ceil(items.length / perPage));
	return {
		items: items.slice((page - 1) * perPage, page * perPage),
		page,
		pageCount,
	};
}
