import datetime
import json
import os
import pathlib
import tempfile
import unittest

import jsonschema

import madeit_log

SCHEMA_DIR = pathlib.Path(__file__).parent.parent / "schema"
SCHEMA = json.loads((SCHEMA_DIR / "madeit-log-v1.json").read_text())
# Shared with the TypeScript suite, so the two redactors agree by test rather than by reading.
REDACTION_CASES = json.loads((SCHEMA_DIR / "redaction-cases.json").read_text())


def _lines(path):
    with open(path) as handle:
        return [json.loads(line) for line in handle if line.strip()]


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

    def test_truncates_a_session_id_however_its_key_is_spelled(self):
        keys = ("sessionId", "madeit.sessionId", "session.id", "claude_session_id",
                "madeit.session_id", "session_id")
        self.log.info("a.b", "b", {key: "a9f15bb8-65e4-4c1a-9f2b" for key in keys})
        for key in keys:
            self.assertEqual(self.seen[0]["Attributes"][key], "a9f15bb8-65e", key)

    def test_exempts_a_count_only_when_the_credential_word_is_token(self):
        # Nobody counts passwords. A count word next to any other credential
        # word is a credential with a suffix, and it drops.
        keys = ("api_key_used", "secret_total", "password_max", "cookie_count",
                "jwt_limit", "bearer_remaining")
        self.log.info("a.b", "body", {key: "v" for key in keys})
        for key in keys:
            self.assertNotIn(key, self.seen[0]["Attributes"], key)

    def test_agrees_with_the_typescript_suite_on_every_shared_case(self):
        self.assertGreater(len(REDACTION_CASES), 0)
        for case in REDACTION_CASES:
            key, value, expected = case["key"], case["value"], case["expect"]
            out = madeit_log.redact({key: value})
            if expected == "drop":
                self.assertNotIn(key, out, key)
                self.assertEqual(out["madeit.redacted"], [key], key)
                continue
            self.assertNotIn("madeit.redacted", out, key)
            if expected == "truncate":
                self.assertGreater(len(value), madeit_log.SESSION_PREFIX_LEN, key)
                self.assertEqual(out[key], value[:madeit_log.SESSION_PREFIX_LEN], key)
                continue
            self.assertEqual(out[key], value, key)

    def test_a_well_formed_trace_attribute_on_an_untraced_logger_is_dropped(self):
        self.log.info("a.b", "body", {
            "madeit.trace_id": "4bf92f3577b34da6a3ce929d0e0e4736",
            "madeit.span_id": "00f067aa0ba902b7",
        })
        record = self.seen[0]
        self.assertNotIn("TraceId", record)
        self.assertNotIn("SpanId", record)
        self.assertNotIn("madeit.trace_id", record["Attributes"])
        self.assertNotIn("madeit.span_id", record["Attributes"])
        jsonschema.validate(record, SCHEMA)

    def test_coerces_and_marks_an_event_slug_the_schema_would_reject(self):
        self.log.info("Route", "body")  # must not raise
        self.assertEqual(len(self.seen), 1)
        jsonschema.validate(self.seen[0], SCHEMA)
        self.assertEqual(self.seen[0]["Attributes"]["madeit.event"], "invalid")
        self.assertEqual(self.seen[0]["Attributes"]["madeit.invalid_event"], "Route")
        self.assertEqual(self.seen[0]["Body"], "body")

    def test_coerces_and_marks_an_empty_body_which_the_schema_would_reject(self):
        self.log.info("a.b", "")  # must not raise
        self.assertEqual(len(self.seen), 1)
        jsonschema.validate(self.seen[0], SCHEMA)
        self.assertEqual(self.seen[0]["Attributes"]["madeit.event"], "a.b")
        self.assertEqual(self.seen[0]["Attributes"]["madeit.invalid_body"], True)
        self.assertEqual(self.seen[0]["Body"], "a.b")

    def test_marks_both_defects_at_once_and_body_falls_back_to_the_invalid_event_marker(self):
        self.log.info("Route", "")  # must not raise
        self.assertEqual(len(self.seen), 1)
        jsonschema.validate(self.seen[0], SCHEMA)
        self.assertEqual(self.seen[0]["Attributes"]["madeit.event"], "invalid")
        self.assertEqual(self.seen[0]["Attributes"]["madeit.invalid_event"], "Route")
        self.assertEqual(self.seen[0]["Attributes"]["madeit.invalid_body"], True)
        self.assertEqual(self.seen[0]["Body"], "invalid")

    def test_a_trailing_newline_is_not_a_traceparent(self):
        good = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
        self.assertIsNotNone(madeit_log.parse_traceparent(good))
        self.assertIsNone(madeit_log.parse_traceparent(good + "\n"))

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

    def test_becomes_a_no_op_when_every_sink_has_died(self):
        first_calls, second_calls = [], []
        def first_raiser(_record):
            first_calls.append(1)
            raise OSError("x")
        def second_raiser(_record):
            second_calls.append(1)
            raise OSError("y")
        log = madeit_log.get_logger(
            service="c", version="1", environment="test", repo="r",
            component="c", sinks=[first_raiser, second_raiser])
        log.info("a.b", "one")
        log.info("a.b", "two")  # must not raise, even though every sink is dead
        self.assertEqual(len(first_calls), 1)
        self.assertEqual(len(second_calls), 1)

    def test_a_healthy_sink_gets_the_record_and_one_notice_per_death(self):
        def first_raiser(_record):
            raise OSError("x")
        def second_raiser(_record):
            raise OSError("y")
        seen = []
        log = madeit_log.get_logger(
            service="c", version="1", environment="test", repo="r",
            component="c", sinks=[first_raiser, second_raiser, seen.append])
        log.info("a.b", "body")  # must not raise
        events = [record["Attributes"]["madeit.event"] for record in seen]
        self.assertEqual(events.count("a.b"), 1)
        self.assertEqual(events.count("sink.disabled"), 2)

    def test_never_calls_a_sink_twice_for_one_record_once_it_has_been_disabled(self):
        # A survivor that dies receiving a death notice is gone before the outer
        # loop reaches it, so it must not see the caller's record afterward.
        late_calls = []
        def first_raiser(_record):
            raise OSError("x")
        def fragile(record):
            if record["Attributes"]["madeit.event"] == "sink.disabled":
                raise OSError("y")
            late_calls.append(1)
        log = madeit_log.get_logger(
            service="c", version="1", environment="test", repo="r",
            component="c", sinks=[first_raiser, fragile])
        log.info("a.b", "body")
        self.assertEqual(late_calls, [])

    def test_names_the_errors_type_when_its_message_cannot_be_read(self):
        class Mute(Exception):
            def __str__(self):
                raise RuntimeError("no")
        def boom(_record):
            raise Mute()
        seen = []
        def good(record):
            if record["Attributes"]["madeit.event"] == "sink.disabled":
                seen.append(record["Attributes"]["madeit.error"])
        log = madeit_log.get_logger(
            service="c", version="1", environment="test", repo="r",
            component="c", sinks=[boom, good])
        log.info("a.b", "body")  # must not raise
        self.assertEqual(seen, ["Mute"])


