import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import pytest
from comfy_lab import load_lab_file

WORKFLOWS = os.path.join(os.path.dirname(__file__), "..", "workflows")


def test_load_by_bare_name():
    wf, node_map = load_lab_file("qwen-gen", WORKFLOWS)
    assert "9" in wf and wf["9"]["class_type"] == "KSampler"
    assert any(e["type"] == "prompt" for e in node_map)


def test_load_edit_has_two_image_nodes():
    wf, node_map = load_lab_file("qwen-edit.json", WORKFLOWS)
    image_entry = next(e for e in node_map if e["type"] == "image")
    assert image_entry["node_ids"] == ["6", "14"]


def test_missing_file_raises():
    with pytest.raises(FileNotFoundError):
        load_lab_file("does-not-exist", WORKFLOWS)


def test_malformed_missing_map_raises(tmp_path):
    bad = tmp_path / "bad.json"
    bad.write_text('{"workflow": {}}')
    with pytest.raises(ValueError):
        load_lab_file(str(bad), str(tmp_path))
