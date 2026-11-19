import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { RemoteError, toRemoteError } from '../src/remote.js';

const ENDPOINT = 'https://testwise.example/mcp';

test('a closed connection to TestWise becomes a local error, not a JSON-RPC error the client would take as its own', () => {
	const error = toRemoteError(new McpError(ErrorCode.ConnectionClosed, 'Connection closed'), ENDPOINT);
	assert.ok(error instanceof RemoteError);
	assert.equal(error.kind, 'closed');
	assert.match(error.message, /^The connection to TestWise at https:\/\/testwise\.example\/mcp closed before it answered\./);
});

test('other JSON-RPC errors from TestWise still pass through', () => {
	const error = toRemoteError(new McpError(ErrorCode.InvalidParams, 'Tool nope not found'), ENDPOINT);
	assert.ok(error instanceof McpError);
	assert.equal(error.code, ErrorCode.InvalidParams);
	assert.equal(error.message, 'Tool nope not found');
});
