import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import { FAKE_SIGNATURE, startFakeTestwise } from '../support/fake-testwise.js';
import { connectProxy, makeHome } from '../support/proxy-client.js';

const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(2048, 7)]);

function text(result) {
	return result.content.map((block) => block.text).join('\n');
}

function attach(proxy, args) {
	return proxy.client.callTool({ name: 'attach_file', arguments: args });
}

let accessToken;

function assertNoSecrets(value) {
	assert.ok(!value.includes(accessToken), 'token leaked');
	assert.ok(!value.includes(FAKE_SIGNATURE), 'upload signature leaked');
	assert.ok(!value.includes('X-Amz-'), 'upload URL leaked');
}

describe('attach_file', () => {
	let remote;
	let home;
	let proxy;
	let dir;
	let screenshot;

	before(async () => {
		dir = await mkdtemp(path.join(os.tmpdir(), 'testwise-mcp-'));
		screenshot = path.join(dir, 'shared-list.png');
		await writeFile(screenshot, PNG);
		remote = await startFakeTestwise();
		home = await makeHome();
		const credentials = remote.mintCredentials();
		accessToken = Object.values(credentials.servers)[0].tokens.access_token;
		await home.writeCredentials(credentials);
		proxy = await connectProxy({ url: remote.url, home: home.home, cwd: dir });
	});

	beforeEach(() => {
		remote.state.calls.length = 0;
		remote.state.uploadRequests.length = 0;
		remote.state.uploadResponse = null;
		remote.state.completeError = null;
	});

	after(async () => {
		await proxy?.close();
		await remote?.close();
		await home?.remove();
		await rm(dir, { recursive: true, force: true });
	});

	test('uploads the file and reports its size and type', async () => {
		const result = await attach(proxy, { key: 'LAR-41', path: screenshot });
		assert.equal(result.isError, undefined, text(result));
		const [summary, json] = text(result).split('\n');
		assert.equal(summary, 'Attached shared-list.png (2.0 KB, image/png) to LAR-41.');
		const payload = JSON.parse(json);
		const sha256 = createHash('sha256').update(PNG).digest('hex');
		assert.equal(payload.size, PNG.length);
		assert.equal(payload.contentType, 'image/png');
		assert.equal(payload.sha256, sha256);
		assert.equal(payload.attachment.status, 'ACTIVE');

		assert.deepEqual(remote.state.calls.map((call) => call.name), ['create_attachment_upload', 'complete_attachment_upload']);
		assert.deepEqual(remote.state.calls[0].arguments, {
			key: 'LAR-41', fileName: 'shared-list.png', contentType: 'image/png', size: PNG.length, checksum: sha256,
		});
		assert.deepEqual(remote.state.calls[1].arguments, { key: 'LAR-41', attachmentId: payload.attachmentId });

		const [put] = remote.state.uploadRequests;
		assert.equal(put.method, 'PUT');
		assert.equal(put.headers['content-type'], 'image/png');
		assert.equal(put.headers['if-none-match'], '*');
		assert.equal(put.headers['x-amz-meta-sha256'], sha256);
		assert.equal(put.headers.authorization, undefined, 'the token must never go to storage');
		assert.ok(remote.state.uploads.get(payload.attachmentId).received.equals(PNG));
		assertNoSecrets(text(result));
		assertNoSecrets(proxy.stderr());
	});

	test('reports progress to a client that asks for it', async () => {
		const updates = [];
		const result = await proxy.client.callTool({ name: 'attach_file', arguments: { key: 'LAR-41', path: screenshot } }, undefined, {
			onprogress: (update) => updates.push(update),
		});
		assert.equal(result.isError, undefined, text(result));
		assert.match(updates[0]?.message ?? '', /^Uploading shared-list\.png \(2\.0 KB, image\/png\) to LAR-41$/);
	});

	test('resolves a relative path against the working directory and honours name', async () => {
		const result = await attach(proxy, { key: 'LAR-41', path: 'shared-list.png', name: 'iphone-15-build-212.png' });
		assert.equal(result.isError, undefined, text(result));
		assert.match(text(result), /^Attached iphone-15-build-212\.png \(2\.0 KB, image\/png\) to LAR-41\./);
	});

	test('a refused create step is reported and nothing is uploaded', async () => {
		const result = await attach(proxy, { key: 'NOPE-9', path: screenshot });
		assert.equal(result.isError, true);
		assert.equal(
			text(result),
			'Not attached: TestWise refused the upload of shared-list.png (2.0 KB, image/png) to NOPE-9 (create_attachment_upload): Item NOPE-9 not found',
		);
		assert.equal(remote.state.uploadRequests.length, 0);
	});

	test('a 403 from storage is reported without the upload URL, and complete is not called', async () => {
		remote.state.uploadResponse = {
			status: 403,
			body: `<Error><Code>AccessDenied</Code><Message>Request has expired</Message><CanonicalQueryString>X-Amz-Signature=${FAKE_SIGNATURE}</CanonicalQueryString></Error>`,
		};
		const result = await attach(proxy, { key: 'LAR-41', path: screenshot });
		assert.equal(result.isError, true);
		assert.match(text(result), /^Not attached: uploading shared-list\.png \(2\.0 KB, image\/png\) to LAR-41 failed: storage answered HTTP 403 \(AccessDenied\)\. The upload link may have expired/);
		assert.deepEqual(remote.state.calls.map((call) => call.name), ['create_attachment_upload']);
		assertNoSecrets(text(result));
		assertNoSecrets(proxy.stderr());
	});

	test('an upload link that is not https is refused before any bytes are sent', async () => {
		const original = remote.state.tools.get('create_attachment_upload');
		remote.addTool(original.definition, () => ({
			content: [{ type: 'text', text: `Upload ready.\n${JSON.stringify({ attachmentId: 'a9', uploadUrl: `http://storage.example/a9?X-Amz-Signature=${FAKE_SIGNATURE}`, method: 'PUT', headers: {} })}` }],
		}));
		try {
			const result = await attach(proxy, { key: 'LAR-41', path: screenshot });
			assert.equal(result.isError, true);
			assert.match(text(result), /^Not attached: TestWise returned an upload link that is not https, so the file was not sent\./);
			assertNoSecrets(text(result));
			assert.equal(remote.state.uploadRequests.length, 0);
		} finally {
			remote.state.tools.set('create_attachment_upload', original);
		}
	});

	test('a failed complete step is reported', async () => {
		remote.state.completeError = 'The uploaded bytes do not match an allowed file type';
		const result = await attach(proxy, { key: 'LAR-41', path: screenshot });
		assert.equal(result.isError, true);
		assert.equal(
			text(result),
			'Not attached: shared-list.png (2.0 KB, image/png) was uploaded, but TestWise did not add it to LAR-41 (complete_attachment_upload): The uploaded bytes do not match an allowed file type',
		);
		assert.equal(remote.state.uploadRequests.length, 1);
	});

	test('a missing file is refused before TestWise is called', async () => {
		const missing = path.join(dir, 'nope.png');
		const result = await attach(proxy, { key: 'LAR-41', path: missing });
		assert.equal(result.isError, true);
		assert.equal(text(result), `Not attached: there is no file at ${missing}.`);
		assert.equal(remote.state.calls.length, 0);
	});

	test('a directory is refused', async () => {
		const folder = path.join(dir, 'recordings');
		await mkdir(folder, { recursive: true });
		const result = await attach(proxy, { key: 'LAR-41', path: folder });
		assert.equal(result.isError, true);
		assert.equal(text(result), `Not attached: ${folder} is a directory. Pass a single file.`);
		assert.equal(remote.state.calls.length, 0);
	});

	test('a file over 25 MB is refused with its size', async () => {
		const big = path.join(dir, 'screen-recording.mp4');
		await writeFile(big, '');
		await truncate(big, 25 * 1024 * 1024 + 1);
		const result = await attach(proxy, { key: 'LAR-41', path: big });
		assert.equal(result.isError, true);
		assert.equal(
			text(result),
			`Not attached: ${big} is 25.0 MB (26214401 bytes); the limit is 25 MB (26214400 bytes). Trim or compress it first.`,
		);
		assert.equal(remote.state.calls.length, 0);
	});

	test('a file of exactly 25 MB is accepted', async () => {
		const edge = path.join(dir, 'edge.mp4');
		await writeFile(edge, '');
		await truncate(edge, 25 * 1024 * 1024);
		const result = await attach(proxy, { key: 'LAR-42', path: edge });
		assert.equal(result.isError, undefined, text(result));
		assert.match(text(result), /^Attached edge\.mp4 \(25\.0 MB, video\/mp4\) to LAR-42\./);
	});

	test('an empty file is refused', async () => {
		const empty = path.join(dir, 'empty.log');
		await writeFile(empty, '');
		const result = await attach(proxy, { key: 'LAR-41', path: empty });
		assert.equal(result.isError, true);
		assert.equal(text(result), `Not attached: ${empty} is empty.`);
	});

	test('URLs are refused, file: included', async () => {
		for (const url of ['https://example.com/a.png', 'file:///etc/hosts', 'data:text/plain,hello']) {
			const result = await attach(proxy, { key: 'LAR-41', path: url });
			assert.equal(result.isError, true, url);
			assert.match(text(result), /is a URL scheme\. attach_file reads local files only/);
		}
		assert.equal(remote.state.calls.length, 0);
	});

	test('credentials, keys and secrets are refused, also through symlinks, before TestWise is called', async () => {
		const secrets = {
			'.ssh/id_ed25519': 'private key',
			'.aws/credentials': '[default]',
			'.config/gcloud/application_default_credentials.json': '{}',
			'.docker/config.json': '{"auths":{}}',
			'.npmrc': '//registry.example/:_authToken=x',
			'.netrc': 'machine example login me password x',
			'Library/Keychains/login.keychain-db': 'keychain',
		};
		for (const [name, content] of Object.entries(secrets)) {
			await mkdir(path.dirname(path.join(home.home, name)), { recursive: true });
			await writeFile(path.join(home.home, name), content);
		}
		const project = {
			'.env': 'API_KEY=x', '.env.local': 'API_KEY=x', 'server.pem': 'pem', 'tls.key': 'key', 'id_rsa': 'key', 'build.keychain': 'keychain',
		};
		for (const [name, content] of Object.entries(project)) await writeFile(path.join(dir, name), content);
		await symlink(path.join(home.home, '.testwise', 'credentials.json'), path.join(dir, 'evidence.png'));
		await symlink(path.join(dir, '.env'), path.join(dir, 'notes.txt'));
		await symlink(path.join(home.home, '.ssh'), path.join(dir, 'logs'));

		const refused = [
			'~/.testwise/credentials.json',
			path.join(home.home, '.testwise', 'credentials.json'),
			path.join(home.home, '.testwise', '..', '.testwise', 'credentials.json'),
			...Object.keys(secrets).map((name) => path.join(home.home, name)),
			...Object.keys(project),
			'evidence.png',
			'notes.txt',
			'logs/id_ed25519',
		];
		for (const target of refused) {
			const result = await attach(proxy, { key: 'LAR-41', path: target });
			assert.equal(result.isError, true, target);
			assert.match(text(result), /attach_file never uploads/, target);
		}
		assert.equal(remote.state.calls.length, 0, 'TestWise was never asked for an upload');
		assert.equal(remote.state.uploadRequests.length, 0);
	});

	test('a FIFO is refused without waiting for a writer', { skip: process.platform === 'win32' }, async () => {
		const fifo = path.join(dir, 'capture.log');
		execFileSync('mkfifo', [fifo]);
		const result = await attach(proxy, { key: 'LAR-41', path: fifo });
		assert.equal(result.isError, true);
		assert.equal(text(result), `Not attached: ${fifo} is not a regular file.`);
		await rm(fifo);
	});

	test('missing arguments are reported', async () => {
		const result = await attach(proxy, { key: '', path: screenshot });
		assert.equal(result.isError, true);
		assert.match(text(result), /"key" is required/);
	});
});
