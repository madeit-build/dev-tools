import { describe, expect, it } from "vitest";
import fs from "node:fs";
import { redact, SESSION_PREFIX_LEN } from "./redact.ts";

interface RedactionCase {
  readonly key: string;
  readonly value: string;
  readonly expect: "drop" | "keep" | "truncate";
}

// Shared with the Python suite, so the two redactors agree by test rather than by reading.
const cases: RedactionCase[] = JSON.parse(
  fs.readFileSync(new URL("../../schema/redaction-cases.json", import.meta.url), "utf8"),
);

describe("redact", () => {
  it("drops credential-shaped keys", () => {
    const out = redact({ "madeit.token": "sk-live-abc", "madeit.tool": "Bash" });
    expect(out["madeit.token"]).toBeUndefined();
    expect(out["madeit.tool"]).toBe("Bash");
  });

  it("records WHAT it dropped, so the removal is visible", () => {
    // A silent drop is indistinguishable from a caller that never set it, and
    // "why is that field missing" is exactly the question a log should answer.
    const out = redact({ "madeit.api_key": "x", "madeit.password": "y" });
    expect(out["madeit.redacted"]).toEqual(["madeit.api_key", "madeit.password"]);
  });

  it("truncates a session id to the prefix the throttle already keys on", () => {
    const out = redact({ "madeit.session_id": "a9f15bb8-65e4-4c1a-9f2b-0d1e2f3a4b5c" });
    expect(out["madeit.session_id"]).toBe("a9f15bb8-65e");
  });

  it("leaves a short session id alone", () => {
    expect(redact({ "madeit.session_id": "abc" })["madeit.session_id"]).toBe("abc");
  });

  it("truncates a session id however its key is spelled", () => {
    for (const key of ["sessionId", "madeit.sessionId", "session.id", "claude_session_id",
                       "madeit.session_id", "session_id"]) {
      expect(redact({ [key]: "a9f15bb8-65e4-4c1a-9f2b" })[key], key).toBe("a9f15bb8-65e");
    }
  });

  it("adds no redacted marker when nothing was dropped", () => {
    expect(redact({ "madeit.tool": "Bash" })["madeit.redacted"]).toBeUndefined();
  });

  it("keeps a counted or plural token, which is a metric and not a credential", () => {
    const out = redact({
      "madeit.token_count": 12, "input_tokens": 3, "max_tokens": 4096,
      "madeit.keyboard": "us", "hotkey": "cmd-k",
    });
    expect(Object.keys(out).sort()).toEqual(
      ["hotkey", "input_tokens", "madeit.keyboard", "madeit.token_count", "max_tokens"]);
    expect(out["madeit.redacted"]).toBeUndefined();
  });

  it("exempts a count only when the credential word is token", () => {
    // Nobody counts passwords. A count word next to any other credential word
    // is a credential with a suffix, and it drops.
    for (const key of ["api_key_used", "secret_total", "password_max", "cookie_count",
                       "jwt_limit", "bearer_remaining"]) {
      expect(redact({ [key]: "v" })[key], key).toBeUndefined();
    }
  });

  it("drops a credential however the word is joined to its neighbors", () => {
    for (const key of ["private_key", "signing-key", "aws_access_key_id", "apiKey",
                       "refreshToken", "madeit.bearer", "x.auth", "jwt",
                       "api_key2", "token2", "apikey1"]) {
      expect(redact({ [key]: "v" })[key], key).toBeUndefined();
    }
  });

  it("agrees with the Python suite on every shared case", () => {
    expect(cases.length).toBeGreaterThan(0);
    for (const { key, value, expect: expected } of cases) {
      const out = redact({ [key]: value });
      if (expected === "drop") {
        expect(out[key], key).toBeUndefined();
        expect(out["madeit.redacted"], key).toEqual([key]);
        continue;
      }
      expect(out["madeit.redacted"], key).toBeUndefined();
      if (expected === "truncate") {
        expect(value.length, key).toBeGreaterThan(SESSION_PREFIX_LEN);
        expect(out[key], key).toBe(value.slice(0, SESSION_PREFIX_LEN));
        continue;
      }
      expect(out[key], key).toBe(value);
    }
  });
});
