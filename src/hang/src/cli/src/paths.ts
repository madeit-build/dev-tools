import { realpath } from "node:fs/promises";
import { glob } from "tinyglobby";

/** True only if `candidate` resolves to `root` itself or something beneath it. */
export async function insideRoot(
  candidate: string,
  root: string,
): Promise<boolean> {
  try {
    const real = await realpath(candidate);
    return real === root || real.startsWith(`${root}/`);
  } catch {
    return false;
  }
}

export async function expand(
  patterns: string[],
  root: string,
): Promise<string[]> {
  const matches = await glob(patterns, {
    cwd: root,
    absolute: true,
    dot: false,
  });
  const safe: string[] = [];
  for (const match of matches) {
    if (await insideRoot(match, root)) safe.push(match);
    else
      process.stderr.write(
        `hang: refusing path outside the project root: ${match}\n`,
      );
  }
  return safe.sort();
}
