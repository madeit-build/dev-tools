import { hasScanner, options as pluginOptions } from "@made-i-t/hang-prettier";
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
  useTabs?: boolean;
}

// Matches only a token that BEGINS a path - at the start of the string or
// right after whitespace, a quote, or a paren - never a "/" in the middle
// of a token. That distinction is load-bearing: a scoped package name like
// "@made-i-t/hang-prettier" has a slash in the middle and must survive
// intact, while an absolute path (POSIX, a Windows drive path, or a UNC
// share) starts a token and must be fully redacted. Applied to every
// message this file builds from prettier/Node error text or from a
// resolved (already-normalized) config, since resolveConfig itself
// rewrites a relative plugin specifier to an absolute path before any
// error is ever thrown - naming the specifier the user wrote is not enough
// on its own to avoid leaking one.
const POSIX_PATH = /(?<=^|[\s'"(])\/[^\s'")]+/g;
const WINDOWS_DRIVE_PATH = /(?<=^|[\s'"(])[A-Za-z]:\\[^\s'")]+/g;
const UNC_PATH = /(?<=^|[\s'"(])\\\\[^\s'")]+/g;

function redactPaths(text: string): string {
  return text.replace(POSIX_PATH, "<path>")
             .replace(WINDOWS_DRIVE_PATH, "<path>")
             .replace(UNC_PATH, "<path>");
}

// prettier.resolveConfig's JSON parse failure embeds both the config's
// absolute path and a verbatim source excerpt in its message. Only the
// position reference is safe to surface; everything else in the message is
// either a local path or the config's own source text, both forbidden.
function describeConfigError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const positionLine = message.split("\n")
                              .find((line) => /\bat position \d+/.test(line));
  return redactPaths(positionLine?.trim() ?? "config could not be parsed");
}

function optionNames(support: prettier.SupportInfo): Set<string> {
  const names = support.options.map((option) => option.name)
                               .filter((name): name is string => name !== undefined);
  return new Set(names);
}

// Names the plugins that failed to resolve without using Node's own error
// message, which for a relative specifier embeds two absolute paths (the
// resolved plugin path and the resolver's own location). Built from the
// resolved config instead - and still redacted, since resolveConfig already
// rewrites a relative "./plugin.js" entry to an absolute path. A package
// specifier (scoped or not) has no leading path token, so it passes through
// the redaction untouched.
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
 *
 * Three of the six checks below never read the parsed config at all
 * ("prettier resolves", "operator position supported", and "typescript
 * scanner available"). When the config fails to parse, those three still
 * run - only the three that genuinely need it are skipped - so a broken
 * .prettierrc.json doesn't hide an unrelated failure (like a missing
 * TypeScript scanner) behind an early return.
 */
export async function collectChecks(root: string): Promise<Check[]> {
  let config: ResolvedConfig = {};
  let configError: unknown = null;
  try {
    config = ((await prettier.resolveConfig(`${root}/index.ts`)) ?? {}) as ResolvedConfig;
  } catch (error) {
    configError = error;
  }
  const plugins = config.plugins ?? [];

  // Queried with no plugins so a broken plugin entry below can't also sink
  // this check: "operator position supported" is about the installed
  // prettier version's own surface, not about whether this project's
  // plugins resolve. Guarded the same as the plugin-scoped call below, for
  // the same reason: a thrown error here must become a failing check, not a
  // crash. Runs regardless of whether the config parsed, since it needs
  // none of it.
  let coreOptionNames = new Set<string>();
  try {
    coreOptionNames = optionNames(await prettier.getSupportInfo());
  } catch {
    coreOptionNames = new Set();
  }

  // getSupportInfo throws when a configured plugin isn't resolvable from
  // this root - a failure this check reports rather than lets crash the
  // whole command. Only attempted once the config itself parsed: with no
  // parsed config there is nothing meaningful to resolve plugins from, and
  // "plugin loaded" is skipped below anyway.
  let pluginError: string | null = null;
  let pluginOptionNames = new Set<string>();
  if (configError === null) {
    try {
      const support = await prettier.getSupportInfo({
        plugins: plugins as never[],
      });
      pluginOptionNames = optionNames(support);
    } catch {
      pluginError = `could not resolve: ${describePlugins(plugins)}`;
    }
  }

  const printWidth = config.printWidth ?? 80;
  // The plugin's declared option default is the one value Prettier's own
  // normalization actually fills in when hangWidth is unset (see plugin.ts).
  // Computing a fallback independently here used to drift from that -
  // printWidth + 20 looked plausible but was never what an unconfigured
  // project actually got at print time.
  const hangWidth = config.hangWidth ?? pluginOptions.hangWidth.default;

  const checkDefinitions: { needsConfig: boolean; check: Check }[] = [
    {
      needsConfig: false,
      check: {
        name: "prettier resolves",
        // Informational, not a working probe: prettier is a static import
        // above, so a genuinely missing package throws before collectChecks
        // ever runs and this row is reached. It exists to report the version.
        ok: typeof prettier.version === "string",
        detail: `version ${prettier.version}`,
        fix: "add prettier to the project's devDependencies",
      },
    },
    {
      needsConfig: false,
      check: {
        name: "operator position supported",
        ok: coreOptionNames.has("experimentalOperatorPosition"),
        detail: coreOptionNames.has("experimentalOperatorPosition")
          ? "option present"
          : "option absent",
        fix: "upgrade prettier: operator hanging needs experimentalOperatorPosition",
      },
    },
    {
      needsConfig: true,
      check: {
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
    },
    {
      needsConfig: false,
      check: {
        name: "typescript scanner available",
        ok: hasScanner(),
        detail: hasScanner()
          ? "createScanner present"
          : "createScanner missing",
        fix: "pin typescript to ^5.8: version 7 removed the compiler API from its main entry",
      },
    },
    {
      needsConfig: true,
      check: {
        name: "operator position configured",
        ok: config.experimentalOperatorPosition === "start",
        detail: `experimentalOperatorPosition is ${config.experimentalOperatorPosition ?? "unset"}`,
        fix: 'set "experimentalOperatorPosition": "start" or operator lines will never hang',
      },
    },
    {
      needsConfig: true,
      check: {
        name: "hangWidth at least printWidth",
        ok: hangWidth >= printWidth,
        detail: `hangWidth ${hangWidth}, printWidth ${printWidth}`,
        fix: "raise hangWidth: a budget below printWidth skips every candidate",
      },
    },
    {
      needsConfig: true,
      check: {
        name: "useTabs not set",
        // indentOf counts characters, not visual columns: a tab-indented
        // head and a space-indented continuation would misalign by
        // tabWidth - 1 per tab, so the engine refuses every candidate
        // outright ("use-tabs") rather than emit a misaligned hang.
        ok: config.useTabs !== true,
        detail:
          config.useTabs === true
            ? "useTabs is true: every candidate is refused"
            : "useTabs is unset or false",
        fix: 'set "useTabs": false, or accept that hang will refuse every candidate in this project',
      },
    },
  ];

  const checks: Check[] = [];
  if (configError !== null) {
    checks.push({
      name: "prettier config parses",
      ok: false,
      detail: describeConfigError(configError),
      fix: "the project's prettier config is not valid JSON - check it for a stray comma, unmatched brace, or missing quote",
    });
  }
  for (const definition of checkDefinitions) {
    if (definition.needsConfig && configError !== null) continue;
    checks.push(definition.check);
  }
  return checks;
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
