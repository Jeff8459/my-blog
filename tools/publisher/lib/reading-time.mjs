export function getReadingTime(body = '') {
	const text = String(body)
		.replace(/```[\s\S]*?```/g, ' ')
		.replace(/<[^>]*>/g, ' ')
		.replace(/!?\[[^\]]*\]\([^)]*\)/g, ' ');
	const chineseCharacters = (text.match(/[\u3400-\u9fff]/g) ?? []).length;
	const latinWords = (text.match(/[a-zA-Z0-9]+/g) ?? []).length;
	return Math.max(1, Math.ceil(chineseCharacters / 400 + latinWords / 200));
}
