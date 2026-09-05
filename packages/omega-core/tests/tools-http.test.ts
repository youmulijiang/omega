import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseHttpReplay, replayHttp, requestHttp } from "../src/tools/http.ts";

describe("HTTP tools", () => {
	let server: Server;
	let origin: string;
	let redirectHits = 0;
	beforeAll(async () => {
		server = createServer(async (request, response) => {
			if (request.url === "/slow") return;
			if (request.url === "/stream") { response.writeHead(200); response.write("a"); return; }
			if (request.url === "/redirect") { response.writeHead(302, { location: "/destination" }); response.end(); return; }
			if (request.url === "/destination") redirectHits++;
			if (request.url === "/large") { response.end("0123456789"); return; }
			if (request.url === "/binary") { response.end(Buffer.from([0, 255, 128, 1])); return; }
			if (request.url === "/broken") { response.writeHead(200, { "content-length": "100" }); response.flushHeaders(); response.end("short"); return; }
			if (request.url === "/upgrade") { response.writeHead(101, { connection: "Upgrade", upgrade: "test" }); response.end(); return; }
			const chunks: Buffer[] = [];
			for await (const chunk of request) chunks.push(Buffer.from(chunk));
			response.setHeader("set-cookie", ["a=1", "b=2"]);
			response.statusCode = request.url === "/missing" ? 404 : 200;
			response.end(JSON.stringify({ method: request.method, path: request.url, headers: request.headers, rawHeaders: request.rawHeaders, body: Buffer.concat(chunks).toString("base64") }));
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	});
	afterAll(async () => {
		server.closeAllConnections();
		await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
	});

	it("sends UTF-8 bodies, recalculates length and preserves duplicate response headers", async () => {
		const result = await requestHttp({ url: `${origin}/echo?q=1`, method: "POST", headers: { "Content-Length": "999", "X-Test": "value" }, body: "你好" });
		expect(result.status).toBe(200);
		expect(result.headers.filter((header) => header.name.toLowerCase() === "set-cookie").map((header) => header.value)).toEqual(["a=1", "b=2"]);
		expect(JSON.parse(result.body)).toMatchObject({ method: "POST", path: "/echo?q=1", headers: { "content-length": "6", "x-test": "value" }, body: Buffer.from("你好").toString("base64") });
		expect(result.truncated).toBe(false);
	});
	it("returns HTTP errors as responses and does not follow redirects", async () => {
		expect((await requestHttp({ url: `${origin}/missing` })).status).toBe(404);
		expect((await requestHttp({ url: `${origin}/redirect` })).status).toBe(302);
		expect(redirectHits).toBe(0);
	});
	it("round trips binary request and response bodies", async () => {
		const body = Buffer.from([0, 255, 128, 1]).toString("base64");
		const sent = await requestHttp({ url: origin, method: "POST", body, bodyEncoding: "base64" });
		expect(JSON.parse(sent.body).body).toBe(body);
		const received = await requestHttp({ url: `${origin}/binary`, responseEncoding: "base64" });
		expect(received.body).toBe(body);
		expect(received.bodyBytes).toBe(4);
	});
	it("limits response bytes and distinguishes exact-size responses", async () => {
		expect(await requestHttp({ url: `${origin}/large`, maxResponseBytes: 4 })).toMatchObject({ body: "0123", bodyBytes: 4, truncated: true });
		expect(await requestHttp({ url: `${origin}/large`, maxResponseBytes: 10 })).toMatchObject({ body: "0123456789", truncated: false });
	});
	it("times out both headers and stalled bodies", async () => {
		for (const path of ["/slow", "/stream"]) {
			await expect(requestHttp({ url: `${origin}${path}`, timeoutMs: 100 })).rejects.toThrow("timed out");
		}
	});
	it("supports cancellation before and during a request", async () => {
		await expect(requestHttp({ url: origin }, AbortSignal.abort())).rejects.toThrow();
		const controller = new AbortController();
		const pending = requestHttp({ url: `${origin}/slow` }, controller.signal);
		controller.abort();
		await expect(pending).rejects.toThrow();
	});
	it("rejects protocol upgrades and incomplete responses", async () => {
		await expect(requestHttp({ url: `${origin}/upgrade` })).rejects.toThrow("upgrades");
		await expect(requestHttp({ url: `${origin}/broken`, timeoutMs: 500 })).rejects.toThrow();
	});
	it("replays captured requests at the explicit URL with header and body overrides", async () => {
		const rawRequest = "POST /original HTTP/1.1\r\nHost: old.invalid\r\nContent-Length: 2\r\nX-Duplicate: one\r\nX-Duplicate: two\r\nAuthorization: old\r\n\r\nold\r\nbody";
		const result = await replayHttp({ url: `${origin}/new?x=2`, rawRequest, headers: { Authorization: "new" }, body: "新" });
		expect(JSON.parse(result.body)).toMatchObject({ method: "POST", path: "/new?x=2", headers: { host: new URL(origin).host, authorization: "new", "content-length": "3", "x-duplicate": "one, two" }, body: Buffer.from("新").toString("base64") });
		expect(parseHttpReplay({ url: origin, rawRequest }).body).toBe("old\r\nbody");
	});
	it("supports LF captures and rejects malformed or chunked captures", () => {
		expect(parseHttpReplay({ url: origin, rawRequest: "GET / HTTP/1.0\nHost: old\n\n" }).method).toBe("GET");
		for (const rawRequest of ["GET / HTTP/1.1", "BAD\r\n\r\n", "GET / HTTP/1.1\r\n folded: header\r\n\r\n", "POST / HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n"]) {
			expect(() => parseHttpReplay({ url: origin, rawRequest })).toThrow();
		}
	});
	it("rejects invalid inputs before issuing a request", async () => {
		for (const input of [{ url: "file:///tmp/test" }, { url: "http://user:pass@localhost" }, { url: origin, timeoutMs: 0 }, { url: origin, maxResponseBytes: -1 }, { url: origin, headers: { bad: "x\r\ninjected: y" } }, { url: origin, method: "GET\r\n" }, { url: origin, body: "!!!", bodyEncoding: "base64" as const }]) {
			await expect(requestHttp(input)).rejects.toThrow();
		}
	});
});
