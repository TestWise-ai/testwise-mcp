#!/usr/bin/env node
// Stands in for the user's browser in tests (set as BROWSER): opens the sign-in URL and follows its redirects,
// so a fake authorization server that approves at once lands on the loopback callback. Every URL it is asked to
// open is appended to $HOME/opened-urls.log, so tests can check what reached the opener.
import { appendFileSync } from 'node:fs';
import path from 'node:path';

appendFileSync(path.join(process.env.HOME, 'opened-urls.log'), `${process.argv[2]}\n`);
let url = process.argv[2];
for (let hop = 0; url?.startsWith('http') && hop < 5; hop += 1) {
	const response = await fetch(url, { redirect: 'manual' });
	await response.body?.cancel();
	const location = response.headers.get('location');
	url = location ? new URL(location, url).href : null;
}
