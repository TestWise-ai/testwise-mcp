// A stand-in for hosted TestWise, used by the tests. One HTTP server plays three parts:
// - the OAuth authorization server: RFC 8414 metadata, /oauth/authorize (decides at once, by redirecting back),
//   /oauth/token (authorization_code with PKCE S256, refresh_token with rotation and reuse detection), /oauth/revoke.
//   Refresh-token reuse follows the hosted rules by default ('grace'): every presenter of a used refresh token within
//   graceMs gets the same successor pair, and a reuse after that revokes that sign-in's token family only. In 'strict'
//   mode any reuse revokes the family at once, so a client that ever presents a refresh token twice loses its sign-in;
// - the protected resource: RFC 9728 metadata and a stateless Streamable HTTP MCP server on /mcp that answers
//   401 with a WWW-Authenticate resource_metadata challenge when the bearer token is missing or invalid;
// - storage: a presigned-upload endpoint on /upload.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import http from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from '@modelcontextprotocol/sdk/types.js';

export const FAKE_SIGNATURE = 'fakeSignature0123456789abcdef';
export const FAKE_INSTRUCTIONS = [
	'TestWise release handoff.',
	'Call get_updates at the start of a session.',
	'After shipping a batch, call publish_release with one check per user-visible behaviour.',
	'When you fix a bug, call request_retest with the build that contains the fix.',
].join('\n');

const ITEMS = new Set(['LAR-41', 'LAR-42']);
const CLIENT_ID = 'testwise-mcp';

function reply(summary, data) {
	return { content: [{ type: 'text', text: `${summary}\n${JSON.stringify(data)}` }] };
}

function refuse(message) {
	return { isError: true, content: [{ type: 'text', text: message }] };
}

function schema(properties, required = []) {
	return { type: 'object', properties, required };
}

function secret(prefix) {
	return `${prefix}_${randomBytes(24).toString('base64url')}`;
}

