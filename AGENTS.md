# AGENTS.md

Container guide for the **`dev-tools`** monorepo (`Made-I-T/dev-tools`) — a home for the developer tools built under Made I.T. Each tool is self-contained; this file orients you to the repo as a whole and hands off to the tool you're working on.

## Layout

```
dev-tools/                       # repo root = Turborepo + pnpm workspace
├── package.json                 # "dev-tools" — turbo orchestrates every tool
├── pnpm-workspace.yaml          # tool-agnostic globs: src/*/src/*  (new tools auto-join)
├── turbo.json · tsconfig.base.json · eslint.config.mjs · .prettier*   # shared by ALL tools
├── dogfood.code-workspace       # opens a tool's folder for F5 dogfooding
└── src/                         # one directory per tool
    └── how-does-this-work/      # guided, rails-driven codebase tours (VS Code first)
        ├── AGENTS.md            # ← read this before working on the tool
        └── src/                 # the tool's own workspace packages
```

The repo root owns the **shared machinery** (pnpm workspace, Turborepo, base TS config, ESLint, Prettier). Each tool keeps its packages under its own `src/`, so per-tool internals stay isolated. Adding a new tool = create `src/<new-tool>/src/<pkg>/package.json`; the `src/*/src/*` workspace globs pick it up automatically.

## Tools

| Tool | Directory | Docs |
| --- | --- | --- |
| How Does This Work | `src/how-does-this-work/` | [`AGENTS.md`](./src/how-does-this-work/AGENTS.md) · [`CLAUDE.md`](./src/how-does-this-work/CLAUDE.md) |

## Commands (run from the repo root)

```bash
pnpm install     # install all workspace deps
pnpm build       # turbo build (dependency order, cached)
pnpm test        # turbo test (builds first)
pnpm lint        # turbo lint
pnpm format      # prettier --write .
```

`pnpm` and `turbo` must run from the repo root (where `pnpm-workspace.yaml` and `turbo.json` live). Target a single package with `--filter <package-name>` regardless of which tool it belongs to.

## Working in this repo

- **Pick a tool, then read its `AGENTS.md`** for that tool's architecture, conventions, and current state before changing anything.
- Keep shared config at the root; keep tool-specific config, docs, and code inside the tool's directory.
- Don't reach across tools: tools are independent: a change in one should not import from another.
