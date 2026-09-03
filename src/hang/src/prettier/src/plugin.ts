import { hangAlign } from "@made-i-t/hang-core";
import { builders, printer } from "prettier/doc";
import * as estree from "prettier/plugins/estree";
import { createAdapter } from "./adapter.js";

// Prettier's plugin surface (Printer, ParserOptions, AstPath, print) is not
// exported in a form usable here without a peer-dependency version pin. `any`
// keeps this plugin buildable against the declared `^3.5.0` peer range.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PrettierPrinter = any;

const base: PrettierPrinter = (estree as PrettierPrinter).printers.estree;

let lastFailure: string | null = null;

/** Holds only the most recent failure across every file formatted in this process, so a
 * multi-file consumer reading it after a batch can attribute one file's failure to another.
 * A consumer that needs per-file attribution needs a different mechanism than this hook. */
export const getLastFailure = (): string | null => lastFailure;

export const options = {
  ...(estree as PrettierPrinter).options,
  hangWidth: {
    type: "int",
    category: "Global",
    default: 100,
    description: "Maximum width a hung continuation line may reach before the hang is skipped.",
  },
};

export const languages = (estree as PrettierPrinter).languages;

export const printers = {
  estree: {
    ...base,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    print(path: any, opts: any, print: any, args: any) {
      const doc = base.print(path, opts, print, args);
      if (path.node?.type !== "Program") return doc;

      try {
        const rendered = printer.printDocToString(doc, opts).formatted;
        const { text } = hangAlign(rendered, createAdapter(opts.filepath), {
          printWidth: opts.printWidth,
          // Defensive fallback for a caller that bypasses Prettier's option normalization,
          // e.g. invoking printers.estree.print directly instead of through prettier.format.
          hangWidth: opts.hangWidth ?? opts.printWidth + 20,
          tabWidth: opts.tabWidth,
        });
        lastFailure = null;
        return builders.join(builders.literalline, text.split("\n"));
      } catch (error) {
        // Fail closed: stock Prettier output beats damaged source. The message
        // is recorded for `hang doctor`; the source itself is never logged.
        lastFailure = error instanceof Error ? error.message : String(error);
        process.stderr.write(`hang: fell back to Prettier output (${lastFailure})\n`);
        return doc;
      }
    },
  },
};
