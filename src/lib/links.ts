import { site } from '../config/site';
import type { BlogPost } from './content';

export interface LinkGraph {
	outgoing: Map<string, Set<string>>;
	backlinks: Map<string, Set<string>>;
}

/** 从 Markdown / MDX 正文提取站内文章引用，并把相对路径、锚点和尾斜杠统一为文章 id。 */
function extractLinks(body: string, currentId: string, publishedIds: Set<string>) {
	const targets = new Set<string>();
	const hrefs: string[] = [];
	const markdownLink = /(?<!!)\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+["'][^"']*["'])?\s*\)/g;
	const htmlLink = /<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>/gi;
	for (const match of body.matchAll(markdownLink)) hrefs.push(match[1]);
	for (const match of body.matchAll(htmlLink)) hrefs.push(match[1]);

	for (const href of hrefs) {
		if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:')) continue;
		try {
			const decoded = decodeURIComponent(href.replaceAll('&amp;', '&'));
			const base = new URL(`/blog/${currentId}/`, site.url);
			const resolved = new URL(decoded, base);
			if (resolved.host !== new URL(site.url).host) continue;
			const segments = resolved.pathname.split('/').filter(Boolean);
			if (segments[0] !== 'blog' || !segments[1]) continue;
			const id = segments[1].replace(/\.mdx?$/i, '');
			if (id !== currentId && publishedIds.has(id)) targets.add(id);
		} catch {
			// 非法链接不影响构建，也不会进入关系索引。
		}
	}
	return targets;
}

export function buildLinkGraph(posts: BlogPost[]): LinkGraph {
	const publishedIds = new Set(posts.map((post) => post.id));
	const outgoing = new Map<string, Set<string>>();
	const backlinks = new Map<string, Set<string>>();
	for (const post of posts) {
		outgoing.set(post.id, extractLinks(post.body ?? '', post.id, publishedIds));
		backlinks.set(post.id, new Set());
	}
	for (const [source, targets] of outgoing) {
		for (const target of targets) backlinks.get(target)?.add(source);
	}
	return { outgoing, backlinks };
}

export function getBacklinks(postId: string, posts: BlogPost[], graph: LinkGraph) {
	const ids = graph.backlinks.get(postId) ?? new Set<string>();
	return posts.filter((post) => ids.has(post.id));
}

export function getRelatedPosts(current: BlogPost, posts: BlogPost[], graph: LinkGraph, limit = 5) {
	const outgoing = graph.outgoing.get(current.id) ?? new Set<string>();
	const backlinks = graph.backlinks.get(current.id) ?? new Set<string>();
	return posts
		.filter((post) => post.id !== current.id)
		.map((post) => {
			const sharedTags = post.data.tags.filter((tag) => current.data.tags.includes(tag)).length;
			const relation = outgoing.has(post.id) ? 120 : backlinks.has(post.id) ? 100 : 0;
			const category = post.data.category === current.data.category ? 3 : 0;
			return {
				post,
				score: relation + sharedTags * 12 + category,
				explicit: relation > 0,
			};
		})
		.filter(({ score }) => score > 0)
		.sort((a, b) =>
			b.score - a.score ||
			Number(b.explicit) - Number(a.explicit) ||
			b.post.data.pubDate.valueOf() - a.post.data.pubDate.valueOf(),
		)
		.slice(0, limit)
		.map(({ post }) => post);
}
