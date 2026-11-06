<div align="center">

<img src="public/icon.svg" width="112" height="112" alt="EScope app icon" />

# EScope

**A simple, handy, open-source Elasticsearch query tool.**

[**English**](README.md) · [简体中文](README.zh-CN.md)

<p>
  <a href="https://tauri.app/"><img src="https://img.shields.io/badge/Tauri-2.x-24C8DB?logo=tauri&logoColor=white" alt="Tauri 2" height="20" /></a>
  <a href="https://react.dev/"><img src="https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black" alt="React 19" height="20" /></a>
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white" alt="TypeScript 5" height="20" /></a>
  <a href="https://www.rust-lang.org/"><img src="https://img.shields.io/badge/Rust-1.85+-orange?logo=rust&logoColor=white" alt="Rust 1.85+" height="20" /></a>
  <a href="https://tailwindcss.com/"><img src="https://img.shields.io/badge/Tailwind_CSS-4.x-38B2AC?logo=tailwind-css&logoColor=white" alt="Tailwind CSS 4" height="20" /></a>
  <a href="#platform-support"><img src="https://img.shields.io/badge/Platform-Windows%20%7C%20macOS%20%7C%20Linux-blue" alt="Platform" height="20" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT" height="20" /></a>
</p>

</div>

---

EScope is a lightweight desktop client for the everyday Elasticsearch workflow: connect to a cluster, write and run a DSL query, inspect and filter the hits, build a quick aggregation or chart, and export what you need — without standing up a full observability platform.

It is intentionally **not** a Kibana replacement, a dashboard builder, or a complete cluster-management suite. EScope focuses on making the daily query loop fast, clear and pleasant.

> **Project status:** early development (`0.1.0`). The query workflow is usable, but APIs, storage schemas and UI details may still change. The current release is **read-only** — it never writes documents, mappings or cluster settings.

## Why EScope

- **Fast to open, fast to query.** A native Tauri shell, a local Monaco editor and a compact workspace keep the path from launch to results short.
- **Local-first by default.** Connection metadata, saved queries and workspace state live in local SQLite. Credentials never belong to the frontend or to a cloud service.
- **Precise results, not pretty lies.** Original JSON tokens, missing values, partial pages and approximation metadata stay visible instead of being silently normalized.
- **Focused on the query loop.** Tabs, PIT pagination, cell filters, aggregations, charts and exports are designed to work together, not as disconnected admin screens.

## Features

| Area | What you can do |
| --- | --- |
| **Connections** | Manage multiple clusters with Basic Auth, API Key or Bearer Token; bind a custom public CA; test identity and inspect cluster/version/license evidence. |
| **Query** | Edit raw JSON DSL with Monaco (local workers, syntax highlighting, formatting, undo/redo); use the visual builder for common query shapes; run independent queries in parallel tabs. |
| **Pagination** | Page through results with Point-in-Time (PIT) cursors on supported clusters; cancel requests and close PIT contexts cleanly when a tab closes. |
| **Results** | Explore hits in a virtualized table with column resize, reorder, visibility, exact local sorting and persistent row selection; switch to raw JSON or a structured document view. |
| **Filters** | Build term/phrase conditions from a cell, combine AND/OR groups, add explicit nested conditions, enable or disable pending conditions, and reuse saved filter sets. |
| **Documents** | Open a paginated JSON-Pointer detail view and compare two hits from the same execution, with metadata, `_source`, `fields` and runtime values kept separate. |
| **Aggregations** | Inspect single-value metrics plus one-level `terms` / `date_histogram` buckets; draw bar or line charts without inventing missing buckets. |
| **Data views** | Save index patterns, aliases and data streams as local views; apply display formats for numbers, percentages, bytes and UTC dates; define bounded runtime fields. |
| **Cluster insight** | Read cluster health, nodes, shards, indices and mappings; inspect field capabilities and permission diagnostics without triggering writes. |
| **Assets** | Save queries with parameter templates, browse bounded execution history, restore the previous workspace, and exchange definitions as local JSON files. |
| **Export** | Copy loaded results as CSV/JSONL, or run a separate bounded PIT scan for a full export with explicit target, DSL and size/row limits. |
| **Desktop experience** | Light/dark themes, four accent colors, density and font controls, Chinese/English UI, keyboard-first dialogs and a fused native title bar. |

## Quick start

### Prerequisites

| Requirement | Version |
| --- | --- |
| Node.js | `20.19+` (or `22.12+`) with npm |
| Rust | `1.85+` via `rustup` |
| Windows | MSVC build tools and the WebView2 runtime |
| macOS | Xcode Command Line Tools |
| Linux | `libwebkit2gtk-4.1-dev`, `build-essential`, `curl`, `wget`, `file`, `libxdo-dev`, `libssl-dev`, `libayatana-appindicator3-dev`, `librsvg2-dev` |

### Run from source

```sh
git clone https://github.com/algerkong/Escope.git
cd EScope
npm ci
npm run tauri -- dev
```

Prefer a quick look without the desktop shell?

```sh
npm run dev
```

Then open `http://127.0.0.1:1420`. The browser preview uses an **in-memory session**: changes disappear on reload, and real credential storage, keyring access and local persistence require the desktop app.

### Build

```sh
# Desktop binary
npm run build:desktop

# Windows NSIS installer (unsigned, current-user install)
npm run build:installer:windows
```

Artifacts are written to `src-tauri/target/release/` (`escope.exe` on Windows) and `src-tauri/target/release/bundle/nsis/` for the installer.

## Architecture

