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
};
