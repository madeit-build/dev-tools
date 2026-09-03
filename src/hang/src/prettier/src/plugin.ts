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

/** Test-only hook: holds only the most recent failure across every file formatted in this
 * process, so a test can assert on the fail-closed path without scraping stderr. Not consumed
 * by `doctor`, which never formats a file and so never populates this. A multi-file consumer
 * needing per-file attribution needs a different mechanism than this hook. */
export const getLastFailure = (): string | null => lastFailure;

export const options = {
  ...(estree as PrettierPrinter).options,
  hangWidth: {
    type: "int",
    category: "Global",
    default: 100,
    description:
      "Maximum width a hung continuation line may reach before the hang is skipped.",
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
        // Render at "lf" regardless of the caller's endOfLine: hangAlign and
        // the literalline join below both split on a bare "\n", and Prettier's
        // own outer printDocToString (the one that turns this whole Doc into
        // the final file, after this printer returns) is what actually stamps
        // opts.endOfLine onto every line break exactly once. Rendering CRLF
        // here too would leave a "\r" on each split piece that the outer pass
        // then adds its own "\r\n" after, doubling every hung line's ending.
        const rendered = printer.printDocToString(doc, {
          ...opts,
          endOfLine: "lf",
        }).formatted;
        const { text } = hangAlign(rendered, createAdapter(opts.filepath), {
          printWidth: opts.printWidth,
          // Falls back to the same literal this module declares as
          // options.hangWidth.default, for a caller that bypasses Prettier's
          // option normalization (e.g. invoking printers.estree.print
          // directly instead of through prettier.format). Through the normal
          // prettier.format path this is never reached: normalization has
          // already filled opts.hangWidth with that same default.
          hangWidth: opts.hangWidth ?? options.hangWidth.default,
          tabWidth: opts.tabWidth,
        });
        lastFailure = null;
        return builders.join(builders.literalline, text.split("\n"));
      } catch (error) {
        // Fail closed: stock Prettier output beats damaged source. The message
        // is recorded for `hang doctor`; the source itself is never logged.
        lastFailure = error instanceof Error ? error.message : String(error);
        process.stderr.write(
          `hang: fell back to Prettier output (${lastFailure})\n`,
        );
        return doc;
      }
    },
  },
};
