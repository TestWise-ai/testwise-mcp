import { redact } from './redact.js';
import { resultText } from './tool-result.js';

const DEFAULT_WAIT_SECONDS = 45;
const MAX_WAIT_SECONDS = 120;

export const LOCAL_INSTRUCTIONS = [
	'TestWise is where QA and the PM test what you build: you publish a release with checks and decisions, and read back their results, bugs and answers.',
	'This server is not signed in yet. Call the `connect` tool: it opens a browser where the user signs in to TestWise and chooses a project.',
	'Once connected, the TestWise tools appear and `connect` returns the instructions for using them.',
].join('\n');

export const connectTool = {
	name: 'connect',
	title: 'Sign in to TestWise and choose a project',
	description: [
		'Sign in to TestWise and choose a project. Opens the sign-in page in the browser (the link is also returned, so you can show it to the user).',
		'Returns when the user has finished, or after waitSeconds with the link if they have not; the sign-in keeps going in the background,',
		'and the TestWise tools appear as soon as it completes. Call it again to check or to keep waiting.',
	].join(' '),
	inputSchema: {
		type: 'object',
		properties: {
			waitSeconds: {
				type: 'number',
				description: `How long to wait for the user to finish signing in before returning (default ${DEFAULT_WAIT_SECONDS}, at most ${MAX_WAIT_SECONDS}).`,
			},
		},
		additionalProperties: false,
	},
	annotations: { title: 'Connect to TestWise', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
};

function textResult(text, isError = false) {
	return { ...(isError ? { isError: true } : {}), content: [{ type: 'text', text }] };
}

export async function whoami(session) {
	if (!session.tools.some((tool) => tool.name === 'whoami')) return null;
	try {
		const result = await session.callTool('whoami', {});
		return result.isError ? null : resultText(result).split('\n')[0] || null;
	} catch {
		return null;
	}
}

export async function runConnect(args, { session }) {
	const requested = Number(args?.waitSeconds);
	const waitSeconds = Number.isFinite(requested) && requested >= 0 ? Math.min(requested, MAX_WAIT_SECONDS) : DEFAULT_WAIT_SECONDS;
	let outcome;
	try {
		outcome = await session.connect({ waitMs: waitSeconds * 1000 });
	} catch (error) {
		return textResult(redact(`Could not connect to TestWise: ${error.message}`), true);
	}
	if (outcome.status === 'pending') {
		const link = outcome.url ? ` If no browser opened, give the user this link:\n${outcome.url}\n` : ' ';
		return textResult(
			`Waiting for the user to sign in to TestWise and choose a project in the browser.${link}Call connect again to keep waiting. `
			+ 'The TestWise tools appear as soon as the sign-in completes.',
		);
	}
	const lines = ['Connected to TestWise.'];
	const identity = await whoami(session);
	if (identity) lines.push(identity);
	lines.push(`${session.tools.length} TestWise tools are now available (the tool list has changed).`);
	if (session.instructions) lines.push('', 'TestWise instructions:', session.instructions);
	return textResult(lines.join('\n'));
}
