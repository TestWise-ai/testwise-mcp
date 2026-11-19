import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerSecret } from './redact.js';

const POSIX = process.platform !== 'win32';

function registerTokens(tokens) {
	registerSecret(tokens?.access_token);
	registerSecret(tokens?.refresh_token);
}

// OAuth credentials, one entry per TestWise MCP endpoint, in ~/.testwise/credentials.json.
// The directory is 0700 and the file 0600; every write replaces the file atomically.
export class CredentialStore {
	constructor({ homeDir = os.homedir() } = {}) {
		this.dir = path.join(homeDir, '.testwise');
		this.file = path.join(this.dir, 'credentials.json');
		this.warnings = [];
	}

	warn(message) {
		if (!this.warnings.includes(message)) this.warnings.push(message);
	}

	takeWarnings() {
		const warnings = this.warnings;
		this.warnings = [];
		return warnings;
	}

	readAll() {
		let text;
		try {
			if (POSIX && (statSync(this.file).mode & 0o077) !== 0) {
				chmodSync(this.file, 0o600);
				this.warn(`${this.file} was readable by other users; its permissions are now 0600.`);
			}
			text = readFileSync(this.file, 'utf8');
		} catch (error) {
			if (error.code === 'ENOENT') return { version: 1, servers: {} };
			this.warn(`${this.file} could not be read (${error.code ?? error.message}); sign in again to replace it.`);
			return { version: 1, servers: {} };
		}
		try {
			const data = JSON.parse(text);
			if (!data || typeof data !== 'object' || !data.servers || typeof data.servers !== 'object' || Array.isArray(data.servers)) {
				throw new Error('unexpected shape');
			}
			for (const entry of Object.values(data.servers)) registerTokens(entry?.tokens);
			return { version: 1, servers: data.servers };
		} catch {
			this.warn(`${this.file} is not valid credentials JSON and was ignored; signing in again replaces it.`);
			return { version: 1, servers: {} };
		}
	}

	writeAll(data) {
		mkdirSync(this.dir, { recursive: true, mode: 0o700 });
		if (POSIX && (statSync(this.dir).mode & 0o077) !== 0) chmodSync(this.dir, 0o700);
		const temp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
		try {
			writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
			if (POSIX) chmodSync(temp, 0o600);
			renameSync(temp, this.file);
		} catch (error) {
			rmSync(temp, { force: true });
			throw error;
		}
	}

	get(serverKey) {
		const entry = this.readAll().servers[serverKey];
		return entry && typeof entry === 'object' ? entry : null;
	}

	update(serverKey, change) {
		const data = this.readAll();
		const next = change(data.servers[serverKey] ?? null);
		if (next) data.servers[serverKey] = next;
		else delete data.servers[serverKey];
		this.writeAll(data);
	}

	saveTokens(serverKey, tokens) {
		registerTokens(tokens);
		this.update(serverKey, (entry) => ({ ...(entry ?? {}), clientId: 'testwise-mcp', tokens, savedAt: new Date().toISOString() }));
	}

	removeTokens(serverKey) {
		if (!this.get(serverKey)) return false;
		this.update(serverKey, () => null);
		return true;
	}
}

export function tokenExpiry(entry) {
	const seconds = Number(entry?.tokens?.expires_in);
	const savedAt = Date.parse(entry?.savedAt ?? '');
	if (!Number.isFinite(seconds) || !Number.isFinite(savedAt)) return null;
	return new Date(savedAt + seconds * 1000);
}
