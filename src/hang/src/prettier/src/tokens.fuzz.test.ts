import { describe, it, expect } from "vitest";
import { sameTokens } from "./tokens.js";

/**
 * Property test for the safety boundary (sameTokens): three separate hand-
 * picked probes have each missed a real hole (member-access template
 * poisoning, then a regex brace desync). Enumerating shapes by hand does not
 * scale, so this generates many combinations of noisy prefixes -- templates,
 * nested substitutions, regexes with braces, tagged templates, object
 * literals, comments, strings -- placed before a fixed, guaranteed-real
 * corruption (an eaten newline inside a later template literal) and asserts
 * the guard rejects every single one. The prefix is byte-identical between
 * the "before" and "after" texts in every case, so the corruption at the end
 * is the only true difference; any "false" verdict is either a correct catch
 * of that corruption or a safe (never unsafe) over-rejection from the
 * empty-stack invariant.
 *
 * Deterministic: mulberry32 seeded with a fixed constant, so a failure here
 * reproduces exactly by re-running the suite -- no flakiness, no need to
 * capture the failing case separately.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NOISE_BLOCKS: readonly string[] = [
  'const msg1 = `hi ${name} there`;\n',
  'const nested1 = `outer ${`inner ${x}`} end`;\n',
  'const nested2 = `outer ${`inner ${x}`} mid ${y} end`;\n',
  'const tagged1 = tag`hi ${y} there`;\n',
  'const obj1 = { a: 1, b: { c: 2 } };\n',
  'const objInSub = `hi ${f({ a: 1 })} there`;\n',
  'const re1 = /x{/;\n',
  'const re2 = /x}/;\n',
  'const re3 = /\\{/;\n',
  'const re4 = /a{2}/;\n',
  'const reInSub = `${/\\{/.test(s) ? "o" : "x"}`;\n',
  'const div1 = `${a / b}`;\n',
  '// a line comment with a { brace\n',
  '/* a block comment with a } brace */\n',
  'const str1 = "a string with { and } braces";\n',
  '',
];

const SEED = 20260902;
const ITERATIONS = 300;
const MAX_BLOCKS_PER_PREFIX = 5;

function randomPrefix(rand: () => number): string {
  const blockCount = Math.floor(rand() * (MAX_BLOCKS_PER_PREFIX + 1));
  let prefix = "";
  for (let i = 0; i < blockCount; i++) {
    prefix += NOISE_BLOCKS[Math.floor(rand() * NOISE_BLOCKS.length)];
  }
  return prefix;
}

// The one guaranteed-real difference between before/after in every case: an
// eaten newline inside a template literal, which the design doc names
// explicitly as a corruption the guard must always catch.
const CORRUPT_BEFORE = "const m = `a\n    .b not a chain`;\n";
const CORRUPT_AFTER = "const m = `a.b not a chain`;\n";

describe("sameTokens fuzz: a real corruption must never be accepted, seed " + SEED, () => {
  const rand = mulberry32(SEED);
  const failures: string[] = [];

  for (let i = 0; i < ITERATIONS; i++) {
    const prefix = randomPrefix(rand);
    const before = prefix + CORRUPT_BEFORE;
    const after = prefix + CORRUPT_AFTER;
    if (sameTokens(before, after, "standard")) {
      failures.push(`iteration ${i}: prefix ${JSON.stringify(prefix)}`);
    }
  }

  it(`never accepts across ${ITERATIONS} generated prefixes`, () => {
    expect(failures).toEqual([]);
  });
});
