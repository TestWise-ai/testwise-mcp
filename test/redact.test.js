import assert from 'node:assert/strict';
import { test } from 'node:test';
import { forgetSecret, redact, redactDeep, registerSecret } from '../src/redact.js';

test('removes bearer values and token fields', () => {
	assert.equal(redact('Authorization: Bearer abc.def.ghi'), 'Authorization: Bearer [redacted]');
	assert.equal(redact('{"access_token":"at_123","refresh_token":"rt_456","expires_in":3600}'), '{"access_token":"[redacted]","refresh_token":"[redacted]","expires_in":3600}');
	assert.equal(redact('grant_type=refresh_token&refresh_token=rt_456&client_id=x'), 'grant_type=refresh_token&refresh_token=[redacted]&client_id=x');
	assert.equal(redact('error code: 403'), 'error code: 403');
});

test('removes the query string of any URL, where signatures and codes live', () => {
	assert.equal(
		redact('PUT https://bucket.example/p/a.png?X-Amz-Signature=deadbeef&X-Amz-Credential=KEY failed'),
		'PUT https://bucket.example/p/a.png?[redacted] failed',
	);
	assert.equal(redact('callback http://127.0.0.1:5000/callback?code=abc&state=xyz'), 'callback http://127.0.0.1:5000/callback?[redacted]');
	assert.equal(redact('see https://testwise.example/releases'), 'see https://testwise.example/releases');
});

test('removes registered secrets wherever they appear', () => {
	registerSecret('opaque-secret-value');
	assert.equal(redact('x opaque-secret-value y'), 'x [redacted] y');
	forgetSecret('opaque-secret-value');
	assert.equal(redact('x opaque-secret-value y'), 'x opaque-secret-value y');
});

test('redacts nested values', () => {
	assert.deepEqual(redactDeep({ content: [{ type: 'text', text: 'Bearer at_abcdefghijklmnop' }], isError: true }), {
		content: [{ type: 'text', text: 'Bearer [redacted]' }],
		isError: true,
	});
});
