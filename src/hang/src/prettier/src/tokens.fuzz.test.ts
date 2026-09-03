import { describe, it, expect } from "vitest";
import { sameTokens } from "./tokens.js";

/**
 * Property test for the safety boundary (sameTokens). Three hand-picked
 * probe rounds each missed a real hole: member-access template poisoning,
 * an object-literal brace inside a substitution, and (twice) a regex's
 * internal characters -- a brace, then a backtick -- being misread as
 * ordinary code by a hand-rolled scanner. Enumerating shapes by hand does
 * not scale.
 *
 * The first version of this fuzz test generated random NOISE before a fixed
 * corruption appended afterward. Review found that shape structurally cannot
 * reproduce either real exploit: both needed the corruption INSIDE the same
 * construct causing the ambiguity (a regex sharing a statement, or a
 * template's own substitution and tail), not textually downstream of a
 * self-contained prefix. This version's CORRUPTING_SHAPES embed the eaten-
 * newline corruption directly inside the ambiguous construct itself --
 * inside the same statement as a backtick-bearing regex, inside a
 * substitution's own trailing template text, inside a nested substitution,
 * etc. NEUTRAL_SHAPES are the same constructs with no corruption at all
 * (before === after byte-for-byte), which exist so the fuzz can also fail
 * loudly on an over-rejection, not just an under-rejection.
 *
 * Each generated case wraps a randomly chosen shape in random, self-
 * contained noise blocks (byte-identical between before/after) before and
 * after it, to vary surrounding context without touching the shape's own
 * internal corruption.
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

interface Shape {
  name: string;
  before: string;
  after: string;
}

// Each shape's corruption -- an eaten newline inside a template's own text,
// the one corruption every round's design doc and tests already treat as
// the canonical must-always-reject case -- lives INSIDE the same construct
// that made the previous scanner-based fixes lose track of context. This is
// the structural difference from the first fuzz version: the corrupted text
// and the ambiguous construct are the same span, not two different spans
// joined by an unrelated prefix.
const CORRUPTING_SHAPES: readonly Shape[] = [
  {
    // Exploit 1's exact shape: a regex containing a backtick shares a
    // statement group with the template being corrupted.
    name: "regex-with-backtick-then-multiline-template",
    before: "const r = /`/;\nconst m = `a\n    .b not a chain`;\n",
    after: "const r = /`/;\nconst m = `a.b not a chain`;\n",
  },
  {
    // Exploit 2's exact shape: a regex brace inside a substitution, whose
    // OWN trailing template text (not a later, separate template) carries
    // the eaten newline.
    name: "regex-brace-in-substitution-corrupt-tail",
    before: "const msg = `hi ${/x{/} end } there\n    .b not a chain`;\n",
    after: "const msg = `hi ${/x{/} end } there.b not a chain`;\n",
  },
  {
    // A nested substitution (template inside a substitution) whose outer
    // template's own tail, after the nested one closes, is what carries the
    // corruption.
    name: "nested-substitution-corrupt-tail",
    before: "const msg = `outer ${`inner ${name}`} end\n    .b not a chain`;\n",
    after: "const msg = `outer ${`inner ${name}`} end.b not a chain`;\n",
  },
  {
    // A tagged template whose own tail carries the corruption, with a
    // backtick-bearing regex earlier in the same substitution.
    name: "tagged-template-with-regex-backtick-corrupt-tail",
    before:
      "const msg = tag`hi ${/`/.test(s) ? a : b} there\n    .b not a chain`;\n",
    after: "const msg = tag`hi ${/`/.test(s) ? a : b} there.b not a chain`;\n",
  },
  {
    // The corruption sits INSIDE the substitution expression itself: a
    // division that looks like it could be a regex boundary, immediately
    // followed (still inside the same template) by the newline-eaten text.
    name: "division-in-substitution-corrupt-tail",
    before: "const msg = `val ${a / b} end\n    .b not a chain`;\n",
    after: "const msg = `val ${a / b} end.b not a chain`;\n",
  },
];

// Same constructs, no corruption at all: the shape's own construct stays
// byte-identical, but a real whitespace-only hang -- joining a member chain
// up onto its receiver, the exact transformation this tool performs -- is
// appended after it. These exist so the fuzz can catch a regression in the
// OTHER direction: an ambiguous construct earlier in the file that makes the
// guard over-reject a real, unrelated whitespace-only change later in it.
//
// Comparing shape.after to itself byte-for-byte here previously made this
// check unable to fail: sameTokens(x, x, ...) is trivially true for any x,
// since identical text always tokenizes identically. Appending a genuine
// before/after pair means the guard has to actually recompute and compare
// two different token streams, not just short-circuit on equal input.
const NEUTRAL_SHAPES: readonly Shape[] = CORRUPTING_SHAPES.map((shape) => ({
  name: shape.name + " (neutral, real whitespace-only hang)",
  before: `${shape.after}const chained = value\n    .method();\n`,
  after: `${shape.after}const chained = value.method();\n`,
}));

const NOISE_BLOCKS: readonly string[] = [
  "const msg1 = `hi ${name} there`;\n",
  "const nested1 = `outer ${`inner ${x}`} end`;\n",
  "const tagged1 = tag`hi ${y} there`;\n",
  "const obj1 = { a: 1, b: { c: 2 } };\n",
  "const objInSub = `hi ${f({ a: 1 })} there`;\n",
  "const re1 = /x{/;\n",
  "const re2 = /x}/;\n",
  "const re3 = /\\{/;\n",
  "const re4 = /a{2}/;\n",
  "const re5 = /`/;\n",
  'const reInSub = `${/\\{/.test(s) ? "o" : "x"}`;\n',
  "const div1 = `${a / b}`;\n",
  "// a line comment with a { brace\n",
  "/* a block comment with a } brace */\n",
  'const str1 = "a string with { and } braces";\n',
  "",
];

