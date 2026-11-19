import { EventEmitter } from 'node:events';
import { auth } from '@modelcontextprotocol/sdk/client/auth.js';
import { openBrowser, signInFetch, startLoopback, TestwiseOAuthProvider } from './oauth.js';
import { authorizedFetch, TokenRefresher } from './refresh.js';
import { RemoteError, Remote, toRemoteError } from './remote.js';

const SIGN_IN_LIFETIME_MS = 10 * 60 * 1000;

function withTimeout(promise, ms) {
	let timer;
	const timeout = new Promise((resolve) => {
		timer = setTimeout(() => resolve({ timedOut: true }), ms);
	});
	return Promise.race([promise.then((value) => ({ value })), timeout]).finally(() => clearTimeout(timer));
}

// The connection to the hosted TestWise MCP endpoint. Emits 'change' whenever it connects or drops back to
// signed out, so the stdio server can send notifications/tools/list_changed.
export class Session extends EventEmitter {
	constructor({ endpoint, store, clientInfo, log, openUrl = openBrowser }) {
		super();
		this.endpoint = endpoint;
		this.serverKey = endpoint.href;
		this.store = store;
		this.clientInfo = clientInfo;
		this.log = log;
		this.openUrl = openUrl;
		this.remote = null;
		this.instructions = undefined;
		this.tools = [];
		this.signIn = null;
		this.connecting = null;
		this.signInFetch = signInFetch(endpoint);
		this.refresher = new TokenRefresher({ store, serverKey: this.serverKey, endpoint, fetchFn: this.signInFetch });
		this.fetch = authorizedFetch({ endpoint, refresher: this.refresher, fetchFn: this.signInFetch });
	}

	get connected() {
		return this.remote !== null;
	}

	hasCredentials() {
		return Boolean(this.store.get(this.serverKey)?.tokens);
	}

	// Connects with the cached credentials, refreshing them if needed. Never opens a browser.
	async connectWithCache() {
		if (this.connected) return true;
		if (!this.connecting) {
			this.connecting = this.openRemote().finally(() => {
				this.connecting = null;
			});
		}
		return this.connecting;
	}

	async openRemote() {
		if (!this.hasCredentials()) return false;
		const provider = new TestwiseOAuthProvider({ store: this.store, serverKey: this.serverKey, endpoint: this.endpoint });
		const remote = new Remote({
			endpoint: this.endpoint,
			authProvider: provider,
			clientInfo: this.clientInfo,
			fetch: this.fetch,
			onToolListChanged: () => this.remoteToolsChanged(remote),
		});
		try {
			await remote.connect();
			const tools = await remote.listTools();
			this.remote = remote;
			this.instructions = remote.instructions;
			this.tools = tools;
		} catch (error) {
			await remote.close().catch(() => {});
			if (error instanceof RemoteError && error.kind === 'auth') return false;
			throw error;
		}
		this.emit('change');
		return true;
	}

	async signedOut(reason) {
		if (!this.remote) return;
		const remote = this.remote;
		this.remote = null;
		this.tools = [];
		await remote.close().catch(() => {});
		this.log?.(reason);
		this.emit('change');
	}

	async refreshTools() {
		try {
			this.tools = await this.remote.listTools();
		} catch (error) {
			if (error instanceof RemoteError && error.kind === 'auth') {
				await this.signedOut(error.message);
				return;
			}
			this.log?.(`Could not refresh the tool list, so the last known list is used. ${error.message}`);
		}
	}

	// TestWise said its tool list changed: refresh it, and tell the client if it really did.
	async remoteToolsChanged(remote) {
		if (this.remote !== remote) return;
		const before = JSON.stringify(this.tools);
		await this.refreshTools();
		if (this.remote === remote && JSON.stringify(this.tools) !== before) this.emit('change');
	}

	async callTool(name, args, options) {
		try {
			return await this.remote.callTool(name, args, options);
		} catch (error) {
			if (error instanceof RemoteError && error.kind === 'auth') await this.signedOut(error.message);
			throw error;
		}
	}

