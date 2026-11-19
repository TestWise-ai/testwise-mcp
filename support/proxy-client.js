// Starts the real testwise-mcp binary over stdio and connects an MCP client to it, with HOME pointed at a
// temporary directory (so credentials land in <home>/.testwise) and BROWSER set to the fake browser.
import { spawn } from 'node:child_process';
import { chmodSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';

export const BIN = fileURLToPath(new URL('../bin/testwise-mcp.js', import.meta.url));
export const FAKE_BROWSER = fileURLToPath(new URL('./fake-browser.js', import.meta.url));
chmodSync(FAKE_BROWSER, 0o755);

export async function makeHome() {
	const home = await mkdtemp(path.join(os.tmpdir(), 'testwise-mcp-home-'));
	return {
		home,
		credentialsFile: path.join(home, '.testwise', 'credentials.json'),
		async writeCredentials(data, mode = 0o600) {
			await mkdir(path.join(home, '.testwise'), { recursive: true, mode: 0o700 });
			await writeFile(path.join(home, '.testwise', 'credentials.json'), typeof data === 'string' ? data : JSON.stringify(data), { mode });
		},
		async readCredentials() {
			return JSON.parse(await readFile(path.join(home, '.testwise', 'credentials.json'), 'utf8'));
		},
		// The URLs the fake browser was asked to open.
		async openedUrls() {
			try {
				return (await readFile(path.join(home, 'opened-urls.log'), 'utf8')).split('\n').filter(Boolean);
			} catch (error) {
				if (error.code === 'ENOENT') return [];
				throw error;
			}
		},
		remove: () => rm(home, { recursive: true, force: true }),
	};
}

export function childEnv({ url, home, browser = FAKE_BROWSER }) {
	return { TESTWISE_URL: url, HOME: home, USERPROFILE: home, BROWSER: browser };
}

export async function connectProxy({ url, home, cwd }) {
	const transport = new StdioClientTransport({
		command: process.execPath,
		args: [BIN],
		env: childEnv({ url, home }),
		cwd,
		stderr: 'pipe',
	});
	let stderr = '';
	transport.stderr.on('data', (chunk) => {
		stderr += chunk.toString('utf8');
	});
	const client = new Client({ name: 'test-client', version: '0.0.0' }, { capabilities: {} });
	let listChanged = 0;
	const waiters = [];
	client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
		listChanged += 1;
		for (const resolve of waiters.splice(0)) resolve();
	});
	await client.connect(transport);
	return {
		client,
		stderr: () => stderr,
		listChangedCount: () => listChanged,
		nextListChanged: () => new Promise((resolve) => waiters.push(resolve)),
		close: () => client.close(),
	};
}

// Runs the binary with arguments (a CLI command, or none) and collects how it exits.
export function runBinary(args, env, { timeoutMs = 20_000 } = {}) {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [BIN, ...args], { env: { PATH: process.env.PATH, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
		let stdout = '';
		let stderr = '';
		child.stdout.on('data', (chunk) => {
			stdout += chunk;
		});
		child.stderr.on('data', (chunk) => {
			stderr += chunk;
		});
		const timer = setTimeout(() => {
			child.kill();
			reject(new Error(`binary did not exit within ${timeoutMs} ms; stderr: ${stderr}`));
		}, timeoutMs);
		child.on('exit', (code) => {
			clearTimeout(timer);
			resolve({ code, stdout, stderr });
		});
	});
}
