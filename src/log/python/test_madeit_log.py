import json
import pathlib
import unittest

import jsonschema

import madeit_log

SCHEMA = json.loads((pathlib.Path(__file__).parent.parent / "schema"
                     / "madeit-log-v1.json").read_text())


class RecordTest(unittest.TestCase):
    def setUp(self):
        self.seen = []
        self.log = madeit_log.get_logger(
            service="cues", version="abc1234", environment="test",
            repo="agent-utilities", component="cues", sinks=[self.seen.append])

    def test_every_level_validates_against_the_shared_schema(self):
        # The SAME file the TypeScript suite validates against. "The two agree"
        # is a test, not a hope.
        self.log.debug("a.b", "d"); self.log.info("a.b", "i")
        self.log.warn("a.b", "w"); self.log.error("a.b", "e")
        self.assertEqual(len(self.seen), 4)
        for record in self.seen:
            jsonschema.validate(record, SCHEMA)

    def test_severity_numbers_match_the_typescript_side(self):
        for level, number in (("debug", 5), ("info", 9), ("warn", 13), ("error", 17)):
            getattr(self.log, level)("a.b", "body")
        self.assertEqual([r["SeverityNumber"] for r in self.seen], [5, 9, 13, 17])

    def test_redacts_before_any_sink_sees_it(self):
        self.log.info("a.b", "body", {"madeit.token": "sk-live", "madeit.tool": "Bash"})
        self.assertNotIn("madeit.token", self.seen[0]["Attributes"])
        self.assertEqual(self.seen[0]["Attributes"]["madeit.tool"], "Bash")
        self.assertEqual(self.seen[0]["Attributes"]["madeit.redacted"], ["madeit.token"])

    def test_truncates_a_session_id_to_twelve_characters(self):
        self.log.info("a.b", "b", {"madeit.session_id": "a9f15bb8-65e4-4c1a-9f2b"})
        self.assertEqual(self.seen[0]["Attributes"]["madeit.session_id"], "a9f15bb8-65e")

    def test_adopts_a_traceparent_minted_by_the_daemon(self):
        traced = self.log.with_trace(
            "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01")
        traced.info("a.b", "body")
        self.assertEqual(self.seen[0]["TraceId"], "4bf92f3577b34da6a3ce929d0e0e4736")
        self.assertEqual(self.seen[0]["SpanId"], "00f067aa0ba902b7")

    def test_junk_trace_context_yields_an_untraced_record_not_a_refusal(self):
        self.log.with_trace("nonsense").info("a.b", "body")
        self.assertNotIn("TraceId", self.seen[0])
        self.assertEqual(len(self.seen), 1)

    def test_a_throwing_sink_never_reaches_the_caller(self):
        def boom(_record):
            raise OSError("disk gone")
        log = madeit_log.get_logger(
            service="c", version="1", environment="test", repo="r",
            component="c", sinks=[boom])
        log.info("a.b", "body")  # must not raise

    def test_keeps_a_counted_or_plural_token_which_is_a_metric_not_a_credential(self):
        self.log.info("a.b", "body", {
            "madeit.token_count": 12, "input_tokens": 3, "max_tokens": 4096,
            "madeit.keyboard": "us", "hotkey": "cmd-k",
        })
        attributes = self.seen[0]["Attributes"]
        for key in ("madeit.token_count", "input_tokens", "max_tokens",
                    "madeit.keyboard", "hotkey"):
            self.assertIn(key, attributes)
        self.assertNotIn("madeit.redacted", attributes)

    def test_drops_a_credential_however_the_word_is_joined_to_its_neighbors(self):
        self.log.info("a.b", "body", {
            "private_key": "v", "signing-key": "v", "aws_access_key_id": "v",
            "apiKey": "v", "refreshToken": "v", "madeit.bearer": "v",
            "x.auth": "v", "jwt": "v",
        })
        attributes = self.seen[0]["Attributes"]
        for key in ("private_key", "signing-key", "aws_access_key_id", "apiKey",
                    "refreshToken", "madeit.bearer", "x.auth", "jwt"):
            self.assertNotIn(key, attributes)

    def test_a_caller_supplied_trace_attribute_never_overrides_with_trace(self):
        traced = self.log.with_trace(
            "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01")
        traced.info("a.b", "body", {
            "madeit.trace_id": "11111111111111111111111111111111",
            "madeit.span_id": "2222222222222222",
        })
        record = self.seen[0]
        self.assertEqual(record["TraceId"], "4bf92f3577b34da6a3ce929d0e0e4736")
        self.assertEqual(record["SpanId"], "00f067aa0ba902b7")
        self.assertNotIn("madeit.trace_id", record["Attributes"])
        self.assertNotIn("madeit.span_id", record["Attributes"])

    def test_a_survivor_receives_caller_records_plus_exactly_one_disabled_notice(self):
        def boom(_record):
            raise OSError("disk gone")
        seen = []
        log = madeit_log.get_logger(
            service="c", version="1", environment="test", repo="r",
            component="c", sinks=[boom, seen.append])
        log.info("a.b", "one")
        log.info("a.b", "two")
        bodies = [record["Body"] for record in seen]
        self.assertEqual(bodies.count("one"), 1)
        self.assertEqual(bodies.count("two"), 1)
        self.assertEqual(bodies.count("a sink failed and was disabled"), 1)
        notice = next(r for r in seen if r["Body"] == "a sink failed and was disabled")
        self.assertEqual(notice["SeverityText"], "ERROR")
        self.assertEqual(notice["Attributes"]["madeit.error"], "disk gone")

    def test_a_raising_sink_is_called_exactly_once_across_two_emits(self):
        calls = []
        def boom(_record):
            calls.append(1)
            raise OSError("disk gone")
        log = madeit_log.get_logger(
            service="c", version="1", environment="test", repo="r",
            component="c", sinks=[boom])
        log.info("a.b", "one")
        log.info("a.b", "two")
        self.assertEqual(len(calls), 1)


if __name__ == "__main__":
    unittest.main()
