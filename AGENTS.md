# AGENTS.md

Bootstrapping guide for AI agents and new contributors working in this repository.

## Product

**"How Does This Work" (packages: `@made-i-t/hdtw-*`)** — an IDE extension providing guided, rails-driven explanations of how a codebase works, from entrypoint to exit. VS Code is the first target IDE; the architecture is built to expand to others (JetBrains next).

## Architecture (the one thing to internalize)

The core logic runs as a **standalone engine process** (LSP-style JSON-RPC server over stdio). Each IDE extension is a **thin client** that spawns the engine and speaks a typed protocol. IDEs don't share a runtime (VS Code = Node, JetBrains = JVM), so the process boundary is what makes cross-IDE reuse possible.

Dependency rules (architectural, not conventional):

- Clients depend **only** on `@made-i-t/hdtw-protocol` — never on engine internals.
- `src/engine/core` is a pure library with no transport or IDE concerns; `src/engine/server` wraps it behind the protocol.
- `src/protocol` is the engine↔client contract, owned by neither side. Changes to it affect every client — treat them as breaking until versioned otherwise.

## Repository layout

```
src/
├── engine/
│   ├── core/        # @made-i-t/hdtw-engine-core — analysis + rails/tour domain model (pure TS lib)
│   └── server/      # @made-i-t/hdtw-engine-server — standalone process, JSON-RPC over stdio
├── protocol/        # @made-i-t/hdtw-protocol — engine↔client contract (types + schema)
└── clients/
    └── vscode/      # hdtw-vscode — thin VS Code extension (ID: madeit.hdtw-vscode)
tools/               # repo-level scripts (release, codegen) — not product code
docs/
├── adr/             # architecture decision records
└── superpowers/specs/  # design documents — read these before large changes
```

Monorepo intended for multiple teams: each workspace package is an independently ownable unit (engine team, protocol stewards, per-IDE client teams).

## Platform & tooling

- **TypeScript/Node** throughout (engine and VS Code client). Future non-Node clients (e.g. Kotlin for JetBrains) speak the same protocol.
- **pnpm workspaces** for dependency management; **Turborepo** for dependency-aware task running and caching.
- **Vitest** for unit tests; **ESLint + Prettier** at the root.
- VS Code integration tests (`@vscode/test-electron`) are deferred until there is real extension behavior to test.

### Commands

```bash
pnpm install                              # install all workspace deps
pnpm build                                # turbo build, dependency order
pnpm test                                 # turbo test (builds first)
pnpm lint                                 # turbo lint
pnpm turbo test --filter=@made-i-t/hdtw-engine-core            # test one package
pnpm --filter @made-i-t/hdtw-engine-server exec vitest run tests/server.e2e.test.ts  # single test file
```

Launching the extension: open the repo in VS Code and press F5 (Run Extension). The extension spawns the engine as a child process; success shows "HDTW engine connected" in the UI. Engine spawn/handshake failures must surface as visible error notifications — fail fast and visibly.

## Current state (update this section as the repo evolves)

- **Product roadmap:** `docs/product-roadmap.md` — the full feature set across all build chunks, key decisions, and per-chunk status. **Read this first for product context.**
- **Approved design spec:** `docs/superpowers/specs/2026-06-12-monorepo-structure-design.md` — the source of truth for the structure described above.
- **Runnable skeleton implemented** (plan: `docs/superpowers/plans/2026-06-12-monorepo-skeleton.md`): `pnpm install && pnpm build` works; F5 in VS Code launches the extension, which spawns the engine and completes the ping/pong handshake.
- Not yet designed: the guided-tour/rails feature set, agent bootstrapping behavior, JetBrains client, release pipeline.

## Working conventions

- Design before building: significant features get a design doc in `docs/superpowers/specs/` (dated, e.g. `YYYY-MM-DD-<topic>-design.md`); durable architectural choices get an ADR in `docs/adr/`.
- Keep the engine/client/protocol boundaries intact in every change — if a client needs engine data, the answer is a protocol addition, not an import.
- The VS Code extension package is `hdtw-vscode` with publisher `madeit` (extension ID `madeit.hdtw-vscode`) — extension manifests cannot use npm scopes, so it deviates from the `@made-i-t/hdtw-*` naming.
- Package convention: every library package has an `exports` map (`types` condition first); all relative imports in .ts files use `.js` extensions (Node16 module resolution).
