import { describe, it, expect } from "vitest";
import * as prettier from "prettier";
import * as plugin from "./plugin.js";
import { CHAINS } from "../fixtures/chains.js";
import { REFUSALS } from "../fixtures/refusals.js";

// Passing the plugin as an imported module object, rather than a file path,
// sidesteps Prettier having to load TypeScript through its own import().
const base = { parser: "typescript" as const, tabWidth: 4, printWidth: 90 };
const withPlugin = { ...base, plugins: [plugin] };

// This mechanism shares no code with tokens.ts: it never calls sameTokens or
// createAdapter. A whitespace-only reprint at a huge width is the whole check,
// so a bug that fools the token guard has to also survive Prettier's own
// reformatting to slip through here.
// Blind spot: Prettier's own printer collapses any run of two or more blank
// lines down to one, so a transform that duplicated or dropped blank lines
// outside the hunk it touched is invisible to this check when both sides
// already have two or more.
const canon = (source: string) => prettier.format(source, { ...base, printWidth: 9999 });

describe("differential oracle", () => {
  for (const [name, source] of Object.entries(CHAINS)) {
    it(`preserves meaning for ${name}`, async () => {
      const hung = await prettier.format(source, withPlugin);
      expect(await canon(hung)).toBe(await canon(source));
    });

    // Determinism check, not an independent semantic one: Prettier's estree
    // printer reprints purely from the AST, ignoring the input's surface
    // layout, so the second pass recomputes the same rendered text and the
    // same hangAlign result whenever the assertion above already passed.
    it(`reaches a fixed point for ${name}`, async () => {
      const once = await prettier.format(source, withPlugin);
      expect(await prettier.format(once, withPlugin)).toBe(once);
    });
  }

  for (const [name, source] of Object.entries(REFUSALS)) {
    it(`refuses to touch ${name}`, async () => {
      const hung = await prettier.format(source, withPlugin);
      expect(hung).toBe(await prettier.format(source, base));
      expect(await canon(hung)).toBe(await canon(source));
    });
  }
});
