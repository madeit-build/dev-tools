import { describe, expect, it } from "vitest";
import { decide } from "./decide.ts";
import { cases } from "./testing/cases.ts";
import { displayLine } from "./display.ts";

describe("displayLine follows the shared cases", () => {
  for (const c of cases) {
    it(c.name, () => {
      expect(displayLine(decide({ cwd: c.cwd, session: c.session, org: c.org }))).toBe(c.expect.display);
    });
  }

  it("never contains an absolute path", () => {
    for (const c of cases) {
      expect(displayLine(decide({ cwd: c.cwd, session: c.session, org: c.org })), c.name).not.toMatch(/(^|\s)\//);
    }
  });
});