	// Signs in through the browser: the first-party public client, PKCE (S256), a loopback redirect on a random port.
	// The SDK discovers the authorization server from the endpoint's 401 challenge (resource_metadata) or the
	// .well-known documents. One sign-in at a time; later callers share the pending one.
	startSignIn() {
		if (this.signIn) return this.signIn;
		const attempt = { url: null, done: null, close: () => {} };
		attempt.done = this.runSignIn(attempt).finally(() => {
			attempt.close();
			if (this.signIn === attempt) this.signIn = null;
		});
		attempt.done.catch(() => {});
		this.signIn = attempt;
		return attempt;
	}

	async runSignIn(attempt) {
		let provider;
		const loopback = await startLoopback({ expectedState: () => provider?.expectedState });
		const expiry = setTimeout(() => loopback.close(), SIGN_IN_LIFETIME_MS);
		expiry.unref();
		attempt.close = () => {
			clearTimeout(expiry);
			loopback.close();
		};
		provider = new TestwiseOAuthProvider({
			store: this.store,
			serverKey: this.serverKey,
			endpoint: this.endpoint,
			interactive: true,
			redirectUrl: loopback.redirectUrl,
			onAuthorizationUrl: (url) => {
				attempt.url = url.href;
				this.log?.raw(`Sign in to TestWise in your browser and choose a project. If no browser opened, visit:\n${url.href}`);
				this.openUrl(url.href);
			},
		});

		const probe = new Remote({ endpoint: this.endpoint, authProvider: provider, clientInfo: this.clientInfo, fetch: this.fetch });
		try {
			await probe.connect();
		} catch (error) {
			if (!(error instanceof RemoteError && error.kind === 'auth' && attempt.url)) throw error;
		} finally {
			await probe.close().catch(() => {});
		}
		if (!attempt.url) {
			// The cached credentials worked after all.
			if (await this.connectWithCache()) return;
			throw new RemoteError('auth', 'TestWise did not ask for a sign-in but refused the connection.');
		}

		let timer;
		const expired = new Promise((resolve) => {
			timer = setTimeout(() => resolve({ error: 'timeout' }), SIGN_IN_LIFETIME_MS);
			timer.unref();
		});
		const callback = await Promise.race([loopback.result, expired]).finally(() => clearTimeout(timer));
		if (callback.error === 'timeout') throw new RemoteError('auth', 'The sign-in link expired. Call connect again for a new one.');
		// The listener has already matched the state. RFC 9207: the response must name the authorization server that
		// this sign-in started at, and must name one at all when that server says it always does.
		const metadata = provider.discoveryState()?.authorizationServerMetadata;
		if (!callback.iss && metadata?.authorization_response_iss_parameter_supported === true) {
			throw new RemoteError('auth', 'Sign-in failed: the browser came back, but did not say which authorization server it came from.');
		}
		if (callback.iss && metadata?.issuer && callback.iss !== metadata.issuer) {
			throw new RemoteError('auth', 'Sign-in failed: the browser came back from a different authorization server.');
		}
		if (callback.error) {
			throw new RemoteError('auth', callback.error === 'access_denied'
				? 'Sign-in was declined in the browser.'
				: `Sign-in failed: ${callback.errorDescription || callback.error}.`);
		}
		try {
			await auth(provider, { serverUrl: this.endpoint, authorizationCode: callback.code, fetchFn: this.signInFetch });
		} catch (error) {
			throw toRemoteError(error, this.endpoint.href);
		}
		if (!(await this.connectWithCache())) {
			throw new RemoteError('auth', 'TestWise issued credentials but refused them. Call connect to try again.');
		}
	}

	// Connects, signing in through the browser if the cached credentials can't be used. Waits at most waitMs for the
	// sign-in; if it is still pending then, returns its URL and lets it finish in the background.
	async connect({ waitMs }) {
		if (this.connected) return { status: 'connected' };
		if (!this.signIn && (await this.connectWithCache())) return { status: 'connected' };
		const attempt = this.startSignIn();
		const outcome = await withTimeout(attempt.done, waitMs);
		if (!outcome.timedOut || this.connected) return { status: 'connected' };
		return { status: 'pending', url: attempt.url };
	}

	async close() {
		this.signIn?.close();
		await this.remote?.close().catch(() => {});
	}
}
