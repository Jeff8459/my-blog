import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export async function ensureDir(directory) {
	await fs.mkdir(directory, { recursive: true });
}

/** 先写入同目录临时文件并 fsync，再原子替换目标，避免页面异常退出留下半个文件。 */
export async function atomicWrite(filePath, content, options = {}) {
	await ensureDir(path.dirname(filePath));
	const temporary = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
	try {
		const handle = await fs.open(temporary, 'w', options.mode ?? 0o644);
		try {
			await handle.writeFile(content, options.encoding ?? 'utf8');
			await handle.sync();
		} finally {
			await handle.close();
		}
		await fs.rename(temporary, filePath);
	} catch (error) {
		await fs.rm(temporary, { force: true });
		throw error;
	}
}

export async function atomicCopy(source, target) {
	await ensureDir(path.dirname(target));
	const temporary = `${target}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
	try {
		await fs.copyFile(source, temporary);
		await fs.rename(temporary, target);
	} catch (error) {
		await fs.rm(temporary, { force: true });
		throw error;
	}
}

export async function backupFile(filePath, backupRoot, label) {
	try {
		const content = await fs.readFile(filePath);
		const stamp = new Date().toISOString().replaceAll(':', '-');
		const target = path.join(backupRoot, label, `${stamp}.bak`);
		await ensureDir(path.dirname(target));
		await fs.writeFile(target, content, { mode: 0o600 });
		const backups = (await fs.readdir(path.dirname(target))).sort();
		for (const stale of backups.slice(0, Math.max(0, backups.length - 20))) {
			await fs.rm(path.join(path.dirname(target), stale), { force: true });
		}
		return target;
	} catch (error) {
		if (error.code === 'ENOENT') return null;
		throw error;
	}
}

export function sha256(content) {
	return crypto.createHash('sha256').update(content).digest('hex');
}
