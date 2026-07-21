import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from comfy_lab import encode_multipart, node_errors_from_history, history_failure, view_url


def test_encode_multipart_shape():
    ctype, body = encode_multipart({"type": "input"}, "image", "a.png", b"\x89PNG")
    assert ctype.startswith("multipart/form-data; boundary=")
    assert b'name="type"' in body
    assert b'filename="a.png"' in body
    assert b"\x89PNG" in body
    assert body.endswith(b"--\r\n")


def test_node_errors_present():
    entry = {"status": {"status_str": "error", "messages": []},
             "node_errors": {"9": {"errors": [{"message": "value not in list"}]}}}
    errs = node_errors_from_history(entry)
    assert "9" in errs


def test_node_errors_absent_on_success():
    entry = {"status": {"status_str": "success"}, "node_errors": {}}
    assert node_errors_from_history(entry) == {}


def test_view_url_builds_query():
    url = view_url("http://127.0.0.1:8188",
                   {"filename": "comfylab_0001.png", "subfolder": "", "type": "output"})
    assert url.startswith("http://127.0.0.1:8188/view?")
    assert "filename=comfylab_0001.png" in url
    assert "type=output" in url


def test_history_failure_none_on_success():
    entry = {"status": {"status_str": "success"}, "outputs": {}, "node_errors": {}}
    assert history_failure(entry) is None


def test_history_failure_reports_node_errors():
    entry = {"node_errors": {"9": {"errors": [{"message": "bad"}]}}}
    assert "9" in history_failure(entry)


def test_history_failure_reports_execution_error():
    entry = {"status": {"status_str": "error", "messages": [["execution_error", {"node_id": "9"}]]},
             "node_errors": {}}
    msg = history_failure(entry)
    assert msg is not None and "execution_error" in msg
