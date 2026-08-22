import { describe, it, expect } from "vitest";
import {
  fleetId, hostId, serviceId, vhostId, partId,
  moduleId, optionId, inputId, externalId, parseId,
} from "./ids";

describe("id construction", () => {
  it("builds ids that encode type and containment", () => {
    expect(fleetId()).toBe("fleet:fleet");
    expect(hostId("box")).toBe("host:box");
    expect(serviceId("box", "caddy")).toBe("service:box/caddy");
    expect(vhostId("box", "chat.keep.madeit.build")).toBe("vhost:box/chat.keep.madeit.build");
    expect(partId("box", "caddy", "port", "2019")).toBe("part:box/caddy/port/2019");
    expect(moduleId("nix/nixos/chat.nix")).toBe("module:nix/nixos/chat.nix");
    expect(optionId("box", "services.caddy.virtualHosts")).toBe("option:box/services.caddy.virtualHosts");
    expect(inputId("nixpkgs")).toBe("input:nixpkgs");
    expect(externalId("tailnet")).toBe("external:tailnet");
  });

  it("is deterministic: same input always yields the same id", () => {
    expect(serviceId("box", "caddy")).toBe(serviceId("box", "caddy"));
  });

  it("distinguishes same-named units on different hosts", () => {
    expect(serviceId("box", "caddy")).not.toBe(serviceId("cerberus", "caddy"));
  });
});

describe("parseId", () => {
  it("round-trips a service id", () => {
    expect(parseId(serviceId("box", "caddy"))).toEqual({
      type: "service", host: "box", rest: "caddy",
    });
  });

  it("round-trips a module id, which has no host", () => {
    expect(parseId(moduleId("nix/nixos/chat.nix"))).toEqual({
      type: "module", host: null, rest: "nix/nixos/chat.nix",
    });
  });

  it("keeps slashes in the tail of a part id", () => {
    expect(parseId(partId("box", "caddy", "port", "2019"))).toEqual({
      type: "part", host: "box", rest: "caddy/port/2019",
    });
  });

  it("rejects an id with no type prefix", () => {
    expect(() => parseId("box/caddy")).toThrow(/malformed id/);
  });

  it("rejects an unknown type prefix", () => {
    expect(() => parseId("banana:box/caddy")).toThrow(/unknown node type/);
  });
});
