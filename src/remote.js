import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { OAuthError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { CallToolResultSchema, ErrorCode, ListToolsResultSchema, McpError } from '@modelcontextprotocol/sdk/types.js';
import { redact, redactDeep } from './redact.js';

const CONNECT_TIMEOUT_MS = 30_000;
const LIST_TIMEOUT_MS = 30_000;
const CALL_TIMEOUT_MS = 120_000;
const MAX_TOOL_PAGES = 20;

export const NOT_SIGNED_IN = 'Not signed in to TestWise, or the sign-in has expired or was revoked. Call the connect tool to sign in.';

// A failure talking to the hosted server, with a message written for the person or agent reading it.
export class RemoteError extends Error {
	constructor(kind, message, status) {
		super(redact(message));
		this.name = 'RemoteError';
		this.kind = kind;
		this.status = status;
	}
}

function detailFromBody(text) {
	const body = String(text ?? '').trim();
	if (!body || body.startsWith('<')) return '';
	try {
		const parsed = JSON.parse(body);
		const message = parsed?.error?.message ?? parsed?.message ?? (typeof parsed?.error === 'string' ? parsed.error : '');
		return typeof message === 'string' ? message.slice(0, 300) : '';
	} catch {
		return body.replace(/\s+/g, ' ').slice(0, 200);
	}
}

function fromHttpStatus(status, detail, endpoint) {
	const suffix = detail ? `: ${detail}` : '';
	if (status === 401) return new RemoteError('auth', NOT_SIGNED_IN, status);
	if (status === 403) return new RemoteError('forbidden', `TestWise refused the request (HTTP 403${suffix}).`, status);
	if (status === 404 || status === 405) {
		return new RemoteError('not_found', `No TestWise MCP endpoint answered at ${endpoint} (HTTP ${status}). Check TESTWISE_URL.`, status);
	}
	if (status === 429) {
		return new RemoteError('rate_limited', `TestWise is rate-limiting this connection (HTTP 429${suffix}). Wait a minute, then try again.`, status);
	}
	if (status >= 500) return new RemoteError('server', `TestWise had a server error (HTTP ${status}${suffix}). Try again shortly.`, status);
	return new RemoteError('http', `TestWise answered HTTP ${status}${suffix}.`, status);
}

function networkReason(error) {
	const cause = error?.cause;
	return cause?.code || cause?.message || error?.code || error?.name || 'network error';
}

// Turns anything the SDK client throws into a RemoteError, except JSON-RPC errors that the hosted
// server itself sent: those are returned unchanged (apart from redaction) so the proxy can pass them on.
export function toRemoteError(error, endpoint) {
	if (error instanceof RemoteError) return error;
	if (error instanceof UnauthorizedError) return new RemoteError('auth', NOT_SIGNED_IN);
	if (error instanceof OAuthError) {
		return new RemoteError('auth_server', `TestWise sign-in failed (${error.errorCode}: ${error.message}).`);
	}
	if (error instanceof StreamableHTTPError) {
		if (error.code === -1) {
			return new RemoteError('protocol', `${endpoint} did not answer like an MCP server. Check TESTWISE_URL.`);
		}
		const marker = 'Error POSTing to endpoint: ';
		const index = error.message.indexOf(marker);
		return fromHttpStatus(error.code, detailFromBody(index >= 0 ? error.message.slice(index + marker.length) : ''), endpoint);
	}
	if (error instanceof McpError) {
		if (error.code === ErrorCode.RequestTimeout) {
			return new RemoteError('timeout', `TestWise did not answer in time (${endpoint}). Try again shortly.`);
		}
		const message = redact(error.message.replace(/^MCP error -?\d+: /, ''));
		const passed = new McpError(error.code, message, error.data === undefined ? undefined : redactDeep(error.data));
		// Keep the hosted server's own wording; the receiving client adds its "MCP error <code>:" prefix itself.
		passed.message = message;
		return passed;
	}
	const network = (error?.name === 'TypeError' && error?.message === 'fetch failed')
		|| typeof error?.cause?.code === 'string'
		|| error?.name === 'AbortError'
		|| error?.name === 'TimeoutError';
	if (network) {
		return new RemoteError(
			'unreachable',
			`Could not reach TestWise at ${endpoint} (${networkReason(error)}). Check the network connection and TESTWISE_URL.`,
		);
	}
	return new RemoteError('unknown', `TestWise request failed: ${error?.message ?? String(error)}`);
}

export class Remote {
	constructor({ endpoint, authProvider, clientInfo, fetch }) {
		this.endpoint = endpoint;
		this.authProvider = authProvider;
		this.clientInfo = clientInfo;
		this.fetch = fetch;
		this.client = null;
	}

	async connect() {
		const client = new Client(this.clientInfo, { capabilities: {} });
		// Failures surface on the request that caused them, so the transport's error channel stays quiet.
		client.onerror = () => {};
		const transport = new StreamableHTTPClientTransport(this.endpoint, { authProvider: this.authProvider, fetch: this.fetch });
		try {
			await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS });
		} catch (error) {
			throw toRemoteError(error, this.endpoint.href);
		}
		this.client = client;
	}

	get instructions() {
		return this.client?.getInstructions();
	}

	async listTools() {
		const tools = [];
		let cursor;
		try {
			for (let page = 0; page < MAX_TOOL_PAGES; page += 1) {
				const result = await this.client.request(
					{ method: 'tools/list', params: cursor ? { cursor } : {} },
					ListToolsResultSchema,
					{ timeout: LIST_TIMEOUT_MS },
				);
				tools.push(...result.tools);
				cursor = result.nextCursor;
				if (!cursor) break;
			}
		} catch (error) {
			throw toRemoteError(error, this.endpoint.href);
		}
		return tools;
	}

	async callTool(name, args) {
		try {
			return await this.client.request(
				{ method: 'tools/call', params: { name, arguments: args ?? {} } },
				CallToolResultSchema,
				{ timeout: CALL_TIMEOUT_MS },
			);
		} catch (error) {
			throw toRemoteError(error, this.endpoint.href);
		}
	}

	async close() {
		await this.client?.close();
	}
}
