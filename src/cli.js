import { discoverOAuthServerInfo } from '@modelcontextprotocol/sdk/client/auth.js';
import { whoami } from './connect-tool.js';
import { CredentialStore, tokenExpiry } from './credentials.js';
import { log } from './log.js';
import { CLIENT_ID } from './oauth.js';
import { redact } from './redact.js';
import { Session } from './session.js';

const LOGIN_WAIT_MS = 10 * 60 * 1000;

export const USAGE = `Usage: testwise-mcp [command]

With no command, runs the TestWise MCP server over stdio (what MCP clients start).

Commands:
  login    Sign in to TestWise in the browser and choose a project
  logout   Revoke the saved sign-in and delete it from this machine
  status   Show whether this machine is signed in, and to which project

Environment:
  TESTWISE_URL   TestWise address (default https://app.testwise.ai)

Credentials are saved in ~/.testwise/credentials.json.
`;

function say(line) {
	process.stdout.write(`${line}\n`);
}

function flushWarnings(store) {
	for (const warning of store.takeWarnings()) log(warning);
}

async function revoke(endpoint, tokens) {
	const { authorizationServerMetadata: metadata } = await discoverOAuthServerInfo(endpoint);
	if (!metadata?.revocation_endpoint) return false;
	let revoked = true;
	for (const [token, hint] of [[tokens.refresh_token, 'refresh_token'], [tokens.access_token, 'access_token']]) {
		if (!token) continue;
		const response = await fetch(metadata.revocation_endpoint, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({ token, token_type_hint: hint, client_id: CLIENT_ID }),
			signal: AbortSignal.timeout(15_000),
		});
		await response.body?.cancel();
		if (!response.ok) revoked = false;
	}
	return revoked;
}

async function login({ config, session, store }) {
	const outcome = await session.connect({ waitMs: LOGIN_WAIT_MS });
	if (outcome.status !== 'connected') {
		log('The sign-in did not finish in time. Run "testwise-mcp login" again.');
		return 1;
	}
	say(`Signed in to TestWise at ${config.endpoint.href}.`);
	const identity = await whoami(session);
	if (identity) say(identity);
	flushWarnings(store);
	return 0;
}

async function logout({ config, store }) {
	const entry = store.get(config.endpoint.href);
	flushWarnings(store);
	if (!entry?.tokens) {
		say(`Not signed in to TestWise at ${config.endpoint.href}; nothing to do.`);
		return 0;
	}
	let revoked = false;
	try {
		revoked = await revoke(config.endpoint, entry.tokens);
	} catch (error) {
		log(`Could not reach TestWise to revoke the sign-in: ${error.message}`);
	}
	await store.removeTokens(config.endpoint.href);
	say(`Signed out of TestWise at ${config.endpoint.href}.`);
	if (!revoked) say('TestWise did not confirm the revocation, so the old sign-in stays valid until it expires or is revoked in TestWise.');
	return 0;
}

async function status({ config, session, store }) {
	const signInHint = 'Run "npx -y testwise-mcp login", or call the connect tool from your coding agent.';
	if (!session.hasCredentials()) {
		flushWarnings(store);
		say(`Not signed in to TestWise at ${config.endpoint.href}. ${signInHint}`);
		return 1;
	}
	let connected;
	try {
		connected = await session.connectWithCache();
	} catch (error) {
		say(`Signed in to TestWise at ${config.endpoint.href}, but it could not be reached: ${error.message}`);
		return 1;
	}
	flushWarnings(store);
	if (!connected) {
		say(`The saved sign-in for ${config.endpoint.href} has expired or was revoked. ${signInHint}`);
		return 1;
	}
	say(`Signed in to TestWise at ${config.endpoint.href}.`);
	const identity = await whoami(session);
	if (identity) say(identity);
	const expiry = tokenExpiry(store.get(config.endpoint.href));
	if (expiry) say(`The access token renews automatically; the current one expires at ${expiry.toISOString()}.`);
	return 0;
}

export async function runCommand(command, { config, version }) {
	const store = new CredentialStore();
	const session = new Session({ endpoint: config.endpoint, store, clientInfo: { name: 'testwise-mcp', version }, log });
	try {
		if (command === 'login') return await login({ config, session, store });
		if (command === 'logout') return await logout({ config, store });
		return await status({ config, session, store });
	} catch (error) {
		log(redact(error.message));
		return 1;
	} finally {
		await session.close();
	}
}
