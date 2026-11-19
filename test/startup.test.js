import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { closedPort, startFakeTestwise } from '../support/fake-testwise.js';
import { childEnv, connectProxy, makeHome, runBinary } from '../support/proxy-client.js';

describe('startup', () => {
	let fake;
	let home;

	before(async () => {
		fake = await startFakeTestwise();
		home = await makeHome();
	});

	after(async () => {
		await fake?.close();
		await home?.remove();
	});

	test('plain http is refused for anything but localhost', async () => {
		const { code, stdout, stderr } = await runBinary([], childEnv({ url: 'http://testwise.example', home: home.home }));
		assert.equal(code, 1);
		assert.equal(stdout, '');
		assert.match(stderr, /^testwise-mcp: TESTWISE_URL must start with https:\/\//);
	});

	test('an invalid TESTWISE_URL is refused', async () => {
		const { code, stderr } = await runBinary([], childEnv({ url: 'not a url', home: home.home }));
		assert.equal(code, 1);
		assert.match(stderr, /TESTWISE_URL is not a valid URL/);
	});

	test('an unreachable server with cached credentials still starts, signed out, and connect explains why', async () => {
		const port = await closedPort();
		const url = `http://127.0.0.1:${port}`;
		const credentials = fake.mintCredentials();
		await home.writeCredentials({ version: 1, servers: { [`${url}/mcp`]: Object.values(credentials.servers)[0] } });
		const proxy = await connectProxy({ url, home: home.home });
		try {
			assert.match(proxy.stderr(), new RegExp(`Could not connect to TestWise yet: Could not reach TestWise at http://127\\.0\\.0\\.1:${port}/mcp \\(ECONNREFUSED\\)`));
			const { tools } = await proxy.client.listTools();
			assert.deepEqual(tools.map((tool) => tool.name), ['connect']);
			const result = await proxy.client.callTool({ name: 'connect', arguments: { waitSeconds: 1 } });
			assert.equal(result.isError, true);
			assert.match(result.content[0].text, /^Could not connect to TestWise: Could not reach TestWise at .* \(ECONNREFUSED\)/);
		} finally {
			await proxy.close();
		}
	});

	test('a URL without an MCP endpoint is reported as such', async () => {
		const url = `${fake.url}/nothing-here`;
		const credentials = fake.mintCredentials();
		await home.writeCredentials({ version: 1, servers: { [`${url}/mcp`]: Object.values(credentials.servers)[0] } });
		const proxy = await connectProxy({ url, home: home.home });
		try {
			assert.match(proxy.stderr(), /No TestWise MCP endpoint answered at http:\/\/127\.0\.0\.1:\d+\/nothing-here\/mcp \(HTTP 404\)/);
		} finally {
			await proxy.close();
		}
	});

	test('--version and --help answer without starting the server', async () => {
		const version = await runBinary(['--version'], childEnv({ url: fake.url, home: home.home }));
		assert.equal(version.code, 0);
		assert.match(version.stdout, /^\d+\.\d+\.\d+\n$/);
		const help = await runBinary(['--help'], childEnv({ url: fake.url, home: home.home }));
		assert.equal(help.code, 0);
		assert.match(help.stdout, /login {4}Sign in to TestWise/);
	});
});
