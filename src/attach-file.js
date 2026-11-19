import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { McpError } from '@modelcontextprotocol/sdk/types.js';
import { allowedFolders, ancestry, blockedRule, blockedSet, defaultTmpDirs, holdsPrivateKey, outsideMessage } from './attach-policy.js';
import { isSecureUrl } from './config.js';
import { log } from './log.js';
import { forgetSecret, redact, registerSecret } from './redact.js';
import { readAttachment, readUploadTicket, resultText } from './tool-result.js';

export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
// An upload may take up to five minutes. Most MCP clients stop waiting after 60 seconds unless progress arrives, so
// a client that asked for progress hears about the upload every PROGRESS_INTERVAL_MS.
const UPLOAD_TIMEOUT_MS = 5 * 60 * 1000;
const PROGRESS_INTERVAL_MS = 10_000;

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
		'Files are read only from that directory, the temp folder, and Desktop, Downloads, Pictures and Movies in the home folder',
		'(plus any folder the user lists in TESTWISE_ATTACH_DIRS); credentials, keys and other known secret files are refused.',
		'Returns the attachment with its size and type. Attach only evidence you captured.',
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

// On Windows, a path starting with two slashes of either kind names a network share (\\server\share, \\?\UNC\...)
// or a device (\\.\pipe\...); reading one can send this machine's credentials to another host.
const WINDOWS_NETWORK_PATH = /^[\\/]{2}/;

export function resolveLocalPath(input, cwd, { platform = process.platform, pathImpl = path, homeDir = os.homedir() } = {}) {
	const value = input.trim();
	// "C:\..." is a Windows drive, anything else shaped like "scheme:" is a URL and is refused.
	if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value) && !/^[A-Za-z]:[\\/]/.test(value)) {
		throw new AttachError(`"${value.split(':')[0]}:" is a URL scheme. attach_file reads local files only; pass a file path.`);
	}
	const windows = platform === 'win32';
	const networkPath = () => new AttachError(`${value} is a network or device path. attach_file reads files on this machine only; pass a local path.`);
	if (windows && WINDOWS_NETWORK_PATH.test(value)) throw networkPath();
	const expanded = value === '~' || value.startsWith('~/') ? pathImpl.join(homeDir, value.slice(1)) : value;
	const resolved = pathImpl.resolve(cwd, expanded);
	if (windows && WINDOWS_NETWORK_PATH.test(resolved)) throw networkPath();
	return resolved;
}

function unreadable(resolved, error) {
	if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return new AttachError(`there is no file at ${resolved}.`);
	if (error.code === 'EACCES' || error.code === 'EPERM') return new AttachError(`${resolved} cannot be read (permission denied).`);
	return new AttachError(`${resolved} cannot be read (${error.code ?? error.message}).`);
}

// Non-blocking, so a FIFO put in the file's place cannot stall the read; no symlink is followed at the last step, as
// the path was already resolved and checked.
const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0);

function refusedSecret(resolved, rule) {
	return new AttachError(`${resolved} is a credentials or key file (${rule}), so attach_file does not upload it.`);
}

