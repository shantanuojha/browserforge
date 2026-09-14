// @ts-check
import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

/**
 * Clean Code thresholds (see docs/CODE-STANDARDS.md). Values are what the packages meet today;
 * tighten them, never loosen them. `severity` lets a package adopt the rules as warnings first
 * and flip to errors once it is refactored (every package is at `error` now).
 */
const cleanCodeRules = (severity) => ({
  complexity: [severity, 12],
  "max-depth": [severity, 3],
  "max-params": [severity, 4],
  "max-lines-per-function": [severity, { max: 65, skipBlankLines: true, skipComments: true }],
  "max-lines": [severity, { max: 300, skipBlankLines: true, skipComments: true }],
  "no-nested-ternary": severity,
  // Use the scoped logger from @browserforge/shared; raw console calls hide their origin.
  "no-console": severity,
});

/** JSX markup is line-hungry; components get more room but the same complexity budget. */
const componentRules = (severity) => ({
  "max-lines-per-function": [severity, { max: 120, skipBlankLines: true, skipComments: true }],
});

const TEST_FILES = ["**/*.test.{ts,tsx}", "**/testing/**", "**/test-utils.ts"];

export default tseslint.config(
  {
    ignores: ["**/node_modules/**", "**/.output/**", "**/.wxt/**", "**/dist/**", "**/coverage/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Plain JS: config files and repo scripts (scripts/*.mjs) run under Node.
    files: ["**/*.{js,mjs,cjs}"],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      globals: { ...globals.browser, ...globals.webextensions, ...globals.node },
    },
    plugins: { "react-hooks": reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // Remote code is a Chrome Web Store policy violation for MV3 extensions.
      "no-eval": "error",
      "no-implied-eval": "error",
      "no-new-func": "error",
    },
  },

  // ---- Clean Code thresholds: enforced everywhere -----------------------------------------------
  {
    files: ["packages/**/*.{ts,tsx}", "extensions/*/**/*.{ts,tsx}"],
    rules: cleanCodeRules("error"),
  },
  {
    files: ["packages/**/*.tsx", "extensions/*/**/*.tsx"],
    rules: componentRules("error"),
  },
  {
    // Library code declares its contract: exported functions carry explicit return types.
    files: [
      "packages/shared/src/**/*.ts",
      "packages/licensing/src/**/*.ts",
      "extensions/*/src/lib/**/*.ts",
    ],
    ignores: TEST_FILES,
    rules: { "@typescript-eslint/explicit-module-boundary-types": "error" },
  },

  // ---- Exemptions -------------------------------------------------------------------------------
  {
    // Test suites read top to bottom; `describe` blocks and scenario builders are long by design.
    files: TEST_FILES,
    rules: {
      "max-lines-per-function": "off",
      "max-lines": "off",
      "max-params": ["error", 5],
    },
  },
  {
    // The logger is the one place console is allowed; build scripts are CLI tools.
    files: ["packages/shared/src/logger.ts", "**/scripts/**/*.{mjs,js,ts}"],
    rules: { "no-console": "off" },
  },
);
