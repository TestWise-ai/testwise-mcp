import assert from 'node:assert/strict';
import { once } from 'node:events';
import { after, before, test } from 'node:test';
import { CredentialStore } from '../src/credentials.js';
import { Session } from '../src/session.js';
import { startFakeTestwise } from '../support/fake-testwise.js';
import { makeHome } from '../support/proxy-client.js';

let fake;
let home;
let session;

before(async () => {
	fake = await startFakeTestwise();
	home = await makeHome();
	await home.writeCredentials(fake.mintCredentials());
});

after(async () => {
	await session?.close();
	await fake.close();
	await home.remove();
});

test('while in use, the session re-lists the tools once the list is older than the refresh interval', async () => {
	session = new Session({
		endpoint: new URL(`${fake.url}/mcp`),
		store: new CredentialStore({ homeDir: home.home }),
		clientInfo: { name: 'test', version: '0.0.0' },
		toolsRefreshMs: 100,
	});
	assert.equal(await session.connectWithCache(), true);
	fake.addTool({ name: 'list_releases', description: 'Releases, newest first.', inputSchema: { type: 'object', properties: {} } }, () => ({
		content: [{ type: 'text', text: '0 releases' }],
	}));

	await session.callTool('whoami', {});
	assert.ok(!session.tools.some((tool) => tool.name === 'list_releases'), 'not re-listed while the list is fresh');

	await new Promise((resolve) => setTimeout(resolve, 150));
	const changed = once(session, 'change');
	await session.callTool('whoami', {});
	await Promise.race([changed, new Promise((resolve, reject) => {
		setTimeout(() => reject(new Error('no change event')), 5000);
	})]);
	assert.ok(session.tools.some((tool) => tool.name === 'list_releases'));
});
