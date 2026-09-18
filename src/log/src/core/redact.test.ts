import { describe, expect, it } from "vitest";
import { redact } from "./redact.ts";

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

  it("matches a credential key however it is cased or spelled", () => {
    for (const key of ["Authorization", "madeit.SECRET", "x.cookie", "auth_token"]) {
      expect(redact({ [key]: "v" })[key], key).toBeUndefined();
    }
  });

  it("adds no redacted marker when nothing was dropped", () => {
    expect(redact({ "madeit.tool": "Bash" })["madeit.redacted"]).toBeUndefined();
  });
});
