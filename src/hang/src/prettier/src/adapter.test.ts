import { describe, it, expect } from "vitest";
import { createAdapter } from "./adapter.js";

describe("createAdapter", () => {
  it("dispatches its scan variant off the filepath: only a .tsx path catches a broken JSX closing tag", () => {
    expect(createAdapter("x.tsx").verify("</div>", "< /div>")).toBe(false);
    expect(createAdapter("x.ts").verify("</div>", "< /div>")).toBe(true);
  });
});
