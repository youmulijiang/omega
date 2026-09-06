import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TUI, TuiStopOptions } from "@earendil-works/pi-tui";

export interface TuiClickEvent {
	/** One-based terminal column reported by the SGR mouse protocol. */
	x: number;
	/** One-based terminal row reported by the SGR mouse protocol. */
	y: number;
	/** Mouse button encoded by the terminal: primary, middle, secondary, or release. */
	button: "primary" | "middle" | "secondary" | "release";
	ctrl: boolean;
	meta: boolean;
	shift: boolean;
}

// biome-ignore lint/suspicious/noConfusingVoidType: void lets handlers omit a return value; true alone consumes the click.
export type TuiClickHandler = (event: TuiClickEvent) => boolean | void;

// ---------------------------------------------------------------------------
// OmegaAPI — pi ExtensionAPI 的超集
//
// 规则：
//   · 所有 pi.xxx() 方法在 omega.xxx() 上原样可用（向下兼容）
//   · omega 专属能力在此接口中声明，通过 createOmegaAPI() 实现
//   · omega-core 内部代码只导入 OmegaAPI，不直接引用 ExtensionAPI
// ---------------------------------------------------------------------------

/** Omega 专属事件扩展（未来在此追加 on() 重载） */
export interface OmegaAPI extends ExtensionAPI {
	/** 内部标识，区分原始 pi API 与 omega 包装层 */
	readonly isOmega: true;
	/** Register a handler for SGR mouse clicks on a concrete TUI instance. */
	registerTuiClick(tui: TUI, handler: TuiClickHandler): () => void;

	// ── 未来扩展占位 ──────────────────────────────────────────────
	// registerSecurityScope(scope: SecurityScope): void;
	// getScope(): SecurityScope | undefined;
	// on(event: "omega_scan_start", handler: ...): void;
	// ─────────────────────────────────────────────────────────────
}

// ---------------------------------------------------------------------------
// 工厂：将 pi 微内核包裹为 OmegaAPI
//
// 实现策略：
//   · Proxy get 陷阱——先查 omega 专属扩展表，再透传给 pi
//   · 所有 pi 方法保持原有 this 绑定，不复制实现
//   · 新增 omega 方法直接挂在 extensions 对象上，pi 无感知
// ---------------------------------------------------------------------------

/** omega 专属方法的具体实现，与 pi 完全解耦 */
type OmegaExtensions = Omit<OmegaAPI, keyof ExtensionAPI>;

interface TuiClickPatch {
	handlers: Set<TuiClickHandler>;
}

const TUI_CLICK_PATCHES = new WeakMap<TUI, TuiClickPatch>();
const SGR_MOUSE_EVENT = /^\x1b\[<(\d+);(\d+);(\d+)m$/;

function parseTuiClick(data: string): TuiClickEvent | undefined {
	const match = SGR_MOUSE_EVENT.exec(data);
	if (!match) return undefined;

	const encodedButton = Number(match[1]);
	const buttonCode = encodedButton & 3;
	const button = ["primary", "middle", "secondary", "release"][buttonCode] as TuiClickEvent["button"];
	return {
		x: Number(match[2]),
		y: Number(match[3]),
		button,
		shift: (encodedButton & 4) !== 0,
		meta: (encodedButton & 8) !== 0,
		ctrl: (encodedButton & 16) !== 0,
	};
}

function registerTuiClick(tui: TUI, handler: TuiClickHandler): () => void {
	let patch = TUI_CLICK_PATCHES.get(tui);
	if (!patch) {
		patch = { handlers: new Set() };
		TUI_CLICK_PATCHES.set(tui, patch);

		const removeInputListener = tui.addInputListener((data) => {
			const event = parseTuiClick(data);
			if (!event) return undefined;
			for (const clickHandler of patch!.handlers) {
				if (clickHandler(event) === true) return { consume: true };
			}
			return undefined;
		});

		// Pi exposes no TUI disposal hook to extensions. Patch stop() on this
		// instance so the listener and captured handlers cannot survive a restart.
		const originalStop = tui.stop;
		tui.stop = function patchedStop(options?: TuiStopOptions): void {
			removeInputListener();
			patch!.handlers.clear();
			TUI_CLICK_PATCHES.delete(tui);
			tui.stop = originalStop;
			originalStop.call(tui, options);
		};
	}

	patch.handlers.add(handler);
	return () => patch?.handlers.delete(handler);
}

/**
 * 将 pi 微内核包裹为 OmegaAPI。
 *
 * - omega-core 的所有子模块接收此对象，通过 `omega.*` 调用
 * - 对 pi 零侵入：pi 的代码、类型、行为完全不变
 * - omega 专属方法在 OMEGA_EXTENSIONS 中独立实现
 */
export function createOmegaAPI(pi: ExtensionAPI): OmegaAPI {
	const omegaExtensions: OmegaExtensions = {
		isOmega: true,
		registerTuiClick,
	};

	return new Proxy(pi as OmegaAPI, {
		get(target, prop, receiver) {
			// omega 专属属性/方法优先
			if (Object.hasOwn(omegaExtensions, prop)) {
				const val: unknown = omegaExtensions[prop as keyof OmegaExtensions];
				return typeof val === "function" ? val.bind(omegaExtensions) : val;
			}
			// 透传给 pi，保持 pi 内部 this 正确绑定
			const val = Reflect.get(target, prop, receiver);
			return typeof val === "function" ? val.bind(target) : val;
		},

		has(target, prop) {
			return prop in omegaExtensions || prop in target;
		},
	});
}
