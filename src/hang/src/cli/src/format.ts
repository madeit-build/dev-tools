import * as hangPlugin from "@made-i-t/hang-prettier";
import * as prettier from "prettier";

type PluginEntry = string | URL | prettier.Plugin;

/**
 * The hang CLI always hangs, regardless of whether the project's own
 * .prettierrc.json lists the plugin. Without this, `--write` and `--explain`
 * can disagree on the same file: --explain always runs hangAlign directly,
 * but --write's prettier.format call only hangs if the plugin happens to be
 * configured, so an unconfigured project silently gets plain Prettier output
 * from --write while --explain claims a hang would have happened. Injected
 * as the live module object, not the "@made-i-t/hang-prettier" specifier, so
 * this works regardless of whether that package is resolvable from the
 * target project's node_modules.
 */
function withHangPlugin(
  plugins: readonly PluginEntry[] | undefined,
): PluginEntry[] {
  const configured = plugins ?? [];
  const alreadyPresent = configured.some(
    (entry) => entry === hangPlugin || entry === "@made-i-t/hang-prettier",
  );
  return alreadyPresent ? [...configured] : [...configured, hangPlugin];
}

export async function resolveFormatOptions(
  file: string,
): Promise<prettier.Options> {
  const config = await prettier.resolveConfig(file);
  return {
    ...config,
    filepath: file,
    plugins: withHangPlugin(config?.plugins),
  };
}
