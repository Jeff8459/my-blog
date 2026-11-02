import { site } from '../../../src/config/site.ts';
import { categories, tags } from '../../../src/config/taxonomy.ts';

export { categories, tags, site };

export function normaliseCategory(value) {
	const target = String(value || '').trim();
	return categories.find((category) => category.slug === target || category.name === target)?.slug ?? null;
}

export function normaliseTag(value) {
	const target = String(value || '').trim().replace(/^#/, '');
	return tags.find((tag) => tag.slug === target || tag.name === target)?.slug ?? null;
}

export function categoryName(slug) {
	return categories.find((category) => category.slug === slug)?.name ?? slug;
}

export function tagName(slug) {
	return tags.find((tag) => tag.slug === slug)?.name ?? slug;
}
