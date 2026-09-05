import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

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

const OMEGA_EXTENSIONS: OmegaExtensions = {
	isOmega: true,
	// 未来在此添加 omega 专属方法实现，例如：
	// registerSecurityScope(scope) { ... },
};

/**
 * 将 pi 微内核包裹为 OmegaAPI。
 *
 * - omega-core 的所有子模块接收此对象，通过 `omega.*` 调用
 * - 对 pi 零侵入：pi 的代码、类型、行为完全不变
 * - omega 专属方法在 OMEGA_EXTENSIONS 中独立实现
 */
export function createOmegaAPI(pi: ExtensionAPI): OmegaAPI {
	return new Proxy(pi as OmegaAPI, {
		get(target, prop, receiver) {
			// omega 专属属性/方法优先
			if (Object.hasOwn(OMEGA_EXTENSIONS, prop)) {
				const val: unknown = OMEGA_EXTENSIONS[prop as keyof OmegaExtensions];
				return typeof val === "function" ? val.bind(OMEGA_EXTENSIONS) : val;
			}
			// 透传给 pi，保持 pi 内部 this 正确绑定
			const val = Reflect.get(target, prop, receiver);
			return typeof val === "function" ? val.bind(target) : val;
		},

		has(target, prop) {
			return prop in OMEGA_EXTENSIONS || prop in target;
		},
	});
}
