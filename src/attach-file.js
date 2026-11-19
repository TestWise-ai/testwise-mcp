import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { McpError } from '@modelcontextprotocol/sdk/types.js';
import { isLoopbackHost } from './config.js';
import { forgetSecret, redact, registerSecret } from './redact.js';
import { readAttachment, readUploadTicket, resultText } from './tool-result.js';

export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const UPLOAD_TIMEOUT_MS = 5 * 60 * 1000;

const CONTENT_TYPES = {
	'.txt': 'text/plain',
	'.log': 'text/plain',
	'.md': 'text/markdown',
	'.json': 'application/json',
	'.har': 'application/json',
	'.csv': 'text/csv',
	'.pdf': 'application/pdf',
	'.zip': 'application/zip',
	'.gz': 'application/gzip',
	'.doc': 'application/msword',
	'.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
	'.xls': 'application/vnd.ms-excel',
	'.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
	'.ppt': 'application/vnd.ms-powerpoint',
	'.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.gif': 'image/gif',
	'.webp': 'image/webp',
	'.mp4': 'video/mp4',
	'.webm': 'video/webm',
	'.mov': 'video/quicktime',
	'.avi': 'video/x-msvideo',
};

export const attachFileTool = {
	name: 'attach_file',
	title: 'Attach a local file to a TestWise item',
	description: [
		'Attach a file from this machine to a TestWise item (a bug, task or decision), so QA and the PM can see the evidence:',
		'a screenshot or screen recording from a real device, a log, a crash report or a network capture.',
		`The file must be ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB or smaller; its type comes from the extension.`,
		'Prefer an absolute path. A relative path is resolved against the directory this server was started in. URLs are not accepted.',
		'Returns the attachment with its size and type. Attach only evidence you captured; never attach credentials, .env files or keys.',
	].join(' '),
	inputSchema: {
		type: 'object',
		properties: {
			key: { type: 'string', description: 'The item key, for example "LAR-41".' },
			path: { type: 'string', description: 'Path of the local file, for example "/home/me/app/artifacts/checkout-error.png".' },
			name: { type: 'string', description: "File name to show in TestWise. Defaults to the file's own name." },
		},
		required: ['key', 'path'],
		additionalProperties: false,
	},
	annotations: { title: 'Attach a local file', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
};

// Never uploaded, whatever an agent is asked to do: the TestWise sign-in, and the usual homes of credentials and keys.
// Matched on the path as given and on the file it resolves to, so a symlink cannot smuggle one out.
const SECRET_DIRECTORIES = ['.testwise', '.ssh', '.aws', '.config/gcloud', 'Library/Keychains'];
const SECRET_FILES = ['.docker/config.json'];
const SECRET_NAMES = [
	[/^\.env/, '.env*'],
	[/^\.npmrc$/, '.npmrc'],
	[/^\.netrc$/, '.netrc'],
	[/\.pem$/, '*.pem'],
	[/\.key$/, '*.key'],
	[/^id_/, 'id_*'],
	[/\.keychain(?:-db)?$/, 'keychains'],
];

function isWithin(child, parent) {
	const relative = path.relative(parent.toLowerCase(), child.toLowerCase());
	return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

// The denylist rule a path falls under, or null. Compared without case, as macOS and Windows file systems do.
export function secretRule(filePath, homes) {
	for (const home of homes) {
		for (const directory of SECRET_DIRECTORIES) if (isWithin(filePath, path.join(home, directory))) return `~/${directory}`;
		for (const file of SECRET_FILES) if (filePath.toLowerCase() === path.join(home, file).toLowerCase()) return `~/${file}`;
	}
	const name = path.basename(filePath).toLowerCase();
	return SECRET_NAMES.find(([pattern]) => pattern.test(name))?.[1] ?? null;
}

export function contentTypeFor(fileName) {
	return CONTENT_TYPES[path.extname(fileName).toLowerCase()] ?? 'application/octet-stream';
}

export function formatBytes(bytes) {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

class AttachError extends Error {}

function failure(message) {
	return { isError: true, content: [{ type: 'text', text: redact(`Not attached: ${message}`) }] };
}

export function resolveLocalPath(input, cwd) {
	const value = input.trim();
	// "C:\..." is a Windows drive, anything else shaped like "scheme:" is a URL and is refused.
	if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value) && !/^[A-Za-z]:[\\/]/.test(value)) {
		throw new AttachError(`"${value.split(':')[0]}:" is a URL scheme. attach_file reads local files only; pass a file path.`);
	}
	const expanded = value === '~' || value.startsWith('~/') ? path.join(os.homedir(), value.slice(1)) : value;
	return path.resolve(cwd, expanded);
}

function unreadable(resolved, error) {
	if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return new AttachError(`there is no file at ${resolved}.`);
	if (error.code === 'EACCES' || error.code === 'EPERM') return new AttachError(`${resolved} cannot be read (permission denied).`);
	return new AttachError(`${resolved} cannot be read (${error.code ?? error.message}).`);
}

// Non-blocking, so a FIFO put in the file's place cannot stall the read; no symlink is followed at the last step, as
// the path was already resolved and checked.
const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0);

