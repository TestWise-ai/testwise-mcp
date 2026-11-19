import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import { registerSecret } from './redact.js';

export const CLIENT_ID = 'testwise-mcp';
const PLACEHOLDER_REDIRECT = 'http://127.0.0.1/callback';

// The OAuth client the SDK's auth() drives: the first-party public client "testwise-mcp", PKCE, a loopback redirect.
// Tokens live in the credential store. A provider made with { interactive: false } never opens a browser: when a
// new sign-in would be needed, it records that and lets the request fail, so the session can offer `connect`.
// The SDK never sees the refresh token: TokenRefresher (refresh.js) refreshes, once, under the credentials lock.
export class TestwiseOAuthProvider {
	constructor({ store, serverKey, interactive = false, redirectUrl, onAuthorizationUrl }) {
		this.store = store;
		this.serverKey = serverKey;
		this.interactive = interactive;
		this._redirectUrl = redirectUrl ?? PLACEHOLDER_REDIRECT;
		this.onAuthorizationUrl = onAuthorizationUrl;
		this.authorizationUrl = null;
		this.needsSignIn = false;
		this._codeVerifier = null;
		this._state = null;
		this._discovery = undefined;
		this._lastTokens = null;
	}

	get redirectUrl() {
		return this._redirectUrl;
	}

	get clientMetadata() {
		return {
			client_name: 'TestWise MCP',
			redirect_uris: [this._redirectUrl],
			grant_types: ['authorization_code', 'refresh_token'],
			response_types: ['code'],
			token_endpoint_auth_method: 'none',
			scope: 'handoff',
		};
	}

	clientInformation() {
		return { client_id: CLIENT_ID };
	}

	state() {
		this._state = randomBytes(24).toString('base64url');
		return this._state;
	}

	get expectedState() {
		return this._state;
	}

	tokens() {
		const tokens = this.store.get(this.serverKey)?.tokens ?? null;
		this._lastTokens = tokens;
		if (!tokens) return undefined;
		const { refresh_token: hidden, ...withoutRefresh } = tokens;
		return withoutRefresh;
	}

	async saveTokens(tokens) {
		await this.store.saveTokens(this.serverKey, tokens);
	}

	// Deletes the saved pair only if it is still the one this provider handed out.
	async invalidateCredentials(scope) {
		if ((scope === 'all' || scope === 'tokens') && this._lastTokens) await this.store.removeTokensIf(this.serverKey, this._lastTokens);
		if (scope === 'all' || scope === 'verifier') this._codeVerifier = null;
		if (scope === 'all' || scope === 'discovery') this._discovery = undefined;
	}

	redirectToAuthorization(authorizationUrl) {
		this.authorizationUrl = authorizationUrl;
		if (!this.interactive) {
			this.needsSignIn = true;
			return;
		}
		this.onAuthorizationUrl?.(authorizationUrl);
	}

	saveCodeVerifier(codeVerifier) {
		registerSecret(codeVerifier);
		this._codeVerifier = codeVerifier;
	}

	codeVerifier() {
		if (!this._codeVerifier) throw new Error('No sign-in is in progress.');
		return this._codeVerifier;
	}

	discoveryState() {
		return this._discovery;
	}

	saveDiscoveryState(state) {
		this._discovery = state;
	}
}

function escapeHtml(text) {
	return String(text).replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

function page(title, message) {
	return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title>`
		+ '<style>body{font:16px/1.5 system-ui,sans-serif;margin:15vh auto;max-width:32rem;padding:0 16px;color:#1f2937}</style></head>'
		+ `<body><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></body></html>`;
}

// One-shot loopback listener for the authorization redirect (RFC 8252): 127.0.0.1, a random port, path /callback.
export async function startLoopback() {
	let settle;
	const result = new Promise((resolve) => {
		settle = resolve;
	});
	let done = false;
	const server = http.createServer((req, res) => {
		const url = new URL(req.url, 'http://127.0.0.1');
		if (url.pathname !== '/callback' || done) {
			res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
			return;
		}
		const code = url.searchParams.get('code');
		const error = url.searchParams.get('error');
		if (!code && !error) {
			res.writeHead(400, { 'Content-Type': 'text/plain' }).end('Missing code');
			return;
		}
		done = true;
		registerSecret(code);
		const ok = Boolean(code) && !error;
		res.writeHead(ok ? 200 : 400, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
		res.end(ok
			? page('Signed in to TestWise', 'You can close this tab.')
			: page('Sign-in did not finish', url.searchParams.get('error_description') || error));
		settle({
			code,
			error,
			errorDescription: url.searchParams.get('error_description'),
			state: url.searchParams.get('state'),
			iss: url.searchParams.get('iss'),
		});
	});
	await new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', resolve);
	});
	const { port } = server.address();
	return {
		redirectUrl: `http://127.0.0.1:${port}/callback`,
		result,
		close() {
			server.closeAllConnections?.();
			server.close();
		},
	};
}

// Opens the sign-in page. BROWSER, if set, names the program to run (the usual convention); otherwise the
// platform's default opener. Failures are ignored: the URL is always printed as well.
export function openBrowser(url) {
	const target = String(url);
	const custom = process.env.BROWSER?.trim();
	const [command, args] = custom
		? [custom, [target]]
		: process.platform === 'darwin'
			? ['open', [target]]
			: process.platform === 'win32'
				? ['rundll32', ['url.dll,FileProtocolHandler', target]]
				: ['xdg-open', [target]];
	try {
		const child = spawn(command, args, { stdio: 'ignore', detached: true });
		child.on('error', () => {});
		child.unref();
	} catch {
		// The printed URL is the fallback.
	}
}
