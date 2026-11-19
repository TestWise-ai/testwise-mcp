import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { attachFile } from '../src/attach-file.js';

const SIGNATURE = 'sig0123456789abcdef';

// The hosted side of an upload, with the ticket create_attachment_upload returns; no network involved.
function stubRemote(endpoint, ticket) {
	const calls = [];
	return {
		calls,
		endpoint: new URL(endpoint),
		async callTool(name) {
			calls.push(name);
			const body = name === 'create_attachment_upload' ? { attachmentId: 'a1', method: 'PUT', ...ticket } : { attachment: { id: 'a1', status: 'ACTIVE' } };
			return { content: [{ type: 'text', text: `ok\n${JSON.stringify(body)}` }] };
		},
	};
}

function stubFetch() {
	const requests = [];
	const fetchImpl = async (url, init) => {
		requests.push({ url, headers: Object.fromEntries(init.headers) });
		return new Response(null, { status: 200 });
	};
	return { requests, fetchImpl };
}

function text(result) {
	return result.content.map((block) => block.text).join('\n');
}

describe('upload links and headers from TestWise', () => {
	let dir;
	let file;

	before(async () => {
		dir = await mkdtemp(path.join(os.tmpdir(), 'testwise-mcp-upload-'));
		file = path.join(dir, 'crash.log');
		await writeFile(file, 'boom');
	});

	after(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	function attach(endpoint, ticket) {
		const remote = stubRemote(endpoint, ticket);
		const { requests, fetchImpl } = stubFetch();
		const run = attachFile({ key: 'LAR-41', path: file }, { remote, cwd: dir, homeDir: dir, fetchImpl });
		return run.then((result) => ({ result, requests, remote }));
	}

	test('plain http to loopback is refused when TestWise is not on loopback', async () => {
		for (const uploadUrl of [`http://127.0.0.1:6379/a1?sig=${SIGNATURE}`, `http://localhost:9200/a1?sig=${SIGNATURE}`, `http://[::1]/a1?sig=${SIGNATURE}`]) {
			const { result, requests } = await attach('https://testwise.example/mcp', { uploadUrl });
			assert.equal(result.isError, true, uploadUrl);
			assert.match(text(result), /upload link that is not https, so the file was not sent/);
			assert.ok(!text(result).includes(SIGNATURE));
			assert.equal(requests.length, 0, uploadUrl);
		}
	});

	test('plain http to loopback is accepted when TestWise itself runs on loopback', async () => {
		const { result, requests } = await attach('http://127.0.0.1:8080/mcp', { uploadUrl: 'http://127.0.0.1:9000/a1?sig=x' });
		assert.equal(result.isError, undefined, text(result));
		assert.equal(requests.length, 1);
	});

	test('headers that would be invalid on the wire are reported, not thrown, and not echoed', async () => {
		for (const headers of [{ 'x-amz-meta-note': `a\r\nInjected: ${SIGNATURE}` }, { [`Bad Name ${SIGNATURE}`]: 'x' }]) {
			const { result, requests, remote } = await attach('https://testwise.example/mcp', { uploadUrl: 'https://storage.example/a1', headers });
			assert.equal(result.isError, true);
			assert.match(text(result), /upload headers that are not valid HTTP headers, so the file was not sent/);
			assert.ok(!text(result).includes(SIGNATURE));
			assert.equal(requests.length, 0);
			assert.deepEqual(remote.calls, ['create_attachment_upload']);
		}
	});

	test('credential and hop-by-hop headers are refused', async () => {
		for (const name of ['Host', 'Authorization', 'cookie', 'Proxy-Authorization', 'Connection', 'Keep-Alive', 'TE', 'Trailer', 'Transfer-Encoding', 'Upgrade']) {
			const { result, requests } = await attach('https://testwise.example/mcp', { uploadUrl: 'https://storage.example/a1', headers: { [name]: 'x' } });
			assert.equal(result.isError, true, name);
			assert.match(text(result), new RegExp(`asked for a ${name} header on the upload`));
			assert.equal(requests.length, 0, name);
		}
	});

	test('a slow upload reports progress at intervals, so the client keeps waiting', async () => {
		const remote = stubRemote('https://testwise.example/mcp', { uploadUrl: 'https://storage.example/a1?sig=x' });
		const updates = [];
		const fetchImpl = () => new Promise((resolve) => {
			setTimeout(() => resolve(new Response(null, { status: 200 })), 200);
		});
		const result = await attachFile({ key: 'LAR-41', path: file }, {
			remote, cwd: dir, homeDir: dir, fetchImpl, onprogress: (update) => updates.push(update), progressIntervalMs: 40,
		});
		assert.equal(result.isError, undefined, text(result));
		const messages = updates.map((update) => update.message);
		assert.match(messages[0], /^Uploading crash\.log \(4 B, text\/plain\) to LAR-41$/);
		assert.ok(messages.filter((message) => /^Still uploading crash\.log/.test(message)).length >= 2, messages.join(' | '));
		assert.match(messages.at(-1), /^Uploaded; adding it to LAR-41$/);
		assert.ok(updates.every((update, index) => index === 0 || update.progress > updates[index - 1].progress), 'progress only increases');
	});

	test('cancelling stops the upload and skips the complete step', async () => {
		const remote = stubRemote('https://testwise.example/mcp', { uploadUrl: 'https://storage.example/a1?sig=x' });
		const controller = new AbortController();
		let aborted = false;
		const fetchImpl = (url, init) => new Promise((resolve, reject) => {
			init.signal.addEventListener('abort', () => {
				aborted = true;
				reject(init.signal.reason);
			});
			setTimeout(() => controller.abort(), 20);
		});
		const result = await attachFile({ key: 'LAR-41', path: file }, { remote, cwd: dir, homeDir: dir, fetchImpl, signal: controller.signal });
		assert.equal(aborted, true, 'the upload request was aborted');
		assert.equal(result.isError, true);
		assert.match(text(result), /was cancelled/);
		assert.deepEqual(remote.calls, ['create_attachment_upload']);
	});

	test('a well-formed ticket still uploads with its headers', async () => {
		const { result, requests } = await attach('https://testwise.example/mcp', {
			uploadUrl: 'https://storage.example/a1?sig=x', headers: { 'If-None-Match': '*', 'x-amz-meta-sha256': 'abc' },
		});
		assert.equal(result.isError, undefined, text(result));
		assert.equal(requests[0].headers['if-none-match'], '*');
		assert.equal(requests[0].headers['content-type'], 'text/plain');
	});
});
