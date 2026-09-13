import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";

/**
 * 最小 WebSocket 服务端（RFC 6455 文本帧子集），用于接收 Chrome 扩展
 * （plugins/browser-plugin）的桥接连接。不引入 `ws` 依赖以避免 lockfile 变更；
 * 仅支持单条连接、文本帧、ping/pong 与关闭握手。
 */

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;

type TextHandler = (message: string) => void;
type CloseHandler = () => void;

interface WsServerOptions {
	port: number;
	onConnection: (connection: BridgeConnection) => void;
}

export class BridgeConnection {
	readonly id: string;
	private readonly socket: Socket;
	private buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
	private handshakeDone = false;
	private fragments: Buffer[] = [];
	private fragmentOpcode = 0;
	private textHandler: TextHandler | undefined;
	private closeHandler: CloseHandler | undefined;
	private closed = false;

	constructor(socket: Socket) {
		this.id = randomBytes(8).toString("hex");
		this.socket = socket;
		socket.on("data", (chunk) => this.onData(chunk));
		socket.on("error", () => this.handleClose());
		socket.on("close", () => this.handleClose());
	}

	onText(handler: TextHandler) {
		this.textHandler = handler;
	}

	onClose(handler: CloseHandler) {
		this.closeHandler = handler;
	}

	sendText(message: string) {
		if (this.closed) return;
		this.socket.write(encodeFrame(Buffer.from(message, "utf8")));
	}

	close() {
		if (this.closed) return;
		this.socket.write(encodeFrame(Buffer.alloc(0), 0x8));
		this.socket.end();
		this.handleClose();
	}

	private handleClose() {
		if (this.closed) return;
		this.closed = true;
		this.closeHandler?.();
	}

	private onData(chunk: Buffer) {
		this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
		if (!this.handshakeDone) {
			if (!this.tryHandshake()) return;
		}
		while (true) {
			const frame = decodeFrame(this.buffer);
			if (!frame) return;
			this.buffer = this.buffer.subarray(frame.consumed);
			this.handleFrame(frame);
		}
	}

	private tryHandshake() {
		const headerEnd = this.buffer.indexOf("\r\n\r\n");
		if (headerEnd < 0) return false;
		const headers = this.buffer.subarray(0, headerEnd).toString("latin1");
		const key = /sec-websocket-key:\s*(\S+)/i.exec(headers)?.[1];
		if (!key) {
			this.socket.end();
			return true;
		}
		const accept = createHash("sha1")
			.update(key + WS_GUID)
			.digest("base64");
		this.socket.write(
			"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
				`Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
		);
		this.buffer = this.buffer.subarray(headerEnd + 4);
		this.handshakeDone = true;
		return true;
	}

	private handleFrame(frame: DecodedFrame) {
		switch (frame.opcode) {
			case 0x1: // text
			case 0x0: // continuation
				if (frame.opcode === 0x1) {
					this.fragments = [frame.payload];
					this.fragmentOpcode = 0x1;
				} else if (this.fragmentOpcode === 0x1) {
					this.fragments.push(frame.payload);
				} else {
					return;
				}
				if (frame.fin && this.fragmentOpcode === 0x1) {
					const message = Buffer.concat(this.fragments).toString("utf8");
					this.fragments = [];
					this.fragmentOpcode = 0;
					this.textHandler?.(message);
				}
				return;
			case 0x8: // close
				this.close();
				return;
			case 0x9: // ping
				this.socket.write(encodeFrame(frame.payload, 0xa));
				return;
			default:
				return;
		}
	}
}

interface DecodedFrame {
	fin: boolean;
	opcode: number;
	payload: Buffer;
	consumed: number;
}

function decodeFrame(buffer: Buffer): DecodedFrame | undefined {
	if (buffer.length < 2) return undefined;
	const fin = (buffer[0] & 0x80) !== 0;
	const opcode = buffer[0] & 0x0f;
	const masked = (buffer[1] & 0x80) !== 0;
	let length = buffer[1] & 0x7f;
	let offset = 2;
	if (length === 126) {
		if (buffer.length < offset + 2) return undefined;
		length = buffer.readUInt16BE(offset);
		offset += 2;
	} else if (length === 127) {
		if (buffer.length < offset + 8) return undefined;
		const big = buffer.readBigUInt64BE(offset);
		if (big > BigInt(MAX_MESSAGE_BYTES)) throw new Error("WebSocket frame too large");
		length = Number(big);
		offset += 8;
	}
	if (length > MAX_MESSAGE_BYTES) throw new Error("WebSocket frame too large");
	const maskLength = masked ? 4 : 0;
	if (buffer.length < offset + maskLength + length) return undefined;
	let payload = buffer.subarray(offset + maskLength, offset + maskLength + length);
	if (masked) {
		const mask = buffer.subarray(offset, offset + 4);
		const unmasked = Buffer.allocUnsafe(length);
		for (let i = 0; i < length; i += 1) {
			unmasked[i] = payload[i] ^ mask[i % 4];
		}
		payload = unmasked;
	}
	return { fin, opcode, payload, consumed: offset + maskLength + length };
}

function encodeFrame(payload: Buffer, opcode = 0x1): Buffer {
	const length = payload.length;
	let header: Buffer;
	if (length < 126) {
		header = Buffer.from([0x80 | opcode, length]);
	} else if (length < 65536) {
		header = Buffer.alloc(4);
		header[0] = 0x80 | opcode;
		header[1] = 126;
		header.writeUInt16BE(length, 2);
	} else {
		header = Buffer.alloc(10);
		header[0] = 0x80 | opcode;
		header[1] = 127;
		header.writeBigUInt64BE(BigInt(length), 2);
	}
	return Buffer.concat([header, payload]);
}

export interface BridgeServer {
	port: number;
	close(): Promise<void>;
}

export function startBridgeServer(options: WsServerOptions): Promise<BridgeServer> {
	return new Promise((resolve, reject) => {
		const server: Server = createServer((socket) => {
			options.onConnection(new BridgeConnection(socket));
		});
		server.on("error", reject);
		server.listen(options.port, "127.0.0.1", () => {
			server.removeListener("error", reject);
			resolve({
				port: options.port,
				close: () =>
					new Promise((resolveClose) => {
						server.close(() => resolveClose());
					}),
			});
		});
	});
}
