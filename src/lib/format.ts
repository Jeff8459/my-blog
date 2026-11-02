export function formatDate(date: Date) {
	return new Intl.DateTimeFormat('zh-CN', {
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
	}).format(date).replaceAll('/', '.');
}

export function formatYear(date: Date) {
	return new Intl.DateTimeFormat('zh-CN', { year: 'numeric' }).format(date);
}
