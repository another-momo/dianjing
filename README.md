# OpenPencil

Open-source design editor. Opens `.fig` and `.pen` design files, includes built-in AI, and ships as a programmable toolkit with a headless Vue SDK for building custom editors.

> **Status:** Active development. Usable today, with some rough edges as features evolve.

**[Try it online →](https://app.openpencil.dev/demo)** · [Download](https://github.com/open-pencil/open-pencil/releases/latest) · [Documentation](https://openpencil.dev) · [Roadmap](https://openpencil.dev/development/roadmap) · [llms.txt](https://openpencil.dev/llms.txt)

![OpenPencil](packages/docs/public/screenshot.png)

## Installation

**macOS (Homebrew):**

```sh
brew install openpencil
```

Or download from the [releases page](https://github.com/open-pencil/open-pencil/releases/latest), or [use the web app](https://app.openpencil.dev) — no install needed.

## What it does

- **Opens `.fig` and `.pen` files** — read and write native Figma files, open supported Pencil documents from the app or OS file browser, copy & paste nodes between apps
- **AI builds designs** — describe what you want in chat, 90+ tools create and modify nodes. Connect OpenRouter, Anthropic, OpenAI, Google AI, Z.ai, MiniMax, or compatible endpoints
- **Lint, convert, and extract tokens** — inspect documents, lint naming/layout/accessibility, convert between supported formats, analyze colors/typography/spacing/clusters, and extract design tokens
- **Components and variants** — create reusable components, group variants into component sets, insert local assets as instances, and switch variants from the inspector
- **Image vectorization** — convert image layers into editable vector layers with Recraft or fal.ai
- **Design-to-code export** — export selections as JSX/Tailwind, generate token outputs, and map designs into component-oriented code workflows
- **Vue SDK for custom editors** — headless components and composables for embedding OpenPencil into other apps or building workflow-specific editing surfaces. [Read the SDK docs →](https://openpencil.dev/programmable/sdk/)
- **Real-time collaboration** — P2P via WebRTC, no server, no account. Cursors, presence, follow mode
- **Auto layout & CSS Grid** — flex and grid layout via Yoga WASM, with gap, padding, alignment, track sizing
- **~7 MB desktop app** — Tauri v2 for macOS, Windows, Linux. Also runs in the browser as a PWA

## AI

### Built-in chat

Press <kbd>⌘</kbd><kbd>J</kbd> to open the AI assistant. It has 100+ tools that can create shapes, set fills and strokes, manage auto-layout, work with components and variables, run boolean operations, analyze design tokens, and export assets. Bring your own API key for OpenRouter, Anthropic, OpenAI, Google AI, Z.ai, MiniMax, or compatible endpoints. No backend, no account.

Not every provider works in the browser, and not every model streams tool calls correctly. See [BYOK provider & model compatibility](packages/docs/programmable/byok-provider-compatibility.md) for measured results — contributions welcome.

### AI agent skill

Teach your AI coding agent to use OpenPencil — inspect designs, export assets, analyze tokens, modify .fig files:

```sh
npx skills add open-pencil/open-pencil
```

Works with Claude Code, Cursor, Windsurf, Codex, and any agent that supports [skills](https://skills.sh).

For documentation-aware agents, the docs site publishes [llms.txt](https://openpencil.dev/llms.txt), [llms-full.txt](https://openpencil.dev/llms-full.txt), and per-page Markdown files generated from the VitePress docs.

## Collaboration

Share a link to co-edit in real time. No server, no account — peers connect directly via WebRTC.

1. Click the share button in the top-right panel
2. Share the generated link (`app.openpencil.dev/share/<room-id>`)
3. Collaborators see your cursor, selection, and edits in real time
4. Click a peer's avatar to follow their viewport

## Why

Figma is a closed platform that actively fights programmatic access. Their MCP server is read-only. [figma-use](https://github.com/dannote/figma-use) added full read/write automation via CDP — then [Figma 126 killed CDP](https://forum.figma.com/report-a-problem-6/remote-debugging-port-not-working-in-figma-desktop-126-1-2-50858). Your design files are in a proprietary binary format that only their software can fully read. Your workflows break when they decide to ship a point release.

OpenPencil is the alternative: open source (MIT), reads .fig files natively, every operation is scriptable, and your data never leaves your machine.

See the [roadmap](https://openpencil.dev/development/roadmap) for product direction and current Figma compatibility gaps.

## OpenPencil Rebuild

This fork carries an in-progress rebuild (re-fork + strangler-port of the AI workbench onto a pi SDK runtime, branch `rebuild/pi`). The historical rebuild working documents are archived under `docs/archive/rebuild-campaign/` (frozen 2026-09-06) — entry point: [docs/archive/rebuild-campaign/README.md](docs/archive/rebuild-campaign/README.md); final tracker snapshot: [docs/archive/rebuild-campaign/tracker.md](docs/archive/rebuild-campaign/tracker.md). These are internal working documents, not user documentation.

## Contributing

### Setup

```sh
bun install
bun run dev:portless  # Web editor at https://open-pencil.localhost
bun run dev           # Direct Vite server at http://localhost:1420
bun run tauri dev     # Desktop app (requires Rust)
```

The first Portless run creates and trusts a local HTTPS certificate. Linked Git worktrees automatically receive branch-prefixed URLs such as `https://fix-ui.open-pencil.localhost`, so concurrent development servers do not compete for port 1420. Their development MCP bridges are exposed through matching sibling URLs such as `https://fix-ui.mcp.open-pencil.localhost`, with isolated TCP ports and runtime socket files. Run `bunx portless doctor` if local routing or certificate trust fails.

Alternatively, open the repository in any [Dev Container](https://containers.dev/)-compatible tool. The container pins Bun, installs the workspace dependencies, and forwards the direct web editor on port 1420. Start it with `bun run dev` after the container is ready.

The Dev Container supports the web editor, packages, and automated checks. Native Tauri development still requires the host setup described below because desktop windows and platform WebView dependencies are not provided in the container.

### Quality gates

| Command             | Description           |
| ------------------- | --------------------- |
| `bun run check`     | Lint + typecheck      |
| `bun run test`      | E2E visual regression |
| `bun run test:unit` | Unit tests            |
| `bun run format`    | Code formatting       |

### Project structure

```
packages/
  scene-graph/    @open-pencil/scene-graph — nodes, primitives, hit testing, copy/snap/undo
  pen/            @open-pencil/pen — Pencil document format helpers
  kiwi/           @open-pencil/kiwi — Kiwi runtime and low-level .fig container parsing
  fig/            @open-pencil/fig — .fig archives, SceneGraph conversion, instances, metadata
  core/           @open-pencil/core — editor engine, renderer, layout, tools, RPC, document I/O
  dom-css/        @open-pencil/dom-css — HTML/CSS/Tailwind to editable design documents
  vue/            @open-pencil/vue — headless Vue SDK
  docs/           Documentation site (openpencil.dev)
src/              Vue app (editor shell, AI, collaboration, document I/O)
desktop/          Tauri v2 desktop app (Rust + config)
tests/            E2E, visual, engine, and integration tests
```

### Tech stack

| Layer         | Tech                                                                              |
| ------------- | --------------------------------------------------------------------------------- |
| Rendering     | Skia (CanvasKit WASM)                                                             |
| Layout        | Yoga WASM (flex + grid via [fork](https://github.com/open-pencil/yoga/tree/grid)) |
| UI            | Vue 3, Reka UI, Tailwind CSS 4                                                    |
| File format   | Kiwi binary + Zstd + ZIP                                                          |
| Collaboration | Trystero (WebRTC P2P) + Yjs (CRDT)                                                |
| Desktop       | Tauri v2                                                                          |
| AI            | Multi-provider (Anthropic, OpenAI, Google AI, OpenRouter), Hono                 |

### Desktop builds

Requires [Rust](https://rustup.rs/) and platform-specific prerequisites ([Tauri v2 guide](https://v2.tauri.app/start/prerequisites/)).

```sh
bun run tauri build
```

## Acknowledgments

Thanks to [@sld0Ant](https://github.com/sld0Ant) (Anton Soldatov) for creating and maintaining the [documentation site](https://openpencil.dev).

## License

OpenPencil is licensed under the [MIT License](./LICENSE).

Copyright (c) 2026 Danila Poyarkov and OpenPencil contributors.
