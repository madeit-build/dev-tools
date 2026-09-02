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

// Absolute paths never belong in doctor's output: a Unix path (this repo's
// own targets) or a Windows drive path, greedily up to the next quote,
// paren, or whitespace. Applied to every message this file builds from
// prettier/Node error text or from a resolved (already-normalized) config,
// since resolveConfig itself rewrites a relative plugin specifier to an
// absolute path before any error is ever thrown - naming the specifier the
// user wrote is not enough on its own to avoid leaking one.
function redactPaths(text: string): string {
  return text
    .replace(/\/[^\s'")]+/g, "<path>")
    .replace(/[A-Za-z]:\\[^\s'")]+/g, "<path>");
}

// prettier.resolveConfig's JSON parse failure embeds both the config's
// absolute path and a verbatim source excerpt in its message. Only the
// position reference is safe to surface; everything else in the message is
// either a local path or the config's own source text, both forbidden.
function describeConfigError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const positionLine = message
    .split("\n")
    .find((line) => /\bat position \d+/.test(line));
  return redactPaths(positionLine?.trim() ?? "config could not be parsed");
}

function optionNames(support: prettier.SupportInfo): Set<string> {
  const names = support.options
    .map((option) => option.name)
    .filter((name): name is string => name !== undefined);
  return new Set(names);
}

// Names the plugins that failed to resolve without using Node's own error
// message, which for a relative specifier embeds two absolute paths (the
// resolved plugin path and the resolver's own location). Built from the
// resolved config instead - and still redacted, since resolveConfig already
// rewrites a relative "./plugin.js" entry to an absolute path.
function describePlugins(plugins: readonly unknown[]): string {
  if (plugins.length === 0) return "configured plugin(s)";
  const names = plugins.map((plugin) =>
    typeof plugin === "string" ? plugin : "<plugin>",
  );
  return redactPaths(names.join(", "));
}

/**
 * Checks run in the order things are most likely to be wrong: prettier itself,
 * then the prettier version's feature surface, then this project's config, then
 * the runtime's own capability, then the two settings needed for a hang to fire.
 */
export async function collectChecks(root: string): Promise<Check[]> {
  let config: ResolvedConfig;
  try {
    config = ((await prettier.resolveConfig(`${root}/index.ts`)) ??
      {}) as ResolvedConfig;
  } catch (error) {
    // Nothing past this point can run meaningfully without a parsed config,
    // so this is the whole report rather than one row alongside guesses.
    return [
      {
        name: "prettier config parses",
        ok: false,
        detail: describeConfigError(error),
        fix: "the project's prettier config is not valid JSON - check it for a stray comma, unmatched brace, or missing quote",
      },
    ];
  }
  const plugins = config.plugins ?? [];

  // Queried with no plugins so a broken plugin entry below can't also sink
  // this check: "operator position supported" is about the installed
  // prettier version's own surface, not about whether this project's
  // plugins resolve. Guarded the same as the plugin-scoped call below, for
  // the same reason: a thrown error here must become a failing check, not a
  // crash.
  let coreOptionNames = new Set<string>();
  try {
    coreOptionNames = optionNames(await prettier.getSupportInfo());
  } catch {
    coreOptionNames = new Set();
  }

  // getSupportInfo throws when a configured plugin isn't resolvable from
  // this root - a failure this check reports rather than lets crash the
  // whole command.
  let pluginError: string | null = null;
  let pluginOptionNames = new Set<string>();
  try {
    const support = await prettier.getSupportInfo({
      plugins: plugins as never[],
    });
    pluginOptionNames = optionNames(support);
  } catch {
    pluginError = `could not resolve: ${describePlugins(plugins)}`;
  }

  const printWidth = config.printWidth ?? 80;
  const hangWidth = config.hangWidth ?? printWidth + 20;

  return [
    {
      name: "prettier resolves",
      // Informational, not a working probe: prettier is a static import
      // above, so a genuinely missing package throws before collectChecks
      // ever runs and this row is reached. It exists to report the version.
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
          ? pluginError
          : pluginOptionNames.has("hangWidth")
            ? "hangWidth is declared"
            : `resolved config lists ${plugins.length} plugin(s), none declaring hangWidth`,
      fix:
        pluginError !== null
          ? "a configured plugin failed to resolve - reinstall it or check that it's linked into this workspace's node_modules"
          : 'add "@made-i-t/hang-prettier" to the "plugins" array in .prettierrc.json',
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
