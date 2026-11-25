import { expect, it } from "vitest";
import { parseOrigin } from "./origin.ts";

it.each([
  [
    "https://github.com/madeit-build/dev-tools.git",
    "madeit-build",
    "dev-tools",
  ],
  ["https://github.com/gufo-org/gufo", "gufo-org", "gufo"],
  [
    "git@github.com:madeit-build/box.provisioning.git",
    "madeit-build",
    "box.provisioning",
  ],
  [
    "ssh://git@github.com/madeit-build/seaboard.git",
    "madeit-build",
    "seaboard",
  ],
  [
    "https://someuser:s3cr3tvalue@github.com/madeit-build/example.git",
    "madeit-build",
    "example",
  ],
  ["https://gitlab.example.com/group/sub/name.git", "group/sub", "name"],
  ["https://github.com/madeit-build/dev-tools/", "madeit-build", "dev-tools"],
  [
    "  https://github.com/madeit-build/dev-tools.git\n",
    "madeit-build",
    "dev-tools",
  ],
  ["git@github.com:group/sub/name.git", "group/sub", "name"],
])("parses %s", (url, owner, name) => {
  expect(parseOrigin(url)).toMatchObject({ owner, name });
});

it.each([
  ["https://github.com/madeit-build/dev-tools.git", "github.com"],
  ["git@github.com:madeit-build/box.provisioning.git", "github.com"],
  ["ssh://git@GitHub.com:22/madeit-build/seaboard.git", "github.com"],
  [
    "https://git.example.net/madeit-build/box.provisioning.git",
    "git.example.net",
  ],
  ["git@work-alias:madeit-build/dev-tools.git", "work-alias"],
])("keeps the host of %s, lowercased", (url, host) => {
  expect(parseOrigin(url)?.host).toBe(host);
});

it.each([
  "file:/srv/git/owner/thing.git",
  "ext::sh -c owner/thing",
  "foo:bar/baz",
  "javascript:owner/thing",
  "host.example:/abs/owner/thing",
])("does not read %s as a host and path", (url) => {
  expect(parseOrigin(url)).toBeNull();
});

it.each([
  "/srv/git/thing.git",
  "../sibling",
  "",
  "https://github.com/onlyowner",
  "not a url",
  "file:///srv/git/owner/thing.git",
  "C:\\repos\\owner\\thing",
])("returns null for %s", (url) => {
  expect(parseOrigin(url)).toBeNull();
});

it("drops a credential", () => {
  expect(
    JSON.stringify(
      parseOrigin("https://someuser:s3cr3tvalue@github.com/a/b.git"),
    ),
  ).not.toContain("s3cr3tvalue");
});

it("refuses a name that could not be a repo", () => {
  expect(parseOrigin("https://github.com/owner/..")).toBeNull();
  expect(parseOrigin("https://github.com/owner/a b")).toBeNull();
});

it("returns null, and does not throw, for a malformed percent escape", () => {
  expect(parseOrigin("https://github.com/owner/%E0%A4%A")).toBeNull();
});
