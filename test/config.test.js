import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConfigError, DEFAULT_URL, readConfig } from '../src/config.js';

test('defaults to the hosted TestWise URL', () => {
	assert.equal(DEFAULT_URL, 'https://app.testwise.ai');
	assert.equal(readConfig({}).endpoint.href, 'https://app.testwise.ai/mcp');
	assert.equal(readConfig({ TESTWISE_URL: '  ' }).endpoint.href, 'https://app.testwise.ai/mcp');
});

test('appends /mcp once, keeping any path prefix', () => {
	const endpoint = (url) => readConfig({ TESTWISE_URL: url }).endpoint.href;
	assert.equal(endpoint('https://testwise.example/'), 'https://testwise.example/mcp');
	assert.equal(endpoint('https://testwise.example/mcp'), 'https://testwise.example/mcp');
	assert.equal(endpoint('https://testwise.example/api/'), 'https://testwise.example/api/mcp');
	assert.equal(endpoint('http://localhost:8080'), 'http://localhost:8080/mcp');
	assert.equal(endpoint('http://127.0.0.1:8080'), 'http://127.0.0.1:8080/mcp');
	assert.equal(endpoint('https://testwise.example/?x=1#frag'), 'https://testwise.example/mcp');
});

test('refuses URLs that would expose tokens', () => {
	const refuse = (url, pattern) => assert.throws(() => readConfig({ TESTWISE_URL: url }), (error) => error instanceof ConfigError && pattern.test(error.message));
	refuse('http://testwise.example', /must start with https:\/\//);
	refuse('ftp://testwise.example', /must start with https:\/\//);
	refuse('https://me:pw@testwise.example', /user name or password/);
	refuse('not a url', /not a valid URL/);
});
