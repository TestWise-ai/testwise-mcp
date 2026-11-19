import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

// Which local files attach_file refuses to upload. Folders and files are compared by identity (device and inode),
// following links both ways, so another spelling of a path (a macOS firmlink such as /System/Volumes/Data/...,
// a dotfile folder that is a link, a link inside a blocked folder that points out of it, a hard link) is caught too.

// Relative to the home folder.
const BLOCKED_DIRECTORIES = ['.testwise', '.ssh', '.aws', '.azure', '.gnupg', '.config/gcloud', '.config/gh', 'Library/Keychains'];
const BLOCKED_FILES = [
	'.docker/config.json', '.kube/config', '.git-credentials', '.cargo/credentials', '.cargo/credentials.toml',
	'.npmrc', '.netrc', '.pypirc', '.bash_history', '.zsh_history',
];
// Anywhere, by name.
const BLOCKED_NAMES = [
	[/^\.env/, '.env*'],
	[/^\.npmrc$/, '.npmrc'],
	[/^\.netrc$/, '.netrc'],
	[/^\.pypirc$/, '.pypirc'],
	[/^\.git-credentials$/, '.git-credentials'],
	[/^\.\w*_history$/, 'shell history'],
	[/\.pem$/, '*.pem'],
	[/\.key$/, '*.key'],
	[/\.p12$/, '*.p12'],
	[/\.pfx$/, '*.pfx'],
	[/\.jks$/, '*.jks'],
	[/^id_/, 'id_*'],
	[/\.keychain(?:-db)?$/, 'keychains'],
];
// Blocked folders are walked to learn the identity of everything in them, within these bounds.
const WALK_ENTRIES = 10_000;
const WALK_DEPTH = 8;

const PRIVATE_KEY = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/;
const SERVICE_ACCOUNT = /"type"\s*:\s*"service_account"/;

// "dev:ino" of what path names, following links; null if it can't be read.
export async function identity(target) {
	try {
		const info = await stat(target, { bigint: true });
		return { id: `${info.dev}:${info.ino}`, directory: info.isDirectory() };
	} catch {
		return null;
	}
}

// The identities of a real path and each folder above it, up to the root.
export async function ancestry(real) {
	const ids = [];
	for (let current = real; ; current = path.dirname(current)) {
		const found = await identity(current);
		if (found) ids.push(found.id);
		if (path.dirname(current) === current) return ids;
	}
}

function isWithin(child, parent) {
	const relative = path.relative(parent.toLowerCase(), child.toLowerCase());
	return relative === '' || !(relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative));
}

// The identities of the blocked folders and files, and of everything inside the folders. `complete` is false when
// the walk stopped at its bounds.
export async function blockedSet(homeDir) {
	const blocked = new Map();
	let budget = WALK_ENTRIES;
	for (const file of BLOCKED_FILES) {
		const found = await identity(path.join(homeDir, file));
		if (found && !blocked.has(found.id)) blocked.set(found.id, `~/${file}`);
	}
	for (const directory of BLOCKED_DIRECTORIES) {
		const label = `~/${directory}`;
		const root = path.join(homeDir, directory);
		const found = await identity(root);
		if (!found) continue;
		blocked.set(found.id, label);
		const queue = found.directory ? [[root, 0]] : [];
		while (queue.length > 0) {
			const [folder, depth] = queue.shift();
			let entries;
			try {
				entries = await readdir(folder, { withFileTypes: true });
			} catch {
				continue;
			}
			budget -= entries.length;
			if (budget < 0) return { blocked, complete: false };
			const ids = await Promise.all(entries.map((entry) => identity(path.join(folder, entry.name))));
			entries.forEach((entry, index) => {
				if (ids[index] && !blocked.has(ids[index].id)) blocked.set(ids[index].id, label);
				// Real folders only: a linked folder is blocked as a whole above, and not walked into.
				if (entry.isDirectory() && depth < WALK_DEPTH) queue.push([path.join(folder, entry.name), depth + 1]);
			});
		}
	}
	return { blocked, complete: true };
}

// The block-list rule `resolved` (as given) or `real` (its real path) falls under, or null. `chain` is ancestry(real).
export function blockedRule({ resolved, real, chain, homeDir, blocked }) {
	for (const id of chain) if (blocked.has(id)) return blocked.get(id);
	for (const candidate of [resolved, real]) {
		for (const directory of BLOCKED_DIRECTORIES) if (isWithin(candidate, path.join(homeDir, directory))) return `~/${directory}`;
		const name = path.basename(candidate).toLowerCase();
		const rule = BLOCKED_NAMES.find(([pattern]) => pattern.test(name))?.[1];
		if (rule) return rule;
	}
	return null;
}

export function holdsPrivateKey(bytes) {
	const text = bytes.toString('latin1');
	return PRIVATE_KEY.test(text) || (SERVICE_ACCOUNT.test(text) && text.includes('"private_key"'));
}
