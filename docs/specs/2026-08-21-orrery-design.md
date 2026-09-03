# orrery Design

**Status:** Approved
**Date:** 2026-08-21

## Goal

A local CLI that evaluates a Nix flake and renders its fleet as an
interactive, drillable graph in the browser. Point it at a flake, get a
picture that is true by construction because it comes from evaluation
rather than from a human keeping a diagram in sync.

The name is literal, not a metaphor: an orrery is a desktop model of a
system, built to be looked at rather than read.

## Context

`box.provisioning` already renders part of this. `nix/topology.nix` wires
up `nix-topology`, and its header comment records a measured result worth
repeating: auto-extraction produced **35 service labels for free** (every
Caddy vhost with its upstream port, plus Caddy, Ollama, Open WebUI, and
PostgreSQL) while the network map came back with 4. The conclusion in that
file was "the service map came free and is the better diagram."

So extraction is not the open problem. Three gaps are:

1. **The output is a static SVG.** No drill-down, no hover, no lens
   switching, no link back to source.
2. **It renders a fraction of what is there.** Box alone evaluates to
   roughly 120 systemd services (121 when measured 2026-08-21; the count
   moves with the config, which is the point).
3. **`nix-topology` must build**, which means an `x86_64-linux` derivation,
   which neither Mac can produce without a remote builder. Editing the
   topology on a laptop and reading the diagram on the box is the loop
   today.

Gap 3 does not apply to orrery, and this was verified rather than assumed:
`nix eval --json <flake>#nixosConfigurations.box.config...` runs to
completion on `aarch64-darwin`. Orrery only evaluates. It never builds, so
the whole pipeline runs on a laptop against a Linux fleet.

### Design boundary

Orrery is a **client of a flake, not part of one**. It never deploys, never
mutates the repo it inspects, and holds no privileges the invoking user did
not already have. It lives in `dev-tools` for the same reason `comfy-lab`
does: the thing being inspected and the thing doing the inspecting stay in
separate repos.

## The two axes (load-bearing decision)

C4's four levels do not survive contact with the NixOS module system. C4
places Code _inside_ Component, a strict containment relationship. In Nix
that is false. Measured on the real config:

```
nix eval .#nixosConfigurations.box.options.services.caddy.virtualHosts.files
  -> reverie.nix, explorer.nix, collab.nix, search.nix,
     chat.nix, ollama.nix, observability.nix, services.nix
```

Eight modules merge into one option, and `observability.nix` in turn
contributes to many services across more than one host. Modules and runtime
objects are many-to-many. Provenance is not a floor you descend to, it is
the other side of the board.

Orrery therefore has two axes rather than four levels:

**Zoom axis**, real containment, drill down and back up:

```
Fleet  ->  Host  ->  Service  ->  Part
```

**Lens axis**, the same graph under a different projection:

- **Runtime**, what exists and what talks to what
- **Declaration**, what `.nix` code put it there

C4's vocabulary is deliberately not used. "Container" already means Docker
in this fleet (`nix/home/containers-mac.nix`, a native Linux Docker daemon
on the box, colima on the Mac), so a "Container view" that did not mean
Docker would be a defect in the UI rather than a naming quibble. "Fleet"
is borrowed from the target repo, where it already appears in `flake.nix`,
`topology.nix`, `accounts.nix`, and `deploy/fleet-deploy.bash`.

## Architecture

Three workspace packages under `src/orrery/src/`, matching the
`pnpm-workspace.yaml` glob `src/*/src/*`. `model` is the contract: `extract`
writes to it, `app` reads from it, and neither knows the other exists.

```
resolve flake  ->  discover hosts  ->  run projection rules (nix eval)
   ->  normalize to nodes + edges  ->  sanitize  ->  validate
   ->  graph.json  ->  serve app  ->  open browser
```

Swapping in a generic ruleset later touches only `extract`. Serving from the
box later touches only how `app` is delivered.

### Projections, not dumps (load-bearing decision)

The evaluated config cannot be serialized wholesale. Verified:

```
nix eval --json .#nixosConfigurations.box.config.systemd.services.caddy
  -> error: cannot coerce a list to a string
     (thrown from derivationStrict)
```

The config is a graph of thunks, functions, and derivations, not a JSON
tree. A curated projection serializes instantly:

