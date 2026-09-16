# Dianjing Copilot instructions

Bun workspace：Vue 3 + CanvasKit 设计编辑器 + pi 设计助手（pi-backend / 自动化桥 / Electron 壳）。

## Conventions

- 仓库约定与架构边界见 `AGENTS.md`（唯一向导真源）
- No `any` unless there is a clear justification; no non-null assertions — use guards
- Use `crypto.getRandomValues()`, never `Math.random()`
- Keep Vue components free of `<style>` blocks
- Use existing dependencies and Reka UI components before hand-rolling UI

## Validation

- Use Bun, not npm/Node scripts unless the package explicitly requires Node
- 日常门禁 `bun run check:quick`；改动面大时 `bun run check`
