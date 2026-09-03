import { writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { buildGraph } from "./pipeline";
import { runDoctor } from "./doctor";
import { log } from "./log";

interface Args {
  flakeRef: string;
  out: string;
  doctor: boolean;
}

export function parseArgs(argv: string[]): Args {
  const positional = argv.filter((a) => !a.startsWith("--"));
  const flag = (name: string): string | undefined => {
    const at = argv.indexOf(`--${name}`);
    return at >= 0 ? argv[at + 1] : undefined;
  };
  const doctor = positional[0] === "doctor";
  return {
    doctor,
    flakeRef: (doctor ? positional[1] : positional[0]) ?? ".",
    out: flag("out") ?? "out",
  };
}

export async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);

  if (args.doctor) return runDoctor(args.flakeRef);

  try {
    const graph = await buildGraph(args.flakeRef);
    const dir = resolve(args.out);
    await mkdir(dir, { recursive: true });
    const path = resolve(dir, "graph.json");
    await writeFile(path, JSON.stringify(graph, null, 2));
    log("graph.written", {
      path,
      nodes: graph.nodes.length,
      edges: graph.edges.length,
      dropped: graph.ledger.length,
    });
    return 0;
  } catch (err) {
    log("run.failed", {
      detail: err instanceof Error ? err.message : String(err),
    });
    process.stderr.write(
      "\nRun 'orrery doctor' to check the most likely causes.\n",
    );
    return 1;
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
