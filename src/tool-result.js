// Hosted TestWise tools answer with text content: a one-line summary plus compact JSON.
// These helpers read that JSON back, whether it arrives as structuredContent, as a text block of its own,
// or as one line of a text block next to the summary.

function parseObject(text) {
	try {
		const value = JSON.parse(text);
		return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
	} catch {
		return null;
	}
}

export function jsonObjects(result) {
	const found = [];
	if (result?.structuredContent && typeof result.structuredContent === 'object') found.push(result.structuredContent);
	for (const block of result?.content ?? []) {
		if (block?.type !== 'text' || typeof block.text !== 'string') continue;
		const text = block.text.trim();
		const candidates = [text, ...text.split('\n').map((line) => line.trim())];
		const first = text.indexOf('{');
		const last = text.lastIndexOf('}');
		if (first >= 0 && last > first) candidates.push(text.slice(first, last + 1));
		for (const candidate of candidates) {
			if (!candidate.startsWith('{')) continue;
			const value = parseObject(candidate);
			if (value) found.push(value);
		}
	}
	return found;
}

export function resultText(result) {
	return (result?.content ?? [])
		.filter((block) => block?.type === 'text' && typeof block.text === 'string')
		.map((block) => block.text.trim())
		.filter(Boolean)
		.join(' ');
}

function unwrap(value) {
	if (value?.data && typeof value.data === 'object' && !Array.isArray(value.data)) return value.data;
	return value;
}

// create_attachment_upload → { attachmentId, uploadUrl, method, headers }.
// Also accepts the attachment service's own shape, { attachment: { id }, uploadUrl, ... }, optionally inside { data }.
export function readUploadTicket(result) {
	for (const candidate of jsonObjects(result)) {
		const value = typeof candidate.uploadUrl === 'string' ? candidate : unwrap(candidate);
		if (typeof value?.uploadUrl !== 'string' || !value.uploadUrl) continue;
		const attachmentId = value.attachmentId ?? value.attachment?.id;
		if ((typeof attachmentId !== 'string' && typeof attachmentId !== 'number') || attachmentId === '') continue;
		const headers = {};
		if (value.headers && typeof value.headers === 'object') {
			for (const [name, header] of Object.entries(value.headers)) {
				if (typeof header === 'string' || typeof header === 'number') headers[name] = String(header);
			}
		}
		const method = typeof value.method === 'string' && value.method ? value.method.toUpperCase() : 'PUT';
		return { attachmentId: String(attachmentId), uploadUrl: value.uploadUrl, method, headers };
	}
	return null;
}

// complete_attachment_upload → { attachment: {...} } (or the attachment itself, optionally inside { data }).
export function readAttachment(result) {
	for (const candidate of jsonObjects(result)) {
		const value = unwrap(candidate);
		if (value?.attachment && typeof value.attachment === 'object') return value.attachment;
		if (value?.id !== undefined) return value;
	}
	return null;
}