function defaultTools(state) {
	return [
		{
			definition: { name: 'whoami', description: 'The project, user and connection this server acts for.', inputSchema: schema({}) },
			run: () => reply('Project Larder, as Pat Tester (connection "Larder coding agent").', {
				project: { id: 'p1', name: 'Larder' },
				user: { name: 'Pat Tester' },
				connection: { name: 'Larder coding agent' },
			}),
		},
		{
			definition: {
				name: 'get_updates',
				description: 'New bugs, comments, results and answered decisions since you last looked.',
				inputSchema: schema({ since: { type: 'string' }, limit: { type: 'number' }, peek: { type: 'boolean' } }),
			},
			run: () => reply('1 new event: LAR-41 was filed by QA.', {
				events: [{ id: 'e1', type: 'item.created', item: { key: 'LAR-41', type: 'BUG', title: 'Lists: offline ticks are lost' } }],
				cursor: 'c1',
				more: false,
			}),
		},
		{
			definition: {
				name: 'publish_release',
				description: 'Create or update a release with its checks and decisions.',
				inputSchema: schema({ release: { type: 'object' }, checks: { type: 'array' }, decisions: { type: 'array' } }, ['release']),
			},
			run: (args) => reply(`Published ${args.release?.name}.`, {
				release: { id: 'r1', name: args.release?.name },
				counts: { checksCreated: args.checks?.length ?? 0, checksUpdated: 0, checksRemoved: 0, decisionsCreated: args.decisions?.length ?? 0, decisionsUpdated: 0 },
				url: 'https://testwise.example/releases#id=p1&release=r1',
				warnings: [],
			}),
		},
		{
			definition: { name: 'get_item', description: 'Read one item.', inputSchema: schema({ key: { type: 'string' } }, ['key']) },
			run: (args, context) => {
				if (args.key === 'LEAK-1') return refuse(`Token ${context.token} may not read LEAK-1`);
				if (!ITEMS.has(args.key)) return refuse(`Item ${args.key} not found`);
				return reply(`${args.key}: Lists: offline ticks are lost`, { key: args.key, status: 'OPEN' });
			},
		},
		{
			definition: {
				name: 'request_retest',
				description: 'Move an item to In review and ask QA to re-test on a build.',
				inputSchema: schema({ key: { type: 'string' }, build: { type: 'string' }, note: { type: 'string' } }, ['key', 'build']),
			},
			run: (args) => reply(`${args.key} is in review; QA asked to re-test on ${args.build}.`, { key: args.key, status: 'IN_REVIEW' }),
		},
		{
			definition: {
				name: 'create_attachment_upload',
				description: 'Start an attachment upload.',
				inputSchema: schema(
					{ key: { type: 'string' }, fileName: { type: 'string' }, contentType: { type: 'string' }, size: { type: 'number' }, checksum: { type: 'string' } },
					['key', 'fileName', 'contentType', 'size'],
				),
			},
			run: (args) => {
				if (!ITEMS.has(args.key)) return refuse(`Item ${args.key} not found`);
				const attachmentId = randomUUID();
				const headers = { 'Content-Type': args.contentType, 'If-None-Match': '*', 'x-amz-meta-sha256': args.checksum };
				state.uploads.set(attachmentId, { ...args, headers, received: null });
				const uploadUrl = `${state.baseUrl}/upload/${attachmentId}?X-Amz-Credential=FAKEKEY&X-Amz-Signature=${FAKE_SIGNATURE}`;
				return reply(`Upload ready for ${args.fileName}.`, { attachmentId, uploadUrl, method: 'PUT', headers, expiresIn: 900 });
			},
		},
		{
			definition: {
				name: 'complete_attachment_upload',
				description: 'Finish an attachment upload.',
				inputSchema: schema({ key: { type: 'string' }, attachmentId: { type: 'string' } }, ['key', 'attachmentId']),
			},
			run: (args) => {
				if (state.completeError) return refuse(state.completeError);
				const upload = state.uploads.get(args.attachmentId);
				if (!upload || upload.key !== args.key) return refuse('Attachment not found');
				if (!upload.received) return refuse('The object has not finished uploading');
				const attachment = { id: args.attachmentId, fileName: upload.fileName, contentType: upload.contentType, size: upload.size, status: 'ACTIVE' };
				return reply(`Attached ${upload.fileName} to ${args.key}.`, { attachment });
			},
		},
	];
}

function readBody(req) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		req.on('data', (chunk) => chunks.push(chunk));
		req.on('end', () => resolve(Buffer.concat(chunks)));
		req.on('error', reject);
	});
}

function sendJson(res, status, body, headers = {}) {
	res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });
	res.end(JSON.stringify(body));
}

function oauthError(res, status, error, description) {
	sendJson(res, status, { error, error_description: description });
}

