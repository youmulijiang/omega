import { describe, expect, it } from "vitest";
import { CdpClient, type CdpWebSocketConstructor } from "../src/chrome/cdp-client.ts";
import {
	activeNetworkCapture,
	getCapturedRequestDetail,
	listCapturedRequests,
	stopNetworkCapture,
} from "../src/chrome/network.ts";

/** 可控的假 WebSocket：手动派发 open/message/close 事件。 */
class FakeWebSocket {
	static instances: FakeWebSocket[] = [];
	readonly sent: string[] = [];
	readonly url: string;
	#listeners = new Map<string, Array<(event: unknown) => void>>();

	constructor(url: string | URL) {
		this.url = String(url);
		FakeWebSocket.instances.push(this);
	}

	addEventListener(method: string, listener: (event: unknown) => void) {
		const list = this.#listeners.get(method) ?? [];
		list.push(listener);
		this.#listeners.set(method, list);
	}

	removeEventListener(method: string, listener: (event: unknown) => void) {
		const list = this.#listeners.get(method) ?? [];
		const index = list.indexOf(listener);
		if (index >= 0) list.splice(index, 1);
	}

	send(data: string) {
		this.sent.push(data);
	}

	close() {
		this.#emit("close", {});
	}

	// --- 测试辅助 ---
	open() {
		this.#emit("open", {});
	}

	message(payload: unknown) {
		this.#emit("message", { data: JSON.stringify(payload) });
	}

	#emit(method: string, event: unknown) {
		for (const listener of [...(this.#listeners.get(method) ?? [])]) listener(event);
	}
}

const webSocketConstructor = FakeWebSocket as unknown as CdpWebSocketConstructor;

async function connectFake(): Promise<{ client: CdpClient; socket: FakeWebSocket }> {
	const url = `ws://cdp/test-${FakeWebSocket.instances.length}`;
	const connectPromise = CdpClient.connect(url, { webSocketConstructor });
	const socket = FakeWebSocket.instances.at(-1);
	if (!socket) throw new Error("FakeWebSocket was not constructed");
	socket.open();
	const client = await connectPromise;
	return { client, socket };
}

describe("CdpClient event subscriptions", () => {
	it("delivers events to wildcard listeners and keeps the connection alive beyond the buffer limit", async () => {
		const { client, socket } = await connectFake();

		const received: Array<{ method: string; params: unknown }> = [];
		const subscription = client.onEvent("*", (method, params) => {
			received.push({ method, params });
		});

		socket.message({ method: "Network.requestWillBeSent", params: { requestId: "r1" } });
		expect(received).toEqual([
			{ method: "Network.requestWillBeSent", params: { requestId: "r1" } },
		]);

		// 订阅者消化的事件不应进入 buffer（无订阅时超过 32 条同方法事件会断连）
		for (let i = 0; i < 100; i += 1) {
			socket.message({ method: "Network.requestWillBeSent", params: { requestId: `bulk-${i}` } });
		}
		expect(received.length).toBe(101);
		// 连接仍存活：send 未抛 throwIfClosed
		let sendError: unknown;
		try {
			const pending = client.send("Test.ping", {}, { timeoutMs: 50 });
			await pending.catch(() => undefined);
		} catch (error) {
			sendError = error;
		}
		expect(sendError).toBeUndefined();
		expect(socket.sent.length).toBe(1);

		subscription.dispose();
		socket.message({ method: "Network.requestWillBeSent", params: { requestId: "r2" } });
		expect(received.length).toBe(101);
		client.close();
	});

	it("notifies closed listeners when the socket closes", async () => {
		const { client, socket } = await connectFake();

		const reasons: unknown[] = [];
		const subscription = client.onClosed((reason) => reasons.push(reason));
		socket.close();
		expect(reasons.length).toBe(1);
		expect(reasons[0]).toBeInstanceOf(Error);
		subscription.dispose();
	});
});

describe("network capture session state", () => {
	const owner = {};

	it("reports no capture before start and rejects list/stop with an actionable error", () => {
		expect(activeNetworkCapture(owner)).toBeUndefined();
		expect(() => listCapturedRequests(owner)).toThrow(/No network capture/);
		expect(stopNetworkCapture(owner)).rejects.toThrow(/No network capture/);
	});

	it("getCapturedRequestDetail rejects when no capture exists", async () => {
		await expect(getCapturedRequestDetail(owner, "nope")).rejects.toThrow(
			/No network capture/,
		);
	});
});
