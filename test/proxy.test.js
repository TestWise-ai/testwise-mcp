import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { FAKE_INSTRUCTIONS, startFakeTestwise } from '../support/fake-testwise.js';
import { connectProxy, makeHome } from '../support/proxy-client.js';

function text(result) {
	return result.content.map((block) => block.text).join('\n');
}

async function signedInProxy() {
	const fake = await startFakeTestwise();
	const home = await makeHome();
	const credentials = fake.mintCredentials();
	await home.writeCredentials(credentials);
	const accessToken = Object.values(credentials.servers)[0].tokens.access_token;
	const proxy = await connectProxy({ url: fake.url, home: home.home });
	return { fake, home, proxy, accessToken };
}

describe('proxy over stdio', () => {
	let fake;
	let home;
	let proxy;
	let accessToken;

	before(async () => {
		({ fake, home, proxy, accessToken } = await signedInProxy());
	});

	after(async () => {
		await proxy?.close();
		await fake?.close();
		await home?.remove();
	});

	test('passes the hosted server instructions through', () => {
		assert.equal(proxy.client.getInstructions(), FAKE_INSTRUCTIONS);
		assert.equal(proxy.client.getServerVersion().name, 'testwise-mcp');
		assert.equal(proxy.client.getServerCapabilities().tools.listChanged, true);
	});

	test('lists the remote tools', async () => {
		const { tools } = await proxy.client.listTools();
		assert.deepEqual(tools.map((tool) => tool.name), [
			'whoami', 'get_updates', 'publish_release', 'get_item', 'request_retest', 'create_attachment_upload', 'complete_attachment_upload',
		]);
		assert.deepEqual(tools.find((tool) => tool.name === 'request_retest').inputSchema.required, ['key', 'build']);
	});

	test('discovers tools added to the hosted server without a restart', async () => {
		fake.addTool(
			{ name: 'list_releases', description: 'Releases, newest first.', inputSchema: { type: 'object', properties: {} } },
			() => ({ content: [{ type: 'text', text: '1 release\n{"releases":[{"name":"2.4"}]}' }] }),
		);
		const { tools } = await proxy.client.listTools();
		assert.ok(tools.some((tool) => tool.name === 'list_releases'));
		const result = await proxy.client.callTool({ name: 'list_releases', arguments: {} });
		assert.equal(text(result), '1 release\n{"releases":[{"name":"2.4"}]}');
	});

	test('forwards tools/call with its arguments and returns the result unchanged', async () => {
		const callsBefore = fake.state.calls.length;
		const result = await proxy.client.callTool({ name: 'request_retest', arguments: { key: 'LAR-41', build: 'iOS 212', note: 'Fixed the refresh.' } });
		assert.equal(result.isError, undefined);
		assert.equal(text(result), 'LAR-41 is in review; QA asked to re-test on iOS 212.\n{"key":"LAR-41","status":"IN_REVIEW"}');
		assert.deepEqual(fake.state.calls.slice(callsBefore), [
			{ name: 'request_retest', arguments: { key: 'LAR-41', build: 'iOS 212', note: 'Fixed the refresh.' } },
		]);
	});

	test('sends the cached access token to the hosted endpoint', () => {
		const posts = fake.state.requests.filter((request) => request.method === 'POST');
		assert.ok(posts.length > 0);
		assert.ok(posts.every((request) => request.authorization === `Bearer ${accessToken}`));
	});

	test('passes isError results through', async () => {
		const result = await proxy.client.callTool({ name: 'get_item', arguments: { key: 'NOPE-1' } });
		assert.equal(result.isError, true);
		assert.equal(text(result), 'Item NOPE-1 not found');
	});

	test('passes JSON-RPC errors from the hosted server through as a direct connection would see them', async () => {
		const direct = new Client({ name: 'direct-client', version: '0.0.0' }, { capabilities: {} });
		await direct.connect(new StreamableHTTPClientTransport(new URL(`${fake.url}/mcp`), {
			requestInit: { headers: { Authorization: `Bearer ${accessToken}` } },
		}));
		const directError = await direct.callTool({ name: 'no_such_tool', arguments: {} }).catch((error) => error);
		await direct.close();
		assert.equal(directError.code, -32602);
		await assert.rejects(
			proxy.client.callTool({ name: 'no_such_tool', arguments: {} }),
			(error) => error.code === directError.code && error.message === directError.message,
		);
	});

	test('redacts the access token from errors the hosted server returns', async () => {
		const result = await proxy.client.callTool({ name: 'get_item', arguments: { key: 'LEAK-1' } });
		assert.equal(result.isError, true);
		assert.ok(!text(result).includes(accessToken));
		assert.match(text(result), /may not read LEAK-1/);
	});

	test('connect reports an existing connection', async () => {
		const result = await proxy.client.callTool({ name: 'connect', arguments: {} });
		assert.match(text(result), /^Connected to TestWise\.\nProject Larder, as Pat Tester/);
		assert.equal(fake.state.authorizeRequests.length, 0);
	});

	test('never writes the token to stderr', () => {
		assert.match(proxy.stderr(), /connected to http:\/\/127\.0\.0\.1:\d+\/mcp: 7 TestWise tools\./);
		assert.ok(!proxy.stderr().includes(accessToken));
	});
});

describe('hosted server goes down mid-session', () => {
	let fake;
	let home;
	let proxy;

	before(async () => {
		({ fake, home, proxy } = await signedInProxy());
		await fake.close();
	});

	after(async () => {
		await proxy?.close();
		await home?.remove();
	});

	test('tools/call returns a clear isError result', async () => {
		const result = await proxy.client.callTool({ name: 'get_updates', arguments: {} });
		assert.equal(result.isError, true);
		assert.match(text(result), /^Could not reach TestWise at http:\/\/127\.0\.0\.1:\d+\/mcp \(ECONNREFUSED\)/);
	});

	test('tools/list falls back to the last known tools', async () => {
		const { tools } = await proxy.client.listTools();
		assert.ok(tools.some((tool) => tool.name === 'get_updates'));
		assert.match(proxy.stderr(), /Could not refresh the tool list/);
	});
});
