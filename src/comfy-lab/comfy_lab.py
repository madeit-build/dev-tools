"""comfy-lab: submit ComfyUI workflow graphs to the box over an ssh tunnel."""
import copy
import json
import os
import random
import socket
import subprocess
import sys
import time
import uuid
import urllib.request
import urllib.parse
import urllib.error
from urllib.parse import urlparse

_HTTP_TIMEOUT = 30

MAPPABLE_TYPES = {
    "model", "prompt", "negative_prompt", "width", "height", "steps", "seed", "image",
}

_SEED_MAX = 1125899906842624

_CONFIG_DEFAULTS = {
    "host": "box",
    "url": "http://127.0.0.1:8188",
    "remote": "127.0.0.1:8188",
    "out": "./out",
    "workflows": None,
}
_ENV_KEYS = {
    "host": "COMFY_LAB_HOST",
    "url": "COMFY_LAB_URL",
    "remote": "COMFY_LAB_REMOTE",
    "out": "COMFY_LAB_OUT",
    "workflows": "COMFY_LAB_WORKFLOWS",
}

_CONTROL_PATH = "~/.ssh/comfy-lab-%h-%p-%r"


def ssh_master_command(host, local_port, remote):
    """ssh argv that opens a persistent multiplexed local forward, then exits
    (the master lives on in the background via ControlPersist)."""
    return [
        "ssh", "-f", "-N",
        "-o", "ControlMaster=auto",
        "-o", f"ControlPath={_CONTROL_PATH}",
        "-o", "ControlPersist=15m",
        "-L", f"{local_port}:{remote}",
        host,
    ]


def port_is_open(port, host="127.0.0.1"):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.settimeout(1.0)
        return probe.connect_ex((host, port)) == 0


def _print_manual_fallback(port, cfg):
    print("open it manually with:", file=sys.stderr)
    print(f"  ssh -N -L {port}:{cfg['remote']} {cfg['host']}", file=sys.stderr)


def ensure_tunnel(cfg):
    """Ensure the local end of the tunnel is reachable. Opens the ssh master
    when it is not. Returns True on success; prints the manual command and
    returns False on failure."""
    port = cfg["local_port"]
    if port_is_open(port):
        return True
    command = ssh_master_command(cfg["host"], port, cfg["remote"])
    try:
        subprocess.run(command, check=True, timeout=20)
    except (subprocess.SubprocessError, OSError) as error:
        print(f"could not open ssh tunnel: {error}", file=sys.stderr)
        _print_manual_fallback(port, cfg)
        return False
    for _ in range(20):
        if port_is_open(port):
            return True
        time.sleep(0.25)
    print(f"tunnel opened but port {port} never became reachable", file=sys.stderr)
    _print_manual_fallback(port, cfg)
    return False


def resolve_config(cli, env, default_workflows_dir):
    """Resolve every knob with precedence CLI flag > env var > default."""
    cfg = {}
    for key, default in _CONFIG_DEFAULTS.items():
        cli_value = cli.get(key)
        env_value = env.get(_ENV_KEYS[key])
        if cli_value is not None:
            cfg[key] = cli_value
        elif env_value is not None:
            cfg[key] = env_value
        else:
            cfg[key] = default
    if cfg["workflows"] is None:
        cfg["workflows"] = default_workflows_dir
    parsed = urlparse(cfg["url"])
    if not parsed.scheme or parsed.port is None:
        raise ValueError(
            f"url must be an http(s) URL with an explicit port, got {cfg['url']!r} "
            f"(e.g. http://127.0.0.1:8188)"
        )
    cfg["local_port"] = parsed.port
    return cfg


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


