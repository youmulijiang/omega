import { createInterface } from "node:readline";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const input = createInterface({ input: process.stdin });
const restartMarker = process.env.OMEGA_MCP_RESTART_MARKER;
const launchCounter = process.env.OMEGA_MCP_LAUNCH_COUNTER;

if (launchCounter) {
	const launches = existsSync(launchCounter) ? Number(readFileSync(launchCounter, "utf8")) : 0;
	writeFileSync(launchCounter, String(launches + 1));
}

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
		if (restartMarker && !existsSync(restartMarker)) {
			writeFileSync(restartMarker, "restart once");
			setTimeout(() => process.exit(0), 20);
		}
	} else if (message.method === "tools/call") {
		if (message.params.name === "hang") return;
		respond(message.id, {
			content: [{ type: "text", text: `echo:${message.params.arguments.text}` }],
		});
	}
});
