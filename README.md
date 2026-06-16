# dev-tools

A home for the developer tools built under **[Made I.T.](https://github.com/Made-I-T)** Each tool is a self-contained project under [`tools/`](./tools), with its own build, tests, and docs.

## Tools

| Tool | What it does |
| --- | --- |
| [`how-does-this-work`](./tools/how-does-this-work) | Guided, rails-driven explanations of how a codebase works — from entrypoint to exit. An AI agent explores a repo and produces a **tour** (ordered, line-anchored, narrated steps) that anyone can then walk on rails, with no agent and no tokens. VS Code first; built to expand to other IDEs. |

## Layout

```
dev-tools/
└── tools/
    └── how-does-this-work/   # pnpm + Turborepo monorepo (engine + IDE clients)
```

Each tool owns its own toolchain — see the tool's own `README.md` and `AGENTS.md` for how to build, test, and contribute to it. New tools are added as sibling directories under `tools/`.
