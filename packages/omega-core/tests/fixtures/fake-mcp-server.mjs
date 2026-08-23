import { createInterface } from "node:readline";

const input = createInterface({ input: process.stdin });

function respond(id, result) {
	process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

input.on("line", line => {
	const message = JSON.parse(line);
	if (message.method === "initialize") {
		respond(message.id, {
			protocolVersion: "2025-03-26",
			capabilities: { tools: {} },
			serverInfo: { name: "omega-test", version: "1.0.0" },
		});
	} else if (message.method === "tools/list") {
		respond(message.id, {
			tools: [{ name: "echo", description: "Echo text", inputSchema: { type: "object" } }],
		});
	} else if (message.method === "tools/call") {
		respond(message.id, {
			content: [{ type: "text", text: `echo:${message.params.arguments.text}` }],
		});
	}
});
