import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { isSecureUrl } from '../src/config.js';
import { startFakeTestwise } from '../support/fake-testwise.js';
import { childEnv, connectProxy, makeHome, runBinary } from '../support/proxy-client.js';

function text(result) {
	return result.content.map((block) => block.text).join('\n');
}

// 0.0.0.0 reaches the fake on this machine but is not a loopback name, so it stands in for plain http on some other
// host without any traffic leaving the machine.
function plainHttp(fake, pathname) {
	return `http://0.0.0.0:${new URL(fake.url).port}${pathname}`;
}

test('only https, or http on loopback when TestWise itself is on loopback, counts as secure', () => {
	const hosted = new URL('https://app.testwise.example/mcp');
	const local = new URL('http://127.0.0.1:8080/mcp');
	assert.equal(isSecureUrl('https://login.example/authorize', hosted), true);
	assert.equal(isSecureUrl('http://127.0.0.1:9000/authorize', hosted), false, 'loopback http only for a loopback TestWise');
	assert.equal(isSecureUrl('http://127.0.0.1:9000/authorize', local), true);
	assert.equal(isSecureUrl('http://localhost:9000/authorize', local), true);
	assert.equal(isSecureUrl('http://login.example/authorize', local), false);
	for (const url of ['file:///etc/passwd', 'ms-msdt:/id', 'javascript:alert(1)', 'vscode://x', 'ftp://login.example/', 'not a url']) {
		assert.equal(isSecureUrl(url, local), false, url);
	}
});

describe('sign-in URLs from the metadata', () => {
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

	const endpoints = {
		'file:': () => 'file:///etc/passwd',
		'ms-msdt:': () => 'ms-msdt:/id',
		'a custom scheme': () => 'vscode://testwise/authorize',
		'plain http on another host': () => plainHttp(fake, '/oauth/authorize'),
	};
	for (const [label, endpoint] of Object.entries(endpoints)) {
		test(`an authorization endpoint using ${label} is never handed to the opener`, async () => {
			fake.state.metadataOverrides = { authorization_endpoint: endpoint() };
			proxy = await connectProxy({ url: fake.url, home: home.home });
			const result = await proxy.client.callTool({ name: 'connect', arguments: { waitSeconds: 2 } });
			assert.equal(result.isError, true, text(result));
			assert.match(text(result), /is not https, so it was not opened/);
			assert.deepEqual(await home.openedUrls(), []);
			assert.doesNotMatch(proxy.stderr(), /If no browser opened/);
			assert.equal(fake.state.authorizeRequests.length, 0);
		});
	}

	test('an authorization code is never sent to a token endpoint that is not https', async () => {
		fake.state.metadataOverrides = { token_endpoint: plainHttp(fake, '/oauth/token') };
		proxy = await connectProxy({ url: fake.url, home: home.home });
		const result = await proxy.client.callTool({ name: 'connect', arguments: {} });
		assert.equal(result.isError, true, text(result));
		assert.match(text(result), /uses http:\/\/0\.0\.0\.0:\d+, which is not https, so it was not contacted/);
		assert.equal(fake.state.tokenRequests.length, 0);
	});

	test('a refresh token is never sent to a token endpoint that is not https', async () => {
		await home.writeCredentials(fake.mintCredentials());
		fake.expireAccessTokens();
		fake.state.metadataOverrides = { token_endpoint: plainHttp(fake, '/oauth/token') };
		proxy = await connectProxy({ url: fake.url, home: home.home });
		assert.match(proxy.stderr(), /is not https, so it was not contacted/);
		assert.equal(fake.state.tokenRequests.length, 0);
	});
});

describe('logout', () => {
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

	test('tokens are not revoked at an authorization server other than the one that issued them', async () => {
		const credentials = fake.mintCredentials();
		Object.values(credentials.servers)[0].tokens.issuer = 'https://other-issuer.example';
		await home.writeCredentials(credentials);
		const logout = await runBinary(['logout'], childEnv({ url: fake.url, home: home.home }));
		assert.equal(logout.code, 0, logout.stderr);
		assert.deepEqual(fake.state.revocations, []);
		assert.match(logout.stdout, /did not confirm the revocation/);
		assert.deepEqual((await home.readCredentials()).servers, {}, 'the local copy is still deleted');
	});

	test('a redirect from the revocation endpoint is not followed', async () => {
		fake.state.revokeRedirect = true;
		await home.writeCredentials(fake.mintCredentials());
		const logout = await runBinary(['logout'], childEnv({ url: fake.url, home: home.home }));
		assert.equal(logout.code, 0, logout.stderr);
		assert.deepEqual(fake.state.revocations, [], 'the tokens were not posted again to the redirect target');
		assert.match(logout.stdout, /did not confirm the revocation/);
	});

	test('a revocation endpoint that is not https is not contacted', async () => {
		fake.state.metadataOverrides = { revocation_endpoint: plainHttp(fake, '/oauth/revoke') };
		await home.writeCredentials(fake.mintCredentials());
		const logout = await runBinary(['logout'], childEnv({ url: fake.url, home: home.home }));
		assert.equal(logout.code, 0, logout.stderr);
		assert.deepEqual(fake.state.revocations, []);
		assert.match(logout.stderr, /is not https, so it was not contacted/);
	});
});
