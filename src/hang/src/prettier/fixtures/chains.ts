export const CHAINS: Record<string, string> = {
  twoLinks:
    "const taken = regions.filter((region) => !region.growing).reduce((sum, region) => sum + regionRows(region, rowsOf), 0);\n",
  fiveLinks:
    "const a = source.stepOne(alpha).stepTwo(beta).stepThree(gamma).stepFour(delta).stepFive(epsilon);\n",
  generics:
    "const g = client.request<Shape>(url).then<Parsed>((r) => r.json(), onError).finish(zz);\n",
  computedHead:
    "const a = registry[key].filterOutEverythingUnwanted((x) => x.on).reduceToTotal((s, x) => s + x, 0);\n",
  spreadArgument:
    "const a = collection.filterOutEverythingUnwanted((x) => x.on).concatenateWith(...otherItems, tail);\n",
  nestedChainInArgument:
    "const a = outer.filterOutUnwanted((x) => inner.mapEachOne(x).reduceToTotal(sum, 0)).finalize(option);\n",
  insideFunction:
    "function f() {\n  const t = regions.filterOutTheGrowingOnes((r) => !r.growing).reduceToTotal((s, r) => s + r, 0);\n}\n",
  lineCommentBetweenLinks:
    "const c = things.filterOutDisabled((x) => x.on)\n  // drop the tiny ones\n  .reduceToTotal((s, x) => s + x, 0);\n",
  // Every other fixture's chain hangs off a VariableDeclarator. This one is a
  // bare ExpressionStatement, a different head shape for buildReplacement's
  // anchor arithmetic to get right.
  bareExpressionStatement:
    "emitter.registerHandler(onChangeCallback).withRetryPolicy(retryPolicyConfig).startListening();\n",

  // Every fixture above is a "." member chain. The oracle only ran with
  // experimentalOperatorPosition unset, so "&&", "??", and ternary
  // continuations -- half the tool's feature surface, including the design
  // spec's own second headline example -- never passed through the
  // independent differential check at all.
  andChain:
    'const ok = typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= MAX_VALUE_ALLOWED_HERE;\n',
  nullishChain:
    "const label = candidate.primaryLabel ?? candidate.secondaryLabel ?? candidate.fallbackLabel ?? DEFAULT_LABEL_VALUE_HERE;\n",
  // From docs/specs/2026-09-02-hang-design.md, "Join and shift": the ternary's
  // "?"/":" branches are members of the run, not hunk starters, and follow
  // the operands above them purely because join-and-shift moves the whole
  // run by one delta.
  ternaryFollowingOperatorRun:
    'total +=\n  typeof published === "number" && Number.isFinite(published) && published >= 0 && published <= MAX_ALLOWED_PUBLISHED_ROWS_HERE\n    ? Math.trunc(published)\n    : ASSUMED_PANE_ROWS;\n',
};