function delay(ms) {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

function issueTokens(state, grant) {
	const accessToken = secret('at');
	const refreshToken = secret('rt');
	state.accessTokens.set(accessToken, { grant, expiresAt: Date.now() + state.accessTokenTtl * 1000, revoked: false });
	state.refreshTokens.set(refreshToken, { grant, used: false, usedAt: 0, successor: null, revoked: false });
	return { access_token: accessToken, token_type: 'Bearer', expires_in: state.accessTokenTtl, refresh_token: refreshToken, scope: 'handoff' };
}

function revokeGrant(state, grant) {
	for (const record of [...state.accessTokens.values(), ...state.refreshTokens.values()]) {
		if (record.grant === grant) record.revoked = true;
	}
}

function handleAuthorize(req, res, state, url) {
	const params = url.searchParams;
	const redirectUri = params.get('redirect_uri') ?? '';
	state.authorizeRequests.push(Object.fromEntries(params));
	const loopback = /^http:\/\/(127\.0\.0\.1|localhost):\d+\/callback$/.test(redirectUri);
	if (params.get('client_id') !== CLIENT_ID || !loopback) {
		res.writeHead(400, { 'Content-Type': 'text/plain' }).end('Unknown client or redirect URI');
		return;
	}
	const back = new URL(redirectUri);
	back.searchParams.set('state', params.get('state') ?? '');
	if (state.callbackIss !== null) back.searchParams.set('iss', state.callbackIss ?? state.baseUrl);
	const valid = params.get('response_type') === 'code'
		&& params.get('code_challenge_method') === 'S256'
		&& params.get('code_challenge')
		&& params.get('state')
		&& params.get('resource') === `${state.baseUrl}/mcp`;
	if (!valid) {
		back.searchParams.set('error', 'invalid_request');
	} else if (state.authorizeMode === 'hold') {
		res.writeHead(200, { 'Content-Type': 'text/html' }).end('<p>Choose a project…</p>');
		return;
	} else if (state.authorizeMode === 'deny') {
		back.searchParams.set('error', state.denyError ?? 'access_denied');
		if (state.denyDescription) back.searchParams.set('error_description', state.denyDescription);
	} else {
		const code = secret('code');
		state.codes.set(code, {
			redirectUri,
			challenge: params.get('code_challenge'),
			resource: params.get('resource'),
			used: false,
			grant: randomUUID(),
		});
		back.searchParams.set('code', code);
	}
	res.writeHead(302, { Location: back.href }).end();
}

async function handleToken(req, res, state) {
	const params = new URLSearchParams((await readBody(req)).toString('utf8'));
	const grantType = params.get('grant_type');
	state.tokenRequests.push({ grantType, resource: params.get('resource'), clientId: params.get('client_id') });
	if (params.get('client_id') !== CLIENT_ID) return oauthError(res, 401, 'invalid_client', 'Unknown client');
	if (params.get('resource') !== `${state.baseUrl}/mcp`) return oauthError(res, 400, 'invalid_target', 'Wrong resource');

	if (grantType === 'authorization_code') {
		const record = state.codes.get(params.get('code'));
		if (!record || record.used) return oauthError(res, 400, 'invalid_grant', 'Unknown or used code');
		record.used = true;
		const challenge = createHash('sha256').update(params.get('code_verifier') ?? '').digest('base64url');
		if (challenge !== record.challenge) return oauthError(res, 400, 'invalid_grant', 'PKCE verification failed');
		if (params.get('redirect_uri') !== record.redirectUri) return oauthError(res, 400, 'invalid_grant', 'redirect_uri mismatch');
		return sendJson(res, 200, issueTokens(state, record.grant));
	}
	if (grantType === 'refresh_token') {
		const record = state.refreshTokens.get(params.get('refresh_token'));
		if (!record || record.revoked) return oauthError(res, 400, 'invalid_grant', 'Unknown or revoked refresh token');
		if (record.used) {
			if (state.refreshReuse === 'grace' && Date.now() - record.usedAt <= state.graceMs) return sendJson(res, 200, record.successor);
			state.reuseDetections.push({ grant: record.grant });
			revokeGrant(state, record.grant);
			return oauthError(res, 400, 'invalid_grant', 'Refresh token reused; the connection was revoked');
		}
		if (state.failRefresh) return oauthError(res, 400, 'invalid_grant', 'The connection was revoked');
		record.used = true;
		record.usedAt = Date.now();
		record.successor = issueTokens(state, record.grant);
		if (state.tokenDelayMs) await delay(state.tokenDelayMs);
		return sendJson(res, 200, record.successor);
	}
	return oauthError(res, 400, 'unsupported_grant_type', 'Unsupported grant type');
}

async function handleRevoke(req, res, state) {
	const params = new URLSearchParams((await readBody(req)).toString('utf8'));
	state.revocations.push({ hint: params.get('token_type_hint'), clientId: params.get('client_id') });
	const record = state.refreshTokens.get(params.get('token')) ?? state.accessTokens.get(params.get('token'));
	if (record) revokeGrant(state, record.grant);
	res.writeHead(200).end();
}

function challenge(res, state, tokenSent) {
	const metadata = `${state.baseUrl}/.well-known/oauth-protected-resource/mcp`;
	const header = `Bearer resource_metadata="${metadata}"${tokenSent ? ', error="invalid_token"' : ''}`;
	sendJson(res, 401, { jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized' }, id: null }, { 'WWW-Authenticate': header });
}

async function handleMcp(req, res, state) {
	const authorization = req.headers.authorization ?? '';
	state.requests.push({ method: req.method, path: '/mcp', authorization });
	if (req.method !== 'POST') {
		res.writeHead(405, { Allow: 'POST' }).end();
		return;
	}
	const token = /^Bearer (.+)$/.exec(authorization)?.[1];
	const record = token ? state.accessTokens.get(token) : null;
	if (!record || record.revoked || record.expiresAt <= Date.now()) {
		await readBody(req);
		challenge(res, state, Boolean(token));
		return;
	}
	const body = JSON.parse((await readBody(req)).toString('utf8'));
	const server = new Server({ name: 'testwise', version: '0.0.0-test' }, { capabilities: { tools: {} }, instructions: state.instructions });
	server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [...state.tools.values()].map((tool) => tool.definition) }));
	server.setRequestHandler(CallToolRequestSchema, async (request) => {
		const { name, arguments: args = {} } = request.params;
		state.calls.push({ name, arguments: args });
		const tool = state.tools.get(name);
		if (!tool) throw new McpError(ErrorCode.InvalidParams, `Tool ${name} not found`);
		return tool.run(args, { token });
	});
	const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
	res.on('close', () => {
		transport.close();
		server.close();
	});
	await server.connect(transport);
	await transport.handleRequest(req, res, body);
}