async function readLocalFile(resolved, homeDir) {
	let real;
	try {
		real = await realpath(resolved);
	} catch (error) {
		throw unreadable(resolved, error);
	}
	const homes = [homeDir, await realpath(homeDir).catch(() => homeDir)];
	const rule = secretRule(resolved, homes) ?? secretRule(real, homes);
	if (rule) throw new AttachError(`${resolved} is a credentials or key file (${rule}), and attach_file never uploads those.`);

	let handle;
	try {
		handle = await open(real, OPEN_FLAGS);
	} catch (error) {
		throw unreadable(resolved, error);
	}
	try {
		// Everything is decided on the open handle, so the file cannot be swapped between the check and the read.
		const info = await handle.stat();
		if (info.isDirectory()) throw new AttachError(`${resolved} is a directory. Pass a single file.`);
		if (!info.isFile()) throw new AttachError(`${resolved} is not a regular file.`);
		checkSize(resolved, info.size);
		const bytes = await handle.readFile();
		if (bytes.length !== info.size) throw new AttachError(`${resolved} changed while it was being read. Try again.`);
		return bytes;
	} finally {
		await handle.close();
	}
}

function checkSize(resolved, size) {
	if (size === 0) throw new AttachError(`${resolved} is empty.`);
	if (size > MAX_ATTACHMENT_BYTES) {
		throw new AttachError(
			`${resolved} is ${formatBytes(size)} (${size} bytes); the limit is 25 MB (${MAX_ATTACHMENT_BYTES} bytes). Trim or compress it first.`,
		);
	}
}

function describeCallError(error) {
	if (error instanceof McpError) return error.message.replace(/^MCP error -?\d+: /, '');
	return error?.message ?? String(error);
}

async function callStep(remote, toolName, args) {
	try {
		return { result: await remote.callTool(toolName, args) };
	} catch (error) {
		return { error: describeCallError(error) };
	}
}

function checkUploadUrl(uploadUrl) {
	let url;
	try {
		url = new URL(uploadUrl);
	} catch {
		return 'TestWise returned an upload link that is not a valid URL.';
	}
	if (url.protocol === 'https:' || (url.protocol === 'http:' && isLoopbackHost(url.hostname))) return null;
	return 'TestWise returned an upload link that is not https, so the file was not sent.';
}

function networkReason(error) {
	if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return 'timed out';
	return error?.cause?.code || error?.cause?.message || error?.name || 'network error';
}

async function storageErrorCode(response) {
	try {
		const body = (await response.text()).slice(0, 4096);
		const code = /<Code>([A-Za-z]{1,64})<\/Code>/.exec(body)?.[1];
		return code ?? null;
	} catch {
		return null;
	}
}

