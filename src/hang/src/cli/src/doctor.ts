import { hasScanner } from "@made-i-t/hang-prettier";
import * as prettier from "prettier";

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
  fix: string;
}

interface ResolvedConfig {
  plugins?: unknown[];
  printWidth?: number;
  hangWidth?: number;
  experimentalOperatorPosition?: string;
}

/**
 * Checks run in the order things are most likely to be wrong: prettier itself,
 * then the prettier version's feature surface, then this project's config, then
 * the runtime's own capability, then the two settings needed for a hang to fire.
 */
export async function collectChecks(root: string): Promise<Check[]> {
  const config = ((await prettier.resolveConfig(`${root}/index.ts`)) ??
    {}) as ResolvedConfig;
  const plugins = config.plugins ?? [];

  // Queried with no plugins so a broken plugin entry below can't also sink
  // this check: "operator position supported" is about the installed
  // prettier version's own surface, not about whether this project's
  // plugins resolve.
  const coreOptionNames = new Set(
    (await prettier.getSupportInfo()).options.map((option) => option.name),
  );

  // getSupportInfo throws "Cannot find package" when a configured plugin
  // isn't resolvable from this root - a failure this check reports rather
  // than lets crash the whole command. The message is trimmed at "imported
  // from" because Node's ERR_MODULE_NOT_FOUND appends an absolute path.
  let pluginError: string | null = null;
  let pluginOptionNames = new Set<string | undefined>();
  try {
    const support = await prettier.getSupportInfo({
      plugins: plugins as never[],
    });
    pluginOptionNames = new Set(support.options.map((option) => option.name));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    pluginError = message.split(" imported from ")[0] ?? message;
  }

  const printWidth = config.printWidth ?? 80;
  const hangWidth = config.hangWidth ?? printWidth + 20;

  return [
    {
      name: "prettier resolves",
      ok: typeof prettier.version === "string",
      detail: `version ${prettier.version}`,
      fix: "add prettier to the project's devDependencies",
    },
    {
      name: "operator position supported",
      ok: coreOptionNames.has("experimentalOperatorPosition"),
      detail: coreOptionNames.has("experimentalOperatorPosition")
        ? "option present"
        : "option absent",
      fix: "upgrade prettier: operator hanging needs experimentalOperatorPosition",
    },
    {
      name: "plugin loaded",
      ok: pluginError === null && pluginOptionNames.has("hangWidth"),
      detail:
        pluginError !== null
          ? `configured plugin(s) failed to resolve: ${pluginError}`
          : pluginOptionNames.has("hangWidth")
            ? "hangWidth is declared"
            : `resolved config lists ${plugins.length} plugin(s), none declaring hangWidth`,
      fix: 'add "@made-i-t/hang-prettier" to the "plugins" array in .prettierrc.json',
    },
    {
      name: "typescript scanner available",
      ok: hasScanner(),
      detail: hasScanner() ? "createScanner present" : "createScanner missing",
      fix: "pin typescript to ^5.8: version 7 removed the compiler API from its main entry",
    },
    {
      name: "operator position configured",
      ok: config.experimentalOperatorPosition === "start",
      detail: `experimentalOperatorPosition is ${config.experimentalOperatorPosition ?? "unset"}`,
      fix: 'set "experimentalOperatorPosition": "start" or operator lines will never hang',
    },
    {
      name: "hangWidth at least printWidth",
      ok: hangWidth >= printWidth,
      detail: `hangWidth ${hangWidth}, printWidth ${printWidth}`,
      fix: "raise hangWidth: a budget below printWidth skips every candidate",
    },
  ];
}

export function renderChecks(checks: readonly Check[]): string {
  const rows = checks.map((check) => {
    const head = `  ${check.ok ? "ok  " : "FAIL"}  ${check.name}: ${check.detail}`;
    return check.ok ? head : `${head}\n        try: ${check.fix}`;
  });
  return ["hang doctor", ...rows].join("\n");
}

export async function runDoctor(root: string): Promise<number> {
  const checks = await collectChecks(root);
  process.stdout.write(`${renderChecks(checks)}\n`);
  return checks.every((check) => check.ok) ? 0 : 1;
}
