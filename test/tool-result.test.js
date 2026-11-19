import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readAttachment, readUploadTicket } from '../src/tool-result.js';

const TICKET = { attachmentId: 'a1', uploadUrl: 'https://storage.example/a1?sig=x', method: 'PUT', headers: { 'Content-Type': 'image/png' } };
const textResult = (...texts) => ({ content: texts.map((value) => ({ type: 'text', text: value })) });

test('reads the upload ticket from a summary line followed by compact JSON', () => {
	assert.deepEqual(readUploadTicket(textResult(`Upload ready for a.png.\n${JSON.stringify(TICKET)}`)), TICKET);
});

test('reads the upload ticket from JSON first, a separate block or structuredContent', () => {
	assert.deepEqual(readUploadTicket(textResult(`${JSON.stringify(TICKET)}\nUpload ready.`)), TICKET);
	assert.deepEqual(readUploadTicket(textResult('Upload ready.', JSON.stringify(TICKET))), TICKET);
	assert.deepEqual(readUploadTicket({ content: [], structuredContent: TICKET }), TICKET);
	assert.deepEqual(readUploadTicket(textResult(`Upload ready: ${JSON.stringify(TICKET)}`)), TICKET);
});

test('accepts the attachment service shape and a { data } envelope', () => {
	const serviceShape = { attachment: { id: 'a1', status: 'PENDING' }, uploadUrl: TICKET.uploadUrl, method: 'PUT', headers: TICKET.headers, expiresIn: 900 };
	assert.deepEqual(readUploadTicket(textResult(JSON.stringify(serviceShape))), TICKET);
	assert.deepEqual(readUploadTicket(textResult(JSON.stringify({ success: true, data: serviceShape }))), TICKET);
});

test('defaults the method to PUT and keeps only string headers', () => {
	const ticket = readUploadTicket(textResult(JSON.stringify({ attachmentId: 7, uploadUrl: 'https://s.example/u', headers: { a: 'b', n: 1, bad: { x: 1 } } })));
	assert.deepEqual(ticket, { attachmentId: '7', uploadUrl: 'https://s.example/u', method: 'PUT', headers: { a: 'b', n: '1' } });
});

test('returns null when the ticket is incomplete', () => {
	assert.equal(readUploadTicket(textResult('Upload ready.')), null);
	assert.equal(readUploadTicket(textResult(JSON.stringify({ uploadUrl: 'https://s.example/u' }))), null);
	assert.equal(readUploadTicket(textResult(JSON.stringify({ attachmentId: 'a1' }))), null);
});

test('reads the completed attachment', () => {
	const attachment = { id: 'a1', fileName: 'a.png', status: 'ACTIVE' };
	assert.deepEqual(readAttachment(textResult(`Attached a.png.\n${JSON.stringify({ attachment })}`)), attachment);
	assert.deepEqual(readAttachment(textResult(JSON.stringify(attachment))), attachment);
	assert.deepEqual(readAttachment(textResult(JSON.stringify({ success: true, data: { attachment } }))), attachment);
	assert.equal(readAttachment(textResult('Attached.')), null);
});
