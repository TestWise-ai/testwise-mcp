import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { lstat, mkdir, readdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { CredentialStore } from '../src/credentials.js';
import { TestwiseOAuthProvider } from '../src/oauth.js';
import { FAKE_INSTRUCTIONS, startFakeTestwise } from '../support/fake-testwise.js';
import { connectProxy, makeHome } from '../support/proxy-client.js';

function text(result) {
	return result.content.map((block) => block.text).join('\n');
}

function tokenPair(tag) {
	return { access_token: `at_${tag}_0123456789`, token_type: 'Bearer', expires_in: 3600, refresh_token: `rt_${tag}_0123456789` };
}

async function postToken(fake, params) {
	const response = await fetch(`${fake.url}/oauth/token`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({ client_id: 'testwise-mcp', resource: `${fake.url}/mcp`, ...params }),
	});
	return { status: response.status, body: await response.json() };
}

describe('refreshing at expiry', () => {
	let fake;
	let home;
	let proxies;

	beforeEach(async () => {
		home = await makeHome();
		proxies = [];
	});

	afterEach(async () => {
		for (const proxy of proxies) await proxy.close();
		await fake?.close();
		fake = null;
		await home.remove();
	});

	async function savedTokens() {
		return (await home.readCredentials()).servers[`${fake.url}/mcp`]?.tokens;
	}

	for (const refreshReuse of ['strict', 'grace']) {
		test(`parallel tool calls at expiry refresh once (${refreshReuse} server)`, async () => {
			fake = await startFakeTestwise({ refreshReuse });
			await home.writeCredentials(fake.mintCredentials());
			const proxy = await connectProxy({ url: fake.url, home: home.home });
			proxies.push(proxy);
			fake.expireAccessTokens();
			fake.state.tokenDelayMs = 200;

			const results = await Promise.all(
				Array.from({ length: 6 }, (_, index) => proxy.client.callTool({ name: 'request_retest', arguments: { key: 'LAR-41', build: `iOS ${index}` } })),
			);
			for (const result of results) assert.equal(result.isError, undefined, text(result));
			assert.equal(fake.refreshCount(), 1, 'one refresh for all the calls');
			assert.deepEqual(fake.state.reuseDetections, [], 'no refresh token was presented twice');
			assert.ok(fake.isLive(await savedTokens()), 'the saved pair is the live one');
		});
	}

	test('two servers starting at once share one refresh, and both stay signed in (strict server)', async () => {
		fake = await startFakeTestwise({ refreshReuse: 'strict' });
		await home.writeCredentials(fake.mintCredentials());
		fake.expireAccessTokens();
		fake.state.tokenDelayMs = 300;

		const started = await Promise.all([0, 1, 2].map(() => connectProxy({ url: fake.url, home: home.home })));
		proxies.push(...started);
		for (const proxy of started) {
			assert.equal(proxy.client.getInstructions(), FAKE_INSTRUCTIONS, `connected at startup: ${proxy.stderr()}`);
			const result = await proxy.client.callTool({ name: 'whoami', arguments: {} });
			assert.equal(result.isError, undefined, text(result));
		}
		assert.equal(fake.refreshCount(), 1, 'one refresh across the processes');
		assert.deepEqual(fake.state.reuseDetections, []);
		assert.ok(fake.isLive(await savedTokens()));
	});

	test('an access token about to expire is renewed before it is sent', async () => {
		fake = await startFakeTestwise({ refreshReuse: 'strict' });
		const credentials = fake.mintCredentials();
		const entry = Object.values(credentials.servers)[0];
		entry.savedAt = new Date(Date.now() - (entry.tokens.expires_in - 10) * 1000).toISOString();
		await home.writeCredentials(credentials);
		const proxy = await connectProxy({ url: fake.url, home: home.home });
		proxies.push(proxy);

		assert.equal(proxy.client.getInstructions(), FAKE_INSTRUCTIONS);
		assert.equal(fake.refreshCount(), 1);
		assert.ok(!fake.state.requests.some((request) => request.authorization === `Bearer ${entry.tokens.access_token}`), 'the old token was never used');
		assert.ok(fake.isLive(await savedTokens()));
	});

	test('the fake models the hosted grace window and a strict server', async () => {
		fake = await startFakeTestwise({ graceMs: 150 });
		const [first, other] = [fake.mintCredentials(), fake.mintCredentials()].map((data) => Object.values(data.servers)[0].tokens);
		const a = await postToken(fake, { grant_type: 'refresh_token', refresh_token: first.refresh_token });
		const b = await postToken(fake, { grant_type: 'refresh_token', refresh_token: first.refresh_token });
		assert.equal(a.status, 200);
		assert.deepEqual(b, a, 'inside the window every presenter gets the same successor pair');
		await new Promise((resolve) => {
			setTimeout(resolve, 200);
		});
		const late = await postToken(fake, { grant_type: 'refresh_token', refresh_token: first.refresh_token });
		assert.equal(late.body.error, 'invalid_grant');
		assert.ok(!fake.isLive({ access_token: a.body.access_token, refresh_token: a.body.refresh_token }), 'reuse after the window revokes the family');
		assert.ok(fake.isLive(other), 'other sign-ins keep working');

		fake.state.refreshReuse = 'strict';
		const fresh = Object.values(fake.mintCredentials().servers)[0].tokens;
		assert.equal((await postToken(fake, { grant_type: 'refresh_token', refresh_token: fresh.refresh_token })).status, 200);
		assert.equal((await postToken(fake, { grant_type: 'refresh_token', refresh_token: fresh.refresh_token })).body.error, 'invalid_grant');
	});
});

