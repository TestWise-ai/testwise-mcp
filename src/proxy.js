import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema, McpError } from '@modelcontextprotocol/sdk/types.js';
import { connectTool, LOCAL_INSTRUCTIONS, runConnect } from './connect-tool.js';
import { redact, redactDeep } from './redact.js';
import { NOT_SIGNED_IN, RemoteError } from './remote.js';

function errorResult(text) {
	return { isError: true, content: [{ type: 'text', text: redact(text) }] };
}

// The stdio server an MCP client talks to. While signed out it offers `connect` plus the local tools; once
// connected it serves the hosted server's tools (discovered on every tools/list and forwarded untouched) plus the
// local tools ({ definition, run }) that need this machine.
export function createProxyServer({ session, version, localTools = [] }) {
	const local = new Map(localTools.map((tool) => [tool.definition.name, tool]));

	const server = new Server(
		{ name: 'testwise-mcp', version },
		{ capabilities: { tools: { listChanged: true } }, instructions: session.connected ? session.instructions || undefined : LOCAL_INSTRUCTIONS },
	);

	session.on('change', () => {
		server.sendToolListChanged().catch(() => {});
	});

	server.setRequestHandler(ListToolsRequestSchema, async () => {
		if (session.connected) await session.refreshTools();
		const localDefinitions = [...local.values()].map((tool) => tool.definition);
		if (!session.connected) return { tools: [connectTool, ...localDefinitions] };
		return { tools: [...session.tools.filter((tool) => !local.has(tool.name) && tool.name !== connectTool.name), ...localDefinitions] };
	});

	server.setRequestHandler(CallToolRequestSchema, async (request) => {
		const { name, arguments: args } = request.params;
		if (name === connectTool.name && !session.tools.some((tool) => tool.name === name)) return runConnect(args ?? {}, { session });
		const localTool = local.get(name);
		if (!session.connected) return errorResult(NOT_SIGNED_IN);
		if (localTool) return localTool.run(args ?? {}, { remote: session });
		try {
			const result = await session.callTool(name, args);
			return result.isError ? redactDeep(result) : result;
		} catch (error) {
			if (error instanceof McpError) throw error;
			return errorResult(error instanceof RemoteError ? error.message : `TestWise request failed: ${error?.message ?? error}`);
		}
	});

	return server;
}