def encode_multipart(fields, file_field, filename, data):
    """Build a multipart/form-data body: scalar *fields* plus one file part."""
    boundary = uuid.uuid4().hex
    parts = []
    for name, value in fields.items():
        parts.append(f"--{boundary}\r\n".encode())
        parts.append(f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode())
        parts.append(f"{value}\r\n".encode())
    parts.append(f"--{boundary}\r\n".encode())
    parts.append(
        f'Content-Disposition: form-data; name="{file_field}"; filename="{filename}"\r\n'.encode()
    )
    parts.append(b"Content-Type: application/octet-stream\r\n\r\n")
    parts.append(data)
    parts.append(b"\r\n")
    parts.append(f"--{boundary}--\r\n".encode())
    return f"multipart/form-data; boundary={boundary}", b"".join(parts)


def node_errors_from_history(history_entry):
    """Return the node_errors mapping when a graph failed validation, else {}."""
    return history_entry.get("node_errors") or {}


def history_failure(entry):
    """Return a verbatim failure message if a /history entry indicates the run
    failed -- validation node_errors OR an execution-time error reported via
    status -- else None. Execution crashes surface through status, not
    node_errors, so checking only node_errors would treat a failed run as an
    empty success."""
    errors = node_errors_from_history(entry)
    if errors:
        return json.dumps(errors, indent=2)
    status = entry.get("status", {})
    if status.get("status_str") == "error":
        return json.dumps(status, indent=2)
    return None


def view_url(base_url, image):
    query = urllib.parse.urlencode({
        "filename": image.get("filename", ""),
        "subfolder": image.get("subfolder", ""),
        "type": image.get("type", "output"),
    })
    return f"{base_url}/view?{query}"


def _post_json(url, payload):
    body = json.dumps(payload).encode()
    request = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=_HTTP_TIMEOUT) as response:
        return json.load(response)


def _get_json(url):
    with urllib.request.urlopen(url, timeout=_HTTP_TIMEOUT) as response:
        return json.load(response)


def upload_image(base_url, path):
    """Upload a local image to ComfyUI's input store, return the stored name."""
    with open(path, "rb") as handle:
        data = handle.read()
    ctype, body = encode_multipart({"type": "input", "overwrite": "true"},
                                   "image", os.path.basename(path), data)
    request = urllib.request.Request(f"{base_url}/upload/image", data=body,
                                     headers={"Content-Type": ctype})
    try:
        with urllib.request.urlopen(request, timeout=_HTTP_TIMEOUT) as response:
            return json.load(response)["name"]
    except urllib.error.HTTPError as error:
        detail = error.read().decode(errors="replace")
        raise RuntimeError(f"ComfyUI rejected the image upload (HTTP {error.code}):\n{detail}")


def submit_prompt(base_url, workflow, client_id):
    """Queue a workflow. Returns prompt_id. Raises RuntimeError with ComfyUI's
    verbatim node_errors when the graph is rejected (HTTP 400)."""
    try:
        result = _post_json(f"{base_url}/prompt", {"prompt": workflow, "client_id": client_id})
    except urllib.error.HTTPError as error:
        detail = error.read().decode(errors="replace")
        raise RuntimeError(f"ComfyUI rejected the graph (HTTP {error.code}):\n{detail}")
    return result["prompt_id"]


def wait_for_images(base_url, prompt_id, poll_seconds=1.0, timeout_seconds=600):
    """Poll /history until the prompt completes; return its output image records.
    Raises RuntimeError with node_errors verbatim if the run failed."""
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        history = _get_json(f"{base_url}/history/{prompt_id}")
        entry = history.get(prompt_id)
        if entry:
            failure = history_failure(entry)
            if failure:
                raise RuntimeError(f"ComfyUI run failed:\n{failure}")
            images = []
            for node_output in entry.get("outputs", {}).values():
                images.extend(node_output.get("images", []))
            return images
        time.sleep(poll_seconds)
    raise RuntimeError(f"timed out after {timeout_seconds}s waiting for {prompt_id}")


def fetch_bytes(url):
    with urllib.request.urlopen(url, timeout=_HTTP_TIMEOUT) as response:
        return response.read()