async function handleUpload(req, res, state, attachmentId) {
	const body = await readBody(req);
	state.uploadRequests.push({ method: req.method, url: req.url, headers: { ...req.headers }, size: body.length });
	if (state.uploadResponse) {
		res.writeHead(state.uploadResponse.status, { 'Content-Type': 'application/xml' }).end(state.uploadResponse.body);
		return;
	}
	const upload = state.uploads.get(attachmentId);
	const signed = upload
		&& req.method === 'PUT'
		&& Object.entries(upload.headers).every(([name, value]) => req.headers[name.toLowerCase()] === value);
	if (!signed) {
		res.writeHead(403, { 'Content-Type': 'application/xml' }).end('<Error><Code>SignatureDoesNotMatch</Code></Error>');
		return;
	}
	if (body.length !== upload.size || createHash('sha256').update(body).digest('hex') !== upload.checksum) {
		res.writeHead(400, { 'Content-Type': 'application/xml' }).end('<Error><Code>BadDigest</Code></Error>');
		return;
	}
	upload.received = body;
	res.writeHead(200).end();
}

function route(req, res, state) {
	const url = new URL(req.url, state.baseUrl);
	const { pathname } = url;
	if (pathname === '/.well-known/oauth-protected-resource/mcp' || pathname === '/.well-known/oauth-protected-resource') {
		state.discoveryRequests.push(pathname);
		return sendJson(res, 200, {
			resource: `${state.baseUrl}/mcp`,
			authorization_servers: [state.baseUrl],
			scopes_supported: ['handoff'],
			bearer_methods_supported: ['header'],
		});
	}
	if (pathname === '/.well-known/oauth-authorization-server') {
		state.discoveryRequests.push(pathname);
		return sendJson(res, 200, {
			issuer: state.baseUrl,
			authorization_endpoint: `${state.baseUrl}/oauth/authorize`,
			token_endpoint: `${state.baseUrl}/oauth/token`,
			registration_endpoint: `${state.baseUrl}/oauth/register`,
			revocation_endpoint: `${state.baseUrl}/oauth/revoke`,
			response_types_supported: ['code'],
			grant_types_supported: ['authorization_code', 'refresh_token'],
			code_challenge_methods_supported: ['S256'],
			token_endpoint_auth_methods_supported: ['none'],
			scopes_supported: ['handoff'],
			client_id_metadata_document_supported: true,
			authorization_response_iss_parameter_supported: true,
		});
	}
	if (pathname === '/oauth/authorize' && req.method === 'GET') return handleAuthorize(req, res, state, url);
	if (pathname === '/oauth/token' && req.method === 'POST') return handleToken(req, res, state);
	if (pathname === '/oauth/revoke' && req.method === 'POST') return handleRevoke(req, res, state);
	if (pathname === '/mcp') return handleMcp(req, res, state);
	const upload = /^\/upload\/([^/]+)$/.exec(pathname);
	if (upload) return handleUpload(req, res, state, upload[1]);
	res.writeHead(404).end();
	return undefined;
}