const SEED = 20260902;
const ITERATIONS = 300;
const MAX_BLOCKS_PER_SIDE = 3;

function randomNoise(rand: () => number): string {
  const blockCount = Math.floor(rand() * (MAX_BLOCKS_PER_SIDE + 1));
  let noise = "";
  for (let i = 0; i < blockCount; i++) {
    noise += NOISE_BLOCKS[Math.floor(rand() * NOISE_BLOCKS.length)];
  }
  return noise;
}

function wrap(shape: Shape, rand: () => number): Shape {
  const leading = randomNoise(rand);
  const trailing = randomNoise(rand);
  return {
    name: shape.name,
    before: leading + shape.before + trailing,
    after: leading + shape.after + trailing,
  };
}

describe(
  "sameTokens fuzz: corruption embedded inside the ambiguous construct, seed "
    + SEED,
  () => {
    const rand = mulberry32(SEED);
    const acceptedCorruptions: string[] = [];
    const rejectedNeutrals: string[] = [];

    for (let i = 0; i < ITERATIONS; i++) {
      const corrupting = rand() < 0.5;
      const pool = corrupting ? CORRUPTING_SHAPES : NEUTRAL_SHAPES;
      const shape = wrap(pool[Math.floor(rand() * pool.length)], rand);
      const verdict = sameTokens(shape.before, shape.after, "standard");

      if (corrupting && verdict) {
        acceptedCorruptions.push(
          `iteration ${i} (${shape.name}): accepted a real corruption`,
        );
      }
      if (!corrupting && !verdict) {
        rejectedNeutrals.push(
          `iteration ${i} (${shape.name}): rejected a no-op change`,
        );
      }
    }

    it(`never accepts a corruption embedded in an ambiguous construct, across ${ITERATIONS} generated cases`, () => {
      expect(acceptedCorruptions).toEqual([]);
    });

    it(`never rejects the same constructs with no corruption, across ${ITERATIONS} generated cases`, () => {
      expect(rejectedNeutrals).toEqual([]);
    });
  },
);