```text
┌─────────────────────────────────────────────────────────────┐
│                        EScope Desktop                       │
└──────────────────────────────┬──────────────────────────────┘
                               │
        ┌──────────────────────┴──────────────────────┐
        ▼                                             ▼
┌─────────────────────────────┐       ┌─────────────────────────────┐
│      Frontend (Web UI)      │  IPC  │      Backend (Native)       │
│                             │ ◄───► │                             │
│ • React 19 + TypeScript     │       │ • Tauri 2 + Rust            │
│ • Vite + Tailwind CSS 4     │       │ • SQLite (rusqlite)         │
│ • Monaco Editor (local)     │       │ • OS keyring (credentials)  │
│ • TanStack Table + Virtual  │       │ • reqwest + rustls (ES/TLS) │
│ • dnd-kit + Lucide + Visx   │       │ • Typed, constrained IPC    │
└─────────────────────────────┘       └─────────────────────────────┘
```

- **Desktop:** [Tauri 2](https://tauri.app/) with Rust, `rusqlite`, `keyring-rs` and `reqwest`/`rustls`.
- **Frontend:** [React 19](https://react.dev/), [TypeScript](https://www.typescriptlang.org/), [Tailwind CSS 4](https://tailwindcss.com/), [Monaco Editor](https://microsoft.github.io/monaco-editor/), [TanStack Table](https://tanstack.com/table), [TanStack Virtual](https://tanstack.com/virtual), [dnd-kit](https://dndkit.com/), [Lucide](https://lucide.dev/) and [Visx](https://airbnb.io/visx/).
- **Storage:** local SQLite for metadata, query and chart definitions, workspace recovery and history; the OS credential store for Basic/API Key/Bearer secrets.
- **IPC:** typed Tauri commands only. There is no generic URL, method or header proxy, and unknown operations are rejected.

## Platform support

| Platform | Status |
| --- | --- |
| **Windows 10/11** | Primary development target. Custom window controls, Windows credential-store integration and the NSIS installer are implemented. |
| **macOS** | Build configuration and native traffic-light overlay are present; real-device window, keyring and signing acceptance are still pending. |
| **Linux** | Tauri dependencies and build path are configured; native verification and keyring integration are still pending. |

Credential storage uses the operating system keyring **where the build supports it**. Today that means the Windows credential store. On macOS/Linux, credential-backed connections are not available yet; metadata-only connections still work.

### Elasticsearch compatibility

EScope targets Elasticsearch **7.10+** for PIT pagination and full exports. The current manual baseline is **7.17.25**. Compatibility with 8.x and 9.x is being verified; no compatibility claim should be inferred from the version number alone. Identity, permission and license evidence is always read from the cluster rather than guessed from the version.

## Scripts

| Command | Description |
| --- | --- |
| `npm run dev` | Start the Vite preview on port 1420 |
| `npm run build` | Type-check and build the production frontend |
| `npm test` | Run the Vitest unit and component suites |
| `npm run check` | Lint, type-check, build and run both frontend test suites |
| `npm run test:rust` | Run the Rust backend test suite |
| `npm run build:desktop` | Build the native release binary (no installer) |
| `npm run build:installer:windows` | Build the unsigned Windows NSIS installer |
| `npm run build:prototype` | Build the standalone visual prototype |
| `npm run test:prototype` | Run the prototype regression tests |
| `node scripts/generate-icon.mjs` | Regenerate desktop icons from `src-tauri/icons/icon.svg` and `icon-macos.svg` |

## Project structure

```text
src/
  app/          Application shell, settings and routing
  features/     Query workspace, connections, cluster views, dialogs
  components/   Shared controls and window chrome
  domain/       Pure domain models, validation and contracts
  services/     Typed IPC and local-storage adapters
  locales/      English and Chinese UI strings
  styles/       Design tokens and feature styles
src-tauri/
  src/          Rust backend, SQLite, credentials and Elasticsearch client
  icons/        Icon sources (icon.svg, icon-macos.svg) and generated desktop icons
docs/           Design, plans and detailed acceptance records
public/         Static assets and the app icon
```

## Documentation

Detailed design notes, task logs and acceptance records live in [`docs/`](docs/):

- [Development status](docs/development-status.md) — implemented capabilities, limits and test records
- [Development plan](docs/development-plan.md) — delivery phases and current workstream
- [Backlog](docs/development-backlog.md) — tasks, dependencies and acceptance criteria
- [Platform design](docs/platform-design.md) — product boundaries and long-term architecture
- [Settings & shortcuts](docs/settings-and-shortcuts.md) — settings, keybindings and platform behavior
- [Manual acceptance](docs/manual-acceptance.md) — native layout, focus, IME and cross-platform checks

> These documents are currently written in Chinese. The application UI and this README are bilingual.

## Security & privacy

- **Read-only by default.** EScope does not provide document, mapping or cluster-setting writes; unknown operations are refused rather than guessed.
- **Secrets stay in the OS keyring.** Plaintext passwords and tokens are never persisted in the frontend, logs, exports or documentation. Credentials are resolved from an immutable transport snapshot at request time.
- **TLS verification stays on.** Custom CAs are supported, but there is no “skip certificate verification” switch.
- **Local metadata only.** Connections, queries, charts and workspace state are stored in local SQLite. There is no telemetry, tracking or third-party upload.
- **Bounded I/O.** Result pages, document detail, comparison, aggregation, chart and export paths enforce explicit size, depth and count limits instead of truncating silently.

## Contributing

Issues and pull requests are welcome. For a smooth review:

1. Open an issue before a large change so the scope and contracts can be agreed on.
2. Keep changes focused and consistent with the existing domain/IPC boundaries.
3. Add or update tests for behavior changes, then run `npm run check`. For Rust changes, also run `npm run test:rust`.
4. Do not include credentials, real customer data, local configuration or generated build output.

The project is maintained in its spare time; response times may vary.

## License

Released under the [MIT License](LICENSE).