export async function startFakeTestwise({ instructions = FAKE_INSTRUCTIONS, accessTokenTtl = 3600, refreshReuse = 'grace', graceMs = 60_000 } = {}) {
	const state = {
		baseUrl: '',
		instructions,
		accessTokenTtl,
		refreshReuse,
		graceMs,
		tokenDelayMs: 0,
		reuseDetections: [],
		authorizeMode: 'approve',
		// The iss sent back to the callback: the issuer by default, another value, or null to leave it out.
		callbackIss: undefined,
		denyError: null,
		denyDescription: null,
		failRefresh: false,
		tools: new Map(),
		calls: [],
		requests: [],
		discoveryRequests: [],
		authorizeRequests: [],
		tokenRequests: [],
		revocations: [],
		codes: new Map(),
		accessTokens: new Map(),
		refreshTokens: new Map(),
		uploads: new Map(),
		uploadRequests: [],
		uploadResponse: null,
		completeError: null,
	};
	for (const tool of defaultTools(state)) state.tools.set(tool.definition.name, tool);

	const server = http.createServer((req, res) => {
		Promise.resolve()
			.then(() => route(req, res, state))
			.catch((error) => {
				if (!res.headersSent) sendJson(res, 500, { error: { message: error.message } });
			});
	});
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	state.baseUrl = `http://127.0.0.1:${server.address().port}`;

	return {
		url: state.baseUrl,
		state,
		addTool(definition, run) {
			state.tools.set(definition.name, { definition, run });
		},
		// Credentials as `testwise-mcp login` would have saved them, for tests that start signed in.
		mintCredentials() {
			const tokens = issueTokens(state, randomUUID());
			return {
				version: 1,
				servers: {
					[`${state.baseUrl}/mcp`]: { clientId: CLIENT_ID, tokens: { ...tokens, issuer: state.baseUrl }, savedAt: new Date().toISOString() },
				},
			};
		},
		expireAccessTokens() {
			for (const record of state.accessTokens.values()) record.expiresAt = 0;
		},
		liveTokenCount() {
			return [...state.accessTokens.values()].filter((record) => !record.revoked && record.expiresAt > Date.now()).length;
		},
		// Whether an access token would be accepted now, and whether a refresh token could still be exchanged.
		isLive(tokens) {
			const access = state.accessTokens.get(tokens?.access_token);
			const refresh = state.refreshTokens.get(tokens?.refresh_token);
			return Boolean(access && !access.revoked && access.expiresAt > Date.now() && refresh && !refresh.revoked && !refresh.used);
		},
		refreshCount() {
			return state.tokenRequests.filter((request) => request.grantType === 'refresh_token').length;
		},
		async close() {
			server.closeAllConnections();
			await new Promise((resolve) => server.close(resolve));
		},
	};
}

// A local port with nothing listening on it.
export async function closedPort() {
	const server = http.createServer();
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	const { port } = server.address();
	await new Promise((resolve) => server.close(resolve));
	return port;
}
