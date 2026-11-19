import { readFileSync } from 'node:fs';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { runCommand, USAGE } from './cli.js';
import { readConfig } from './config.js';
import { CredentialStore } from './credentials.js';
import { exitWithError, log } from './log.js';
import { createProxyServer } from './proxy.js';
import { Session } from './session.js';

export const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

export const LOCAL_TOOLS = [];

const CACHED_CONNECT_WAIT_MS = 15_000;

async function serve(config) {
	const store = new CredentialStore();
	const session = new Session({ endpoint: config.endpoint, store, clientInfo: { name: 'testwise-mcp', version }, log });

	// Connect with cached credentials before answering initialize, so the hosted instructions can be passed through.
	// This never opens a browser; without usable credentials the server starts signed out and offers `connect`.
	if (session.hasCredentials()) {
		let timer;
		const timeout = new Promise((resolve) => {
			timer = setTimeout(resolve, CACHED_CONNECT_WAIT_MS);
		});
		await Promise.race([
			session.connectWithCache().catch((error) => log(`Could not connect to TestWise yet: ${error.message}`)),
			timeout,
		]).finally(() => clearTimeout(timer));
	}
	for (const warning of store.takeWarnings()) log(warning);
	if (!session.connected) {
		log(`Not signed in to TestWise at ${config.endpoint.href}. The connect tool signs in through the browser; so does "npx -y testwise-mcp login".`);
	}

	const server = createProxyServer({ session, version, localTools: LOCAL_TOOLS });
	let closing = false;
	const shutdown = async () => {
		if (closing) return;
		closing = true;
		await server.close().catch(() => {});
		await session.close().catch(() => {});
		process.exit(0);
	};
	process.stdin.on('end', shutdown);
	process.stdin.on('close', shutdown);
	process.on('SIGINT', shutdown);
	process.on('SIGTERM', shutdown);

	await server.connect(new StdioServerTransport());
	if (session.connected) {
		log(`connected to ${config.endpoint.href}: ${session.tools.length} TestWise tools.`);
	}
}

export async function main(argv = process.argv.slice(2)) {
	const [command] = argv;
	if (command === '--version' || command === '-v') {
		process.stdout.write(`${version}\n`);
		return;
	}
	if (command === '--help' || command === '-h' || command === 'help') {
		process.stdout.write(USAGE);
		return;
	}
	if (command !== undefined && !['login', 'logout', 'status'].includes(command)) {
		process.stderr.write(USAGE);
		exitWithError(`unknown command "${command}"`, 2);
		return;
	}

	let config;
	try {
		config = readConfig(process.env);
	} catch (error) {
		exitWithError(error.message);
		return;
	}
	if (command === undefined) {
		await serve(config);
		return;
	}
	const code = await runCommand(command, { config, version });
	process.stdout.write('', () => process.exit(code));
}
