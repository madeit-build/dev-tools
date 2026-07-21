# comfy-lab

Rapid build/test harness for ComfyUI workflow graphs on the box. Submits a
graph over an ssh tunnel to the box's localhost-only ComfyUI, injects
parameters via a node map, and surfaces ComfyUI errors verbatim.

## Usage

    python comfy_lab.py run qwen-gen --prompt "a fox in a library" --seed 42
    python comfy_lab.py run qwen-edit --prompt "add a cat" --image scene.png
    python comfy_lab.py run qwen-edit --prompt "put the teapot on the table" \
        --image scene.png --image teapot.png     # two images = composite

Additional workflow parameters: `--negative` (negative prompt), `--steps` (inference steps).
With qwen-edit, pass two `--image` inputs for a composite; a single image fills one slot while the other holds a placeholder.
If the ssh tunnel fails to open, the tool prints the manual `ssh -N -L ...` command and exits non-zero.

## Lab file format

A lab workflow is `{ "workflow": {...}, "map": [...] }`, the same pairing the
box seeds as `COMFYUI_WORKFLOW` and `COMFYUI_WORKFLOW_NODES`. To graduate a
proven graph into the box, copy those two fields into `box.provisioning`'s
`nix/nixos/chat.nix` and open a PR.

## Configuration (CLI flag > env var > default)

| Flag          | Env                   | Default                 |
| ------------- | --------------------- | ----------------------- |
| `--host`      | `COMFY_LAB_HOST`      | `box`                   |
| `--url`       | `COMFY_LAB_URL`       | `http://127.0.0.1:8188` |
| `--remote`    | `COMFY_LAB_REMOTE`    | `127.0.0.1:8188`        |
| `--out`       | `COMFY_LAB_OUT`       | `./out`                 |
| `--workflows` | `COMFY_LAB_WORKFLOWS` | `<tool>/workflows/`     |

ComfyUI stays localhost-only on the box; the tool tunnels over ssh-over-tailnet
and never widens that bind.

## Tests

    python -m pytest -q
