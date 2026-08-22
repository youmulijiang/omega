# OMEGA Patches

本文件记录所有对上游 Pi 文件的修改。每次 upstream sync 时，需逐条核验。

## 格式

```
## [PATCH-XXX] 包名: 改动简述
- 文件: packages/xxx/src/xxx.ts:行号
- 改动: 具体改了什么
- 原因: 为什么必须改上游文件
- 上游同步风险: 低 / 中 / 高
- 上次验证: YYYY-MM-DD @ vX.X.X
```

---

<!-- patches will be added below -->

## [PATCH-001] coding-agent: 品牌名改为 omega，配置目录改为 .omega

- 文件: packages/coding-agent/package.json（piConfig + bin 字段）
- 改动: `piConfig.name: "omega"`, `piConfig.configDir: ".omega"`, `bin: {"omega": "dist/cli.js"}`
- 原因: OMEGA 使用独立配置目录，避免与 pi 配置混用；`omega` 为用户启动命令
- 上游同步风险: 低（仅 JSON 字段，上游极少改动）
- 上次验证: 2026-08-22 @ v0.84.2（upstream c49906ec7）
