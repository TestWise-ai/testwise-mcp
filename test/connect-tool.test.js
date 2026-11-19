import assert from 'node:assert/strict';
import { test } from 'node:test';
import { connectTool, runConnect } from '../src/connect-tool.js';

// Most MCP clients give up on a request after 60 seconds, so connect must answer well before that.
test('connect waits less than a minute, whatever waitSeconds asks for', async () => {
	const waits = [];
	const session = {
		tools: [],
		async connect({ waitMs }) {
			waits.push(waitMs);
			return { status: 'pending', url: 'https://testwise.example/oauth/authorize' };
		},
	};
	for (const waitSeconds of [120, 59, 3600, Infinity]) await runConnect({ waitSeconds }, { session });
	await runConnect({}, { session });
	await runConnect({ waitSeconds: 5 }, { session });
	assert.ok(waits.slice(0, 4).every((ms) => ms <= 50_000), waits.join(', '));
	assert.equal(waits[4], 45_000, 'the default');
	assert.equal(waits[5], 5_000);
	assert.match(connectTool.inputSchema.properties.waitSeconds.description, /at most 50\)/);
	assert.equal(connectTool.inputSchema.properties.waitSeconds.maximum, 50);
});
