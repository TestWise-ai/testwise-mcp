import { readdir, realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Which local files attach_file reads. Two rules, both decided by identity (device and inode) and following links
// both ways, so another spelling of a path (a macOS firmlink such as /System/Volumes/Data/..., a dotfile folder that
// is a link, a link inside a blocked folder that points out of it, a hard link) gets around neither:
// 1. The file must be inside an allowed folder: the project folder this server was started in (unless that is the
//    home folder or above it), the temp folders, the folders screenshots and recordings usually land in, and any
//    folder listed in TESTWISE_ATTACH_DIRS.
// 2. Inside those, known homes of credentials and keys are refused, as are key and secret file names and files that
//    hold a private key.

const SCREENSHOT_FOLDERS = ['Desktop', 'Downloads', 'Pictures', 'Movies'];
// Settings and application data in the home folder: never a project, even when this server is started inside them.
const SETTINGS_FOLDERS = ['Library', '.config', '.local/share'];

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

export function defaultTmpDirs() {
	return process.platform === 'win32' ? [os.tmpdir()] : [os.tmpdir(), '/tmp', '/private/tmp'];
}

// TESTWISE_ATTACH_DIRS: folders separated by the platform's path delimiter; "~/" means the home folder.
function extraFolders(env, cwd, homeDir) {
	return String(env?.TESTWISE_ATTACH_DIRS ?? '')
		.split(path.delimiter)
		.map((entry) => entry.trim())
		.filter(Boolean)
		.map((entry) => path.resolve(cwd, entry === '~' || entry.startsWith('~/') ? path.join(homeDir, entry.slice(1)) : entry));
}

// Each dropped folder is reported once per warn function (once per process for the default, the log).
const warned = new WeakMap();

function warnOnce(warn, message) {
	if (!warn) return;
	if (!warned.has(warn)) warned.set(warn, new Set());
	const seen = warned.get(warn);
	if (seen.has(message)) return;
	seen.add(message);
	warn(message);
}

// The identities of the allowed folders that exist, and whether the project folder is one of them. No allowed
// folder may be the home folder or a folder above it, whichever way it is named or linked: that would open the whole
// home folder. Such folders are dropped with a warning.
export async function allowedFolders({ cwd, homeDir, env, tmpDirs, warn }) {
	const ids = new Set();
	const homeAndAbove = new Set(await ancestry(await realpath(homeDir).catch(() => homeDir)));
	const add = async (folder, role) => {
		const found = await identity(folder);
		if (!found?.directory) return;
		if (homeAndAbove.has(found.id)) {
			warnOnce(warn, `attach_file does not read from ${folder} (${role}): it is your home folder or a folder above it.`);
			return;
		}
		ids.add(found.id);
	};

	const settings = new Set();
	for (const folder of SETTINGS_FOLDERS) {
		const found = await identity(path.join(homeDir, folder));
		if (found) settings.add(found.id);
	}
	const project = await identity(cwd);
	let projectAllowed = false;
	if (project?.directory) {
		const chain = await ancestry(await realpath(cwd).catch(() => cwd));
		if (homeAndAbove.has(project.id) || chain.some((id) => settings.has(id))) {
			warnOnce(warn, `attach_file does not read from ${cwd} (the folder this server was started in): it is your home folder, `
				+ 'a folder above it or a settings folder.');
		} else {
			ids.add(project.id);
			projectAllowed = true;
		}
	}
	for (const folder of tmpDirs) await add(folder, 'a temp folder');
	for (const folder of SCREENSHOT_FOLDERS) await add(path.join(homeDir, folder), 'a screenshot folder');
	for (const folder of extraFolders(env, cwd, homeDir)) await add(folder, 'listed in TESTWISE_ATTACH_DIRS');
	return { ids, projectAllowed };
}

export function outsideMessage(resolved, { cwd, projectAllowed }) {
	const project = projectAllowed
		? `the project folder (${cwd})`
		: `the project folder (none: this server was started in ${cwd}, which is your home folder, a folder above it or a settings folder)`;
	return `${resolved} is outside the folders attach_file reads from: ${project}, the temp folder, and Desktop, Downloads, `
		+ 'Pictures and Movies in your home folder. To allow another folder, add it to TESTWISE_ATTACH_DIRS in this '
		+ `server's environment (separate several with "${path.delimiter}").`;
}
