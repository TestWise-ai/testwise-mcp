// Keeps secrets out of everything this process prints or returns as an error: OAuth tokens and codes,
// bearer headers, and signed URLs (their signature lives in the query string).

const secrets = new Set();

const BEARER_PATTERN = /\b(Bearer\s+)[^\s"',;]+/gi;
const TOKEN_FIELD_PATTERN = /(\b(?:access_token|refresh_token|id_token|code_verifier)"?\s*[:=]\s*"?)[^"&\s,}]+/gi;
const URL_QUERY_PATTERN = /\b(https?:\/\/[^\s"'<>?#]+)\?[^\s"'<>]*/gi;

export const REDACTED = '[redacted]';

export function registerSecret(value) {
	if (typeof value === 'string' && value.length >= 8) secrets.add(value);
}

export function forgetSecret(value) {
	secrets.delete(value);
}

export function redact(value) {
	let text = String(value ?? '');
	for (const secret of secrets) text = text.split(secret).join(REDACTED);
	return text
		.replace(URL_QUERY_PATTERN, `$1?${REDACTED}`)
		.replace(BEARER_PATTERN, `$1${REDACTED}`)
		.replace(TOKEN_FIELD_PATTERN, `$1${REDACTED}`);
}

export function redactDeep(value) {
	if (typeof value === 'string') return redact(value);
	if (Array.isArray(value)) return value.map(redactDeep);
	if (value && typeof value === 'object') {
		const copy = {};
		for (const [key, entry] of Object.entries(value)) copy[key] = redactDeep(entry);
		return copy;
	}
	return value;
}