async function readLocalFile(resolved, { cwd, homeDir, env, tmpDirs, warn }) {
	let real;
	try {
		real = await realpath(resolved);
	} catch (error) {
		throw unreadable(resolved, error);
	}
	const chain = await ancestry(real);
	const allowed = await allowedFolders({ cwd, homeDir, env, tmpDirs, warn });
	if (!chain.some((id) => allowed.ids.has(id))) throw new AttachError(outsideMessage(resolved, { cwd, ...allowed }));
	const { blocked, complete } = await blockedSet(homeDir);
	const rule = blockedRule({ resolved, real, chain, homeDir, blocked });
	if (rule) throw refusedSecret(resolved, rule);

	let handle;
	try {
		handle = await open(real, OPEN_FLAGS);
	} catch (error) {
		throw unreadable(resolved, error);
	}
	try {
		// Everything is decided on the open handle, so the file cannot be swapped between the check and the read.
		const info = await handle.stat({ bigint: true });
		if (info.isDirectory()) throw new AttachError(`${resolved} is a directory. Pass a single file.`);
		if (!info.isFile()) throw new AttachError(`${resolved} is not a regular file.`);
		const id = `${info.dev}:${info.ino}`;
		if (id !== chain[0]) throw new AttachError(`${resolved} changed while it was being checked. Try again.`);
		// A hard link is the same file under another name; it is refused if the walk of the blocked folders found it,
		// or could not finish.
		if (info.nlink > 1n && !complete) {
			throw new AttachError(`${resolved} has other hard links that could not all be checked, so attach_file does not upload it.`);
		}
		const size = Number(info.size);
		checkSize(resolved, size);
		const bytes = await handle.readFile();
		if (bytes.length !== size) throw new AttachError(`${resolved} changed while it was being read. Try again.`);
		if (holdsPrivateKey(bytes)) throw new AttachError(`${resolved} contains a private key, so attach_file does not upload it.`);
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

async function callStep(remote, toolName, args, signal) {
	try {
		return { result: await remote.callTool(toolName, args, { signal }) };
	} catch (error) {
		return { error: describeCallError(error) };
	}
}

// Plain http only to loopback, and only when TestWise itself runs there: otherwise a ticket could aim the upload at a
// service on this machine.
function checkUploadUrl(uploadUrl, endpoint) {
	if (!URL.canParse(uploadUrl)) return 'TestWise returned an upload link that is not a valid URL.';
	if (isSecureUrl(uploadUrl, endpoint)) return null;
	return 'TestWise returned an upload link that is not https, so the file was not sent.';
}

// Headers a storage service has no business asking for: credentials, and hop-by-hop headers that only the HTTP
// client itself may set.
const REFUSED_HEADERS = new Set([
	'host', 'authorization', 'cookie', 'proxy-authorization', 'proxy-authenticate',
	'connection', 'keep-alive', 'te', 'trailer', 'transfer-encoding', 'upgrade',
]);

function uploadHeaders(ticket, contentType) {
	const headers = new Headers({ 'Content-Type': contentType });
	for (const [name, value] of Object.entries(ticket.headers)) {
		if (REFUSED_HEADERS.has(name.toLowerCase())) {
			return { error: `TestWise asked for a ${name} header on the upload, which attach_file never sends, so the file was not sent.` };
		}
		try {
			headers.set(name, value);
		} catch {
			// The header's text is not repeated: it may hold signed values.
			return { error: 'TestWise returned upload headers that are not valid HTTP headers, so the file was not sent.' };
		}
	}
	return { headers };
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

async function upload({ ticket, bytes, headers, fetchImpl, signal }) {
	let response;
	try {
		response = await fetchImpl(ticket.uploadUrl, {
			method: ticket.method,
			headers,
			body: bytes,
			redirect: 'error',
			signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(UPLOAD_TIMEOUT_MS)]) : AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
		});
	} catch (error) {
		if (signal?.aborted) return { cancelled: true, error: 'the upload was cancelled' };
		return { error: `could not reach storage (${networkReason(error)})` };
	}
	if (response.ok) {
		await response.body?.cancel();
		return {};
	}
	const code = await storageErrorCode(response);
	return { status: response.status, error: `storage answered HTTP ${response.status}${code ? ` (${code})` : ''}` };
}

// Reports progress only when the client asked for it (onprogress set); each report counts up by one.
function progressReporter(onprogress) {
	let count = 0;
	return (message) => {
		count += 1;
		onprogress?.({ progress: count, message });
	};
}

export async function attachFile(args, {
	remote, cwd = process.cwd(), homeDir = os.homedir(), env = process.env, tmpDirs = defaultTmpDirs(), warn = log, fetchImpl = globalThis.fetch,
	signal, onprogress, progressIntervalMs = PROGRESS_INTERVAL_MS,
}) {
	const report = progressReporter(onprogress);
	const key = typeof args?.key === 'string' ? args.key.trim() : '';
	const filePath = typeof args?.path === 'string' ? args.path : '';
	if (!key) return failure('"key" is required, for example "LAR-41".');
	if (!filePath.trim()) return failure('"path" is required: the local file to attach.');
	if (args.name !== undefined && typeof args.name !== 'string') return failure('"name" must be a string.');

	let resolved;
	let bytes;
	try {
		resolved = resolveLocalPath(filePath, cwd, { homeDir });
		bytes = await readLocalFile(resolved, { cwd, homeDir, env, tmpDirs, warn });
	} catch (error) {
		if (error instanceof AttachError) return failure(error.message);
		return failure(`${resolved ?? filePath} cannot be read (${error.code ?? error.message}).`);
	}

	const fileName = args.name?.trim() || path.basename(resolved);
	const size = bytes.length;
	const contentType = contentTypeFor(path.extname(fileName) ? fileName : resolved);
	const sha256 = createHash('sha256').update(bytes).digest('hex');
	const described = `${fileName} (${formatBytes(size)}, ${contentType})`;

	const created = await callStep(remote, 'create_attachment_upload', { key, fileName, contentType, size, checksum: sha256 }, signal);
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
	const badUrl = checkUploadUrl(ticket.uploadUrl, remote.endpoint);
	if (badUrl) return failure(`${badUrl} (${described})`);
	const { headers, error: badHeaders } = uploadHeaders(ticket, contentType);
	if (badHeaders) return failure(`${badHeaders} (${described})`);

	registerSecret(ticket.uploadUrl);
	report(`Uploading ${described} to ${key}`);
	const started = Date.now();
	const heartbeat = setInterval(() => report(`Still uploading ${described} (${Math.round((Date.now() - started) / 1000)} s)`), progressIntervalMs);
	let uploaded;
	try {
		uploaded = await upload({ ticket, bytes, headers, fetchImpl, signal });
	} finally {
		clearInterval(heartbeat);
		forgetSecret(ticket.uploadUrl);
	}
	if (uploaded.cancelled) return failure(`uploading ${described} to ${key} was cancelled.`);
	if (uploaded.error) {
		const hint = uploaded.status === 403 ? ' The upload link may have expired, or the file changed after it was requested.' : '';
		return failure(`uploading ${described} to ${key} failed: ${uploaded.error}.${hint} Run attach_file again.`);
	}

	report(`Uploaded; adding it to ${key}`);
	const completed = await callStep(remote, 'complete_attachment_upload', { key, attachmentId: ticket.attachmentId }, signal);
	if (completed.error || completed.result.isError) {
		const reason = completed.error ?? (resultText(completed.result) || 'no reason given');
		return failure(`${described} was uploaded, but TestWise did not add it to ${key} (complete_attachment_upload): ${reason}`);
	}

	const attachment = readAttachment(completed.result);
	const summary = `Attached ${described} to ${key}.`;
	const payload = { key, attachmentId: ticket.attachmentId, fileName, size, contentType, sha256, ...(attachment ? { attachment } : {}) };
	return { content: [{ type: 'text', text: `${summary}\n${JSON.stringify(payload)}` }] };
}
