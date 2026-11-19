import { spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
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

function sameSecret(a, b) {
	const x = Buffer.from(String(a));
	const y = Buffer.from(String(b));
	return x.length === y.length && timingSafeEqual(x, y);
}

const ERROR_CODE = /^[A-Za-z0-9_.-]{1,64}$/;
const UNSAFE_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]+/g;

// Text that arrived in the callback URL, made safe to print: no control or bidi characters, at most max characters.
export function cleanText(value, max = 200) {
	const text = String(value ?? '').replace(UNSAFE_CHARACTERS, ' ').replace(/\s+/g, ' ').trim();
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function plain(res, status, message) {
	res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }).end(message);
}

// One-shot loopback listener for the authorization redirect (RFC 8252): 127.0.0.1, a random port, path /callback.
// Only a redirect carrying this sign-in's state (expectedState()) settles it; anything else is answered 400 and the
// listener keeps waiting, so another page cannot end or hijack the sign-in.
export async function startLoopback({ expectedState }) {
	let settle;
	const result = new Promise((resolve) => {
		settle = resolve;
	});
	let done = false;
	const server = http.createServer((req, res) => {
		const url = new URL(req.url, 'http://127.0.0.1');
		if (url.pathname !== '/callback' || done) {
			plain(res, 404, 'Not found');
			return;
		}
		const params = url.searchParams;
		const expected = expectedState();
		const state = params.get('state');
		if (!expected || !state || !sameSecret(state, expected)) {
			plain(res, 400, 'This link does not belong to the TestWise sign-in in progress.');
			return;
		}
		const code = params.get('code');
		const error = params.get('error');
		if (!code && !error) {
			plain(res, 400, 'Missing code');
			return;
		}
		done = true;
		registerSecret(code);
		const ok = Boolean(code) && !error;
		res.writeHead(ok ? 200 : 400, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
		res.end(ok
			? page('Signed in to TestWise', 'You can close this tab.')
			: page('Sign-in did not finish', 'Return to your coding agent and try again.'));
		settle({
			code: ok ? code : null,
			error: error === null ? null : ERROR_CODE.test(error) ? error : 'invalid_error',
			errorDescription: cleanText(params.get('error_description')) || null,
			iss: params.get('iss'),
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
