import { discoverOAuthServerInfo, extractWWWAuthenticateParams, refreshAuthorization, selectResourceURL } from '@modelcontextprotocol/sdk/client/auth.js';
import { InvalidGrantError, OAuthError, ServerError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { sameTokens, tokenExpiry } from './credentials.js';
import { CLIENT_ID } from './oauth.js';

// Renew the access token this long before it expires, so requests rarely meet a 401 at all.
const RENEW_BEFORE_MS = 60_000;
const TOKEN_REQUEST_TIMEOUT_MS = 15_000;

// Authorization server identifiers, compared as URLs and tolerating one trailing slash.
export function sameIssuer(a, b) {
	const normalize = (value) => {
		try {
			return new URL(value).href.replace(/\/$/, '');
		} catch {
			return String(value).replace(/\/$/, '');
		}
	};
	return normalize(a) === normalize(b);
}

// Refreshes the saved sign-in for one endpoint. A refresh token may be presented only once (TestWise rotates it, and
// a strict server revokes the sign-in on reuse), so:
// - in this process, concurrent callers share one refresh;
// - across processes, the refresh runs under the credentials lock, and re-reads the saved pair first: if another
//   process has already replaced the pair the caller used, the saved pair is returned and nothing is sent;
// - when TestWise answers invalid_grant, the pair is deleted only if it is still the one that failed.
// The SDK's own refresh is never used: the provider hides the refresh token from it.
export class TokenRefresher {
	constructor({ store, serverKey, endpoint, fetchFn = fetch }) {
		this.store = store;
		this.serverKey = serverKey;
		this.endpoint = endpoint;
		this.fetchFn = (url, init) => fetchFn(url, { ...init, signal: init?.signal ?? AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS) });
		this.pending = null;
		this.server = null;
	}

	tokens() {
		return this.store.get(this.serverKey)?.tokens ?? null;
	}

	expiresSoon() {
		const expiry = tokenExpiry(this.store.get(this.serverKey));
		return expiry !== null && expiry.getTime() - Date.now() < RENEW_BEFORE_MS;
	}

	// `seen` is the pair the caller sent. Resolves to the pair to use now, or null when there is none (signed out).
	refresh(seen, { resourceMetadataUrl } = {}) {
		if (!this.pending) {
			this.pending = this.run(seen, resourceMetadataUrl).finally(() => {
				this.pending = null;
			});
		}
		return this.pending;
	}

	async discover(resourceMetadataUrl) {
		if (!this.server) {
			const info = await discoverOAuthServerInfo(this.endpoint, { resourceMetadataUrl, fetchFn: this.fetchFn });
			const selected = await selectResourceURL(this.endpoint, {}, info.resourceMetadata);
			this.server = {
				issuer: String(info.authorizationServerUrl),
				metadata: info.authorizationServerMetadata,
				// Sent verbatim, as the SDK does: URL.href would add a trailing slash to a pathless resource.
				resource: selected && info.resourceMetadata ? info.resourceMetadata.resource : selected,
			};
		}
		return this.server;
	}

	async run(seen, resourceMetadataUrl) {
		// Discovery needs no lock, so it happens first and the lock is held only for the token request.
		const server = await this.discover(resourceMetadataUrl);
		const outcome = await this.store.withLock(async () => {
			const current = this.tokens();
			if (!current) return null;
			if (!sameTokens(current, seen)) return current;
			if (!current.refresh_token) return null;
			// A refresh token is only ever sent to the authorization server that issued it.
			if (current.issuer && !sameIssuer(current.issuer, server.issuer)) return null;
			let fresh;
			try {
				fresh = await refreshAuthorization(server.issuer, {
					metadata: server.metadata,
					clientInformation: { client_id: CLIENT_ID },
					refreshToken: current.refresh_token,
					resource: server.resource,
					fetchFn: this.fetchFn,
				});
			} catch (error) {
				if (error instanceof InvalidGrantError) {
					this.store.removeTokensIfHeld(this.serverKey, current);
					return null;
				}
				if (error instanceof OAuthError && !(error instanceof ServerError)) return null;
				throw error;
			}
			const tokens = { ...fresh, issuer: server.issuer };
			if (!this.store.holdsLock()) return { lostLock: true, from: current, tokens };
			this.store.saveTokensHeld(this.serverKey, tokens);
			return tokens;
		});
		if (!outcome?.lostLock) return outcome;
		// The lock was taken over while this refresh was slow. Under the lock again: if another process saved a newer
		// pair (or signed out) meanwhile, that stands; otherwise this pair is saved.
		return this.store.withLock(async () => {
			const stored = this.tokens();
			if (!sameTokens(stored, outcome.from)) return stored;
			this.store.saveTokensHeld(this.serverKey, outcome.tokens);
			return outcome.tokens;
		});
	}
}

function withBearer(init, tokens) {
	const headers = new Headers(init?.headers);
	if (tokens?.access_token) headers.set('Authorization', `Bearer ${tokens.access_token}`);
	else headers.delete('Authorization');
	return { ...init, headers };
}

// The fetch the MCP transport uses. Requests to the MCP endpoint carry the saved access token, renewed shortly before
// it expires; a 401 triggers one shared refresh and a single retry. Other requests (sign-in discovery and token
// requests made by the SDK) pass through to fetchFn.
export function authorizedFetch({ endpoint, refresher, fetchFn = fetch }) {
	return async (input, init) => {
		const url = input instanceof Request ? input.url : String(input);
		if (url !== endpoint.href) return fetchFn(input, init);

		let seen = refresher.tokens();
		if (seen?.refresh_token && refresher.expiresSoon()) {
			// A failed early renewal is not fatal: the current token may still be accepted, and a 401 tries again.
			seen = await refresher.refresh(seen).catch(() => seen);
		}
		const response = await fetchFn(input, withBearer(init, seen));
		if (response.status !== 401 || !seen) return response;

		let fresh;
		try {
			fresh = await refresher.refresh(seen, extractWWWAuthenticateParams(response));
		} catch (error) {
			await response.body?.cancel();
			throw error;
		}
		// Without a new pair the 401 goes back to the SDK, which reports that a sign-in is needed.
		if (!fresh || fresh.access_token === seen.access_token) return response;
		await response.body?.cancel();
		return fetchFn(input, withBearer(init, fresh));
	};
}
