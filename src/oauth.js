import { spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import { isSecureUrl } from './config.js';
import { registerSecret } from './redact.js';
import { RemoteError } from './remote.js';

export const CLIENT_ID = 'testwise-mcp';
const PLACEHOLDER_REDIRECT = 'http://127.0.0.1/callback';

// Names a URL without its path or query, for messages.
function origin(url) {
	try {
		const parsed = new URL(url);
		return parsed.origin === 'null' ? `${parsed.protocol}…` : parsed.origin;
	} catch {
		return 'an invalid URL';
	}
}

// The fetch for every sign-in request (metadata discovery, token, revocation): it refuses any URL that is not https
// (see isSecureUrl), so a hostile or broken metadata document cannot send codes or tokens in clear text.
export function signInFetch(endpoint, fetchImpl = fetch) {
	return (input, init) => {
		const url = input instanceof Request ? input.url : String(input);
		if (!isSecureUrl(url, endpoint)) {
			return Promise.reject(new RemoteError('auth_server', `TestWise sign-in uses ${origin(url)}, which is not https, so it was not contacted.`));
		}
		return fetchImpl(input, init);
	};
}

// The OAuth client the SDK's auth() drives: the first-party public client "testwise-mcp", PKCE, a loopback redirect.
// Tokens live in the credential store. A provider made with { interactive: false } never opens a browser: when a
// new sign-in would be needed, it records that and lets the request fail, so the session can offer `connect`.
// The SDK never sees the refresh token: TokenRefresher (refresh.js) refreshes, once, under the credentials lock.
export class TestwiseOAuthProvider {
	constructor({ store, serverKey, endpoint = new URL(serverKey), interactive = false, redirectUrl, onAuthorizationUrl }) {
		this.store = store;
		this.serverKey = serverKey;
		this.endpoint = endpoint;
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
		// Never hand the opener anything but a web page: file:, ms-msdt: and other schemes can run programs.
		if (!isSecureUrl(authorizationUrl, this.endpoint)) {
			throw new RemoteError('auth_server', `TestWise advertised a sign-in page at ${origin(authorizationUrl)}, which is not https, so it was not opened.`);
		}
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

const PAGE_STYLE = 'body{margin:0;background:#0f172a;color:#e2e8f0;font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}'
	+ 'main{max-width:28rem;margin:12vh auto;padding:0 16px}'
	+ '.brand{display:flex;align-items:center;justify-content:center;gap:10px;margin-bottom:24px;font-size:12px;letter-spacing:1.2px;line-height:1.2;color:#fff}'
	+ '.card{background:#1e293b;border:1px solid #334155;border-radius:16px;padding:28px 24px;text-align:center}'
	+ '.mark{width:48px;height:48px;margin:0 auto 12px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:24px;font-weight:700}'
	+ '.ok{background:#14532d;color:#86efac}.no{background:#7f1d1d;color:#fca5a5}'
	+ 'h1{font-size:20px;margin:0 0 8px;color:#f8fafc}p{margin:0;color:#cbd5e1}'
	+ '.note{margin-top:16px;text-align:center;font-size:13px;color:#94a3b8}';
const SHIELD = '<svg width="36" height="36" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2 4 5v6c0 5 3.4 9.3 8 11 4.6-1.7 8-6 8-11V5z" fill="#6d5ce7"/>'
	+ '<path d="m8.5 12 2.5 2.5 4.5-5" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

// The page the browser lands on when TestWise sends it back here. This package serves it on 127.0.0.1, and people who
// expect a TestWise address are surprised by a local one, so it says why. Self-contained: no scripts, no requests.
function page(title, message, ok) {
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)} · TestWise</title>`
		+ `<style>${PAGE_STYLE}</style></head><body><main>`
		+ `<div class="brand">${SHIELD}<span>TEST<br>WISE</span></div>`
		+ `<div class="card"><div class="mark ${ok ? 'ok' : 'no'}" aria-hidden="true">${ok ? '✓' : '!'}</div><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></div>`
		+ '<p class="note">This page comes from TestWise MCP on this computer, which is why its address starts with 127.0.0.1.</p>'
		+ '</main></body></html>';
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

function plain(res, status, message, headers = {}) {
	res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...headers }).end(message);
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
		let url;
		try {
			url = new URL(req.url, 'http://127.0.0.1');
		} catch {
			plain(res, 400, 'Bad request');
			return;
		}
		if (url.pathname !== '/callback' || done) {
			plain(res, 404, 'Not found');
			return;
		}
		if (req.method !== 'GET') {
			plain(res, 405, 'Method not allowed', { Allow: 'GET' });
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
			? page('You\'re signed in to TestWise', 'Go back to your coding agent: it finishes connecting by itself. You can close this tab.', true)
			: page('Sign-in didn\'t finish', 'Go back to your coding agent and try again.', false));
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
