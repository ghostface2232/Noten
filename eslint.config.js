import tseslint from "typescript-eslint";

// Narrow, project-specific guardrails. We deliberately do NOT enable broad
// recommended sets here — the goal is to lock in invariants that runtime tests
// cannot easily express, not to enforce style.

const RAW_WRITE_SELECTOR =
  "CallExpression[callee.type='MemberExpression'][callee.property.name='writeTextFile']";

const MTIME_BYPASS_SELECTORS = [
  // `something.mtime!` — non-null assertion
  {
    selector:
      "TSNonNullExpression > MemberExpression[property.name='mtime']",
    message:
      "Don't bypass the null check on FileStat.mtime; handle the unknown-mtime case explicitly. See reconcileFolder.ts for the canonical pattern.",
  },
  {
    selector:
      "TSNonNullExpression > MemberExpression[property.name='birthtime']",
    message:
      "Don't bypass the null check on FileStat.birthtime; handle the unknown case explicitly.",
  },
  // `something.mtime as Date` (and any other `as` cast)
  {
    selector:
      "TSAsExpression[expression.type='MemberExpression'][expression.property.name='mtime']",
    message:
      "Don't cast away the null on FileStat.mtime; handle the unknown-mtime case explicitly.",
  },
  {
    selector:
      "TSAsExpression[expression.type='MemberExpression'][expression.property.name='birthtime']",
    message:
      "Don't cast away the null on FileStat.birthtime; handle the unknown case explicitly.",
  },
];

export default tseslint.config(
  {
    ignores: ["dist/**", "src-tauri/**", "node_modules/**"],
  },
  {
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
      },
    },
    plugins: { "@typescript-eslint": tseslint.plugin },
    rules: {
      // Rule 2: forbid bypassing the FileStat.mtime/birthtime nullability.
      // Bare in-memory tests are exempt because their mock always returns a
      // concrete Date.
      "no-restricted-syntax": ["error", ...MTIME_BYPASS_SELECTORS],
    },
  },
  // Rule 1: durable writers must route through atomicWriteText, not raw
  // FileSystem.writeTextFile. Allowlist is explicit so adding a new durable
  // writer requires an obvious config edit (loud failure on regression).
  {
    files: [
      "src/utils/metadataIO.ts",
      "src/utils/groupsIO.ts",
      "src/utils/conflictFileDetector.ts",
    ],
    rules: {
      "no-restricted-syntax": [
        "error",
        ...MTIME_BYPASS_SELECTORS,
        {
          selector: RAW_WRITE_SELECTOR,
          message:
            "Durable writers must call atomicWriteText(fs, path, content), not fs.writeTextFile directly. Raw writes leave readers exposed to half-written files when AV/OneDrive interrupts the operation.",
        },
      ],
    },
  },
  // Tests intentionally bypass nullability (the mock guarantees concrete
  // values) and exercise the raw FileSystem surface directly.
  {
    files: ["src/**/*.test.ts", "src/**/*.test-utils.ts"],
    rules: {
      "no-restricted-syntax": "off",
    },
  },
);
