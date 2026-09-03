# Design: Multi-IDE Extension Monorepo Structure

**Date:** 2026-06-12
**Status:** Approved
**Product:** "How Does This Work" — guided, rails-driven explanation of how a codebase works from entrypoint to exit. VS Code first, expanding to other IDEs (JetBrains next).

## Goals

- Support the full delivery lifecycle of multiple IDE extensions in a single repository (monorepo, multiple teams).
- Maximize reuse of the core analysis and tour engine across IDEs with different runtimes (Node, JVM, .NET).
- Make team ownership boundaries structural, not conventional.

## Key Decisions

### 1. Standalone engine + thin clients

The core logic (codebase analysis, rails/tour engine) runs as a **separate process** — an LSP-style JSON-RPC server over stdio. Each IDE extension is a thin client that spawns the engine and speaks a defined protocol.

Rationale: IDEs do not share a runtime (VS Code is Node, JetBrains is JVM, Visual Studio is .NET). A process boundary with a typed protocol is the only sharing strategy that scales across all of them. It also lets the engine team and client teams ship independently.

Alternatives considered:
- **Shared TS core embedded per-IDE** — fastest for VS Code alone, but JetBrains would need an embedded Node runtime or a port. Rejected.
- **Independent per-IDE implementations** — every feature rebuilt per IDE. Rejected.

### 2. Tooling: pnpm workspaces + Turborepo

- pnpm for strict, fast dependency management and workspace linking.
- Turborepo for dependency-aware task running (`build`, `test`, `lint`) with caching; CI can filter to affected packages.
- Engine language is TypeScript/Node (natural fit for VS Code-first; the protocol keeps clients language-agnostic).

Alternatives considered: Nx (richer guardrails, steeper curve — revisit if team count grows), plain workspaces (no orchestration — rejected for multi-team use).

### 3. Code under a top-level `src/` folder

All product code lives under `src/`. Repo-level tooling and docs live outside it.

## Repository Layout

```
ide-how-does-this-work/
├── src/
│   ├── engine/
│   │   ├── core/             # @hdtw/engine-core — analysis + rails/tour domain model (pure TS lib)
│   │   └── server/           # @hdtw/engine-server — standalone process, JSON-RPC over stdio
│   ├── protocol/             # @hdtw/protocol — the engine↔client contract (types + schema)
│   └── clients/
│       └── vscode/           # @hdtw/vscode — thin VS Code extension
│       └── (jetbrains/ later — thin Kotlin client speaking the same protocol)
├── tools/                    # repo-level scripts (release, codegen) — not product code
├── docs/
│   ├── adr/                  # architecture decision records
│   └── superpowers/specs/    # design documents
├── pnpm-workspace.yaml
├── turbo.json
├── tsconfig.base.json
└── package.json
```

`protocol/` sits beside `engine/` and `clients/`, not inside either: it is the contract both sides depend on, owned by neither.

Package scope is `@hdtw` ("How Does This Work") — a working name, trivially renameable.

## Team Boundaries & Dependency Rules

- Each workspace package is an independently ownable unit (CODEOWNERS-ready: engine team, protocol stewards, per-IDE client teams).
- **Clients depend only on `@hdtw/protocol`** — never on engine internals. The engine ships as a process, not a library, so this is enforced by architecture.
- `engine/core` has no dependency on `engine/server` or any transport concern; `engine/server` wraps `core` behind the protocol.

## Runnable Skeleton (initial scaffold scope)

The scaffold includes minimal working code proving the architecture end-to-end:

- `pnpm install && turbo build` builds all packages in dependency order.
- F5 in VS Code launches the extension, which spawns `engine-server` as a child process and exchanges a typed `ping`/`pong` over stdio JSON-RPC (via the `vscode-jsonrpc` npm package, which is transport-only and IDE-agnostic).
- Success surfaces "HDTW engine connected (v0.0.1)" in the VS Code UI.

## Error Handling

- Engine spawn failure or handshake timeout produces a clear, user-visible VS Code error notification — fail fast and visibly.
- Protocol messages are typed; malformed messages are rejected at the boundary.

## Testing & Quality

- Vitest for unit tests in `engine/core`, `engine/server`, and `protocol` (one real test each in the skeleton, proving the harness).
- ESLint + Prettier at the root, run via `turbo lint`.
- VS Code integration tests (`@vscode/test-electron`) deferred until there is real extension behavior to test.

## Out of Scope (for this design)

- Feature design of the guided tour / rails experience (separate design discussion).
- Agent bootstrapping (separate discussion).
- JetBrains client implementation (structure reserves space only).
- Release/publishing pipeline (tools/ reserves space; designed when first release approaches).
