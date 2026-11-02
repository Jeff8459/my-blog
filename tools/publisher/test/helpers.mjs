import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

export async function makeFixture(options = {}) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'notes-publisher-'));
	await fs.mkdir(path.join(root, 'src/content/blog'), { recursive: true });
	await fs.mkdir(path.join(root, 'src/assets/publisher'), { recursive: true });
	await fs.mkdir(path.join(root, 'src/content/archive'), { recursive: true });
	await fs.mkdir(path.join(root, 'src/styles'), { recursive: true });
	await fs.mkdir(path.join(root, 'public'), { recursive: true });
	await fs.writeFile(path.join(root, '.gitignore'), '.publisher/\ndist/\nnode_modules/\n');
	await fs.writeFile(path.join(root, 'src/styles/global.css'), ':root{--background:#fff;--text:#222;--muted:#666;--line:#ddd;--accent:#3569a8;--code-bg:#f6f8fa;--mark-bg:#e8f0fa;--sidebar:#f8fafc;--bg:#fff;--faint:#999;--font-sans:sans-serif;--font-mono:monospace}.prose{line-height:1.8}');
	await fs.writeFile(path.join(root, 'public/favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
	await fs.writeFile(path.join(root, 'src/content/blog/existing-note.md'), `---
title: "已有笔记"
description: "用于导入关联测试的已有文章。"
pubDate: "2026-10-01"
category: "technology"
tags: ["writing"]
draft: false
---
这是一篇已经发布的笔记。
`);
	if (options.git !== false) {
		await execFileAsync('git', ['init', '-b', 'main'], { cwd: root });
		await execFileAsync('git', ['config', 'user.name', 'Publisher Test'], { cwd: root });
		await execFileAsync('git', ['config', 'user.email', 'publisher@example.invalid'], { cwd: root });
		await execFileAsync('git', ['add', '.'], { cwd: root });
		await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: root });
		const remote = path.join(root, '..', `${path.basename(root)}-remote.git`);
		await execFileAsync('git', ['init', '--bare', remote]);
		await execFileAsync('git', ['remote', 'add', 'origin', remote], { cwd: root });
		await execFileAsync('git', ['push', '-u', 'origin', 'main'], { cwd: root });
	}
	return { root, cleanup: async () => fs.rm(root, { recursive: true, force: true }) };
}

export async function runGit(root, args) {
	const { stdout } = await execFileAsync('git', args, { cwd: root, encoding: 'utf8' });
	return stdout.trim();
}