class FileSinkTest(unittest.TestCase):
    def setUp(self):
        self.path = os.path.join(tempfile.mkdtemp(), "nested", "out.jsonl")
        self.seen = []
        self.log = madeit_log.get_logger(
            service="cues", version="abc1234", environment="test",
            repo="agent-utilities", component="cues",
            sinks=[madeit_log.file_sink(self.path)])

    def test_creates_the_parent_directory(self):
        self.log.info("a.b", "body")
        self.assertEqual(len(_lines(self.path)), 1)

    def test_a_bare_filename_needs_no_directory(self):
        cwd = os.getcwd()
        os.chdir(tempfile.mkdtemp())
        try:
            madeit_log.file_sink("out.jsonl")({"Body": "b"})
            self.assertEqual(_lines("out.jsonl"), [{"Body": "b"}])
        finally:
            os.chdir(cwd)

    def test_serializes_a_datetime_attribute_rather_than_dying_on_it(self):
        self.log.info("a.b", "body", {"at": datetime.datetime(2026, 9, 10, 8, 0)})
        self.log.info("a.b", "body")
        lines = _lines(self.path)
        self.assertEqual(len(lines), 2)
        self.assertEqual(lines[0]["Attributes"]["at"], "2026-09-10 08:00:00")

    def test_replaces_a_record_it_cannot_serialize_and_keeps_going(self):
        # One cyclic attribute must not disable the whole sink for the process,
        # and the replacement must still say which event was lost.
        cyclic = {}
        cyclic["self"] = cyclic
        self.log.warn("a.b", "body", {"cyclic": cyclic})  # must not raise
        self.log.info("a.b", "body")
        replaced, following = _lines(self.path)
        self.assertEqual(replaced["Attributes"]["madeit.event"], "log.unserializable")
        self.assertEqual(replaced["Attributes"]["madeit.original_event"], "a.b")
        self.assertIn("ircular", replaced["Attributes"]["madeit.error"])
        self.assertEqual(replaced["Body"], "record could not be serialized")
        self.assertEqual(replaced["SeverityText"], "WARN")
        self.assertEqual(replaced["SeverityNumber"], 13)
        jsonschema.validate(replaced, SCHEMA)
        self.assertEqual(following["Body"], "body")


if __name__ == "__main__":
    unittest.main()
