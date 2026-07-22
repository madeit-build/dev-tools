import sys, os, socket
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from comfy_lab import ssh_master_command, port_is_open


def test_ssh_master_command_has_forward_and_persist():
    cmd = ssh_master_command("box", 8188, "127.0.0.1:8188")
    assert cmd[0] == "ssh"
    assert "-L" in cmd
    assert "8188:127.0.0.1:8188" in cmd
    joined = " ".join(cmd)
    assert "ControlMaster=auto" in joined
    assert "ControlPersist" in joined
    assert cmd[-1] == "box"


def test_port_is_open_true_for_listening_socket():
    server = socket.socket()
    server.bind(("127.0.0.1", 0))
    server.listen(1)
    port = server.getsockname()[1]
    try:
        assert port_is_open(port) is True
    finally:
        server.close()


def test_port_is_open_false_for_closed_port():
    server = socket.socket()
    server.bind(("127.0.0.1", 0))
    port = server.getsockname()[1]
    server.close()
    assert port_is_open(port) is False
