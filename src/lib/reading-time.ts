export function getReadingTime(body = '') {
	const text = body
		.replace(/^---[\s\S]*?---/, '')
		.replace(/```[\s\S]*?```/g, ' ')
		.replace(/<[^>]*>/g, ' ')
		.replace(/!?\[[^\]]*\]\([^)]*\)/g, ' ');
	const chineseCharacters = (text.match(/[\u3400-\u9fff]/g) ?? []).length;
	const latinWords = (text.match(/[a-zA-Z0-9]+/g) ?? []).length;
	const minutes = Math.ceil(chineseCharacters / 400 + latinWords / 200);
	return Math.max(1, minutes);
}
