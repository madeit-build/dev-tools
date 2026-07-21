import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import pytest
from comfy_lab import apply_map

GEN_WF = {
    "6": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["4", 0], "text": ""}},
    "7": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["4", 0], "text": ""}},
    "8": {"class_type": "EmptySD3LatentImage", "inputs": {"width": 1024, "height": 1024, "batch_size": 1}},
    "9": {"class_type": "KSampler", "inputs": {"seed": 0, "steps": 4, "cfg": 1.0}},
}
GEN_MAP = [
    {"type": "prompt", "key": "text", "node_ids": ["6"]},
    {"type": "negative_prompt", "key": "text", "node_ids": ["7"]},
    {"type": "width", "key": "width", "node_ids": ["8"]},
    {"type": "height", "key": "height", "node_ids": ["8"]},
    {"type": "steps", "key": "steps", "node_ids": ["9"]},
    {"type": "seed", "key": "seed", "node_ids": ["9"]},
]
EDIT_MAP = [
    {"type": "prompt", "key": "prompt", "node_ids": ["7"]},
    {"type": "image", "key": "image", "node_ids": ["6", "14"]},
    {"type": "seed", "key": "seed", "node_ids": ["11"]},
]
EDIT_WF = {
    "6": {"class_type": "LoadImage", "inputs": {"image": "example.png"}},
    "14": {"class_type": "LoadImage", "inputs": {"image": "example.png"}},
    "7": {"class_type": "TextEncodeQwenImageEditPlus", "inputs": {"prompt": ""}},
    "11": {"class_type": "KSampler", "inputs": {"seed": 0, "steps": 4}},
}


def test_prompt_and_steps_written():
    out = apply_map(GEN_WF, GEN_MAP, {"prompt": "a fox", "steps": 8})
    assert out["6"]["inputs"]["text"] == "a fox"
    assert out["9"]["inputs"]["steps"] == 8


def test_unsupplied_param_keeps_workflow_default():
    out = apply_map(GEN_WF, GEN_MAP, {"prompt": "a fox"})
    assert out["7"]["inputs"]["text"] == ""  # negative untouched


def test_seed_supplied():
    out = apply_map(GEN_WF, GEN_MAP, {"prompt": "x", "seed": 42})
    assert out["9"]["inputs"]["seed"] == 42


def test_seed_randomized_when_absent():
    out = apply_map(GEN_WF, GEN_MAP, {"prompt": "x"})
    assert isinstance(out["9"]["inputs"]["seed"], int)
    assert 0 <= out["9"]["inputs"]["seed"] <= 1125899906842624


def test_input_not_mutated():
    apply_map(GEN_WF, GEN_MAP, {"prompt": "x", "seed": 1})
    assert GEN_WF["6"]["inputs"]["text"] == ""  # original untouched


def test_composite_two_images_per_index():
    out = apply_map(EDIT_WF, EDIT_MAP, {"prompt": "p", "image": ["a.png", "b.png"]})
    assert out["6"]["inputs"]["image"] == "a.png"
    assert out["14"]["inputs"]["image"] == "b.png"


def test_single_image_fills_first_node_only():
    out = apply_map(EDIT_WF, EDIT_MAP, {"prompt": "p", "image": ["a.png"]})
    assert out["6"]["inputs"]["image"] == "a.png"
    assert out["14"]["inputs"]["image"] == "example.png"  # second untouched


def test_param_absent_from_map_raises():
    # the bug-class guard: edit map has no 'steps' entry
    with pytest.raises(KeyError):
        apply_map(EDIT_WF, EDIT_MAP, {"prompt": "p", "steps": 8})
