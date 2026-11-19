import { redact } from './redact.js';

export const DEFAULT_URL = 'https://app.testwise.ai';

export class ConfigError extends Error {}

export function isLoopbackHost(hostname) {
	return hostname === 'localhost' || hostname === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(hostname);
}

// TESTWISE_URL is the only setting. The MCP endpoint is <TESTWISE_URL>/mcp; it also keys the cached credentials.
export function readConfig(env) {
	const rawUrl = (env.TESTWISE_URL ?? '').trim() || DEFAULT_URL;
	let base;
	try {
		base = new URL(rawUrl);
	} catch {
		throw new ConfigError(`TESTWISE_URL is not a valid URL: ${redact(rawUrl)}`);
	}
	if (base.username || base.password) throw new ConfigError('TESTWISE_URL must not contain a user name or password.');
	const secure = base.protocol === 'https:' || (base.protocol === 'http:' && isLoopbackHost(base.hostname));
	if (!secure) {
		throw new ConfigError('TESTWISE_URL must start with https:// (http:// is allowed only for localhost), so tokens never travel in clear text.');
	}
	const path = base.pathname.replace(/\/+$/, '');
	const endpoint = new URL(`${base.origin}${path.endsWith('/mcp') ? path : `${path}/mcp`}`);
	return { endpoint };
}
