"""comfy-lab: submit ComfyUI workflow graphs to the box over an ssh tunnel."""
import copy
import json
import os
import random

MAPPABLE_TYPES = {
    "model", "prompt", "negative_prompt", "width", "height", "steps", "seed", "image",
}

_SEED_MAX = 1125899906842624


def apply_map(workflow, node_map, params):
    """Return a deep-copied *workflow* with *params* written per *node_map*.

    A lab file's map mirrors open-webui's COMFYUI_WORKFLOW_NODES: each entry is
    {type, key, node_ids}. A supplied param whose type is not present in the map
    is an error, not a silent no-op -- the guard that catches config drift. A
    'seed' entry is always written (random when no seed is supplied); an 'image'
    entry fills its node_ids per index from the params 'image' list.
    """
    entries_by_type = {}
    for entry in node_map:
        entries_by_type.setdefault(entry["type"], []).append(entry)

    for supplied in params:
        if supplied not in entries_by_type:
            raise KeyError(
                f"param '{supplied}' has no entry in the workflow map "
                f"(map types: {sorted(entries_by_type)})"
            )

    result = copy.deepcopy(workflow)
    for ptype, entries in entries_by_type.items():
        for entry in entries:
            key, node_ids = entry["key"], entry["node_ids"]
            if ptype == "seed":
                value = params.get("seed")
                if value is None:
                    value = random.randint(0, _SEED_MAX)
                for node_id in node_ids:
                    result[node_id]["inputs"][key] = value
            elif ptype == "image":
                images = params.get("image")
                if not images:
                    continue
                for index, node_id in enumerate(node_ids):
                    if index < len(images):
                        result[node_id]["inputs"][key] = images[index]
            else:
                if ptype not in params:
                    continue
                for node_id in node_ids:
                    result[node_id]["inputs"][key] = params[ptype]
    return result


def load_lab_file(name, workflows_dir):
    """Resolve *name* (explicit path, or bare name under *workflows_dir*) and
    return (workflow, map). A lab file is {"workflow": {...}, "map": [...]},
    the same pairing the box seeds as COMFYUI_WORKFLOW / COMFYUI_WORKFLOW_NODES.
    """
    path = name
    if not os.path.isfile(path):
        candidate = os.path.join(workflows_dir, name)
        if not candidate.endswith(".json"):
            candidate += ".json"
        path = candidate
    if not os.path.isfile(path):
        raise FileNotFoundError(f"no lab workflow found for '{name}' (looked at {path})")

    with open(path) as handle:
        data = json.load(handle)
    if "workflow" not in data or "map" not in data:
        raise ValueError(f"{path} is not a lab file (needs 'workflow' and 'map' keys)")
    return data["workflow"], data["map"]
