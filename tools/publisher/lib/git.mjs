import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import { PublisherError } from './paths.mjs';

const execFileAsync = promisify(execFile);

export async function git(root, args, options = {}) {
	try {
		const { stdout, stderr } = await execFileAsync('git', args, {
			cwd: root,
			encoding: 'utf8',
			maxBuffer: 4 * 1024 * 1024,
			timeout: options.timeout ?? 60_000,
			env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
		});
		return { stdout: stdout.replace(/[\s\u0000]+$/, ''), stderr: stderr.replace(/[\s\u0000]+$/, '') };
	} catch (error) {
		const message = String(error.stderr || error.stdout || error.message).trim();
		throw new PublisherError(`Git 操作失败：${message}`, 409);
	}
}

export async function getGitState(root) {
	const [{ stdout: branch }, { stdout: head }, { stdout: status }] = await Promise.all([
		git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']),
		git(root, ['rev-parse', 'HEAD']),
		git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames']),
	]);
	let upstream = null;
	try {
		upstream = (await git(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'])).stdout;
	} catch {
		upstream = null;
	}
	return { branch, head, upstream, changes: parseStatus(status) };
}

/** 解析 `git status --porcelain=v1 -z`，路径保持原样，避免文件名空格被截断。 */
export function parseStatus(output) {
	if (!output) return [];
	const fields = output.split('\0');
	const entries = [];
	for (let index = 0; index < fields.length; index += 1) {
		const field = fields[index];
		if (!field) continue;
		const indexStatus = field[0];
		const worktreeStatus = field[1];
		const file = field.slice(3);
		let originalPath;
		if (indexStatus === 'R' || indexStatus === 'C') {
			originalPath = fields[index + 1];
			index += 1;
		}
		entries.push({ index: indexStatus, worktree: worktreeStatus, path: file, originalPath, staged: indexStatus !== ' ' && indexStatus !== '?' });
	}
	return entries;
}

export function isAllowedPath(file, allowedFiles, assetDirectory) {
	const normal = file.replaceAll('\\', '/');
	const list = (Array.isArray(allowedFiles) ? allowedFiles : [allowedFiles])
		.filter(Boolean)
		.map((item) => item.replaceAll('\\', '/'));
	if (list.includes(normal)) return true;
	if (!assetDirectory) return false;
	const assets = assetDirectory.replaceAll('\\', '/').replace(/\/?$/, '/');
	return normal.startsWith(assets);
}

export async function checkRepositorySafety(root, allowedFiles, assetDirectory, options = {}) {
	const label = options.actionLabel ?? '发布';
	const state = await getGitState(root);
	const errors = [];
	if (state.branch !== 'main') errors.push(`当前分支是 ${state.branch}，发布中心只允许从 main ${label}。请先安全合并并切换回 main。`);
	const outside = state.changes.filter((change) => !isAllowedPath(change.path, allowedFiles, assetDirectory));
	if (outside.length) errors.push(`存在不属于本次${label}的修改：${outside.slice(0, 6).map((change) => change.path).join('、')}${outside.length > 6 ? ' 等' : ''}`);
	const unrelatedStaged = state.changes.filter((change) => change.staged && !isAllowedPath(change.path, allowedFiles, assetDirectory));
	if (unrelatedStaged.length) errors.push(`暂存区存在无关文件：${unrelatedStaged.map((change) => change.path).join('、')}`);
	if (options.fetchRemote !== false) {
		try {
			await git(root, ['fetch', '--quiet', 'origin', 'main'], { timeout: 60_000 });
		} catch (error) {
			errors.push(`无法获取 origin/main：${error.message}`);
		}
	}
	if (errors.length === 0) {
		try {
			const { stdout: remote } = await git(root, ['rev-parse', 'origin/main']);
			if (remote !== state.head) errors.push('本地 main 与 origin/main 不一致。请先安全同步远程分支，发布中心不会自动重置或强制推送。');
		} catch {
			errors.push('无法确认 origin/main 状态。');
		}
	}
	return { ...state, errors, changes: state.changes, remoteChecked: options.fetchRemote !== false };
}

/**
 * 暂存一个路径：存在则 `git add`，仅存在于索引（例如已被移走）则记录删除，
 * 两者都不是时跳过，避免把未提交的新文件误加入本次提交。
 */
async function stagePath(root, file) {
	try {
		await git(root, ['ls-files', '--error-unmatch', '--', file]);
		await git(root, ['add', '-A', '--', file]);
		return;
	} catch {
		// 索引中没有该路径。
	}
	try {
		await fs.access(path.join(root, file));
		await git(root, ['add', '--', file]);
	} catch {
		// 磁盘上也不存在：没有需要暂存的内容。
	}
}

export async function stageAndCommit(root, allowedFiles, assetDirectory, message) {
	const before = await getGitState(root);
	const unrelated = before.changes.filter((change) => !isAllowedPath(change.path, allowedFiles, assetDirectory));
	if (unrelated.length) throw new PublisherError('工作区存在无关修改，已停止提交。', 409);
	const files = before.changes.map((change) => change.path).filter((file) => isAllowedPath(file, allowedFiles, assetDirectory));
	if (!files.length) throw new PublisherError('没有可发布的文件变更。', 409);
	for (const file of Array.isArray(allowedFiles) ? allowedFiles : [allowedFiles]) {
		if (file) await stagePath(root, file);
	}
	if (assetDirectory) {
		try {
			await git(root, ['add', '--', assetDirectory]);
		} catch {
			// 没有图片附件时目录可能不存在。
		}
	}
	// 关闭重命名检测，确保删除与新增各自成一项，避免只提交其中一半。
	const { stdout: stagedOutput } = await git(root, ['diff', '--cached', '--name-only', '-z', '--no-renames']);
	const staged = stagedOutput.split('\0').filter(Boolean);
	const forbidden = staged.filter((file) => !isAllowedPath(file, allowedFiles, assetDirectory));
	if (forbidden.length) {
		await git(root, ['restore', '--staged', '--', ...forbidden]);
		throw new PublisherError(`暂存区包含禁止发布的文件：${forbidden.join('、')}`, 409);
	}
	if (!staged.length) throw new PublisherError('没有可提交的变更。', 409);
	await git(root, ['commit', '-m', message, '--', ...staged], { timeout: 60_000 });
	return { commit: (await git(root, ['rev-parse', 'HEAD'])).stdout, files: staged };
}

export async function pushMain(root) {
	const result = await git(root, ['push', 'origin', 'main'], { timeout: 90_000 });
	return { ok: true, output: result.stdout || result.stderr };
}

export async function getDiff(root, files) {
	const blocks = [];
	for (const file of files) {
		const relative = path.relative(root, file).replaceAll('\\', '/');
		let tracked = true;
		try {
			await git(root, ['ls-files', '--error-unmatch', '--', relative]);
		} catch {
			tracked = false;
		}
		if (tracked) {
			try {
				const { stdout } = await git(root, ['diff', '--no-ext-diff', '--', relative]);
				if (stdout) blocks.push(stdout);
			} catch {
				// 保留文件列表，diff 失败时不阻断发布检查。
			}
			continue;
		}
		try {
			const content = await fs.readFile(file, 'utf8');
			const lines = content.replace(/\n$/, '').split('\n');
			blocks.push([
				`--- /dev/null`,
				`+++ b/${relative}`,
				`@@ -0,0 +1,${lines.length} @@`,
				...lines.map((line) => `+${line}`),
			].join('\n'));
		} catch {
			// 二进制或不可读文件不作为文本 diff 展示。
		}
	}
	return blocks.join('\n').slice(0, 120_000);
}
