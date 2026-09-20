import { describe, it, expect } from "vitest";
import { parseHash, toHash, type View } from "./route";

describe("parseHash", () => {
  it("defaults to the fleet under the runtime lens when the hash is empty", () => {
    expect(parseHash("")).toEqual({
      path: [],
      lens: "runtime",
      selected: null,
    });
  });

  it("reads a drill path", () => {
    expect(parseHash("#/box/caddy").path).toEqual(["box", "caddy"]);
  });

  it("reads the lens", () => {
    expect(parseHash("#/box?lens=declaration").lens).toBe("declaration");
  });

  it("reads the selection", () => {
    expect(parseHash("#/box?sel=service:box/caddy").selected).toBe(
      "service:box/caddy",
    );
  });

  it("falls back to runtime for an unknown lens rather than rendering nothing", () => {
    expect(parseHash("#/box?lens=banana").lens).toBe("runtime");
  });

  it("tolerates a trailing slash", () => {
    expect(parseHash("#/box/").path).toEqual(["box"]);
  });
});

describe("toHash", () => {
  it("round-trips through parseHash", () => {
    const view: View = {
      path: ["box", "caddy"],
      lens: "declaration",
      selected: "service:box/caddy",
    };
    expect(parseHash(toHash(view))).toEqual(view);
  });

  it("omits the lens when it is the default, keeping the common URL short", () => {
    expect(toHash({ path: ["box"], lens: "runtime", selected: null })).toBe(
      "#/box",
    );
  });

  it("renders the fleet view as a bare hash", () => {
    expect(toHash({ path: [], lens: "runtime", selected: null })).toBe("#/");
  });

  it("round-trips a vhost id, whose dots must survive", () => {
    const view: View = {
      path: ["box"],
      lens: "runtime",
      selected: "vhost:box/chat.keep.madeit.build",
    };
    expect(parseHash(toHash(view)).selected).toBe(
      "vhost:box/chat.keep.madeit.build",
    );
  });
});
