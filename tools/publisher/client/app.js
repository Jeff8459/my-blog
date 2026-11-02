import { basicSetup } from 'codemirror';
import { EditorView } from '@codemirror/view';
import { markdown } from '@codemirror/lang-markdown';
import MarkdownIt from 'markdown-it';

const TOKEN = document.querySelector('meta[name="publisher-token"]')?.getAttribute('content') ?? '';
const viewRoot = document.getElementById('view');
const toastNode = document.querySelector('[data-toast]');
const state = {
	bootstrap: null,
	editor: null,
	importPool: [],
	importAnalysis: null,
	dirty: false,
	saving: false,
	saveTimer: null,
	toastTimer: null,
	routeCleanup: null,
};

const md = new MarkdownIt({ html: false, linkify: true, typographer: true });
const defaultImage = md.renderer.rules.image;
md.renderer.rules.image = (tokens, index, options, env, self) => {
	const token = tokens[index];
	const source = token.attrGet('src');
	if (source) token.attrSet('src', env?.resolveImage ? env.resolveImage(source) : source);
	token.attrSet('loading', 'lazy');
	return defaultImage ? defaultImage(tokens, index, options, env, self) : self.renderToken(tokens, index, options);
};

function element(tag, attributes = {}, ...children) {
	const node = document.createElement(tag);
	for (const [key, value] of Object.entries(attributes || {})) {
		if (value === undefined || value === null || value === false) continue;
		if (key === 'class') node.className = value;
		else if (key === 'text') node.textContent = value;
		else if (key === 'html') node.innerHTML = value;
		else if (/^on[a-z]/i.test(key) && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
		else if (key === 'dataset') Object.assign(node.dataset, value);
		else if (key in node && key !== 'list') node[key] = value;
		else node.setAttribute(key, value === true ? '' : value);
	}
	for (const child of children.flat(Infinity)) {
		if (child === null || child === undefined || child === false) continue;
		node.append(child instanceof Node ? child : document.createTextNode(String(child)));
	}
	return node;
}

function clear(node) {
	while (node.firstChild) node.removeChild(node.firstChild);
}

function showToast(message, type = 'info') {
	toastNode.textContent = message;
	toastNode.className = `toast show ${type === 'error' ? 'error' : ''}`;
	clearTimeout(state.toastTimer);
	state.toastTimer = setTimeout(() => { toastNode.className = 'toast'; }, 3200);
}

async function api(url, options = {}) {
	const headers = new Headers(options.headers || {});
	headers.set('x-publisher-token', TOKEN);
	let body = options.body;
	if (body !== undefined && !(body instanceof Blob) && !(body instanceof ArrayBuffer) && typeof body !== 'string') {
		headers.set('content-type', 'application/json');
		body = JSON.stringify(body);
	}
	const response = await fetch(url, { ...options, headers, body });
	let data = {};
	try { data = await response.json(); } catch { /* 空响应 */ }
	if (!response.ok) {
		const error = new Error(data.error || `请求失败（HTTP ${response.status}）`);
		error.details = data.details;
		error.status = response.status;
		throw error;
	}
	return data;
}

function mediaUrl(path) {
	return `/api/media?token=${encodeURIComponent(TOKEN)}&path=${encodeURIComponent(path)}`;
}

function resolveEditorImage(source) {
	if (!source || /^(https?:|data:|blob:|\/api\/)/i.test(source)) return source;
	let decoded = source;
	try { decoded = decodeURIComponent(source); } catch { /* 保留原始路径 */ }
	let clean = decoded.startsWith('/') ? `public/${decoded.slice(1)}` : `src/content/blog/${decoded}`;
	const parts = [];
	for (const segment of clean.split('/')) {
		if (!segment || segment === '.') continue;
		if (segment === '..') parts.pop();
		else parts.push(segment);
	}
	return mediaUrl(parts.join('/'));
}

function renderPreviewHtml(body, metadata, options = {}) {
	const resolver = options.resolveImage ?? resolveEditorImage;
	const html = md.render(String(body || ''), { resolveImage: resolver });
	const wrap = element('div', { class: 'preview-article' });
	if (options.showHeader !== false) {
		wrap.append(element('header', { class: 'preview-meta' },
			element('p', { class: 'page-label', text: metadata?.categoryName || 'PREVIEW' }),
			element('h1', { text: metadata?.title || '未命名文章' }),
			metadata?.description ? element('p', { text: metadata.description }) : null,
		));
	}
	const prose = element('div', { class: 'prose', html });
	wrap.append(prose);
	prose.querySelectorAll('a[href^="/blog/"]').forEach((link) => {
		link.title = '在新窗口打开线上文章';
		link.target = '_blank';
		link.rel = 'noopener';
		link.href = `${state.bootstrap?.site?.url?.replace(/\/$/, '') || ''}${link.getAttribute('href')}`;
	});
	return wrap;
}

function formatDate(value) {
	if (!value) return '—';
	const date = new Date(value);
	if (Number.isNaN(date.valueOf())) return String(value);
	return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(date).replaceAll('/', '.');
}

function formatDateTime(value) {
	if (!value) return '—';
	const date = new Date(value);
	if (Number.isNaN(date.valueOf())) return String(value);
	return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(date).replaceAll('/', '.');
}

function setHeaderState() {
	const target = document.querySelector('[data-git-header]');
	if (!state.bootstrap) return;
	const { git, counts } = state.bootstrap;
	target.textContent = `${git.branch}@${git.head.slice(0, 7)} · ${counts.drafts} 草稿`;
	document.querySelectorAll('[data-site-link]').forEach((link) => { link.href = state.bootstrap.site.url; });
	if (!state.bootstrap.runtime.supported) showToast(`当前 ${state.bootstrap.runtime.node} 低于 Astro 要求，生产构建可能失败。`, 'error');
}

function activeNav(name) {
	document.querySelectorAll('[data-nav]').forEach((link) => link.classList.toggle('active', link.dataset.nav === name));
}

function pageHeader(label, title, description, actions = []) {
	return element('header', { class: 'page-head' },
		element('div', {}, element('p', { class: 'page-label', text: label }), element('h1', { text: title }), description ? element('p', { text: description }) : null),
		element('div', { class: 'page-actions' }, ...actions),
	);
}

function statusPill(text, tone) {
	return element('span', { class: `status ${tone}`, text });
}

function button(label, options = {}) {
	return element('button', {
		type: 'button',
		class: `button ${options.primary ? 'primary' : ''} ${options.ghost ? 'ghost' : ''} ${options.small ? 'small' : ''} ${options.danger ? 'danger' : ''}`.trim(),
		onclick: options.onClick,
		disabled: options.disabled,
		text: label,
	});
}

function linkButton(label, href, options = {}) {
	return element('a', { class: `button ${options.primary ? 'primary' : ''} ${options.ghost ? 'ghost' : ''} ${options.small ? 'small' : ''}`.trim(), href, target: options.external ? '_blank' : undefined, rel: options.external ? 'noopener' : undefined, text: label });
}

async function refreshBootstrap() {
	state.bootstrap = await api('/api/bootstrap');
	setHeaderState();
	return state.bootstrap;
}

function applyTheme() {
	const saved = localStorage.getItem('publisher-theme');
	const systemDark = matchMedia('(prefers-color-scheme: dark)').matches;
	document.documentElement.dataset.theme = saved === 'dark' || (!saved && systemDark) ? 'dark' : 'light';
}

function route() {
	if (state.routeCleanup) { state.routeCleanup(); state.routeCleanup = null; }
	state.editor = null;
	state.importAnalysis = null;
	const hash = location.hash.replace(/^#/, '') || '/';
	document.querySelectorAll('[data-nav]').forEach((link) => link.classList.remove('active'));
	if (hash === '/') renderDashboard();
	else if (hash === '/new') renderNew();
	else if (hash === '/import') renderImport();
	else if (hash === '/archives') renderArchives();
	else if (hash === '/history') renderHistory();
	else if (hash.startsWith('/edit/')) renderEditor(decodeURIComponent(hash.slice(6)));
	else if (hash.startsWith('/publish/')) renderPublish(decodeURIComponent(hash.slice(9)));
	else if (hash.startsWith('/archive/')) renderMove('archive', decodeURIComponent(hash.slice(9)));
	else if (hash.startsWith('/restore/')) renderMove('restore', decodeURIComponent(hash.slice(9)));
	else renderDashboard();
}

function renderLoading(text = '正在读取文章…') {
	clear(viewRoot);
	viewRoot.append(element('div', { class: 'loading-state', text }));
}

function renderDashboard() {
	activeNav('dashboard');
	clear(viewRoot);
	if (!state.bootstrap) return;
	const filters = { query: '', status: 'all', category: 'all' };
	const total = state.bootstrap.counts.total;
	const body = element('div', {});
	viewRoot.append(
		pageHeader('LIBRARY / ALL NOTES', '文章管理', '在本地管理草稿、正式文章与发布状态。', [
			linkButton('导入 Obsidian', '#/import'),
			linkButton('新建文章', '#/new', { primary: true }),
		]),
		element('div', { class: 'stat-strip' },
			element('span', {}, '共 ', element('strong', { text: String(total) }), ' 篇'),
			element('span', {}, '草稿 ', element('strong', { text: String(state.bootstrap.counts.drafts) })),
			element('span', {}, '归档 ', element('strong', { text: String(state.bootstrap.counts.archived ?? 0) })),
			element('span', {}, 'Git ', element('strong', { text: `${state.bootstrap.git.branch} / ${state.bootstrap.git.changeCount} 项变更` })),
		),
		element('div', { class: 'toolbar' },
			element('input', { type: 'search', placeholder: '搜索标题、slug 或标签…', 'aria-label': '搜索文章', oninput: (event) => { filters.query = event.target.value.toLowerCase(); renderRows(); } }),
			element('select', { 'aria-label': '按状态筛选', onchange: (event) => { filters.status = event.target.value; renderRows(); } },
				element('option', { value: 'all', text: '全部状态' }), element('option', { value: 'draft', text: '草稿' }), element('option', { value: 'published', text: '正式文章' })),
			element('select', { 'aria-label': '按分类筛选', onchange: (event) => { filters.category = event.target.value; renderRows(); } },
				element('option', { value: 'all', text: '全部分类' }), ...state.bootstrap.categories.map((category) => element('option', { value: category.slug, text: category.name }))),
		),
		body,
	);
	const tableWrap = element('div', { class: 'data-table-wrap' });
	const table = element('table', { class: 'data-table' });
	table.append(element('thead', {}, element('tr', {},
		element('th', { text: '标题' }), element('th', { text: '分类' }), element('th', { text: '标签' }),
		element('th', { text: '更新' }), element('th', { text: '状态' }), element('th', { text: 'Git' }), element('th', { text: '操作' }),
	)));
	const tbody = element('tbody');
	table.append(tbody);
	tableWrap.append(table);
	body.append(tableWrap);
	function renderRows() {
		clear(tbody);
		const list = state.bootstrap.articles.filter((article) => {
			const haystack = `${article.title} ${article.slug} ${article.tags.map((tag) => tag.name).join(' ')}`.toLowerCase();
			return (!filters.query || haystack.includes(filters.query))
				&& (filters.status === 'all' || (filters.status === 'draft' ? article.draft : !article.draft))
				&& (filters.category === 'all' || article.category === filters.category);
		});
		if (!list.length) {
			const cell = element('td', { colspan: 7 });
			cell.append(element('div', { class: 'empty-panel' }, element('strong', { text: '没有匹配的文章' }), element('span', { text: '调整筛选条件，或创建一篇新笔记。' })));
			tbody.append(element('tr', {}, cell));
			return;
		}
		for (const article of list) {
			const pushed = article.lastPublish?.pushed;
			tbody.append(element('tr', {},
				element('td', {}, element('a', { class: 'article-title', href: `#/edit/${article.slug}`, text: article.title }), element('div', { class: 'article-sub' }, element('span', { class: 'mono', text: `/${article.slug}/` }), article.lastPublish?.deployment === 'deployed' ? element('span', { text: '线上已核验' }) : null)),
				element('td', { text: article.categoryName || '—' }),
				element('td', {}, element('div', { class: 'tag-list' }, ...(article.tags.length ? article.tags.slice(0, 3).map((tag) => element('span', { class: 'mini-tag', text: tag.name })) : [element('span', { class: 'faint', text: '—' })]))),
				element('td', { class: 'mono' }, element('div', { text: `创建 ${formatDate(article.pubDate)}` }), element('div', { class: 'faint', text: `更新 ${formatDate(article.updatedDate || article.pubDate)}` })),
				element('td', {}, statusPill(
					// 这里只表示内容状态；是否已提交、已推送由 Git 列单独显示，避免把“已提交”说成“已发布”。
					article.draft ? '草稿' : '正式文章',
					article.draft ? 'draft' : 'published',
				)),
				element('td', {}, statusPill(pushed ? '已推送' : article.git.label, article.git.code === 'modified' ? 'local' : pushed ? 'pushed' : article.git.code === 'broken' ? 'failed' : 'local')),
				element('td', {}, element('div', { class: 'row-actions' },
					element('a', { class: 'button small ghost', href: `#/edit/${article.slug}`, text: '编辑' }),
					element('a', { class: 'button small ghost', href: `#/publish/${article.slug}`, text: '发布' }),
					element('button', { type: 'button', class: 'button small ghost', text: '复制', onclick: async () => {
						try { const result = await api(`/api/articles/${article.slug}/copy`, { method: 'POST' }); showToast('副本已创建'); await refreshBootstrap(); location.hash = `#/edit/${result.article.slug}`; }
						catch (error) { showToast(error.message, 'error'); }
					} }),
					element('button', { type: 'button', class: 'button small ghost danger', text: '归档', onclick: () => { location.hash = `#/archive/${article.slug}`; } }),
				)),
			));
		}
	}
	renderRows();
}

function archivedAtLabel(value) {
	return value ? formatDateTime(value) : '—';
}

function renderArchives() {
	activeNav('archives');
	clear(viewRoot);
	const archives = state.bootstrap.archives ?? [];
	const table = element('table', { class: 'data-table archives' });
	table.append(element('thead', {}, element('tr', {},
		element('th', { text: '标题' }), element('th', { text: '分类' }), element('th', { text: '归档时间' }), element('th', { text: '操作' }),
	)));
	const tbody = element('tbody');
	if (!archives.length) {
		tbody.append(element('tr', {}, element('td', { colspan: 4 },
			element('div', { class: 'empty-panel' },
				element('strong', { text: '还没有归档的文章' }),
				element('span', { text: '在文章列表点击「归档」，走完检查与推送后，文章会出现在这里。' }),
			),
		)));
	}
	for (const entry of archives) {
		tbody.append(element('tr', {},
			element('td', {},
				element('a', { class: 'article-title', href: `#/restore/${entry.slug}`, text: entry.title }),
				element('div', { class: 'article-sub' }, element('span', { class: 'mono', text: entry.file }), entry.conflict ? statusPill('同名文章已存在', 'failed') : null),
			),
			element('td', { text: entry.categoryName || '—' }),
			element('td', { class: 'mono', text: archivedAtLabel(entry.archivedAt) }),
			element('td', {}, element('div', { class: 'row-actions' },
				element('a', { class: 'button small ghost', href: `#/restore/${entry.slug}`, text: '恢复' }),
			)),
		));
	}
	table.append(tbody);
	viewRoot.append(
		pageHeader('ARCHIVE / RESTORE', '归档与恢复', '归档只把文件移出 src/content/blog 并保留在 src/content/archive；恢复会沿用原 slug，文章地址不变。', [
			linkButton('文章列表', '#/'),
		]),
		element('div', { class: 'stat-strip' },
			element('span', {}, '归档 ', element('strong', { text: String(archives.length) }), ' 篇'),
			element('span', {}, 'Git ', element('strong', { text: `${state.bootstrap.git.branch}@${state.bootstrap.git.head.slice(0, 7)}` })),
		),
		element('div', { class: 'data-table-wrap' }, table),
	);
}

function renderMove(kind, slug) {
	const isArchive = kind === 'archive';
	activeNav(isArchive ? 'dashboard' : 'archives');
	clear(viewRoot);
	const article = isArchive
		? state.bootstrap.articles.find((item) => item.slug === slug)
		: (state.bootstrap.archives ?? []).find((item) => item.slug === slug);
	if (!article) {
		viewRoot.append(
			pageHeader('NOT FOUND', isArchive ? '找不到这篇文章' : '找不到这篇归档笔记', `没有在本地找到「${slug}」。可能已被移动，请刷新后重试。`),
			linkButton('返回文章列表', '#/'),
		);
		return;
	}
	if (!isArchive && article.conflict) {
		viewRoot.append(
			pageHeader('BLOCKED', '无法恢复', `博客中已存在 /blog/${slug}/，请先归档或重命名同名文章。`),
			linkButton('返回归档列表', '#/archives'),
		);
		return;
	}
	const steps = ['确认与校验', '生产构建', '文件差异', '推送与核验'];
	const stageList = element('ol', { class: 'publish-steps', dataset: { steps: String(steps.length) } },
		...steps.map((step, index) => element('li', { dataset: { step: String(index) }, text: step })));
	const resultArea = element('div', {});
	const siteRoot = state.bootstrap.site.url.replace(/\/$/, '');
	const head = pageHeader(
		isArchive ? 'PUBLISH / ARCHIVE' : 'PUBLISH / RESTORE',
		isArchive ? '归档确认' : '恢复确认',
		isArchive
			? '归档会把文章移出 src/content/blog，并从站点、RSS、Sitemap 和搜索中移除；文件保留在 src/content/archive，可随时恢复。'
			: '恢复会把归档笔记移回 src/content/blog，沿用原 slug，文章地址与站内链接保持不变。',
		[isArchive ? linkButton('返回编辑', `#/edit/${slug}`) : linkButton('返回归档列表', '#/archives'), linkButton('文章列表', '#/')],
	);
	const info = element('section', { class: 'section-panel', style: 'margin-top:0' },
		element('dl', { class: 'kv' },
			element('dt', { text: '标题' }), element('dd', { text: article.title }),
			element('dt', { text: '文章 URL' }), element('dd', {}, element('a', { href: `${siteRoot}/blog/${slug}/`, target: '_blank', rel: 'noopener', text: `/blog/${slug}/` })),
			element('dt', { text: '分类 / 标签' }), element('dd', { text: `${article.categoryName || '—'} · ${article.tags.map((tag) => tag.name).join(', ') || '无标签'}` }),
			isArchive ? element('dt', { text: '保留位置' }) : element('dt', { text: '移回位置' }),
			isArchive ? element('dd', { class: 'mono', text: `src/content/archive/${slug}.md（同名冲突时自动加后缀）` }) : element('dd', { class: 'mono', text: `src/content/blog/${slug}.md` }),
			element('dt', { text: 'Git 分支' }), element('dd', { class: 'mono', text: `${state.bootstrap.git.branch}@${state.bootstrap.git.head.slice(0, 7)}` }),
		),
	);
	const confirmation = element('input', { type: 'text', placeholder: article.title, autocomplete: 'off', 'aria-label': '输入完整文章标题以确认归档' });
	const confirmField = isArchive
		? element('div', { class: 'field', style: 'margin-top:12px' },
			element('label', { text: '输入完整文章标题以确认归档' }),
			confirmation,
			element('span', { class: 'note-hint', text: '这一步只运行检查并移动本地文件；确认推送前可以用「取消并还原」回到原状。' }),
		)
		: element('p', { class: 'note-hint', style: 'margin-top:10px', text: '检查会把笔记移回博客目录并运行真实生产构建；构建失败会自动移回归档目录。' });
	const checkButton = button(isArchive ? '运行归档检查' : '运行恢复检查', { primary: true, onClick: async () => {
		if (isArchive && confirmation.value.trim() !== article.title) {
			showToast('请输入完整文章标题后再运行检查。', 'error');
			confirmation.focus();
			return;
		}
		checkButton.disabled = true; checkButton.textContent = '检查与构建中…';
		clear(resultArea);
		resultArea.append(element('div', { class: 'result-banner pending' }, element('span', { class: 'spinner' }), '正在运行检查与 Astro 生产构建，通常需要数秒。'));
		try {
			const result = isArchive
				? await api('/api/archive/check', { method: 'POST', body: { slug, confirmation: confirmation.value.trim() } })
				: await api('/api/archive/restore/check', { method: 'POST', body: { slug } });
			renderMoveCheck(result, resultArea, { slug, article, isArchive, stageList, checkButton });
		} catch (error) {
			resultArea.replaceChildren(element('div', { class: 'result-banner error', text: error.message }));
			checkButton.disabled = false; checkButton.textContent = isArchive ? '重新运行归档检查' : '重新运行恢复检查';
		}
	} });
	viewRoot.append(
		head, info, confirmField,
		element('div', { class: 'move-actions' }, checkButton,
			element('span', { class: 'note-hint', text: isArchive ? '归档与恢复都需要推送后才会影响线上站点。' : '构建成功只代表本地通过；推送后仍需确认 Cloudflare 部署。' })),
		stageList, resultArea,
	);
}

function renderMoveCheck(result, container, ctx) {
	const { isArchive, slug, stageList, checkButton } = ctx;
	for (const item of stageList.children) item.className = '';
	const mark = (index, stateName) => { stageList.querySelector(`[data-step="${index}"]`)?.classList.add(stateName); };
	clear(container);
	if (!result.ok) {
		mark(0, 'done');
		mark(1, result.stage === 'build' ? 'failed' : 'done');
		container.append(element('div', { class: 'result-banner error', text: result.stage === 'build' ? '生产构建失败，文件已自动还原，未产生任何提交。' : '检查未通过，文件已自动还原。' }));
		if (result.errors?.length) container.append(element('ul', { class: 'error-list' }, ...result.errors.map((item) => element('li', { text: item }))));
		if (result.warnings?.length) container.append(element('ul', { class: 'warning-list' }, ...result.warnings.map((item) => element('li', { text: item }))));
		if (result.build?.output) container.append(element('details', { class: 'build-log' }, element('summary', { text: '查看构建日志' }), element('pre', { text: result.build.output })));
		checkButton.disabled = false; checkButton.textContent = isArchive ? '重新运行归档检查' : '重新运行恢复检查';
		return;
	}
	[0, 1, 2].forEach((index) => mark(index, 'done'));
	container.append(element('div', { class: 'result-banner success', text: isArchive ? '文件已移到归档目录，构建与变更检查通过。确认前尚未产生任何提交。' : '文件已移回博客目录，构建与变更检查通过。确认前尚未产生任何提交。' }));
	if (result.warnings?.length) container.append(element('ul', { class: 'warning-list' }, ...result.warnings.map((item) => element('li', { text: item }))));
	const safetyErrors = result.safety?.errors ?? [];
	if (safetyErrors.length) {
		mark(3, 'failed');
		container.append(element('ul', { class: 'error-list' }, ...safetyErrors.map((item) => element('li', { text: item }))));
	}
	const fileItems = result.files.length
		? result.files.map((file) => element('li', {}, statusPill(file.label, 'local'), element('span', { text: file.path })))
		: [element('li', { text: '没有文件变更，可能已经提交。' })];
	container.append(element('div', { class: 'publish-grid' },
		element('section', { class: 'section-panel' }, element('h2', { text: '准备提交的文件' }), element('ul', { class: 'file-list' }, ...fileItems)),
		element('section', { class: 'section-panel' },
			element('h2', { text: '构建结果' }),
			element('dl', { class: 'kv' },
				element('dt', { text: '状态' }), element('dd', { text: '通过' }),
				element('dt', { text: '耗时' }), element('dd', { text: `${(result.build.durationMs / 1000).toFixed(1)} 秒` }),
				element('dt', { text: '目标' }), element('dd', { text: 'main → origin/main' }),
			),
		),
	));
	if (result.diff) container.append(element('details', { class: 'build-log' }, element('summary', { text: '查看本次文本差异' }), element('pre', { class: 'diff-view', text: result.diff })));
	if (result.build?.output) container.append(element('details', { class: 'build-log' }, element('summary', { text: '查看构建日志' }), element('pre', { text: result.build.output })));
	const cancelButton = button('取消并还原', { onClick: async () => {
		if (!confirm('将把文件移回原位并放弃本次检查，不会产生任何提交。继续？')) return;
		cancelButton.disabled = true;
		try {
			await api('/api/archive/cancel', { method: 'POST', body: { checkId: result.checkId } });
			showToast('已还原，未产生提交');
			await refreshBootstrap();
			location.hash = isArchive ? '#/' : '#/archives';
		} catch (error) {
			showToast(error.message, 'error');
			cancelButton.disabled = false;
		}
	} });
	const confirmButton = button(isArchive ? '确认归档并推送 main' : '确认恢复并推送 main', { primary: true, disabled: safetyErrors.length > 0, onClick: async () => {
		const text = isArchive
			? `将移除线上文章 /blog/${slug}/，并把文件提交、推送到 GitHub main。\n\n${ctx.article.title}\n\n文件会保留在 src/content/archive，可随时恢复。继续？`
			: `将恢复线上文章 /blog/${slug}/，并提交、推送到 GitHub main。\n\n${ctx.article.title}\n\n继续？`;
		if (!confirm(text)) return;
		confirmButton.disabled = true; confirmButton.textContent = '正在提交并推送…';
		try {
			const moved = await api('/api/publish/confirm', { method: 'POST', body: { checkId: result.checkId } });
			renderMoveResult(moved, container, { ...ctx, stageList });
		} catch (error) {
			container.append(element('div', { class: 'result-banner error', text: error.message }));
			confirmButton.disabled = false; confirmButton.textContent = isArchive ? '确认归档并推送 main' : '确认恢复并推送 main';
		}
	} });
	container.append(element('div', { class: 'move-actions move-actions-end' }, cancelButton, confirmButton));
}

function renderMoveResult(result, container, ctx) {
	const { isArchive, slug, stageList } = ctx;
	clear(container);
	[0, 1, 2].forEach((index) => { stageList.querySelector(`[data-step="${index}"]`)?.classList.add('done'); });
	const siteRoot = state.bootstrap.site.url.replace(/\/$/, '');
	if (!result.ok && result.stage !== 'pushed') {
		stageList.querySelector('[data-step="3"]')?.classList.add('failed');
		container.append(element('div', { class: 'result-banner error', text: result.error || '推送失败，但本地提交已保留。请根据终端错误修复网络或权限。' }));
		if (result.commit) container.append(element('p', { class: 'mono', text: `本地提交：${result.commit}` }));
		container.append(element('div', { class: 'page-actions', style: 'margin-top:10px' }, linkButton('发布历史', '#/history'), linkButton('返回列表', isArchive ? '#/archives' : '#/')));
		return;
	}
	stageList.querySelector('[data-step="3"]')?.classList.add('done');
	container.append(element('div', { class: 'result-banner success', text: isArchive ? '已推送 GitHub，正在等待线上文章地址失效。' : '已推送 GitHub，正在等待线上文章恢复。' }));
	container.append(element('dl', { class: 'kv' },
		element('dt', { text: '提交' }), element('dd', { class: 'mono', text: result.commit }),
		element('dt', { text: '分支' }), element('dd', { text: 'main → origin/main' }),
		element('dt', { text: '文章' }), element('dd', {}, element('a', { href: `${siteRoot}/blog/${slug}/`, target: '_blank', rel: 'noopener', text: `${siteRoot}/blog/${slug}/` })),
	));
	const verify = button('检查线上状态', { onClick: async () => { await verifyDeployment(result.commit, container, stageList, verify, 0, { stepIndex: 3, expectRemoval: isArchive }); } });
	container.append(element('div', { class: 'page-actions', style: 'margin-top:10px' },
		linkButton('发布历史', '#/history'),
		linkButton(isArchive ? '归档列表' : '文章列表', isArchive ? '#/archives' : '#/'),
		verify));
	verifyDeployment(result.commit, container, stageList, verify, 0, { stepIndex: 3, expectRemoval: isArchive });
	refreshBootstrap().catch(() => undefined);
}

function categoryOptions(selected) {
	return state.bootstrap.categories.map((category) => element('option', { value: category.slug, text: category.name, selected: category.slug === selected }));
}

function generateSlug() {
	const now = new Date();
	const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
	return `note-${stamp}`;
}

function renderNew() {
	activeNav('new');
	clear(viewRoot);
	let slugEdited = false;
	const title = element('input', { name: 'title', placeholder: '文章标题', required: true });
	const slug = element('input', { name: 'slug', value: generateSlug(), pattern: '[a-z0-9]+(?:-[a-z0-9]+)*', required: true });
	slug.addEventListener('input', () => { slugEdited = true; });
	title.addEventListener('input', () => {
		if (slugEdited) return;
		const ascii = title.value.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 72);
		if (ascii) slug.value = ascii;
	});
	const description = element('textarea', { name: 'description', maxlength: 180, placeholder: '用一两句话说明文章解决的问题' });
	const category = element('select', { name: 'category' }, ...categoryOptions('technology'));
	const tags = element('input', { name: 'tags', placeholder: '工作方法, 写作（逗号分隔）' });
	const error = element('ul', { class: 'error-list' });
	const form = element('form', { class: 'form-panel section-panel', onsubmit: async (event) => {
		event.preventDefault();
		clear(error);
		try {
			const result = await api('/api/articles', { method: 'POST', body: {
				title: title.value.trim(), slug: slug.value.trim(), description: description.value.trim(),
				category: category.value, tags: parseTags(tags.value), body: '## 开始写作\n\n',
			} });
			showToast('草稿已创建');
			await refreshBootstrap();
			location.hash = `#/edit/${result.article.slug}`;
		} catch (reason) {
			error.append(element('li', { text: reason.message }));
		}
	} },
	element('div', { class: 'form-grid' },
		element('div', { class: 'field wide' }, element('label', { for: 'new-title', text: '标题' }), Object.assign(title, { id: 'new-title' })),
		element('div', { class: 'field' }, element('label', { for: 'new-slug', text: 'URL slug（创建后保持不变）' }), slug, element('span', { class: 'note-hint', text: '文章地址：/blog/<slug>/' })),
		element('div', { class: 'field' }, element('label', { for: 'new-category', text: '分类' }), Object.assign(category, { id: 'new-category' })),
		element('div', { class: 'field wide' }, element('label', { for: 'new-desc', text: '摘要' }), Object.assign(description, { id: 'new-desc' })),
		element('div', { class: 'field wide' }, element('label', { for: 'new-tags', text: '标签' }), Object.assign(tags, { id: 'new-tags' }), element('span', { class: 'note-hint', text: `可用标签：${state.bootstrap.tags.map((tag) => tag.name).join('、')}` })),
	),
	error,
	element('div', { class: 'form-actions' }, linkButton('取消', '#/'), element('button', { class: 'button primary', type: 'submit', text: '创建草稿并编辑' })),
	);
	viewRoot.append(
		pageHeader('NEW / DRAFT', '新建文章', '先创建本地草稿，内容不会进入线上，直到确认发布。'),
		form,
	);
}

function parseTags(value) {
	return [...new Set(String(value).split(/[,，]/).map((item) => item.trim()).filter(Boolean).map((item) => {
		const found = state.bootstrap.tags.find((tag) => tag.name === item || tag.slug === item);
		return found?.slug ?? item.replace(/^#/, '');
	}))];
}

function renderEditor(slug) {
	activeNav('dashboard');
	renderLoading();
	loadEditor(slug).catch((error) => {
		clear(viewRoot);
		viewRoot.append(pageHeader('ERROR', '无法打开文章', error.message), linkButton('返回文章列表', '#/'));
	});
}

async function loadEditor(slug) {
	const article = await api(`/api/articles/${encodeURIComponent(slug)}`);
	if (location.hash !== `#/edit/${slug}`) return;
	const category = element('select', {}, ...categoryOptions(article.metadata.category));
	const title = element('input', { class: 'editor-title', value: article.metadata.title, 'aria-label': '文章标题' });
	const description = element('textarea', { maxlength: 180, 'aria-label': '摘要' });
	description.value = article.metadata.description;
	const tags = element('input', { value: article.metadata.tags.map((tag) => state.bootstrap.tags.find((item) => item.slug === tag)?.name ?? tag).join(', '), 'aria-label': '标签' });
	const pubDate = element('input', { type: 'date', value: article.metadata.pubDate, 'aria-label': '发布日期' });
	const cover = element('input', { value: article.metadata.cover ?? '', placeholder: '../../assets/...', 'aria-label': '封面路径' });
	const coverAlt = element('input', { value: article.metadata.coverAlt ?? '', 'aria-label': '封面替代文字' });
	const seoTitle = element('input', { value: article.metadata.seoTitle ?? '', maxlength: 120, 'aria-label': 'SEO 标题' });
	const seoDescription = element('input', { value: article.metadata.seoDescription ?? '', maxlength: 180, 'aria-label': 'SEO 描述' });
	const featured = element('input', { type: 'checkbox', checked: article.metadata.featured });
	const demo = element('input', { type: 'checkbox', checked: article.metadata.demo });
	const stateLabel = element('span', { class: 'save-state', text: '已保存' });
	const editorHost = element('div', { class: 'editor-host' });
	const previewHost = element('div', { class: 'preview-host' });
	const mobileLayout = element('div', { class: 'editor-layout', dataset: { mobileView: 'edit' } },);
	const editorPane = element('section', { class: 'editor-pane editor-pane-main' });
	const previewPane = element('section', { class: 'editor-pane preview-pane' });
	const toolbar = element('div', { class: 'editor-toolbar' });
	let view;
	const local = {
		article,
		version: article.version,
		dirty: false,
		saving: false,
		locked: false,
		timer: null,
		previewTimer: null,
		changeSerial: 0,
	};
	state.editor = local;

	const currentMetadata = () => ({
		...local.article.metadata,
		title: title.value.trim(),
		description: description.value.trim(),
		category: category.value,
		tags: parseTags(tags.value),
		pubDate: pubDate.value || article.metadata.pubDate,
		cover: cover.value.trim() || undefined,
		coverAlt: coverAlt.value.trim() || undefined,
		seoTitle: seoTitle.value.trim() || undefined,
		seoDescription: seoDescription.value.trim() || undefined,
		featured: featured.checked,
		demo: demo.checked,
	});
	const updatePreview = () => {
		previewHost.replaceChildren(renderPreviewHtml(view.state.doc.toString(), currentMetadata()));
	};
	const setSaveState = (text, className = '') => {
		stateLabel.textContent = text;
		stateLabel.className = `save-state ${className}`.trim();
	};
	const markDirty = () => {
		local.dirty = true;
		local.changeSerial += 1;
		state.dirty = true;
		setSaveState('未保存', 'dirty');
		clearTimeout(local.timer);
		local.timer = setTimeout(() => save(false), 1200);
	};
	const refreshFromArticle = (updated, clean) => {
		local.article = updated;
		local.version = updated.version;
		if (clean) {
			local.dirty = false;
			state.dirty = false;
			setSaveState('已保存');
		}
	};
	const save = async (manual = true) => {
		if (local.saving || local.locked) return null;
		const serial = local.changeSerial;
		local.saving = true;
		state.saving = true;
		setSaveState('保存中…');
		try {
			const result = await api(`/api/articles/${encodeURIComponent(slug)}`, {
				method: 'PUT',
				body: { body: view.state.doc.toString(), metadata: currentMetadata(), version: local.version },
			});
			refreshFromArticle(result.article, serial === local.changeSerial);
			const errors = result.validation?.errors ?? [];
			if (errors.length) { setSaveState('已保存，有待修正项', 'dirty'); showToast(errors[0], 'error'); }
			else if (manual) showToast('已保存');
			if (serial !== local.changeSerial) { clearTimeout(local.timer); local.timer = setTimeout(() => save(false), 300); }
			return result;
		} catch (error) {
			local.locked = error.status === 409;
			setSaveState(local.locked ? '存在冲突，请重新打开' : '保存失败', 'error');
			showToast(error.message, 'error');
			return null;
		} finally {
			local.saving = false;
			state.saving = false;
		}
	};
	const insertText = (value) => {
		const selection = view.state.selection.main;
		view.dispatch({ changes: { from: selection.from, to: selection.to, insert: value }, selection: { anchor: selection.from + value.length } });
		view.focus();
	};
	const insert = (before, after = '', placeholder = '文本') => {
		const selection = view.state.selection.main;
		const selected = view.state.sliceDoc(selection.from, selection.to) || placeholder;
		view.dispatch({ changes: { from: selection.from, to: selection.to, insert: `${before}${selected}${after}` }, selection: { anchor: selection.from + before.length, head: selection.from + before.length + selected.length } });
		view.focus();
	};
	const insertAtLine = (prefix) => {
		const selection = view.state.selection.main;
		const line = view.state.doc.lineAt(selection.from);
		view.dispatch({ changes: { from: line.from, insert: prefix }, selection: { anchor: selection.from + prefix.length } });
		view.focus();
	};
	const uploadImage = async (file) => {
		if (!file?.type.startsWith('image/')) return;
		if (file.size > 15 * 1024 * 1024) { showToast('图片不能超过 15 MB。', 'error'); return; }
		try {
			setSaveState('上传图片…');
			const result = await api(`/api/articles/${encodeURIComponent(slug)}/upload?filename=${encodeURIComponent(file.name)}`, {
				method: 'POST', body: file, headers: { 'content-type': file.type || 'application/octet-stream' },
			});
			insertText(result.markdown);
			showToast('图片已插入并保存到文章资源目录');
		} catch (error) { showToast(error.message, 'error'); }
	};
	const setupPicker = () => openArticlePicker((target) => {
		const label = target.title;
		insert(`[${label}](/blog/${target.slug}/)`);
	});
	const tools = [
		['H2', () => insertAtLine('## ')], ['B', () => insert('**', '**', '重点')], ['I', () => insert('*', '*', '强调')],
		['“', () => insertAtLine('> ')], ['`', () => insert('`', '`', '代码')], ['```', () => insert('```ts\n', '\n```', 'const answer = 42;')],
		['—', () => insertText('\n---\n')], ['表格', () => insertText('\n| 列一 | 列二 |\n| --- | --- |\n| 内容 | 内容 |\n')],
		['链接', setupPicker], ['图片', () => imageInput.click()],
	];
	tools.forEach(([label, action], index) => {
		if (index === 5 || index === 9) toolbar.append(element('span', { class: 'toolbar-sep' }));
		toolbar.append(element('button', { type: 'button', class: 'toolbar-btn', text: label, onclick: action }));
	});
	toolbar.append(element('span', { class: 'pane-label', text: 'MARKDOWN' }));
	const imageInput = element('input', { type: 'file', accept: 'image/png,image/jpeg,image/gif,image/webp,image/avif', hidden: true, onchange: () => { uploadImage(imageInput.files[0]); imageInput.value = ''; } });
	editorPane.append(toolbar, editorHost, imageInput);
	previewPane.append(element('div', { class: 'editor-toolbar' }, element('span', { class: 'pane-label', text: 'LIVE PREVIEW' })), previewHost);
	mobileLayout.append(editorPane, previewPane);
	const tabs = element('div', { class: 'editor-mobile-tabs' },
		element('button', { type: 'button', class: 'active', text: '编辑', onclick: (event) => { mobileLayout.dataset.mobileView = 'edit'; event.currentTarget.classList.add('active'); event.currentTarget.nextSibling.classList.remove('active'); } }),
		element('button', { type: 'button', text: '预览', onclick: (event) => { mobileLayout.dataset.mobileView = 'preview'; event.currentTarget.classList.add('active'); event.currentTarget.previousSibling.classList.remove('active'); } }),
	);
	const meta = element('div', { class: 'editor-meta form-panel' },
		element('div', { class: 'field' }, element('label', { text: '摘要' }), description),
		element('div', { class: 'field' }, element('label', { text: '分类' }), category),
		element('div', { class: 'field' }, element('label', { text: '标签（逗号分隔）' }), tags),
	);
	const advanced = element('details', { class: 'advanced-fields form-panel' },
		element('summary', { text: '更多字段：日期、封面与 SEO' }),
		element('div', { class: 'form-grid' },
			element('div', { class: 'field' }, element('label', { text: '发布日期' }), pubDate),
			element('div', { class: 'field' }, element('label', { text: '展示选项' }), element('div', { class: 'check-row' }, element('label', {}, featured, ' 首页精选'), element('label', {}, demo, ' 标记为示例'))),
			element('div', { class: 'field wide' }, element('label', { text: '封面路径（可选）' }), cover),
			element('div', { class: 'field wide' }, element('label', { text: '封面替代文字' }), coverAlt),
			element('div', { class: 'field wide' }, element('label', { text: 'SEO 标题（可选）' }), seoTitle),
			element('div', { class: 'field wide' }, element('label', { text: 'SEO 描述（可选）' }), seoDescription),
		),
	);
	const actions = element('div', { class: 'page-actions' },
		element('a', { class: 'button ghost', href: '#/', text: '返回列表' }),
		element('button', { type: 'button', class: 'button', text: '恢复备份', onclick: () => openBackups(slug) }),
		stateLabel,
		button(local.article.metadata.draft ? '保存草稿' : '保存修改', { onClick: () => save(true) }),
		button('发布检查', { primary: true, onClick: async () => {
			const saved = await save(true);
			if (!saved) return;
			if (saved.validation?.errors?.length) { showToast('仍有内容错误，暂不能进入发布检查。', 'error'); return; }
			location.hash = `#/publish/${slug}`;
		} }),
	);
	const head = element('div', { class: 'editor-head' },
		element('a', { class: 'back', href: '#/', text: '← 文章' }),
		element('div', { class: 'editor-title-wrap' }, title),
		element('div', { class: 'page-actions' }, statusPill(local.article.metadata.draft ? '草稿' : '正式文章', local.article.metadata.draft ? 'draft' : 'published'), element('a', { class: 'mono muted', href: `${state.bootstrap.site.url.replace(/\/$/, '')}/blog/${slug}/`, target: '_blank', rel: 'noopener', text: '/blog/' + slug + '/' })),
	);
	clear(viewRoot);
	viewRoot.append(head, actions, meta, advanced, tabs, mobileLayout);
	view = new EditorView({
		parent: editorHost,
		doc: article.body,
		extensions: [
			basicSetup,
			markdown(),
			EditorView.lineWrapping,
			EditorView.theme({
				'&': { height: '100%', backgroundColor: 'var(--pub-panel)', color: 'var(--pub-ink)' },
				'.cm-content': { caretColor: 'var(--pub-accent)' },
				'.cm-cursor': { borderLeftColor: 'var(--pub-accent)' },
				'.cm-selectionBackground, ::selection': { backgroundColor: 'var(--pub-accent-soft) !important' },
			}),
			EditorView.updateListener.of((update) => {
				if (!update.docChanged) return;
				markDirty();
				clearTimeout(local.previewTimer);
				local.previewTimer = setTimeout(updatePreview, 120);
			}),
		],
	});
	[title, description, category, tags, pubDate, cover, coverAlt, seoTitle, seoDescription, featured, demo].forEach((input) => {
		input.addEventListener('input', () => { markDirty(); clearTimeout(local.previewTimer); local.previewTimer = setTimeout(updatePreview, 120); });
		input.addEventListener('change', markDirty);
	});
	view.dom.addEventListener('paste', (event) => {
		const image = [...(event.clipboardData?.files ?? [])].find((file) => file.type.startsWith('image/'));
		if (image) { event.preventDefault(); uploadImage(image); }
	});
	view.dom.addEventListener('dragover', (event) => event.preventDefault());
	view.dom.addEventListener('drop', (event) => {
		const image = [...(event.dataTransfer?.files ?? [])].find((file) => file.type.startsWith('image/'));
		if (image) { event.preventDefault(); uploadImage(image); }
	});
	const keyHandler = (event) => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') { event.preventDefault(); save(true); } };
	document.addEventListener('keydown', keyHandler);
	local.save = save;
	state.routeCleanup = () => {
		clearTimeout(local.timer);
		clearTimeout(local.previewTimer);
		document.removeEventListener('keydown', keyHandler);
		view.destroy();
	};
	updatePreview();
}

function openDialog(title, content, actions = []) {
	const close = element('button', { type: 'button', class: 'button ghost small', text: '关闭' });
	const dialog = element('dialog', { class: 'pub-dialog' },
		element('div', { class: 'dialog-head' }, element('span', { text: title }), close),
		element('div', { class: 'dialog-body' }, content),
		element('div', { class: 'dialog-foot' }, ...actions),
	);
	close.addEventListener('click', () => { dialog.close(); dialog.remove(); });
	dialog.addEventListener('cancel', () => setTimeout(() => dialog.remove(), 0));
	document.body.append(dialog);
	dialog.showModal();
	return { dialog, close };
}

function openArticlePicker(handler) {
	const list = element('div', { class: 'article-picker' });
	state.bootstrap.articles.forEach((article) => {
		const item = element('button', { type: 'button' }, element('span', { text: article.title }), element('span', { text: `/blog/${article.slug}/` }));
		item.addEventListener('click', () => { handler(article); modal.dialog.close(); modal.dialog.remove(); });
		list.append(item);
	});
	const modal = openDialog('插入站内文章链接', list);
}

async function openBackups(slug) {
	const data = await api(`/api/articles/${encodeURIComponent(slug)}/backups`);
	const list = element('div', { class: 'article-picker' });
	if (!data.backups.length) list.append(element('p', { class: 'note-hint', text: '还没有本地备份。保存文章后会自动创建备份。' }));
	for (const backup of data.backups) {
		const item = element('button', { type: 'button' }, element('span', { text: formatDateTime(backup.createdAt) }), element('span', { text: `${Math.ceil(backup.size / 1024)} KB` }));
		item.addEventListener('click', async () => {
			if (!confirm('恢复这个备份会覆盖当前正文，并在恢复前自动再备份一次。继续？')) return;
			try {
				await api(`/api/articles/${encodeURIComponent(slug)}/backups`, { method: 'POST', body: { backup: backup.name } });
				modal.dialog.close(); modal.dialog.remove();
				showToast('已恢复备份');
				loadEditor(slug);
			} catch (error) { showToast(error.message, 'error'); }
		});
		list.append(item);
	}
	const modal = openDialog('恢复历史备份（最多保留 20 份）', list);
}

function renderPublish(slug) {
	activeNav('dashboard');
	renderLoading();
	loadPublish(slug).catch((error) => { clear(viewRoot); viewRoot.append(pageHeader('ERROR', '无法读取发布信息', error.message), linkButton('返回文章列表', '#/')); });
}

async function loadPublish(slug) {
	const article = await api(`/api/articles/${encodeURIComponent(slug)}`);
	if (location.hash !== `#/publish/${slug}`) return;
	const resultArea = element('div', {});
	const steps = ['保存稿件', '内容校验', '生产构建', '文件差异', '推送 GitHub', 'Cloudflare 部署'];
	const stageList = element('ol', { class: 'publish-steps' }, ...steps.map((step, index) => element('li', { dataset: { step: String(index) }, text: step })));
	const head = pageHeader('PUBLISH / CHECK', '发布确认', '所有检查通过后，才会提交本次文章和附件并推送 main。', [linkButton('返回编辑', `#/edit/${slug}`), linkButton('文章列表', '#/')]);
	const info = element('section', { class: 'section-panel', style: 'margin-top:0' },
		element('dl', { class: 'kv' },
			element('dt', { text: '标题' }), element('dd', { text: article.metadata.title }),
			element('dt', { text: '目标 URL' }), element('dd', {}, element('a', { href: `/blog/${slug}/`, target: '_blank', rel: 'noopener', text: `/blog/${slug}/` })),
			element('dt', { text: '分类 / 标签' }), element('dd', { text: `${article.metadata.category} · ${article.metadata.tags.join(', ') || '无标签'}` }),
			element('dt', { text: '本地状态' }), element('dd', { text: article.metadata.draft ? '草稿' : '正式文章' }),
			element('dt', { text: 'Git 分支' }), element('dd', { class: 'mono', text: `${state.bootstrap.git.branch}@${state.bootstrap.git.head.slice(0, 7)}` }),
		),
	);
	const checkButton = button('运行发布检查', { primary: true, onClick: async () => {
		checkButton.disabled = true; checkButton.textContent = '检查与构建中…';
		clear(resultArea);
		resultArea.append(element('div', { class: 'result-banner pending' }, element('span', { class: 'spinner' }), '正在运行内容校验与 Astro 生产构建，通常需要数秒。'));
		try {
			const result = await api('/api/publish/check', { method: 'POST', body: { slug } });
			renderCheckResult(result, resultArea, slug, stageList);
		} catch (error) {
			resultArea.replaceChildren(element('div', { class: 'result-banner error', text: error.message }));
		} finally { checkButton.disabled = false; checkButton.textContent = '重新运行检查'; }
	} });
	clear(viewRoot);
	viewRoot.append(head, info, element('div', { style: 'display:flex;gap:6px;margin-top:10px' }, checkButton, element('span', { class: 'note-hint', style: 'align-self:center', text: '构建成功只代表本地通过；推送成功后仍需确认 Cloudflare 部署。' })), stageList, resultArea);
}

function renderCheckResult(result, container, slug, stageList) {
	for (const item of stageList.children) item.className = '';
	const mark = (index, stateName) => { const item = stageList.querySelector(`[data-step="${index}"]`); if (item) item.classList.add(stateName); };
	clear(container);
	if (!result.ok) {
		mark(1, result.stage === 'validation' ? 'failed' : 'done');
		if (result.stage === 'build') { mark(1, 'done'); mark(2, 'failed'); }
		container.append(element('div', { class: 'result-banner error', text: result.stage === 'build' ? '生产构建失败，正文和草稿状态已保留。' : '内容校验未通过，请修复后重试。' }));
		if (result.errors?.length) container.append(element('ul', { class: 'error-list' }, ...result.errors.map((error) => element('li', { text: error }))));
		if (result.build?.output) container.append(element('details', { class: 'build-log' }, element('summary', { text: '查看构建日志' }), element('pre', { text: result.build.output })));
		return;
	}
	[0, 1, 2, 3].forEach((index) => mark(index, 'done'));
	container.append(element('div', { class: 'result-banner success', text: '内容、构建与差异检查均已通过。' }));
	const safetyErrors = result.safety?.errors ?? [];
	if (safetyErrors.length) {
		mark(4, 'failed');
		container.append(element('ul', { class: 'error-list' }, ...safetyErrors.map((error) => element('li', { text: error }))));
	}
	if (result.errors?.length) container.append(element('ul', { class: 'error-list' }, ...result.errors.map((error) => element('li', { text: error }))));
	if (result.warnings?.length) container.append(element('ul', { class: 'warning-list' }, ...result.warnings.map((warning) => element('li', { text: warning }))));
	const fileItems = result.files.length
		? result.files.map((file) => element('li', {}, statusPill(file.label, 'local'), element('span', { text: file.path })))
		: [element('li', { text: '没有文件变更，可能已经提交。' })];
	const filePanel = element('section', { class: 'section-panel' },
		element('h2', { text: '准备提交的文件' }),
		element('ul', { class: 'file-list' }, ...fileItems),
	);
	const buildPanel = element('section', { class: 'section-panel' },
		element('h2', { text: '构建结果' }),
		element('dl', { class: 'kv' },
			element('dt', { text: '状态' }), element('dd', { text: '通过' }),
			element('dt', { text: '耗时' }), element('dd', { text: `${(result.build.durationMs / 1000).toFixed(1)} 秒` }),
			element('dt', { text: '目标' }), element('dd', { text: 'main → origin/main' }),
		),
	);
	const grid = element('div', { class: 'publish-grid' }, filePanel, buildPanel);
	container.append(grid);
	if (result.diff) container.append(element('details', { class: 'build-log' }, element('summary', { text: '查看本次文本差异' }), element('pre', { class: 'diff-view', text: result.diff })));
	if (result.build?.output) container.append(element('details', { class: 'build-log' }, element('summary', { text: '查看构建日志' }), element('pre', { text: result.build.output })));
	const controls = element('div', { style: 'display:flex;align-items:center;gap:8px;justify-content:flex-end;margin-top:12px' });
	const confirmButton = button('确认发布到 main', { primary: true, disabled: safetyErrors.length > 0, onClick: async () => {
		if (!confirm(`将提交本次文章和附件，并推送到 GitHub main。\n\n${result.article.title}\n/blog/${slug}/\n\nCloudflare 将随后自动部署。继续？`)) return;
		confirmButton.disabled = true; confirmButton.textContent = '正在提交并推送…';
		try {
			const published = await api('/api/publish/confirm', { method: 'POST', body: { checkId: result.checkId } });
			renderPublishResult(published, container, stageList, slug);
		} catch (error) {
			container.append(element('div', { class: 'result-banner error', text: error.message }));
			confirmButton.disabled = false; confirmButton.textContent = '确认发布到 main';
		}
	} });
	controls.append(linkButton('查看线上页面', `${state.bootstrap.site.url.replace(/\/$/, '')}/blog/${slug}/`, { external: true }), confirmButton);
	container.append(controls);
}

function renderPublishResult(result, container, stageList, slug) {
	clear(container);
	[0, 1, 2, 3].forEach((index) => { stageList.querySelector(`[data-step="${index}"]`)?.classList.add('done'); });
	if (!result.ok && result.stage !== 'pushed') {
		stageList.querySelector('[data-step="4"]')?.classList.add('failed');
		container.append(element('div', { class: 'result-banner error', text: result.error || '推送失败，但本地提交已保留。请根据终端错误修复网络或权限。' }));
		if (result.commit) container.append(element('p', { class: 'mono', text: `本地提交：${result.commit}` }));
		return;
	}
	stageList.querySelector('[data-step="4"]')?.classList.add('done');
	container.append(element('div', { class: 'result-banner success', text: '已推送 GitHub。Cloudflare 部署仍需核验。' }));
	container.append(element('dl', { class: 'kv' },
		element('dt', { text: '提交' }), element('dd', { class: 'mono', text: result.commit }),
		element('dt', { text: '分支' }), element('dd', { text: 'main → origin/main' }),
		element('dt', { text: '文章' }), element('dd', {}, element('a', { href: `${state.bootstrap.site.url.replace(/\/$/, '')}/blog/${slug}/`, target: '_blank', rel: 'noopener', text: `${state.bootstrap.site.url.replace(/\/$/, '')}/blog/${slug}/` })),
	));
	const verify = button('检查线上部署', { onClick: async () => { await verifyDeployment(result.commit, container, stageList, verify); } });
	container.append(element('div', { class: 'page-actions', style: 'margin-top:10px' }, linkButton('发布历史', '#/history'), linkButton('返回文章', `#/edit/${slug}`), verify));
	verifyDeployment(result.commit, container, stageList, verify);
}

async function verifyDeployment(commit, container, stageList, buttonNode, attempts = 0, options = {}) {
	const stepIndex = options.stepIndex ?? 5;
	const expectRemoval = Boolean(options.expectRemoval);
	if (buttonNode) { buttonNode.disabled = true; buttonNode.textContent = '核验中…'; }
	const banner = element('div', { class: 'result-banner pending' }, element('span', { class: 'spinner' }), expectRemoval ? '正在检查线上文章地址是否已失效…' : '正在检查线上文章是否已更新…');
	container.querySelector('[data-deploy-status]')?.remove();
	banner.dataset.deployStatus = '';
	container.append(banner);
	try {
		const result = await api('/api/deploy/verify', { method: 'POST', body: { commit } });
		if (result.status === 'deployed') {
			stageList.querySelector(`[data-step="${stepIndex}"]`)?.classList.add('done');
			banner.className = 'result-banner success';
			banner.textContent = expectRemoval ? '线上归档已核验：文章地址已返回 404。' : '线上部署已核验：线上正文修订指纹与本次发布一致。';
			if (buttonNode) buttonNode.remove();
		} else if (result.status === 'pending' && attempts < 3) {
			banner.className = 'result-banner pending';
			banner.textContent = `${result.detail} 将在 15 秒后重试（${attempts + 1}/3）。`;
			setTimeout(() => verifyDeployment(commit, container, stageList, buttonNode, attempts + 1, options), 15_000);
		} else {
			banner.className = 'result-banner pending';
			banner.textContent = `已推送，部署未确认：${result.detail} `;
			banner.append(element('a', { href: 'https://dash.cloudflare.com/', target: '_blank', rel: 'noopener', text: '打开 Cloudflare 控制台' }));
			if (buttonNode) { buttonNode.disabled = false; buttonNode.textContent = '再次检查部署'; }
		}
	} catch (error) {
		banner.className = 'result-banner error';
		banner.textContent = `部署核验失败：${error.message}`;
		if (buttonNode) { buttonNode.disabled = false; buttonNode.textContent = '再次检查部署'; }
	}
}

function renderImport() {
	activeNav('import');
	clear(viewRoot);
	state.importPool = [];
	const folderInput = element('input', { type: 'file', multiple: true, accept: '.md,image/*', onchange: (event) => addImportFiles([...event.target.files]) });
	folderInput.setAttribute('webkitdirectory', '');
	const fileInput = element('input', { type: 'file', multiple: true, accept: '.md,.markdown', onchange: (event) => addImportFiles([...event.target.files]) });
	const attachmentInput = element('input', { type: 'file', multiple: true, accept: 'image/*', onchange: (event) => addImportFiles([...event.target.files]) });
	const noteSelect = element('select', { class: 'import-select', 'aria-label': '选择要导入的 Markdown 笔记' });
	const fileSummary = element('p', { class: 'note-hint', text: '尚未选择文件。' });
	const result = element('div', {});
	const analyzeButton = button('分析并预览导入', { primary: true, disabled: true, onClick: async () => {
		const file = state.importPool.find((item) => item.relativePath === noteSelect.value);
		if (!file) return;
		analyzeButton.disabled = true; analyzeButton.textContent = '正在分析…';
		clear(result);
		try {
			const content = await file.file.text();
			const references = extractImportReferences(content);
			const candidates = state.importPool.filter((item) => item.kind === 'image' && references.some((ref) => item.file.name.normalize('NFC') === ref || item.relativePath.replaceAll('\\', '/').endsWith(ref)));
			const payloadFiles = [];
			for (const item of candidates.slice(0, 100)) payloadFiles.push({ name: item.file.name, path: item.relativePath, base64: await fileToBase64(item.file), size: item.file.size });
			const data = await api('/api/import/analyze', { method: 'POST', body: { note: { name: file.file.name, path: file.relativePath, content }, files: payloadFiles } });
			state.importAnalysis = data;
			renderImportAnalysis(data, result);
			showToast('分析完成。确认预览与差异后再导入。');
		} catch (error) { result.replaceChildren(element('div', { class: 'result-banner error', text: error.message })); }
		finally { analyzeButton.disabled = !noteSelect.value; analyzeButton.textContent = '分析并预览导入'; }
	} });
	function addImportFiles(files) {
		const map = new Map(state.importPool.map((item) => [`${item.relativePath}:${item.file.size}:${item.file.lastModified}`, item]));
		for (const file of files) {
			const relativePath = file.webkitRelativePath || file.name;
			const kind = /\.md$/i.test(file.name) ? 'markdown' : file.type.startsWith('image/') ? 'image' : 'other';
			if (kind === 'other') continue;
			map.set(`${relativePath}:${file.size}:${file.lastModified}`, { file, relativePath, kind });
		}
		state.importPool = [...map.values()];
		const notes = state.importPool.filter((item) => item.kind === 'markdown');
		noteSelect.replaceChildren(...(notes.length ? notes.map((item) => element('option', { value: item.relativePath, text: item.relativePath })) : [element('option', { value: '', text: '没有找到 Markdown 文件' })]));
		analyzeButton.disabled = !notes.length;
		fileSummary.textContent = `已选择 ${notes.length} 篇笔记、${state.importPool.filter((item) => item.kind === 'image').length} 个图片附件。只会上传选中笔记和正文实际引用的附件。`;
	}
	viewRoot.append(
		pageHeader('IMPORT / OBSIDIAN', '导入 Obsidian 笔记', '选择 Vault 文件夹或单篇 Markdown。导入只创建本地草稿，不会自动发布。'),
		element('section', { class: 'import-drop' },
			element('h2', { text: '1. 选择来源' }),
			element('p', { text: '不会扫描或发布整个笔记库。文件夹只用于定位你选中的笔记和正文引用图片。' }),
			element('div', { class: 'file-input-row' },
				element('label', { class: 'file-input-label' }, '选择 Vault 文件夹', folderInput),
				element('label', { class: 'file-input-label' }, '选择 Markdown 文件', fileInput),
				element('label', { class: 'file-input-label' }, '补充图片附件', attachmentInput),
			),
			fileSummary,
		),
		element('section', { class: 'section-panel' },
			element('div', { class: 'field' }, element('label', { text: '选择要导入的笔记' }), noteSelect),
			element('div', { class: 'form-actions' }, analyzeButton),
		),
		result,
	);
}

function extractImportReferences(markdown) {
	const refs = new Set();
	for (const match of markdown.matchAll(/!\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g)) refs.add(match[1].trim());
	for (const match of markdown.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)) refs.add(match[1].trim().replace(/^<|>$/g, ''));
	return [...refs].filter((ref) => !/^(https?:|data:)/i.test(ref));
}

function fileToBase64(file) {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
		reader.onerror = () => reject(reader.error);
		reader.readAsDataURL(file);
	});
}

