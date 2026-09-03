# orrery

An orrery is a desktop model of a system, built to be looked at rather than
read. This one evaluates a Nix flake and renders the fleet it describes.

```
orrery ~/path/to/flake            evaluate, write graph.json
orrery doctor ~/path/to/flake     check the things most likely to be wrong
```

## Why evaluate instead of parse

Parsing `.nix` files tells you what the text says. Evaluating tells you what
the system is, after imports, overrides, and option merging have all been
applied. The difference is the whole product.

The clearest case: on one real fleet, `services.caddy.virtualHosts` is defined
by **eight separate modules**. The module system merges them and erases the
seam, so no amount of reading one file tells you where a given vhost came
from. `definitionsWithLocations` gives per-key attribution, and the
Declaration lens draws it.

Two more things evaluation shows that parsing cannot, both measured rather
than argued:

- `ExecStart` for `caddy` is `["", "/nix/store/…/caddy run …"]`, a list whose
  leading empty entry is systemd's reset idiom. That shape appears nowhere in
  the source; the module system manufactures it.
- Dumping a whole service to JSON fails with `cannot coerce a list to a
  string`, thrown from `derivationStrict`. The evaluated config is a graph of
  thunks and derivations, not a document, which is why every rule here is a
  narrow projection rather than a dump.

## The two axes

Zoom is real containment: **Fleet, Host, Service, Part**.

Lens is a projection of the same graph: **Runtime** (what exists and what
talks to what) and **Declaration** (what code put it there). Flipping the lens
keeps your selection, because node identity is shared across both.

C4's vocabulary is deliberately not used. "Container" already means Docker in
the fleet this was built against, and C4 nests Code inside Component, which is
false here: modules and runtime objects are many-to-many.

## Solid and dashed

Solid edges are declared: NixOS said so. Dashed edges are inferred: orrery
read them out of free-form text, usually a Caddyfile or an environment
variable, and could be wrong. Select a node to see an inferred edge's evidence.

Port ownership is tiered, and the tier decides the confidence. A published
`oci-containers` port and a `services.<name>.port` are declared facts. Reading
a port out of an environment variable is not.

The diagram never claims more than it knows.

## Why something is missing

Click the "not drawn" count. Every candidate a rule saw and did not draw is
listed with a reason. Nothing is dropped silently, and the panel is how you
answer "why is X not on my diagram" without adding a print statement.

That panel earns its keep: it is what surfaced a wired-but-unused tier of the
port index during development, by reporting an upstream that resolved to
nothing.

## Secrets

`graph.json` is a projection of an evaluated system config, so it is treated
as secrets-adjacent and is never committed. Three controls, in order of
weight:

1. **Allowlist by construction.** Projections name their fields, so a new
   field reaching the graph needs a code change.
2. **Redaction.** A secret-shaped key, or a value pointing into `/run/secrets`
   or `/run/credentials`, keeps its key and loses its value. That a service
   reads a secret named X is worth drawing; the value never is.
3. **Path scrubbing.** Store hashes and usernames are removed from every
   string that reaches the artifact, including edge evidence and ledger
   details, not only node attributes.

## Layout

Layered and deterministic (`elkjs`), never force-directed. Force layout is
non-deterministic, so two runs of one graph give two pictures, and it
degenerates into a hairball well below this fleet's node counts. Nodes and
edges are sorted before layout, so a rule changing its output order cannot
reshuffle the canvas.

## Tests

Tier 1 replays projections captured from a real fleet through the normalizer,
and needs no Nix. Tier 2 is one suite against a fixture flake in
`fixtures/flake`, where **two modules define the same option**, because that
merge is the headline capability and no recorded fixture can stand in for it.

The fixture flake must stay tracked by git. A flake inside a repository is
invisible to Nix until it is.

## Scope

Read-only. It renders the configuration, not what is currently running.
Reconciling declared against actual is a different tool, and merging the two
would make the diagram lie about which one it is showing.
