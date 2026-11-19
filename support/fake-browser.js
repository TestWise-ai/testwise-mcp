#!/usr/bin/env node
// Stands in for the user's browser in tests (set as BROWSER): opens the sign-in URL and follows its redirects,
// so a fake authorization server that approves at once lands on the loopback callback.
let url = process.argv[2];
for (let hop = 0; url && hop < 5; hop += 1) {
	const response = await fetch(url, { redirect: 'manual' });
	await response.body?.cancel();
	const location = response.headers.get('location');
	url = location ? new URL(location, url).href : null;
}