function renderImportAnalysis(analysis, container) {
	clear(container);
	const previewMap = new Map(analysis.attachments.map((item) => [item.targetName, item.previewUrl]));
	const title = element('input', { value: analysis.title });
	const slug = element('input', { value: analysis.slug, disabled: Boolean(analysis.existing) });
	const description = element('input', { value: analysis.metadata.description });
	const category = element('select', {}, ...categoryOptions(analysis.metadata.category));
	const tags = element('input', { value: analysis.metadata.tags.map((tag) => state.bootstrap.tags.find((item) => item.slug === tag)?.name ?? tag).join(', ') });
	const previewHost = element('div', { class: 'preview-host import-preview', style: 'height:auto;max-height:440px;border:1px solid var(--pub-line);border-radius:4px' }, renderPreviewHtml(analysis.previewBody, analysis.metadata, {
		resolveImage: (source) => {
			let decoded = source;
			try { decoded = decodeURIComponent(source); } catch { /* 保留原始路径 */ }
			const match = decoded.match(/__ASSET__\/(.+)$/);
			if (match) return previewMap.get(match[1]) || '';
			return resolveEditorImage(decoded);
		},
	}));
	const diffHost = element('pre', { class: 'diff-view' });
	if (analysis.diff) {
		for (const part of analysis.diff) {
			const span = element('span', { class: part.added ? 'diff-added' : part.removed ? 'diff-removed' : '', text: part.value });
			diffHost.append(span);
		}
	} else diffHost.textContent = '新文章，无已有正文差异。';
	const commitButton = button(analysis.existing ? '确认更新已有文章（保持 URL）' : '导入为本地草稿', { primary: true, onClick: async () => {
		if (analysis.existing && !confirm(`检测到已有文章「${analysis.existing.title}」。\n导入将更新它并保持 URL 不变：${analysis.existing.url}\n\n继续？`)) return;
		commitButton.disabled = true; commitButton.textContent = '正在写入…';
		try {
			const committed = await api('/api/import/commit', { method: 'POST', body: {
				analysisId: analysis.analysisId,
				mode: analysis.existing ? 'update' : 'new',
				slug: slug.value.trim(), title: title.value.trim(), description: description.value.trim(),
				category: category.value, tags: parseTags(tags.value),
			} });
			showToast(analysis.existing ? '已有文章已更新，URL 保持不变' : '导入完成，已创建本地草稿');
			await refreshBootstrap();
			location.hash = `#/edit/${committed.article.slug}`;
		} catch (error) {
			showToast(error.message, 'error');
			container.prepend(element('div', { class: 'result-banner error', text: error.message }));
			commitButton.disabled = false; commitButton.textContent = analysis.existing ? '确认更新已有文章（保持 URL）' : '导入为本地草稿';
		}
	} });
	container.append(
		element('section', { class: 'section-panel' },
			element('h2', { text: '2. 导入预览与差异' }),
			analysis.existing ? element('div', { class: 'result-banner pending', text: `检测到同名文章，将更新已有文章并保持 URL：${analysis.existing.url}` }) : element('div', { class: 'result-banner', text: '将创建一篇新的本地草稿。' }),
			element('div', { class: 'form-grid' },
				element('div', { class: 'field wide' }, element('label', { text: '标题' }), title),
				element('div', { class: 'field' }, element('label', { text: 'URL slug' }), slug),
				element('div', { class: 'field' }, element('label', { text: '分类' }), category),
				element('div', { class: 'field wide' }, element('label', { text: '摘要' }), description),
				element('div', { class: 'field wide' }, element('label', { text: '标签' }), tags),
			),
			analysis.warnings.length ? element('ul', { class: 'warning-list', style: 'margin-top:10px' }, ...analysis.warnings.map((warning) => element('li', { text: warning }))) : null,
			element('div', { class: 'publish-grid', style: 'margin-top:10px' },
				element('div', {}, element('h2', { text: '正文预览' }), previewHost),
				element('div', {}, element('h2', { text: '与现有正文差异' }), diffHost, element('p', { class: 'note-hint', text: `附件：${analysis.attachments.length} 个；重复导入会识别为更新，不会创建重复文章。` })),
			),
			element('div', { class: 'form-actions' }, linkButton('取消', '#/import'), commitButton),
		),
	);
}

