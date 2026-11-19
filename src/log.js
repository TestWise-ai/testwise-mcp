import { redact } from './redact.js';

// stdout carries the MCP protocol, so everything human-readable goes to stderr.
export function log(message) {
	process.stderr.write(`testwise-mcp: ${redact(message)}\n`);
}

// For text that must reach the user unchanged, such as the sign-in URL. Never pass secrets here.
log.raw = (message) => {
	process.stderr.write(`testwise-mcp: ${message}\n`);
};

export function exitWithError(message, code = 1) {
	process.stderr.write(`testwise-mcp: ${redact(message)}\n`, () => process.exit(code));
}
