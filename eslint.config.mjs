// @ts-check
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/.next/**",
      "**/.astro/**",
      "**/out/**",
      "**/next-env.d.ts",
      "**/.turbo/**",
      "**/coverage/**",
      "**/node_modules/**",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/consistent-type-imports": "error",
    },
  },
  {
    // Build/tooling config files run in Node and may read `process.env`.
    files: ["**/*.config.{js,cjs,mjs}"],
    languageOptions: { globals: { process: "readonly" } },
  },
  {
    // Node-run scripts and standalone server bins (not bundled for the browser).
    files: ["**/server/**/*.{js,cjs,mjs}", "scripts/**/*.{js,cjs,mjs}"],
    languageOptions: {
      globals: {
        process: "readonly",
        console: "readonly",
        URL: "readonly",
        setTimeout: "readonly",
        setInterval: "readonly",
        clearTimeout: "readonly",
        clearInterval: "readonly",
        Buffer: "readonly",
      },
    },
  },
);
