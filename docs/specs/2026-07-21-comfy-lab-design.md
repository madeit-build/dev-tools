# comfy-lab Design

**Status:** Approved
**Date:** 2026-07-21

## Goal

A laptop-side CLI for rapidly building and testing ComfyUI workflows against
the box's localhost-only ComfyUI, with zero deploy cycle. Proven graphs
graduate into the box's identity (`chat.nix`) by copy, not translation.

## Context

The box runs ComfyUI bound to `127.0.0.1:8188` (localhost-only is a deliberate
security control: ComfyUI executes model and custom-node code, the largest code
surface on the box). Open WebUI drives it for chat, but there is no fast path to
iterate on raw workflow graphs. This tool is that path.

Design boundary agreed up front: this is a **client of the box, not part of the
box**. It never goes through `box-deploy`, so it lives in `dev-tools`, not in
`box.provisioning`. Graphs that prove out get graduated into `box.provisioning`
via a reviewed PR (into `chat.nix`). The lab is where you are reckless; the box
config is where you are deliberate. Keeping them in separate repos preserves
that seam.

## Architecture

One invocation runs a linear pipeline:

```
ensure_tunnel  ->  load lab file  ->  inject params  ->  POST /prompt
   ->  poll /history  ->  fetch /view images  ->  save to out/
```

Single-file Python, standard library only (`urllib`, `subprocess`, `json`,
`argparse`), so it runs the instant it is cloned with no `pip install`.

### The lab file format (load-bearing decision)

A lab workflow file is the graph plus its node map in one object, structurally
identical to the box's stored config:

```json
{
  "workflow": { "1": { "class_type": "UNETLoader", "inputs": { ... } }, ... },
  "map":      [ { "type": "prompt", "key": "text", "node_ids": ["6"] },
                { "type": "seed",   "key": "seed", "node_ids": ["9"] } ]
}
```

- `workflow` maps 1:1 to open-webui's `COMFYUI_WORKFLOW`
- `map` maps 1:1 to open-webui's `COMFYUI_WORKFLOW_NODES`

Graduating a proven graph into the box is therefore a copy of two fields into
`chat.nix`, no format conversion, no drift. Experiment-format == deploy-format.

### Param injector

A faithful re-implementation of open-webui's `_apply_workflow_nodes`: for each
supplied parameter, find the `map` entry whose `type` matches and write the
value into `workflow[node_id]["inputs"][key]` for each `node_id`. Supported
types mirror the box: `model`, `prompt`, `negative_prompt`, `width`, `height`,
`steps`, `seed`, `image`.

- `seed` defaults to a random int when not supplied.
- `image` entries with multiple `node_ids` fill per-index from the `--image`
  list (single image sets the first node; two images drive a composite),
  matching open-webui's list semantics.
- A parameter whose `type` is absent from the map is a hard error, not a silent
  no-op. This is the guard that would have caught the two edit-config bugs.

### ComfyUI error transparency

When `/prompt` returns a validation failure, the tool prints ComfyUI's
`node_errors` **verbatim** and exits non-zero. This is the exact failure
open-webui collapses into "Something went wrong :/"; the lab refuses to hide it.

### Transport

`ensure_tunnel()` uses a persistent multiplexed ssh master
(`-o ControlMaster=auto -o ControlPersist=15m -L <local>:<remote> <host>`), so
the first call opens the tunnel and subsequent calls reuse it as plain HTTP to
the local end. ComfyUI's localhost-only bind on the box is untouched; the tunnel
rides ssh-over-tailnet. If the tunnel cannot open, the tool prints the one-line
manual `ssh -L` command and exits clean.

## Configuration

No address or path is a literal in the code. Precedence is
**CLI flag > env var > default**.

| Concern                  | CLI flag      | Env var               | Default                 |
| ------------------------ | ------------- | --------------------- | ----------------------- |
| SSH host (tunnel target) | `--host`      | `COMFY_LAB_HOST`      | `box`                   |
| ComfyUI URL (local end)  | `--url`       | `COMFY_LAB_URL`       | `http://127.0.0.1:8188` |
| Remote bind to forward   | `--remote`    | `COMFY_LAB_REMOTE`    | `127.0.0.1:8188`        |
| Output dir               | `--out`       | `COMFY_LAB_OUT`       | `./out/`                |
| Workflows dir            | `--workflows` | `COMFY_LAB_WORKFLOWS` | `<tool>/workflows/`     |

The tunnel's local port is derived from `--url`'s port so the two never
disagree.

## CLI surface

```
comfy-lab run <workflow> [--prompt STR] [--negative STR] [--seed INT]
                         [--steps INT] [--image PATH ...] [--out DIR]
                         [--host H] [--url U] [--remote R] [--workflows DIR]
```

`<workflow>` resolves against `--workflows` if not an explicit path. `--image`
repeats for composites. Output images are written to the out dir named by
prompt_id; the tool prints each saved path and the submit-to-done timing.

## File structure

```
dev-tools/src/comfy-lab/
  comfy_lab.py            # CLI + injector + tunnel + ComfyUI client
  workflows/
    qwen-gen.json         # { workflow, map } seeded from the proven box graph
    qwen-edit.json        # { workflow, map } two-LoadImage edit/composite graph
  tests/
    test_inject.py        # pure unit tests for the injector
  README.md
```

## Testing

The injector is pure and unit-tested with no network:

- prompt/seed/steps written into the correct node + key
- composite: two `--image` values fill `node_ids` per index; one value fills
  only the first
- seed defaults to a value in range when omitted
- a param whose `type` is not in the map raises (the bug-class guard)

Transport and end-to-end submission are a box-dependent smoke test, skipped when
the tunnel is unavailable.

## Out of scope (YAGNI)

No web UI, no batch/queue runner, no config file, no auto-open viewer (a
`--open` flag is a trivial later add). The tool does exactly one thing: submit a
graph with overrides, return the image, and surface real errors.
