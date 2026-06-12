# Product Roadmap — "How Does This Work"

**Living document.** Update statuses and decisions as chunks land. This is the full-product context: what every chunk delivers, what capability it unlocks, and when it arrives relative to the others.

## Vision

An IDE extension that explains how a codebase works — from entrypoint to exit — the way a **principal engineer walks a new hire through the platform**: guided, rails-driven tours through real code, narrated with the architecture, implementation patterns, and the *why* behind them. Powered by an AI agent that has genuinely explored the codebase.

## Two load-bearing architectural insights

1. **Generation and playback are different products.** An agent (expensive, occasional) *generates* tour artifacts; the rails experience *replays* them deterministically — free, offline, instant, no LLM. One person generates; the whole team walks.
2. **Tours are the universal currency.** A saved catalog tour and a live conversational walk are the same artifact — conversation is just one way of minting tours. Both entry experiences ride one system.

## Decisions log

| Decision | Choice | Rationale |
|---|---|---|
| Agent runtime | Embedded agentic loop (Claude Agent SDK) in the engine, staged toward hybrid grounding | Full UX control; lives in the engine so every IDE client benefits; incremental path from file tools to code-map grounding |
| Cost model | BYOK / user's existing subscription auth | Token costs are never ours; authors need auth, tour consumers never do |
| Build sequencing | Vertical capability milestones (usable product at every chunk) | Artifact model — the sharing/monetization core — proven first; agent lands on stable rails |
| V1 entry experiences | Both catalog and ask-first conversation (chunks 1–3) | Unified by the tours-as-currency insight |
| Walk UX | Inline narration thread in the editor (VS Code Comments API), collapsible; tours sidebar; status-bar progress | Zero eye travel; "senior engineer commenting on your screen"; native markdown/theming/collapse |
| Tour storage | `.hdtw/tours/*.tour.json` committed alongside source | The repo is the distribution channel; sharing = `git pull` |
| Generation auth | API key (SecretStorage) → Claude Code CLI credential fallback | Zero-setup for subscription holders; key path for everyone else; consumers never need auth |
| Agent backend seam | All generation behind a `TourGenerator` port | Bring-your-own-agent (Codex, Copilot, …) can land later without touching pipeline/protocol/clients |

## Chunks

### Chunk 0 — Monorepo skeleton ✅ shipped 2026-06-12

| Feature | Capability |
|---|---|
| pnpm + Turborepo monorepo, four packages | Multi-team, multi-IDE delivery structure |
| `@made-i-t/hdtw-protocol` | Typed engine↔client JSON-RPC contract |
| `@made-i-t/hdtw-engine-server` + `engine-core` | Standalone engine process over stdio; pure domain core |
| `hdtw-vscode` thin client (`madeit.hdtw-vscode`) | Spawns engine, ping/pong handshake, fail-fast error surfacing |

### Chunk 1 — Tour artifacts + rails playback ✅ shipped 2026-06-12

Spec: `docs/superpowers/specs/2026-06-12-chunk-1-rails-playback-design.md`

| Feature | Capability |
|---|---|
| Tour artifact schema (`schemaVersion`, steps, anchors with `snippetHash`) | Durable, versionable, shareable walkthroughs; hash stored now enables Chunk 4 drift detection retroactively |
| Engine: `hdtw/listTours`, `hdtw/getTour` (stateless) | Any client can enumerate and fetch a repo's tours |
| Tours sidebar (activity bar + TreeView) | Discover a repo's tours at a glance |
| Rails walking: open → reveal → highlight → inline narration thread (collapsible) with Back/Next/Exit; status-bar progress | The core onboarding experience — free, offline, no agent needed |
| Graceful degradation: invalid tours badged with precise errors; drifted anchors warn but don't break the walk | Tours stay useful as code evolves |
| Dogfood artifact: committed tour of this repo's architecture | Proves the format; doubles as our own onboarding |

### Chunk 2 — Embedded agent + tour generation 🔄 spec'd, next up

Spec: `docs/superpowers/specs/2026-06-12-chunk-2-agent-tour-generation-design.md`

| Feature | Capability |
|---|---|
| Agent SDK embedded in engine; API-key or Claude Code subscription auth | The "principal engineer" comes alive — explores with read/grep/glob tools |
| "Generate Tour…" flow (topic prompt → exploration → verified tour → auto-walk) | Tours created on demand for any codebase; git is the review mechanism |
| Live progress + token-cost visibility; budget caps; cancellation | Users trust the product with their key |
| Engine-owned anchor verification + repair round (agent never supplies hashes) | Generated steps must point at real code (no hallucinated anchors) |
| `TourGenerator` port (Claude implementation + test fake) | Reserved seam for future bring-your-own-agent backends (Codex, Copilot, …) |

### Chunk 3 — Conversational walks (V1 complete) ⬜ not started

| Feature | Capability |
|---|---|
| "How does X work?" entry → live exploration → impromptu walk on the same rails | Ask-first magic; the answer is a tour, not a wall of text |
| "Save this walk" → catalog tour | Conversation mints durable artifacts |
| Mid-tour "Why? 💬" detours (in the narration thread) | The new hire can interrupt; the engineer answers in context, then returns to the rails |

### Chunk 4 — Grounding (the hybrid stage) ⬜ not started

| Feature | Capability |
|---|---|
| Code-map tools (tree-sitter/LSP): entrypoints, call graphs | Agent cites verified structure instead of guessing — less hallucination, fewer tokens |
| Anchor drift detection (via stored `snippetHash`) + re-anchoring | Tour freshness as code evolves; stale steps flagged or auto-healed |

### Candidate chunk — Tour graph: related-tour links + walk stack ⬜ idea (2026-06-12)

| Feature | Capability |
|---|---|
| Optional `relatedTourIds` on tour steps (schema-additive — no version bump; old clients ignore it) | Tours stay flat as artifacts; hierarchy is composed at walk time |
| Narration thread renders related-tour links; following one pushes the current walk onto a stack, walks the sub-tour, pops back | "I'm on a monorepo-architecture step and there's a whole tour on how JSON-RPC plays in" — detour and return without losing your place |
| Agent cross-links during generation (it can see the existing tour catalog) | The tour graph grows itself as tours accumulate |

Sequencing note: pairs naturally with Chunk 3 — "Why?" detours and related-tour detours share the push/pop walk-stack mechanic.

### Chunk 5 — Team & beyond ⬜ not started

| Feature | Capability |
|---|---|
| Tour-freshness CI check | Teams keep committed tours honest in PRs |
| JetBrains thin client (same protocol) | Second IDE; validates the engine/client architecture |
| Monetization experiments (hosted generation with managed keys, team features, marketplaces) | Free BYOK core stays free; paid layers ride the same artifacts |

## Sequencing rationale

Artifact-first beats conversation-first because the sharing and monetization story lives in the artifact: chunk 1 proves the core data model with zero token cost, chunk 2 makes minting tours effortless, chunk 3 completes the V1 magic, chunk 4 hardens trust, chunk 5 scales it beyond one person. Each chunk ends with something genuinely usable.
