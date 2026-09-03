import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["**/dist/**", "**/node_modules/**", "**/.turbo/**"],
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_" },
      ],
    },
  },
  {
    // hang-core is the one package in this monorepo with a hard "imports
    // nothing" contract (see src/hang/AGENTS.md): it takes text and an
    // injected Adapter and returns text plus a Decision[], with no
    // dependency on prettier, typescript, node:*, or any other workspace
    // package. The plan calls a violation here a design failure; this rule
    // is what actually checks that instead of relying on review to catch it.
    files: ["src/hang/src/core/src/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["prettier", "prettier/*", "typescript", "node:*", "@made-i-t/*"],
              message:
                "@made-i-t/hang-core imports nothing -- see src/hang/AGENTS.md.",
            },
          ],
        },
      ],
    },
  },
);
