import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from comfy_lab import build_parser


def test_run_parses_core_args():
    args = build_parser().parse_args(
        ["run", "qwen-edit", "--prompt", "hi", "--image", "a.png", "--image", "b.png", "--seed", "7"]
    )
    assert args.command == "run"
    assert args.workflow == "qwen-edit"
    assert args.prompt == "hi"
    assert args.image == ["a.png", "b.png"]
    assert args.seed == 7


def test_config_flags_default_to_none_so_env_can_win():
    args = build_parser().parse_args(["run", "qwen-gen"])
    assert args.host is None and args.url is None and args.out is None
