import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { resolveLocalPath } from '../src/attach-file.js';

const WINDOWS = { platform: 'win32', pathImpl: path.win32, homeDir: 'C:\\Users\\pat' };
const POSIX = { platform: 'linux', pathImpl: path.posix, homeDir: '/home/pat' };

test('UNC and device paths are refused on Windows', () => {
	const refused = [
		'\\\\server\\share\\shot.png',
		'//server/share/shot.png',
		'/\\server\\share\\shot.png',
		'\\\\?\\UNC\\server\\share\\shot.png',
		'\\\\.\\pipe\\testwise',
		'\\\\?\\C:\\shots\\shot.png',
		'  \\\\server\\share\\shot.png',
	];
	for (const input of refused) {
		assert.throws(() => resolveLocalPath(input, 'C:\\work', WINDOWS), /is a network or device path/, input);
	}
});

test('a relative path cannot reach a share through a UNC working directory', () => {
	assert.throws(() => resolveLocalPath('shot.png', '\\\\server\\share\\work', WINDOWS), /is a network or device path/);
});

test('local Windows paths still resolve', () => {
	assert.equal(resolveLocalPath('C:\\work\\shot.png', 'D:\\other', WINDOWS), 'C:\\work\\shot.png');
	assert.equal(resolveLocalPath('C:/work/shot.png', 'D:\\other', WINDOWS), 'C:\\work\\shot.png');
	assert.equal(resolveLocalPath('shots\\shot.png', 'C:\\work', WINDOWS), 'C:\\work\\shots\\shot.png');
	assert.equal(resolveLocalPath('~/shot.png', 'C:\\work', WINDOWS), 'C:\\Users\\pat\\shot.png');
});

test('on other systems a leading // is an ordinary path', () => {
	assert.equal(resolveLocalPath('//tmp/shot.png', '/work', POSIX), '/tmp/shot.png');
	assert.equal(resolveLocalPath('~/shot.png', '/work', POSIX), '/home/pat/shot.png');
});