```
--apply 's: builtins.mapAttrs (n: v: {
    inherit (v) description wantedBy after;
    exec = v.serviceConfig.ExecStart or null;
    user = v.serviceConfig.User or null;
  }) s'
```

Extraction rules are therefore structurally mandatory, not a refinement.
Any design that defers slicing to the browser is already dead. This has a
security consequence covered below: the projection is an allowlist by
construction.

### The graph model

Nodes carry a stable id, a type, a label, attributes, and provenance.

| Type        | Is                                     | Source                                        |
| ----------- | -------------------------------------- | --------------------------------------------- |
| `fleet`     | the whole thing, one node              | synthesized                                   |
| `host`      | box, cerberus, martinez                | `nixosConfigurations`, `darwinConfigurations` |
| `external`  | tailnet, internet, GitHub, nixpkgs     | rules, explicitly declared                    |
| `service`   | a systemd unit or launchd agent        | `config.systemd.services`                     |
| `vhost`     | a Caddy virtual host, the front door   | `services.caddy.virtualHosts`                 |
| `datastore` | a database, a SQLite file, a state dir | `StateDirectory`, `services.postgresql`       |
| `port`      | a listening socket                     | firewall, vhost upstreams                     |
| `part`      | leaf detail: ExecStart, user, env key  | `serviceConfig.*`                             |
| `module`    | one `.nix` file                        | `options.*.files`                             |
| `option`    | an option path                         | the option tree                               |
| `input`     | a flake input                          | `flake.inputs`                                |

Edges: `contains` is the zoom axis. `proxies-to`, `listens-on`, `reads`,
`writes`, and `depends-on` are the Runtime lens. `declared-by`, `defines`,
`imports`, and `provides` are the Declaration lens.

### Declared vs inferred (load-bearing decision)

Every edge carries `source: "declared" | "inferred"`.

`after = postgresql.service` is declared fact; NixOS said it. "This vhost
proxies to Ollama" comes from matching `reverse_proxy` inside `extraConfig`,
which is a guess. `nix/topology.nix` states the principle being honored
here: "guessing before looking is how a diagram ends up asserting a network
the configs do not describe."

Inferred edges render dashed, declared edges solid. The brand is monochrome
with no accent hue and `--radius: 0`, so stroke style is one of few
remaining encodings, and it is spent on epistemics rather than decoration.
The diagram never claims more than it knows.

### Stable ids (load-bearing decision)

```
host:box
service:box/caddy
part:box/caddy/port/2019
module:nix/nixos/chat.nix
```

Identity is shared across both lenses. Selecting Caddy in Runtime and
flipping to Declaration keeps you on Caddy rather than dropping you at the
top of a different diagram. Cross-lens identity is the core promise of this
architecture and the reason a per-view pipeline design was rejected.

The same scheme makes two graphs diffable. NixOS generations are the right
axis for that, not commits: a commit records what was written, a generation
records what booted, so a generation diff also catches a nixpkgs bump that
changed the fleet with no line edited. Generations are already on disk at
`/nix/var/nix/profiles/system-N-link`. Not in scope now. The id scheme keeps
it cheap later, which costs nothing today.

### Rendering

`@xyflow/react` for canvas, pan, zoom, and selection. `elkjs` for layout.
Custom node components throughout, rendered against the brand repo's
`tokens.css`. React Flow's stock appearance is rounded and colorful and
would fight `--radius: 0` on every node, so only its viewport machinery is
used.

Force-directed layout is rejected on two grounds. It degenerates into a
hairball well below 35 nodes, and it is non-deterministic, so two runs
produce two pictures. ELK's layered algorithm is deterministic and
flow-shaped. Determinism is also what makes a future generations diff
legible: stable layout means the delta is visible, where a force layout
would reshuffle the canvas and hide it.

Lens, zoom, and selection live in the URL hash
(`#/fleet/box/caddy?lens=declaration`), so any view is a pasteable link.

## Security

**Identity:** the local user in their own shell. **Authn:** the OS already
answered it; the caller can run `nix eval` against this flake or orrery
cannot either. **Authz:** none required, because of the property this design
commits to preserving:

> Orrery grants no access the caller did not already have. It is a renderer
> for data reachable with more typing.