describe('credentials store', () => {
	let home;

	beforeEach(async () => {
		home = await makeHome();
	});

	afterEach(async () => {
		await home.remove();
	});

	test('invalid_grant deletes the saved pair only if it is still the one that failed', async () => {
		const key = 'https://testwise.example/mcp';
		const mine = new CredentialStore({ homeDir: home.home });
		const otherProcess = new CredentialStore({ homeDir: home.home });
		await mine.saveTokens(key, tokenPair('old'));
		const provider = new TestwiseOAuthProvider({ store: mine, serverKey: key });
		assert.equal(provider.tokens().access_token, 'at_old_0123456789');
		await otherProcess.saveTokens(key, tokenPair('new'));

		await provider.invalidateCredentials('tokens');
		assert.equal(mine.get(key).tokens.refresh_token, 'rt_new_0123456789', 'a pair saved meanwhile survives');

		provider.tokens();
		await provider.invalidateCredentials('tokens');
		assert.equal(mine.get(key), null, 'the pair that failed is deleted');
	});

	test('a credentials file that is a symlink is neither followed nor chmodded, and a save replaces the link', { skip: process.platform === 'win32' }, async () => {
		const elsewhere = path.join(home.home, 'shared-notes.json');
		await writeFile(elsewhere, JSON.stringify({ version: 1, servers: { 'https://testwise.example/mcp': { tokens: tokenPair('planted') } } }), { mode: 0o644 });
		await mkdir(path.join(home.home, '.testwise'), { recursive: true, mode: 0o700 });
		await symlink(elsewhere, home.credentialsFile);

		const store = new CredentialStore({ homeDir: home.home });
		assert.equal(store.get('https://testwise.example/mcp'), null, 'the linked file is not read');
		assert.match(store.takeWarnings().join('\n'), /credentials\.json is not a regular file/);
		assert.equal((await stat(elsewhere)).mode & 0o777, 0o644, 'the link target keeps its permissions');

		await store.saveTokens('https://testwise.example/mcp', tokenPair('mine'));
		const saved = await lstat(home.credentialsFile);
		assert.ok(saved.isFile(), 'the link was replaced by a regular file');
		assert.equal(saved.mode & 0o777, 0o600);
		assert.match(await readFile(elsewhere, 'utf8'), /planted/, 'the link target is untouched');
		assert.deepEqual((await readdir(path.join(home.home, '.testwise'))).filter((name) => name.endsWith('.tmp')), [], 'no temporary file is left');
	});

	test('the credentials lock serializes writers and recovers from a stale lock', async () => {
		const store = new CredentialStore({ homeDir: home.home });
		const order = [];
		const slow = store.withLock(async () => {
			order.push('a:start');
			await new Promise((resolve) => {
				setTimeout(resolve, 100);
			});
			order.push('a:end');
		});
		const other = new CredentialStore({ homeDir: home.home });
		const second = other.withLock(async () => {
			order.push('b');
		});
		await Promise.all([slow, second]);
		assert.deepEqual(order, ['a:start', 'a:end', 'b']);

		// A lock left by a process that has exited is taken over at once.
		const exited = spawn(process.execPath, ['-e', '']);
		const deadPid = await new Promise((resolve) => {
			exited.on('exit', () => resolve(exited.pid));
		});
		await mkdir(path.join(home.home, '.testwise'), { recursive: true });
		const lockFile = path.join(home.home, '.testwise', 'credentials.lock');
		await writeFile(lockFile, JSON.stringify({ pid: deadPid, host: os.hostname(), at: Date.now() }));
		const started = Date.now();
		assert.equal(await store.withLock(async () => 'taken'), 'taken');
		assert.ok(Date.now() - started < 2000);

		// So is one older than any refresh could take, whoever holds it.
		await writeFile(lockFile, JSON.stringify({ pid: process.pid, host: os.hostname(), at: Date.now() - 10 * 60 * 1000 }));
		assert.equal(await store.withLock(async () => 'taken again'), 'taken again');
	});
});
