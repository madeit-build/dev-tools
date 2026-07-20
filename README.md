# dev-tools

A home for the developer tools built under **[Made I.T.](https://github.com/Made-I-T)** Each tool is a self-contained project under [`src/`](./src), with its own build, tests, and docs.

## Tools

| Tool | What it does |
| --- | --- |
| [`how-does-this-work`](./src/how-does-this-work) | Guided, rails-driven explanations of how a codebase works — from entrypoint to exit. An AI agent explores a repo and produces a **tour** (ordered, line-anchored, narrated steps) that anyone can then walk on rails, with no agent and no tokens. VS Code first; built to expand to other IDEs. |
| [`git-hooks`](./src/git-hooks) | Git hooks that catch the mistakes agents make quietly. Currently a `pre-push` guard that refuses to push a branch whose PR is already merged, the failure mode where an agent keeps committing to a merged branch and strands the work off main. |
| [`progress`](./src/progress) | A sourceable bash progress reporter. Narrates a script's known phases and live-tails its opaque long-poles (`nixos-rebuild`, `docker pull`) as an animated checklist on a TTY, degrading to plain append-only lines off one. One file, no deps, bash 3.2 compatible. |

## Layout

```
dev-tools/
└── src/
    ├── how-does-this-work/   # pnpm + Turborepo monorepo (engine + IDE clients)
    └── git-hooks/            # POSIX sh hooks, installed via core.hooksPath
```

Each tool owns its own toolchain — see the tool's own `README.md` and `AGENTS.md` for how to build, test, and contribute to it. New tools are added as sibling directories under `src/`.
