import { randomBytes } from 'node:crypto';
import {
	chmodSync, closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync,
	utimesSync, writeSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { registerSecret } from './redact.js';

const POSIX = process.platform !== 'win32';

// The credentials lock is held for one read-modify-write, or one refresh: a token request with a 15 s timeout. Its
// holder touches it every LOCK_HEARTBEAT_MS, so a lock untouched for LOCK_STALE_MS (well above the longest hold), or
// left by a process that has exited, was abandoned and is taken over.
const LOCK_STALE_MS = 60_000;
const LOCK_HEARTBEAT_MS = 5_000;
const LOCK_WAIT_MS = 90_000;
const LOCK_RETRY_MS = 25;
// The breaker file is held only for the instant it takes to re-check and remove a stale lock.
const BREAKER_STALE_MS = 10_000;

function registerTokens(tokens) {
	registerSecret(tokens?.access_token);
	registerSecret(tokens?.refresh_token);
}

export function sameTokens(a, b) {
	return Boolean(a && b) && a.access_token === b.access_token && a.refresh_token === b.refresh_token;
}

function processIsGone(pid) {
	try {
		process.kill(pid, 0);
		return false;
	} catch (error) {
		return error.code === 'ESRCH';
	}
}

// OAuth credentials, one entry per TestWise MCP endpoint, in ~/.testwise/credentials.json.
// The directory is 0700 and the file 0600; every write replaces the file atomically. Every change is a
// read-modify-write under ~/.testwise/credentials.lock, so testwise-mcp processes sharing the file never lose
// each other's changes. Reads take no lock: the file is only ever replaced whole.
export class CredentialStore {
	constructor({ homeDir = os.homedir(), heartbeatMs = LOCK_HEARTBEAT_MS } = {}) {
		this.dir = path.join(homeDir, '.testwise');
		this.file = path.join(this.dir, 'credentials.json');
		this.lockFile = path.join(this.dir, 'credentials.lock');
		this.breakerFile = `${this.lockFile}.break`;
		this.heartbeatMs = heartbeatMs;
		this.heldLock = null;
		this.warnings = [];
		this.queue = Promise.resolve();
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
		let fd;
		try {
			// Only a regular file is read: a symlink here is not followed (nor its target chmodded).
			if (!lstatSync(this.file).isFile()) {
				this.warn(`${this.file} is not a regular file, so it was ignored; signing in again replaces it.`);
				return { version: 1, servers: {} };
			}
			fd = openSync(this.file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
			if (POSIX && (fstatSync(fd).mode & 0o077) !== 0) {
				fchmodSync(fd, 0o600);
				this.warn(`${this.file} was readable by other users; its permissions are now 0600.`);
			}
			text = readFileSync(fd, 'utf8');
		} catch (error) {
			if (error.code === 'ENOENT') return { version: 1, servers: {} };
			this.warn(`${this.file} could not be read (${error.code ?? error.message}); sign in again to replace it.`);
			return { version: 1, servers: {} };
		} finally {
			if (fd !== undefined) closeSync(fd);
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

	ensureDir() {
		mkdirSync(this.dir, { recursive: true, mode: 0o700 });
		if (POSIX && (statSync(this.dir).mode & 0o077) !== 0) chmodSync(this.dir, 0o700);
	}

	// Runs task while holding the credentials lock: one task at a time in this process, and across processes
	// through the lock file, created exclusively.
	withLock(task) {
		const run = this.queue.then(async () => {
			const release = await this.acquireLock();
			try {
				return await task();
			} finally {
				release();
			}
		});
		this.queue = run.catch(() => {});
		return run;
	}

	async acquireLock() {
		this.ensureDir();
		const deadline = Date.now() + LOCK_WAIT_MS;
		for (;;) {
			const mine = this.tryCreateLock();
			if (mine) return this.holdLock(mine);
			if (this.lockIsStale()) {
				this.breakStaleLock();
				continue;
			}
			if (Date.now() > deadline) throw new Error(`${this.lockFile} is held by another testwise-mcp process. Try again shortly.`);
			await delay(LOCK_RETRY_MS);
		}
	}

	// Creates the lock file if there is none, stamped with the moment it was created. Returns its content, or null.
	tryCreateLock() {
		let fd;
		try {
			fd = openSync(this.lockFile, 'wx', 0o600);
		} catch (error) {
			if (error.code === 'EEXIST') return null;
			throw error;
		}
		const mine = JSON.stringify({ pid: process.pid, host: os.hostname(), at: Date.now(), id: randomBytes(8).toString('hex') });
		try {
			writeSync(fd, mine);
		} finally {
			closeSync(fd);
		}
		return mine;
	}

	holdLock(mine) {
		this.heldLock = mine;
		const heartbeat = setInterval(() => {
			try {
				const now = new Date();
				utimesSync(this.lockFile, now, now);
			} catch {
				// Gone; the release below copes.
			}
		}, this.heartbeatMs);
		heartbeat.unref();
		return () => {
			clearInterval(heartbeat);
			this.heldLock = null;
			this.removeLockIfMine(mine);
		};
	}

	removeLockIfMine(mine) {
		try {
			if (readFileSync(this.lockFile, 'utf8') === mine) rmSync(this.lockFile, { force: true });
		} catch {
			// Already gone.
		}
	}

	// Resolves once every change queued so far, and any queued while waiting, has been written.
	async idle() {
		let current;
		do {
			current = this.queue;
			await current;
		} while (current !== this.queue);
	}

	// Whether the lock file still holds this store's lock: another process takes over a lock that looks abandoned,
	// for instance after this machine slept while holding it.
	holdsLock() {
		if (!this.heldLock) return false;
		try {
			return readFileSync(this.lockFile, 'utf8') === this.heldLock;
		} catch {
			return false;
		}
	}

	// For an exiting process: gives up the lock if this store holds it.
	releaseHeldLock() {
		if (this.heldLock) this.removeLockIfMine(this.heldLock);
		this.heldLock = null;
	}

	// Several processes may find the same stale lock. Only one at a time may remove it: the one holding the breaker
	// file, and only if the lock is still stale then. The others, re-checking after it, find the new holder's lock.
	breakStaleLock() {
		let fd;
		try {
			fd = openSync(this.breakerFile, 'wx', 0o600);
		} catch (error) {
			if (error.code !== 'EEXIST') throw error;
			// A breaker left by a process that died in that instant is cleared once it is old.
			try {
				if (Date.now() - statSync(this.breakerFile).mtimeMs > BREAKER_STALE_MS) rmSync(this.breakerFile, { force: true });
			} catch {
				// Already gone.
			}
			return;
		}
		closeSync(fd);
		try {
			if (this.lockIsStale()) rmSync(this.lockFile, { force: true });
		} finally {
			rmSync(this.breakerFile, { force: true });
		}
	}

	lockIsStale() {
		let info = null;
		let modified;
		try {
			modified = statSync(this.lockFile).mtimeMs;
			info = JSON.parse(readFileSync(this.lockFile, 'utf8'));
		} catch (error) {
			if (error.code === 'ENOENT') return false;
			// Unreadable, or still being written: judged by its age alone.
		}
		// The holder's heartbeat moves the modification time forward.
		const touched = Math.max(Number.isFinite(info?.at) ? info.at : 0, Number.isFinite(modified) ? modified : 0);
		if (touched > 0 && Date.now() - touched > LOCK_STALE_MS) return true;
		return info?.host === os.hostname() && Number.isInteger(info?.pid) && processIsGone(info.pid);
	}

	// Writes a new file under an unguessable name, created exclusively (never through an existing file or link),
	// flushes it to disk, then renames it over credentials.json, replacing the file (or a link) in one step.
	writeAll(data) {
		this.ensureDir();
		const temp = `${this.file}.${randomBytes(8).toString('hex')}.tmp`;
		let fd;
		try {
			fd = openSync(temp, 'wx', 0o600);
			writeSync(fd, `${JSON.stringify(data, null, 2)}\n`);
			fsyncSync(fd);
			closeSync(fd);
			fd = undefined;
			if (POSIX) chmodSync(temp, 0o600);
			renameSync(temp, this.file);
		} catch (error) {
			if (fd !== undefined) closeSync(fd);
			rmSync(temp, { force: true });
			throw error;
		}
	}

	get(serverKey) {
		const entry = this.readAll().servers[serverKey];
		return entry && typeof entry === 'object' ? entry : null;
	}

	// The *Held methods expect the caller to hold the lock (see withLock); the others take it themselves.
	updateHeld(serverKey, change) {
		const data = this.readAll();
		const entry = data.servers[serverKey] ?? null;
		const next = change(entry);
		if (next === entry) return;
		if (next) data.servers[serverKey] = next;
		else delete data.servers[serverKey];
		this.writeAll(data);
	}

	update(serverKey, change) {
		return this.withLock(() => this.updateHeld(serverKey, change));
	}

	saveTokensHeld(serverKey, tokens) {
		registerTokens(tokens);
		this.updateHeld(serverKey, (entry) => ({ ...(entry ?? {}), clientId: 'testwise-mcp', tokens, savedAt: new Date().toISOString() }));
	}

	saveTokens(serverKey, tokens) {
		return this.withLock(() => this.saveTokensHeld(serverKey, tokens));
	}

	async removeTokens(serverKey) {
		let removed = false;
		await this.update(serverKey, (entry) => {
			removed = Boolean(entry);
			return null;
		});
		return removed;
	}

	// Compare-and-delete: removes the saved pair only if it is still `tokens`, so a pair another process saved
	// meanwhile survives.
	removeTokensIfHeld(serverKey, tokens) {
		this.updateHeld(serverKey, (entry) => (sameTokens(entry?.tokens, tokens) ? null : entry));
	}

	removeTokensIf(serverKey, tokens) {
		return this.withLock(() => this.removeTokensIfHeld(serverKey, tokens));
	}
}

export function tokenExpiry(entry) {
	const seconds = Number(entry?.tokens?.expires_in);
	const savedAt = Date.parse(entry?.savedAt ?? '');
	if (!Number.isFinite(seconds) || !Number.isFinite(savedAt)) return null;
	return new Date(savedAt + seconds * 1000);
}
