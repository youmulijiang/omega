import { createConnection, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { type BridgeServer, startBridgeServer } from "../src/browser-extension/ws-server.ts";

/**
 * 回归：BridgeServer.close() 必须主动断开已建立的连接。
 *
 * node 的 server.close() 只停止接受新连接，已建立的 socket 会一直保留，回调仅在
 * 全部连接结束后触发。此前实现从不关闭已接受的连接，于是 stopBridge()（在
 * session_shutdown 中被 await）永久挂起，端口不释放，扩展端的 socket 停留在
 * OPEN 状态并一直显示「已连接」——即使 Omega 已经不再响应。
 */

const WS_KEY = "dGhlIHNhbXBsZSBub25jZQ==";
const CLOSE_OPCODE = 0x8;

const openServers: BridgeServer[] = [];
const openSockets: Socket[] = [];

afterEach(async () => {
	for (const socket of openSockets.splice(0)) socket.destroy();
	for (const server of openServers.splice(0)) await server.close();
});

async function startOnFreePort(): Promise<BridgeServer> {
	let lastError: unknown;
	for (let attempt = 0; attempt < 20; attempt += 1) {
		const port = 20000 + Math.floor(Math.random() * 20000);
		try {
			const server = await startBridgeServer({ port, onConnection: () => {} });
			openServers.push(server);
			return server;
		} catch (error) {
			lastError = error;
		}
	}
	throw new Error(`Could not start bridge server on a free port: ${String(lastError)}`);
}

interface Client {
	socket: Socket;
	chunks: Buffer[];
}

/** 用原始 socket 完成一次 WebSocket 握手，返回已完成握手的客户端。 */
function openClient(port: number): Promise<Client> {
	return new Promise((resolve, reject) => {
		const socket = createConnection({ port, host: "127.0.0.1" });
		openSockets.push(socket);
		const chunks: Buffer[] = [];
		socket.on("data", (chunk: Buffer) => chunks.push(chunk));
		socket.on("error", reject);
		socket.on("connect", () => {
			socket.write(
				"GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
					`Sec-WebSocket-Key: ${WS_KEY}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
			);
			const onData = () => {
				if (!Buffer.concat(chunks).toString("latin1").includes("101 Switching Protocols")) return;
				socket.off("data", onData);
				resolve({ socket, chunks });
			};
			socket.on("data", onData);
		});
	});
}

/** 握手响应之后的字节流中是否出现了关闭帧（FIN + opcode 0x8）。 */
function hasCloseFrame(chunks: Buffer[]): boolean {
	const buffer = Buffer.concat(chunks);
	const headerEnd = buffer.indexOf("\r\n\r\n");
	if (headerEnd < 0) return false;
	const frames = buffer.subarray(headerEnd + 4);
	for (let index = 0; index < frames.length; index += 1) {
		if ((frames[index] & 0x80) !== 0 && (frames[index] & 0x0f) === CLOSE_OPCODE) return true;
	}
	return false;
}

function waitForCloseFrame(client: Client, timeoutMs = 2000): Promise<boolean> {
	return new Promise((resolve) => {
		if (hasCloseFrame(client.chunks)) {
			resolve(true);
			return;
		}
		const finish = (value: boolean) => {
			clearTimeout(timer);
			client.socket.off("data", check);
			client.socket.off("close", onClose);
			resolve(value);
		};
		const check = () => {
			if (hasCloseFrame(client.chunks)) finish(true);
		};
		const onClose = () => finish(hasCloseFrame(client.chunks));
		const timer = setTimeout(() => finish(false), timeoutMs);
		client.socket.on("data", check);
		client.socket.on("close", onClose);
	});
}

describe("browser bridge WebSocket server", () => {
	it("closes accepted connections and resolves close() while a client is attached", async () => {
		const server = await startOnFreePort();
		const client = await openClient(server.port);
		const closeFrame = waitForCloseFrame(client);

		const startedAt = Date.now();
		await server.close();
		const elapsed = Date.now() - startedAt;

		// 宽限期 200ms；未关闭连接时 close() 永不回调。
		expect(elapsed).toBeLessThan(1500);
		expect(await closeFrame).toBe(true);
	});

	it("releases the port after close() so a new bridge can bind it", async () => {
		const server = await startOnFreePort();
		const client = await openClient(server.port);
		await server.close();
		client.socket.destroy();

		const restarted = await startBridgeServer({ port: server.port, onConnection: () => {} });
		openServers.push(restarted);
		expect(restarted.port).toBe(server.port);
	});
});