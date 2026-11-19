import assert from 'node:assert/strict';
import { existsSync, realpathSync } from 'node:fs';
import { link, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { attachFile } from '../src/attach-file.js';

// The hosted side of an upload; no network involved.
function stubRemote() {
	const calls = [];
	return {
		calls,
		endpoint: new URL('https://testwise.example/mcp'),
		async callTool(name) {
			calls.push(name);
			const body = name === 'create_attachment_upload'
				? { attachmentId: 'a1', method: 'PUT', uploadUrl: 'https://storage.example/a1?sig=x' }
				: { attachment: { id: 'a1', status: 'ACTIVE' } };
			return { content: [{ type: 'text', text: `ok\n${JSON.stringify(body)}` }] };
		},
	};
}

function text(result) {
	return result.content.map((block) => block.text).join('\n');
}

const PRIVATE_KEY = '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----\n';

describe('which files attach_file reads', () => {
	let base;
	let home;
	let project;
	let outside;

	before(async () => {
		base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'testwise-mcp-policy-')));
		home = path.join(base, 'home');
		project = path.join(base, 'project');
		outside = path.join(base, 'elsewhere');
		for (const folder of [home, project, outside, path.join(home, 'Desktop'), path.join(home, 'work')]) await mkdir(folder, { recursive: true });
	});

	after(async () => {
		await rm(base, { recursive: true, force: true });
	});

	// tmpDirs: [] keeps the test's own temp folder from counting as an allowed place.
	async function attach(filePath, options = {}) {
		const remote = stubRemote();
		const requests = [];
		const fetchImpl = async (url) => {
			requests.push(url);
			return new Response(null, { status: 200 });
		};
		const result = await attachFile({ key: 'LAR-41', path: filePath }, {
			remote, cwd: project, homeDir: home, env: {}, tmpDirs: [], fetchImpl, ...options,
		});
		return { result, sent: requests.length > 0 || remote.calls.length > 0 };
	}

	async function put(file, content = 'data') {
		await mkdir(path.dirname(file), { recursive: true });
		await writeFile(file, content);
		return file;
	}

	describe('allowed folders', () => {
		const OUTSIDE = /is outside the folders attach_file reads from: the project folder .*, the temp folder, and Desktop, Downloads, Pictures and Movies in your home folder\. To allow another folder, add it to TESTWISE_ATTACH_DIRS/;

		test('the project folder and the screenshot folders are allowed; the rest of the home folder is not', async () => {
			for (const file of [await put(path.join(project, 'shots', 'a.png')), await put(path.join(home, 'Desktop', 'Screen Shot.png'))]) {
				const { result } = await attach(file);
				assert.equal(result.isError, undefined, `${file}: ${text(result)}`);
			}
			for (const file of [await put(path.join(home, 'work', 'b.png')), await put(path.join(home, 'notes.txt')), await put(path.join(outside, 'c.png'))]) {
				const { result, sent } = await attach(file);
				assert.equal(result.isError, true, file);
				assert.match(text(result), OUTSIDE);
				assert.equal(sent, false);
			}
		});

		test('a link from the project folder to a file elsewhere is judged by where the file is', async () => {
			const target = await put(path.join(outside, 'd.png'));
			await symlink(target, path.join(project, 'd.png'));
			const { result } = await attach(path.join(project, 'd.png'));
			assert.equal(result.isError, true);
			assert.match(text(result), OUTSIDE);
		});

		test('started in the home folder or at the root, the project folder allows nothing', async () => {
			const file = await put(path.join(home, 'work', 'e.png'));
			for (const cwd of [home, path.parse(home).root]) {
				const { result } = await attach(file, { cwd });
				assert.equal(result.isError, true, cwd);
				assert.match(text(result), /the project folder \(none: this server was started in .*, which is your home folder or above it\)/);
			}
		});

		test('temp folders are allowed', async () => {
			const { result } = await attach(await put(path.join(outside, 'f.png')), { tmpDirs: [outside] });
			assert.equal(result.isError, undefined, text(result));
		});

		test('TESTWISE_ATTACH_DIRS adds folders', async () => {
			const env = { TESTWISE_ATTACH_DIRS: [outside, '~/work'].join(path.delimiter) };
			for (const file of [await put(path.join(outside, 'g.png')), await put(path.join(home, 'work', 'h.png'))]) {
				const { result } = await attach(file, { env });
				assert.equal(result.isError, undefined, `${file}: ${text(result)}`);
			}
			const { result } = await attach(await put(path.join(home, 'i.png')), { env });
			assert.equal(result.isError, true);
		});

		test('another spelling of an allowed folder is still allowed', { skip: !existsSync('/System/Volumes/Data') }, async () => {
			const file = await put(path.join(project, 'j.png'));
			const { result } = await attach(path.join('/System/Volumes/Data', file));
			assert.equal(result.isError, undefined, text(result));
		});
	});

	describe('secrets inside the allowed folders', () => {
		// Here the home folder is allowed, so these are refused by the block list alone.
		const homeAllowed = () => ({ env: { TESTWISE_ATTACH_DIRS: home } });

		async function assertRefused(filePath, pattern = /so attach_file does not upload it/) {
			const { result, sent } = await attach(filePath, homeAllowed());
			assert.equal(result.isError, true, filePath);
			assert.match(text(result), pattern, filePath);
			assert.equal(sent, false, `nothing was sent for ${filePath}`);
		}

		test('the macOS firmlink spelling of a home folder path', { skip: !existsSync('/System/Volumes/Data') }, async () => {
			await put(path.join(home, '.aws', 'credentials'));
			await assertRefused(path.join('/System/Volumes/Data', realpathSync(home), '.aws', 'credentials'));
		});

		test('the real location of a dotfile folder that is a link', async () => {
			const real = await put(path.join(home, 'dotfiles', 'gcloud', 'application_default_credentials.json'), '{}');
			await mkdir(path.join(home, '.config'), { recursive: true });
			await symlink(path.join(home, 'dotfiles', 'gcloud'), path.join(home, '.config', 'gcloud'));
			await assertRefused(real);
		});

		test('a file a blocked folder links out to', async () => {
			const target = await put(path.join(home, 'dotfiles', 'ssh_config'), 'Host *');
			await mkdir(path.join(home, '.ssh'), { recursive: true });
			await symlink(target, path.join(home, '.ssh', 'config'));
			await assertRefused(target);
		});

		test('hard links to a key, and to a blocked file', async () => {
			const key = await put(path.join(home, '.ssh', 'deploy'), 'not a pem, no telltale name');
			await link(key, path.join(project, 'evidence.png'));
			await assertRefused(path.join(project, 'evidence.png'));
			const gitCredentials = await put(path.join(home, '.git-credentials'));
			await link(gitCredentials, path.join(project, 'notes.txt'));
			await assertRefused(path.join(project, 'notes.txt'));
		});

		test('a file whose name starts with two dots inside a blocked folder', async () => {
			await assertRefused(await put(path.join(home, '.ssh', '..notes')));
		});

		test('credentials files that were not on the first list', async () => {
			const files = [
				'.config/gh/hosts.yml', '.zsh_history', '.bash_history', '.cargo/credentials.toml', '.cargo/credentials',
				'.gnupg/pubring.kbx', '.kube/config', '.azure/msal_token_cache.json', 'Library/Keychains/login.keychain-db',
			];
			for (const name of files) await assertRefused(await put(path.join(home, name)));
			for (const name of ['.pypirc', 'client.p12', 'client.pfx', 'release.jks', '.env.production', 'server.pem', 'tls.key', 'id_ed25519']) {
				await assertRefused(await put(path.join(project, name)));
			}
		});

		test('a file that holds a private key, whatever its name', async () => {
			await assertRefused(await put(path.join(project, 'support-ticket.txt'), `See below.\n${PRIVATE_KEY}`), /contains a private key/);
			const serviceAccount = JSON.stringify({ type: 'service_account', project_id: 'demo', private_key_id: 'abc', private_key: 'redacted' });
			await assertRefused(await put(path.join(project, 'build-config.json'), serviceAccount), /contains a private key/);
		});

		test('ordinary files, hard-linked ones included, are still attached', async () => {
			const log = await put(path.join(project, 'crash.log'), 'boom');
			await link(log, path.join(project, 'crash-copy.log'));
			for (const file of [log, path.join(project, 'crash-copy.log'), await put(path.join(home, 'work', 'shot.png'))]) {
				const { result } = await attach(file, homeAllowed());
				assert.equal(result.isError, undefined, `${file}: ${text(result)}`);
			}
		});
	});
});