async function upload({ ticket, bytes, contentType, fetchImpl }) {
	const headers = new Headers({ 'Content-Type': contentType });
	for (const [name, value] of Object.entries(ticket.headers)) headers.set(name, value);
	let response;
	try {
		response = await fetchImpl(ticket.uploadUrl, {
			method: ticket.method,
			headers,
			body: bytes,
			redirect: 'error',
			signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
		});
	} catch (error) {
		return { error: `could not reach storage (${networkReason(error)})` };
	}
	if (response.ok) {
		await response.body?.cancel();
		return {};
	}
	const code = await storageErrorCode(response);
	return { status: response.status, error: `storage answered HTTP ${response.status}${code ? ` (${code})` : ''}` };
}

export async function attachFile(args, { remote, cwd = process.cwd(), homeDir = os.homedir(), fetchImpl = globalThis.fetch }) {
	const key = typeof args?.key === 'string' ? args.key.trim() : '';
	const filePath = typeof args?.path === 'string' ? args.path : '';
	if (!key) return failure('"key" is required, for example "LAR-41".');
	if (!filePath.trim()) return failure('"path" is required: the local file to attach.');
	if (args.name !== undefined && typeof args.name !== 'string') return failure('"name" must be a string.');

	let resolved;
	let bytes;
	try {
		resolved = resolveLocalPath(filePath, cwd);
		bytes = await readLocalFile(resolved, homeDir);
	} catch (error) {
		if (error instanceof AttachError) return failure(error.message);
		return failure(`${resolved ?? filePath} cannot be read (${error.code ?? error.message}).`);
	}

	const fileName = args.name?.trim() || path.basename(resolved);
	const size = bytes.length;
	const contentType = contentTypeFor(path.extname(fileName) ? fileName : resolved);
	const sha256 = createHash('sha256').update(bytes).digest('hex');
	const described = `${fileName} (${formatBytes(size)}, ${contentType})`;

	const created = await callStep(remote, 'create_attachment_upload', { key, fileName, contentType, size, checksum: sha256 });
	if (created.error) return failure(`TestWise could not start the upload of ${described} to ${key} (create_attachment_upload): ${created.error}`);
	if (created.result.isError) {
		return failure(`TestWise refused the upload of ${described} to ${key} (create_attachment_upload): ${resultText(created.result) || 'no reason given'}`);
	}
	const ticket = readUploadTicket(created.result);
	if (!ticket) {
		return failure(`create_attachment_upload did not return an attachmentId and uploadUrl, so ${described} was not sent.`);
	}
	if (!['PUT', 'POST'].includes(ticket.method)) {
		return failure(`create_attachment_upload asked for an HTTP ${ticket.method} upload, which attach_file does not support.`);
	}
	const badUrl = checkUploadUrl(ticket.uploadUrl);
	if (badUrl) return failure(`${badUrl} (${described})`);

	registerSecret(ticket.uploadUrl);
	let uploaded;
	try {
		uploaded = await upload({ ticket, bytes, contentType, fetchImpl });
	} finally {
		forgetSecret(ticket.uploadUrl);
	}
	if (uploaded.error) {
		const hint = uploaded.status === 403 ? ' The upload link may have expired, or the file changed after it was requested.' : '';
		return failure(`uploading ${described} to ${key} failed: ${uploaded.error}.${hint} Run attach_file again.`);
	}

	const completed = await callStep(remote, 'complete_attachment_upload', { key, attachmentId: ticket.attachmentId });
	if (completed.error || completed.result.isError) {
		const reason = completed.error ?? (resultText(completed.result) || 'no reason given');
		return failure(`${described} was uploaded, but TestWise did not add it to ${key} (complete_attachment_upload): ${reason}`);
	}

	const attachment = readAttachment(completed.result);
	const summary = `Attached ${described} to ${key}.`;
	const payload = { key, attachmentId: ticket.attachmentId, fileName, size, contentType, sha256, ...(attachment ? { attachment } : {}) };
	return { content: [{ type: 'text', text: `${summary}\n${JSON.stringify(payload)}` }] };
}
