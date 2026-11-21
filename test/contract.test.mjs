import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const contract = JSON.parse(readFileSync(new URL('contract/answerer.json', root), 'utf8'));
const readme = readFileSync(new URL('README.md', root), 'utf8');

test('contract/answerer.json：字段齐全，地址只指向本机', () => {
	assert.ok(Array.isArray(contract));
	assert.equal(contract.length, 1);

	const wrapper = contract[0];
	// OCS 的 AnswerWrapperParser 只要求 name 是非空字符串（parser.ts:15-17），
	// 显示名属于产品命名，不该被测试钉死。
	assert.ok(typeof wrapper.name === 'string' && wrapper.name.trim().length > 0);
	assert.equal(wrapper.url, 'http://127.0.0.1:8787/answer');
	assert.equal(wrapper.homepage, 'http://127.0.0.1:8787');
	assert.equal(wrapper.method, 'post');
	assert.equal(wrapper.type, 'fetch');
	assert.equal(wrapper.responseType, 'json');
	assert.equal(wrapper.headers['Content-Type'], 'application/json');

	// 三个占位符必须与 OCS 的 env 字段同名（answer.wrapper.handler.ts:46-66）
	assert.deepEqual(wrapper.data, {
		title: '${title}',
		type: '${type}',
		options: '${options}'
	});
});

test('OCS handler：ok:true → [undefined, answer]；ok:false → undefined', () => {
	const wrapper = contract[0];
	// 与 OCS 一样用 Function(handler)() 执行（answer.wrapper.handler.ts:168）
	const handler = Function(wrapper.handler)();

	assert.deepEqual(handler({ ok: true, answer: 'C. 3' }), [undefined, 'C. 3']);
	assert.equal(handler({ ok: false, reason: 'low_confidence' }), undefined);
	assert.equal(handler({ ok: false, reason: 'provider_error' }), undefined);
	assert.equal(handler(null), undefined);
	assert.equal(handler({}), undefined);
});

test('README 声明了与 COMPAT 一致的兼容版本', () => {
	// 顶部是 banner，但兼容版本必须显式出现：改了 src/server.mjs 的 COMPAT
	// 而忘了改 README，这条测试会立刻失败。
	const compat = /export const COMPAT = '([^']+)'/.exec(readFileSync(new URL('src/server.mjs', root), 'utf8'))?.[1];
	assert.ok(compat, 'src/server.mjs 里找不到 COMPAT 常量');
	assert.ok(readme.includes(`兼容 ${compat}`), `README 必须出现「兼容 ${compat}」`);
});
