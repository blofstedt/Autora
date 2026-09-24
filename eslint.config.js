// Lint for bugs, not style: formatting is left to the author. Type-aware, so
// it can catch promises nobody awaits and hooks that read stale values.
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";

export default tseslint.config(
  { ignores: ["dist/", "node_modules/", "ui/", ".autora/", "recordings/"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      parserOptions: {
        // One per half of the app; see the comment in tsconfig.server.json.
        project: ["./tsconfig.json", "./tsconfig.server.json", "./tsconfig.test.json"],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": ["error", { checksVoidReturn: false }],
      "@typescript-eslint/await-thenable": "error",
      // Payloads from models, MCP servers and the browser arrive untyped.
      "@typescript-eslint/no-explicit-any": "off",
      // `catch {}` is how "best effort" is spelled here.
      "no-empty": ["error", { allowEmptyCatch: true }],
      // Stripping control characters out of text is on purpose.
      "no-control-regex": "off",
      // A zero-width space keeps `*/` in a comment from ending it.
      "no-irregular-whitespace": ["error", { skipComments: true }],
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" }],
    },
  },
  {
    files: ["src/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    languageOptions: { globals: globals.browser },
    rules: reactHooks.configs.recommended.rules,
  },
  {
    files: ["server.ts", "server/**/*.ts", "tests/**/*.{ts,mjs}", "*.config.{js,ts}"],
    languageOptions: { globals: globals.node },
  },
  {
    files: ["public/sw.js"],
    languageOptions: { globals: globals.serviceworker },
  },
);