async function renderHistory() {
	activeNav('history');
	renderLoading('正在读取发布历史…');
	try {
		const data = await api('/api/history');
		clear(viewRoot);
		const list = element('div', { class: 'history-list' });
		if (!data.records.length) list.append(element('div', { class: 'empty-panel' }, element('strong', { text: '还没有发布历史' }), element('span', { text: '完成一次发布检查并确认后，记录会保存在这里。' })));
		for (const record of data.records) {
			const status = record.deployment?.status;
			const tone = status === 'deployed' ? 'published' : status === 'pending' ? 'draft' : record.push?.ok ? 'pushed' : 'failed';
			const actionLabel = record.action === 'archive' ? '归档' : record.action === 'restore' ? '恢复' : '发布';
			const verify = status !== 'deployed' && record.commit ? button('核验部署', { small: true, onClick: async () => {
				try {
					const result = await api('/api/deploy/verify', { method: 'POST', body: { commit: record.commit } });
					showToast(result.status === 'deployed' ? '线上状态已核验' : result.detail, result.status === 'deployed' ? 'info' : 'error');
					renderHistory();
				} catch (error) { showToast(error.message, 'error'); }
			} }) : null;
			list.append(element('article', { class: 'history-item' },
				element('div', {},
					element('h2', { text: record.title }),
					element('p', {}, element('a', { href: record.url, target: '_blank', rel: 'noopener', text: record.url })),
					element('div', { class: 'history-meta' },
						element('span', { text: formatDateTime(record.createdAt) }),
						element('span', { text: record.commit?.slice(0, 7) || '—' }),
						statusPill(actionLabel, record.action === 'archive' ? 'local' : record.action === 'restore' ? 'pushed' : 'local'),
						statusPill(status === 'deployed' ? '线上已核验' : status === 'pending' ? '已推送，部署未确认' : record.push?.ok ? '已推送' : '发布失败', tone),
					),
				),
				element('div', { class: 'row-actions' }, element('a', { class: 'button small ghost', href: `${state.bootstrap.site.github}/commit/${record.commit}`, target: '_blank', rel: 'noopener', text: '查看提交' }), verify),
			));
		}
		viewRoot.append(pageHeader('HISTORY / RELEASES', '发布历史', '本地记录的提交、推送与可核验的部署状态。'), list);
	} catch (error) {
		clear(viewRoot);
		viewRoot.append(pageHeader('ERROR', '无法读取发布历史', error.message));
	}
}

applyTheme();
document.querySelector('[data-theme-toggle]')?.addEventListener('click', () => {
	const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
	localStorage.setItem('publisher-theme', next);
	document.documentElement.dataset.theme = next;
});
window.addEventListener('beforeunload', (event) => {
	if (state.dirty) event.preventDefault();
});
document.addEventListener('visibilitychange', () => {
	if (document.visibilityState === 'hidden' && state.editor?.dirty) {
		clearTimeout(state.editor.timer);
		state.editor.save?.(false);
	}
});
document.addEventListener('click', async (event) => {
	const anchor = event.target instanceof Element ? event.target.closest('a[href^="#/"]') : null;
	if (!anchor || !state.editor?.dirty) return;
	const destination = anchor.getAttribute('href');
	event.preventDefault();
	const saved = await state.editor.save(true);
	if (saved) location.hash = destination;
}, true);
window.addEventListener('hashchange', route);
refreshBootstrap().then(() => route()).catch((error) => {
	clear(viewRoot);
	viewRoot.append(pageHeader('CONNECTION ERROR', '无法连接本地服务', error.message));
});
