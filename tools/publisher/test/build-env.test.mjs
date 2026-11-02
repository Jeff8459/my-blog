import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeNodeOptions } from '../lib/build.mjs';

test('构建环境只剥离沙箱删除拦截 shim，其他 NODE_OPTIONS 参数保留', () => {
	assert.equal(sanitizeNodeOptions('--max-old-space-size=4096 --require /tmp/shim/node-safe-delete-shim.cjs'), '--max-old-space-size=4096');
	assert.equal(sanitizeNodeOptions('--require /Applications/WorkBuddy.app/vendor/node-safe-delete-shim.cjs'), '');
	assert.equal(sanitizeNodeOptions('--max-old-space-size=4096'), '--max-old-space-size=4096');
	assert.equal(sanitizeNodeOptions(''), '');
	assert.equal(sanitizeNodeOptions(undefined), '');
});

test('同时存在多个 --require 时不会留下悬空参数', () => {
	assert.equal(sanitizeNodeOptions('--require /tmp/a.cjs --require /tmp/node-safe-delete-shim.cjs'), '--require /tmp/a.cjs');
});
