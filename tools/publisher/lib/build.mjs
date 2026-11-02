import { spawn } from 'node:child_process';
import { PublisherError } from './paths.mjs';

/**
 * 去掉仅用于开发沙箱的删除拦截 shim：它会拦截 Astro 清理 dist 时的批量删除，
 * 让正常构建以退出码 1 结束。其他 NODE_OPTIONS 参数保持不变。
 */
export function sanitizeNodeOptions(value) {
	const raw = String(value ?? '').trim();
	if (!raw) return '';
	const tokens = raw.split(/\s+/).filter((token) => !token.includes('node-safe-delete-shim'));
	const cleaned = tokens.join(' ').replace(/(^|\s)(--require|--import|--loader)\s*$/, '').trim();
	return cleaned;
}

function buildEnv() {
	const env = { ...process.env, CI: '1', FORCE_COLOR: '0' };
	if ('NODE_OPTIONS' in env) {
		const cleaned = sanitizeNodeOptions(env.NODE_OPTIONS);
		if (cleaned) env.NODE_OPTIONS = cleaned;
		else delete env.NODE_OPTIONS;
	}
	return env;
}

/** 运行固定的 npm production build，不接受任何来自 HTTP 的命令或参数。 */
export function runProductionBuild(root, options = {}) {
	return new Promise((resolve) => {
		const npmCli = process.env.npm_execpath;
		const command = npmCli ? process.execPath : process.env.npm_executable || 'npm';
		const args = npmCli ? [npmCli, 'run', 'build'] : ['run', 'build'];
		const child = spawn(command, args, {
			cwd: root,
			env: buildEnv(),
			shell: false,
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		let output = '';
		const append = (chunk) => {
			output = `${output}${chunk.toString()}`.slice(-200_000);
		};
		child.stdout.on('data', append);
		child.stderr.on('data', append);
		const timer = setTimeout(() => {
			child.kill('SIGTERM');
			output += '\n构建超过 180 秒，已终止。';
		}, options.timeout ?? 180_000);
		const startedAt = Date.now();
		child.on('error', (error) => {
			clearTimeout(timer);
			resolve({ ok: false, output: `${output}\n${error.message}`.trim(), durationMs: Date.now() - startedAt, exitCode: null });
		});
		child.on('close', (code) => {
			clearTimeout(timer);
			resolve({ ok: code === 0, output: output.trim(), durationMs: Date.now() - startedAt, exitCode: code });
		});
	});
}

export async function assertBuildRunner(fn) {
	if (typeof fn !== 'function') throw new PublisherError('构建执行器未配置。', 500);
}
