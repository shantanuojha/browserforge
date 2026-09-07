// @ts-check
import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/.output/**",
      "**/.wxt/**",
      "**/dist/**",
      "**/coverage/**",
      "site/**/*.html",
    ],
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
);