That property ends the moment the app is served over a network. An
unauthenticated page would hand every tailnet peer a map of the fleet with
ports, users, and state directories. Hosting is therefore gated on an authn
decision made at that time. It is not assumed away here.

### The artifact is the risk

`graph.json` is secrets-adjacent and gets three controls:

1. **Allowlist by construction.** Projections name their fields explicitly.
   A new field reaching the graph requires a code change, so nothing leaks
   by default. Structural, not a filter, and therefore the primary control.
2. **Redaction pass regardless.** Env vars whose _name_ matches secret
   shapes, and values under `/run/secrets/`, have the **value** replaced
   with a marker while the **key survives**. "This service reads a secret
   named `X`" is the architectural fact worth drawing. The value must never
   reach disk.
3. **Never committed.** `graph.json` is written to a gitignored scratch
   directory. Store paths are rewritten to repo-relative, which strips both
   store hashes and local filesystem structure.

Logs carry rule names and counts, never values.

### Do not mutate the subject

Every evaluation runs with `--no-write-lock-file` and `--read-only`. Both
were run against the real box config on 2026-08-21, on the full
`systemd.services` projection rather than a trivial attribute, exiting 0.
Evaluating a flake can otherwise rewrite `flake.lock`, and a diagnostic tool
that dirties the git tree it is inspecting is a defect.

## Observability

The question this tool will generate is "why is service X not on my
diagram?" It is answerable without adding code.

**The drop ledger.** Every candidate the extractor saw and did not emit is
recorded with a reason code: `no-exec`, `filtered-by-rule`, `rule-error`,
`eval-failed`. The ledger ships inside `graph.json` and the app has a panel
for it. On box alone that is roughly 120 units in and 35 out, so the ledger
runs to about 85 rows, and those rows are the difference between a tool that
is trusted and one that is suspected.

**Structured logs**, JSON lines, at every state transition: host discovered,
rule started and finished with node and edge counts, sanitize pass with
redaction count, validation pass or fail. Every failure states what broke
and what to try next.

**`orrery doctor`**, checking in most-likely-wrong-first order:

1. `nix` on PATH, and its version
2. the flake ref resolves
3. hosts are discoverable
4. one cheap probe evaluation succeeds
5. rules parse
6. the last `graph.json` validates against the schema

## CLI surface

```
orrery <flake-ref> [--host <name>] [--out <dir>] [--no-open]
orrery doctor
```

`<flake-ref>` defaults to the current directory. Default behavior evaluates
every discoverable host, writes `graph.json`, serves `app`, and opens a
browser.

## File structure

```
src/orrery/
  README.md
  docs/
  src/
    extract/        projection rules and the driver that runs them
      rules/        one Nix function per projection
    model/          node and edge types, id scheme, schema validator
    app/            React, brand tokens, the two lenses
```

## Testing

**Tier 1, hermetic, no Nix.** Raw projections captured from a real
evaluation are committed as fixtures and replayed through the normalizer
against a golden `graph.json`. This covers the normalizer, id scheme,
sanitizer, and validator, and runs anywhere in about a second.

**Tier 2, one test, requires Nix.** A fixture flake with three services, a
Caddy vhost, and **two modules that both define the same option**. The last
part is not optional: option merging is the headline capability, so the
merge case is tested or the capability is not real.

Additionally:

- The redaction pass gets its own tests with secret-shaped inputs. Untested
  redaction is decorative.
- The lens flip gets a test asserting selection survives it, since
  cross-lens identity is the architectural promise.

The real `box.provisioning` config is a manual smoke check. The evaluation
takes minutes and needs the fleet, so it does not belong in CI.

## Out of scope (YAGNI)

- **Generation diffing.** Designed for, not built. The id scheme and the
  deterministic layout are what keep it cheap.
- **Serving from the box.** Requires an authn decision that is deliberately
  deferred rather than guessed.
- **Generic flake support.** Rules stay data so a second target is a
  ruleset rather than a rewrite, but only this fleet is targeted now.
- **Live runtime state.** Orrery renders the configuration, not what is
  currently running. Reconciling declared against actual is a different
  tool, and conflating them would make the diagram lie.
- **Editing.** Read-only, permanently.
