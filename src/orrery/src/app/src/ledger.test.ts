import { describe, it, expect } from "vitest";
import { groupLedger, searchLedger } from "./ledger";
import type { DropRecord } from "@made-i-t/orrery-model";

const row = (over: Partial<DropRecord>): DropRecord => ({
  candidate: "x", host: "box", rule: "services", reason: "no-exec", detail: "no ExecStart", ...over,
});

describe("groupLedger", () => {
  it("groups rows by reason", () => {
    const g = groupLedger([row({}), row({ reason: "filtered-by-rule" }), row({})]);
    expect(g.find((x) => x.reason === "no-exec")?.rows).toHaveLength(2);
    expect(g.find((x) => x.reason === "filtered-by-rule")?.rows).toHaveLength(1);
  });

  it("gives every reason a human label rather than showing the raw code", () => {
    for (const g of groupLedger([row({}), row({ reason: "eval-failed" })])) {
      expect(g.label.length).toBeGreaterThan(0);
      expect(g.label).not.toBe(g.reason);
    }
  });

  it("orders failures above routine filtering, since a failure is the actionable one", () => {
    const g = groupLedger([row({ reason: "no-exec" }), row({ reason: "eval-failed" })]);
    expect(g[0].reason).toBe("eval-failed");
  });

  it("omits a reason with no rows rather than showing an empty group", () => {
    expect(groupLedger([row({ reason: "no-exec" })]).map((g) => g.reason)).toEqual(["no-exec"]);
  });

  it("returns nothing for an empty ledger", () => {
    expect(groupLedger([])).toEqual([]);
  });
});

describe("searchLedger", () => {
  it("matches on the candidate name", () => {
    expect(searchLedger([row({ candidate: "postgresql" }), row({ candidate: "caddy" })], "postgres")).toHaveLength(1);
  });

  it("matches on the detail text, so a port number finds its row", () => {
    expect(searchLedger([row({ detail: "port 65000 maps to nothing" })], "65000")).toHaveLength(1);
  });

  it("is case insensitive", () => {
    expect(searchLedger([row({ candidate: "Caddy" })], "caddy")).toHaveLength(1);
  });

  it("returns everything for an empty query", () => {
    const rows = [row({}), row({})];
    expect(searchLedger(rows, "")).toHaveLength(2);
  });

  it("matches on the rule name, so you can ask what one rule dropped", () => {
    expect(searchLedger([row({ rule: "vhosts" }), row({ rule: "services" })], "vhosts")).toHaveLength(1);
  });
});
