import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from comfy_lab import resolve_config

import pytest

DEFAULT_WF = "/tool/workflows"


def test_defaults():
    cfg = resolve_config({}, {}, DEFAULT_WF)
    assert cfg["host"] == "box"
    assert cfg["url"] == "http://127.0.0.1:8188"
    assert cfg["remote"] == "127.0.0.1:8188"
    assert cfg["out"] == "./out"
    assert cfg["workflows"] == DEFAULT_WF
    assert cfg["local_port"] == 8188


def test_env_overrides_default():
    cfg = resolve_config({}, {"COMFY_LAB_HOST": "otherbox"}, DEFAULT_WF)
    assert cfg["host"] == "otherbox"


def test_cli_overrides_env():
    cfg = resolve_config({"host": "clibox"}, {"COMFY_LAB_HOST": "envbox"}, DEFAULT_WF)
    assert cfg["host"] == "clibox"


def test_local_port_derived_from_url():
    cfg = resolve_config({"url": "http://127.0.0.1:9999"}, {}, DEFAULT_WF)
    assert cfg["local_port"] == 9999


def test_cli_none_falls_through_to_env():
    cfg = resolve_config({"host": None}, {"COMFY_LAB_HOST": "envbox"}, DEFAULT_WF)
    assert cfg["host"] == "envbox"


def test_schemeless_url_raises():
    with pytest.raises(ValueError):
        resolve_config({"url": "192.168.1.50:8189"}, {}, DEFAULT_WF)


def test_url_without_port_raises():
    with pytest.raises(ValueError):
        resolve_config({"url": "http://127.0.0.1"}, {}, DEFAULT_WF)
