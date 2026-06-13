# How Does This Work

> Guided, rails-driven explanations of how a codebase works — from entrypoint to exit — the way a principal engineer walks a new hire through the platform.

**How Does This Work** is an IDE extension that turns "how does this codebase actually work?" into a guided walk through real code. An AI agent explores the repository, then produces a **tour**: an ordered set of steps, each anchored to specific lines in specific files, narrated with the architecture and the *why* behind the code. Anyone on the team can then walk that tour on rails — step by step, with the narration pinned inline beneath the code — with no agent and no tokens.

VS Code is the first target IDE; the architecture is built to expand to others (JetBrains next).

## The two ideas that shape everything

1. **Generation and playback are different products.** An agent (expensive, occasional) *generates* a tour; the rails experience *replays* it deterministically — free, offline, instant, no LLM. **One person generates; the whole team walks.**
2. **Tours are the universal currency.** A tour is a plain `.hdtw/tours/*.tour.json` file committed alongside your source. Sharing a walkthrough is just `git pull`. Generating one, asking for one in conversation, or hand-authoring one all produce the same artifact.

## Current status

| Chunk | Capability | Status |
|---|---|---|
| 0 | Monorepo skeleton — engine process + thin clients | ✅ shipped |
| 1 | Tour artifacts + rails playback (sidebar, inline narration, drift-tolerant) | ✅ shipped |
| 2 | Embedded agent tour generation (Claude Agent SDK, budget, cancellation, anchor verification) | ✅ shipped |
| 3 | Conversational walks + mid-tour "Why?" detours | ⬜ planned |
| 4 | Grounding — code-map tools + anchor drift detection | ⬜ planned |
| 5 | Team & beyond — freshness CI, JetBrains client, monetization | ⬜ planned |

See [`docs/product-roadmap.md`](docs/product-roadmap.md) for the full feature set, the decisions log, and per-chunk detail.

## Architecture

The core logic runs as a **standalone engine process** — an LSP-style JSON-RPC server over stdio. Each IDE extension is a **thin client** that spawns the engine and speaks a typed protocol. IDEs don't share a runtime (VS Code is Node, JetBrains is the JVM), so the process boundary is what makes cross-IDE reuse possible.

```
src/
├── engine/
│   ├── core/        # @made-i-t/hdtw-engine-core — pure domain: tour parsing, anchor verification, hashing
│   └── server/      # @made-i-t/hdtw-engine-server — the process: stdio JSON-RPC, fs, the embedded agent
├── protocol/        # @made-i-t/hdtw-protocol — the engine↔client contract (types + method names)
└── clients/
    └── vscode/      # hdtw-vscode — thin VS Code extension (ID: madeit.hdtw-vscode)
```

**Dependency rules** (architectural, not conventional):

- Clients depend **only** on `@made-i-t/hdtw-protocol` — never on engine internals. The engine ships as a process, not a library.
- `engine-core` is pure: no filesystem, no transport, no network/SDK. (Deterministic `node:` builtins such as `node:crypto` are allowed.)
- `engine-server` owns all filesystem access and the agent; it wraps `engine-core` behind the protocol.

A generated tour is **never trusted on the agent's word**: the agent proposes hashless anchors, and the engine independently re-reads each file, verifies the line ranges, computes the snippet hash itself, and runs one repair round before a final validation gate. The generation agent is strictly read-only (Read / Grep / Glob).

## Getting started

Requires [pnpm](https://pnpm.io) (via `corepack enable pnpm`).

```bash
pnpm install      # install all workspace deps
pnpm build        # build every package in dependency order (Turborepo)
pnpm test         # run the test suite
pnpm lint         # lint all packages
```

### Run the extension

Open the repo in VS Code and press **F5** (the `dogfood.code-workspace` launch config opens the Extension Development Host with this repo loaded). You'll get the **How Does This Work** view in the activity bar.

- **Walk a tour:** click a tour in the sidebar — the included `monorepo-architecture` tour walks this repo's own design.
- **Generate a tour:** click the ✨ button, type a topic, and watch the agent explore. Authentication resolves in order: an API key set via **"HDTW: Set Anthropic API Key"** (stored in VS Code SecretStorage), then your Claude Code CLI login. Tour *consumers* never need credentials.

### Useful commands

```bash
pnpm turbo test --filter=@made-i-t/hdtw-engine-core                              # test one package
pnpm --filter @made-i-t/hdtw-engine-server exec vitest run tests/server.e2e.test.ts   # one test file
HDTW_GENERATOR=fake …    # run the engine with a deterministic test generator (no API calls)
```

## Repository conventions

- **Design before building.** Significant features get a dated design doc in `docs/superpowers/specs/`; durable architectural choices get an ADR in `docs/adr/`. Agent/contributor onboarding lives in [`AGENTS.md`](AGENTS.md).
- TypeScript throughout, `node16` module resolution (`.js` extensions on relative imports). Packages are scoped `@made-i-t/hdtw-*`; the VS Code extension is unscoped (`hdtw-vscode`) because extension manifests can't use npm scopes.
- Keep the engine / client / protocol boundaries intact: if a client needs engine data, the answer is a protocol addition, not an import.

## License

TBD.
