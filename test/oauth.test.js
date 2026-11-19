import assert from 'node:assert/strict';
import { stat } from 'node:fs/promises';
import net from 'node:net';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { FAKE_INSTRUCTIONS, startFakeTestwise } from '../support/fake-testwise.js';
import { childEnv, connectProxy, makeHome, runBinary } from '../support/proxy-client.js';

const POSIX = process.platform !== 'win32';

function text(result) {
	return result.content.map((block) => block.text).join('\n');
}

function names(tools) {
	return tools.map((tool) => tool.name);
}

function assertNoTokens(output, fake) {
	for (const token of [...fake.state.accessTokens.keys(), ...fake.state.refreshTokens.keys(), ...fake.state.codes.keys()]) {
		assert.ok(!output.includes(token), 'a token or code leaked');
	}
}

describe('signing in', () => {
	let fake;
	let home;
	let proxy;

	beforeEach(async () => {
		fake = await startFakeTestwise();
		home = await makeHome();
	});

	afterEach(async () => {
		await proxy?.close();
		proxy = null;
		await fake.close();
		await home.remove();
	});

	test('starts signed out without blocking initialize, offering connect and attach_file', async () => {
		proxy = await connectProxy({ url: fake.url, home: home.home });
		assert.match(proxy.client.getInstructions(), /Call the `connect` tool/);
		const { tools } = await proxy.client.listTools();
		assert.deepEqual(names(tools), ['connect', 'attach_file']);
		assert.equal(fake.state.authorizeRequests.length, 0, 'no browser before connect is called');
		assert.match(proxy.stderr(), /Not signed in to TestWise at http:\/\/127\.0\.0\.1:\d+\/mcp/);

		const call = await proxy.client.callTool({ name: 'get_updates', arguments: {} });
		assert.equal(call.isError, true);
		assert.match(text(call), /Call the connect tool to sign in/);
		const attach = await proxy.client.callTool({ name: 'attach_file', arguments: { key: 'LAR-41', path: '/tmp/x.png' } });
		assert.equal(attach.isError, true);
		assert.match(text(attach), /Not signed in/);
	});

	test('connect signs in through the browser, caches the credentials and switches to the remote tools', async () => {
		proxy = await connectProxy({ url: fake.url, home: home.home });
		const changed = proxy.nextListChanged();
		const result = await proxy.client.callTool({ name: 'connect', arguments: {} });
		assert.equal(result.isError, undefined, text(result));
		assert.match(text(result), /^Connected to TestWise\.\nProject Larder, as Pat Tester/);
		assert.ok(text(result).includes(`TestWise instructions:\n${FAKE_INSTRUCTIONS}`));
		await changed;

		const { tools } = await proxy.client.listTools();
		assert.deepEqual(names(tools), [
			'whoami', 'get_updates', 'publish_release', 'get_item', 'request_retest', 'create_attachment_upload', 'complete_attachment_upload', 'attach_file',
		]);
		const updates = await proxy.client.callTool({ name: 'get_updates', arguments: {} });
		assert.match(text(updates), /^1 new event: LAR-41 was filed by QA\./);

		const [authorize] = fake.state.authorizeRequests;
		assert.equal(authorize.client_id, 'testwise-mcp');
		assert.equal(authorize.code_challenge_method, 'S256');
		assert.equal(authorize.resource, `${fake.url}/mcp`);
		assert.match(authorize.redirect_uri, /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
		assert.ok(fake.state.discoveryRequests.includes('/.well-known/oauth-protected-resource/mcp'), 'discovery follows the 401 challenge');
		assert.deepEqual(fake.state.tokenRequests.map((request) => request.grantType), ['authorization_code']);

		const saved = await home.readCredentials();
		const entry = saved.servers[`${fake.url}/mcp`];
		assert.equal(entry.clientId, 'testwise-mcp');
		assert.ok(fake.state.accessTokens.has(entry.tokens.access_token));
		assert.match(proxy.stderr(), /Sign in to TestWise in your browser/);
		assertNoTokens(proxy.stderr(), fake);

		if (POSIX) {
			assert.equal((await stat(home.credentialsFile)).mode & 0o777, 0o600);
			assert.equal((await stat(`${home.home}/.testwise`)).mode & 0o777, 0o700);
		}
	});

	test('connect returns the link while the user is still signing in, then the tools appear on their own', async () => {
		fake.state.authorizeMode = 'hold';
		proxy = await connectProxy({ url: fake.url, home: home.home });
		const pending = await proxy.client.callTool({ name: 'connect', arguments: { waitSeconds: 1 } });
		assert.equal(pending.isError, undefined);
		assert.match(text(pending), /^Waiting for the user to sign in to TestWise/);
		assert.match(text(pending), /\nhttp:\/\/127\.0\.0\.1:\d+\/oauth\/authorize\?/);

		// The user approves in the same browser tab: replay the held request with the fake now approving.
		fake.state.authorizeMode = 'approve';
		const changed = proxy.nextListChanged();
		const link = /\n(http:\/\/127\.0\.0\.1:\d+\/oauth\/authorize\?\S+)\n/.exec(text(pending))[1];
		const approved = await fetch(link, { redirect: 'manual' });
		await fetch(approved.headers.get('location'));
		await changed;
		const { tools } = await proxy.client.listTools();
		assert.ok(names(tools).includes('get_updates'));
	});

	test('a declined sign-in is reported', async () => {
		fake.state.authorizeMode = 'deny';
		proxy = await connectProxy({ url: fake.url, home: home.home });
		const result = await proxy.client.callTool({ name: 'connect', arguments: {} });
		assert.equal(result.isError, true);
		assert.match(text(result), /Sign-in was declined in the browser/);
	});
});

describe('the sign-in callback', () => {
	let fake;
	let home;
	let proxy;

	beforeEach(async () => {
		fake = await startFakeTestwise();
		home = await makeHome();
	});

	afterEach(async () => {
		await proxy?.close();
		proxy = null;
		await fake.close();
		await home.remove();
	});

	async function pendingSignIn() {
		fake.state.authorizeMode = 'hold';
		proxy = await connectProxy({ url: fake.url, home: home.home });
		const pending = await proxy.client.callTool({ name: 'connect', arguments: { waitSeconds: 1 } });
		assert.match(text(pending), /^Waiting for the user to sign in/);
		while (fake.state.authorizeRequests.length === 0) await new Promise((resolve) => setTimeout(resolve, 20));
		const [authorize] = fake.state.authorizeRequests;
		return { callback: authorize.redirect_uri, state: authorize.state, link: /\n(http:\/\/127\.0\.0\.1:\d+\/oauth\/authorize\?\S+)\n/.exec(text(pending))[1] };
	}

	async function approve(link) {
		fake.state.authorizeMode = 'approve';
		const approved = await fetch(link, { redirect: 'manual' });
		return fetch(approved.headers.get('location'));
	}

	test('requests without the sign-in\'s state are refused and do not end the sign-in', { timeout: 15_000 }, async () => {
		const { callback, link } = await pendingSignIn();
		for (const query of ['code=attacker-code&state=wrong', 'code=attacker-code', 'error=access_denied', 'error=access_denied&state=wrong', 'state=']) {
			const response = await fetch(`${callback}?${query}`);
			assert.equal(response.status, 400, query);
			await response.body?.cancel();
		}

		const changed = proxy.nextListChanged();
		const landed = await approve(link);
		assert.equal(landed.status, 200);
		const html = await landed.text();
		assert.match(html, /<h1>You&#39;re signed in to TestWise<\/h1>/);
		assert.match(html, /which is why its address starts with 127\.0\.0\.1/, 'it explains the local address');
		assert.doesNotMatch(html, /<script|<link|src=|https?:\/\//, 'self-contained: no scripts and nothing fetched');
		await changed;
		assert.match(text(await proxy.client.callTool({ name: 'connect', arguments: {} })), /^Connected to TestWise\./);
		assert.deepEqual(fake.state.tokenRequests.map((request) => request.grantType), ['authorization_code'], 'the attacker code was never exchanged');
	});

	test('a malformed request or another method gets an error answer, and the server keeps running', { timeout: 15_000 }, async () => {
		const { callback, state, link } = await pendingSignIn();
		const { port } = new URL(callback);
		const raw = await new Promise((resolve, reject) => {
			const socket = net.connect(port, '127.0.0.1', () => socket.end('GET // HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n'));
			let answer = '';
			socket.on('data', (chunk) => {
				answer += chunk;
			});
			socket.on('end', () => resolve(answer));
			socket.on('error', reject);
		});
		assert.match(raw, /^HTTP\/1\.1 400 /);
		const posted = await fetch(`${callback}?error=access_denied&state=${state}`, { method: 'POST' });
		assert.equal(posted.status, 405);
		assert.equal(posted.headers.get('allow'), 'GET');

		const changed = proxy.nextListChanged();
		await approve(link);
		await changed;
		assert.ok(names((await proxy.client.listTools()).tools).includes('get_updates'));
	});

	test('a refused sign-in lands on a page that says it did not finish', { timeout: 15_000 }, async () => {
		const { callback, state } = await pendingSignIn();
		const landed = await fetch(`${callback}?error=access_denied&state=${state}`);
		assert.equal(landed.status, 400);
		const html = await landed.text();
		assert.match(html, /<h1>Sign-in didn&#39;t finish<\/h1>/);
		assert.match(html, /Go back to your coding agent and try again\./);
		assert.doesNotMatch(html, /<script|<link|src=|https?:\/\//);
	});

	test('an error from the authorization server is shown without control characters, and capped', async () => {
		fake.state.authorizeMode = 'deny';
		fake.state.denyError = 'server_error';
		fake.state.denyDescription = `Denied\u001b]0;owned\u0007\u001b[2J\r\n${'x'.repeat(500)}`;
		proxy = await connectProxy({ url: fake.url, home: home.home });
		const result = await proxy.client.callTool({ name: 'connect', arguments: {} });
		assert.equal(result.isError, true);
		assert.match(text(result), /^Could not connect to TestWise: Sign-in failed: Denied/);
		assert.doesNotMatch(text(result), /[\u0000-\u001f\u007f-\u009f]/);
		assert.ok(text(result).length < 300, `capped: ${text(result).length}`);
	});

	test('a callback without iss is refused when the server advertises it', async () => {
		fake.state.callbackIss = null;
		proxy = await connectProxy({ url: fake.url, home: home.home });
		const result = await proxy.client.callTool({ name: 'connect', arguments: {} });
		assert.equal(result.isError, true);
		assert.match(text(result), /did not say which authorization server it came from/);
		assert.equal(fake.state.tokenRequests.length, 0, 'the code was not exchanged');
	});

	test('a callback from another authorization server is refused', async () => {
		fake.state.callbackIss = 'https://other-issuer.example';
		proxy = await connectProxy({ url: fake.url, home: home.home });
		const result = await proxy.client.callTool({ name: 'connect', arguments: {} });
		assert.equal(result.isError, true);
		assert.match(text(result), /came back from a different authorization server/);
		assert.equal(fake.state.tokenRequests.length, 0);
	});
});

describe('cached credentials', () => {
	let fake;
	let home;
	let proxy;

	beforeEach(async () => {
		fake = await startFakeTestwise();
		home = await makeHome();
	});

	afterEach(async () => {
		await proxy?.close();
		proxy = null;
		await fake.close();
		await home.remove();
	});

	test('a cached token connects at startup, with the hosted instructions passed through', async () => {
		await home.writeCredentials(fake.mintCredentials());
		proxy = await connectProxy({ url: fake.url, home: home.home });
		assert.equal(proxy.client.getInstructions(), FAKE_INSTRUCTIONS);
		const { tools } = await proxy.client.listTools();
		assert.ok(names(tools).includes('publish_release'));
		assert.ok(!names(tools).includes('connect'));
		assert.equal(fake.state.authorizeRequests.length, 0);
		assert.equal(fake.state.tokenRequests.length, 0);
	});

	test('an expired access token is refreshed automatically and the new pair is saved', async () => {
		await home.writeCredentials(fake.mintCredentials());
		proxy = await connectProxy({ url: fake.url, home: home.home });
		const before = (await home.readCredentials()).servers[`${fake.url}/mcp`].tokens;
		fake.expireAccessTokens();

		const result = await proxy.client.callTool({ name: 'request_retest', arguments: { key: 'LAR-41', build: 'Android 2.4.1 (341)' } });
		assert.equal(result.isError, undefined, text(result));
		assert.deepEqual(fake.state.tokenRequests.map((request) => request.grantType), ['refresh_token']);
		assert.equal(fake.state.tokenRequests[0].resource, `${fake.url}/mcp`);
		const after = (await home.readCredentials()).servers[`${fake.url}/mcp`].tokens;
		assert.notEqual(after.access_token, before.access_token);
		assert.notEqual(after.refresh_token, before.refresh_token);
		assert.equal(fake.state.authorizeRequests.length, 0, 'refreshing never opens a browser');
		assertNoTokens(proxy.stderr(), fake);
	});

	test('a failed refresh drops back to connect, without opening a browser', async () => {
		await home.writeCredentials(fake.mintCredentials());
		proxy = await connectProxy({ url: fake.url, home: home.home });
		fake.expireAccessTokens();
		fake.state.failRefresh = true;
		const changed = proxy.nextListChanged();

		const result = await proxy.client.callTool({ name: 'get_updates', arguments: {} });
		assert.equal(result.isError, true);
		assert.match(text(result), /sign-in has expired or was revoked\. Call the connect tool/);
		await changed;
		const { tools } = await proxy.client.listTools();
		assert.deepEqual(names(tools), ['connect', 'attach_file']);
		assert.equal(fake.state.authorizeRequests.length, 0);
		assert.equal((await home.readCredentials()).servers[`${fake.url}/mcp`], undefined, 'the dead credentials are removed');

		fake.state.failRefresh = false;
		const reconnected = await proxy.client.callTool({ name: 'connect', arguments: {} });
		assert.match(text(reconnected), /^Connected to TestWise\./);
	});

	test('a corrupt credentials file is ignored with a warning and replaced by the next sign-in', async () => {
		await home.writeCredentials('{ not json');
		proxy = await connectProxy({ url: fake.url, home: home.home });
		assert.match(proxy.stderr(), /credentials\.json is not valid credentials JSON and was ignored/);
		assert.deepEqual(names((await proxy.client.listTools()).tools), ['connect', 'attach_file']);
		const result = await proxy.client.callTool({ name: 'connect', arguments: {} });
		assert.match(text(result), /^Connected to TestWise\./);
		assert.ok((await home.readCredentials()).servers[`${fake.url}/mcp`].tokens.access_token);
	});

	test('a credentials file readable by others is tightened to 0600', { skip: !POSIX }, async () => {
		await home.writeCredentials(fake.mintCredentials(), 0o644);
		proxy = await connectProxy({ url: fake.url, home: home.home });
		assert.equal((await stat(home.credentialsFile)).mode & 0o777, 0o600);
		assert.match(proxy.stderr(), /was readable by other users; its permissions are now 0600/);
	});
});

describe('login, status and logout', () => {
	let fake;
	let home;

	beforeEach(async () => {
		fake = await startFakeTestwise();
		home = await makeHome();
	});

	afterEach(async () => {
		await fake.close();
		await home.remove();
	});

	test('login signs in, status reports the project, logout revokes and deletes the credentials', async () => {
		const env = childEnv({ url: fake.url, home: home.home });

		const before = await runBinary(['status'], env);
		assert.equal(before.code, 1);
		assert.match(before.stdout, /^Not signed in to TestWise at http:\/\/127\.0\.0\.1:\d+\/mcp\./);

		const login = await runBinary(['login'], env);
		assert.equal(login.code, 0, login.stderr);
		assert.match(login.stdout, /^Signed in to TestWise at http:\/\/127\.0\.0\.1:\d+\/mcp\.\nProject Larder, as Pat Tester/);
		assert.match(login.stderr, /If no browser opened, visit:\nhttp:\/\/127\.0\.0\.1:\d+\/oauth\/authorize\?/);

		const status = await runBinary(['status'], env);
		assert.equal(status.code, 0, status.stderr);
		assert.match(status.stdout, /^Signed in to TestWise at .*\nProject Larder, as Pat Tester.*\nThe access token renews automatically; the current one expires at /);

		const logout = await runBinary(['logout'], env);
		assert.equal(logout.code, 0, logout.stderr);
		assert.match(logout.stdout, /^Signed out of TestWise at /);
		assert.deepEqual(fake.state.revocations.map((revocation) => revocation.hint), ['refresh_token', 'access_token']);
		assert.equal(fake.liveTokenCount(), 0);
		assert.deepEqual((await home.readCredentials()).servers, {});

		const after = await runBinary(['status'], env);
		assert.equal(after.code, 1);
		for (const output of [login.stdout, login.stderr, status.stdout, status.stderr, logout.stdout, logout.stderr]) assertNoTokens(output, fake);
	});

	test('status reports a corrupt credentials file instead of crashing', async () => {
		await home.writeCredentials('[]');
		const status = await runBinary(['status'], childEnv({ url: fake.url, home: home.home }));
		assert.equal(status.code, 1);
		assert.match(status.stderr, /is not valid credentials JSON/);
		assert.match(status.stdout, /^Not signed in/);
	});

	test('logout without credentials is a no-op', async () => {
		const logout = await runBinary(['logout'], childEnv({ url: fake.url, home: home.home }));
		assert.equal(logout.code, 0);
		assert.match(logout.stdout, /nothing to do/);
	});

	test('an unknown command prints usage', async () => {
		const result = await runBinary(['frobnicate'], childEnv({ url: fake.url, home: home.home }));
		assert.equal(result.code, 2);
		assert.match(result.stderr, /Usage: testwise-mcp \[command\]/);
	});
});

