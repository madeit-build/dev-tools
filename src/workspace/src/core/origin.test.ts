import { expect, it } from "vitest";
import { parseOrigin } from "./origin.ts";

it.each([
  ["https://github.com/madeit-build/dev-tools.git", "madeit-build", "dev-tools"],
  ["https://github.com/gufo-org/gufo", "gufo-org", "gufo"],
  ["git@github.com:madeit-build/box.provisioning.git", "madeit-build", "box.provisioning"],
  ["ssh://git@github.com/madeit-build/seaboard.git", "madeit-build", "seaboard"],
  ["https://someuser:s3cr3tvalue@github.com/madeit-build/example.git", "madeit-build", "example"],
  ["https://gitlab.example.com/group/sub/name.git", "group/sub", "name"],
  ["https://github.com/madeit-build/dev-tools/", "madeit-build", "dev-tools"],
  ["  https://github.com/madeit-build/dev-tools.git\n", "madeit-build", "dev-tools"],
  ["git@github.com:group/sub/name.git", "group/sub", "name"],
])("parses %s", (url, owner, name) => {
  expect(parseOrigin(url)).toEqual({ owner, name });
});

it.each(["/srv/git/thing.git", "../sibling", "", "https://github.com/onlyowner", "not a url", "file:///srv/git/owner/thing.git", "C:\\repos\\owner\\thing"])(
  "returns null for %s",
  (url) => {
    expect(parseOrigin(url)).toBeNull();
  },
);

it("drops a credential", () => {
  expect(JSON.stringify(parseOrigin("https://someuser:s3cr3tvalue@github.com/a/b.git"))).not.toContain("s3cr3tvalue");
});

it("refuses a name that could not be a repo", () => {
  expect(parseOrigin("https://github.com/owner/..")).toBeNull();
  expect(parseOrigin("https://github.com/owner/a b")).toBeNull();
});

it("returns null, and does not throw, for a malformed percent escape", () => {
  expect(parseOrigin("https://github.com/owner/%E0%A4%A")).toBeNull();
});
