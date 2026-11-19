// Used by the tests: waits until <startAt> (ms since the epoch), takes the credentials lock in <home>, holds it for
// <holdMs> and logs "in <pid>" and "out <pid>" to <log>, so overlapping holders show up as two "in" lines in a row.
import { appendFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { CredentialStore } from '../src/credentials.js';

const [home, log, startAt, holdMs] = process.argv.slice(2);
await delay(Math.max(0, Number(startAt) - Date.now()));
await new CredentialStore({ homeDir: home }).withLock(async () => {
	appendFileSync(log, `in ${process.pid}\n`);
	await delay(Number(holdMs));
	appendFileSync(log, `out ${process.pid}\n`);
});
