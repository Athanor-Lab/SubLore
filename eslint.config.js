import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // .whisper/ is the whisper.cpp checkout and its build trees, which carry their own JS and
  // TypeScript. It is git-ignored; the linter has to be told separately. See BACKLOG.md M3.1.
  // Build output and local tooling. `.claude/worktrees/` holds agent worktrees, which are whole
  // copies of this repository: linting them finds every file twice and breaks the TypeScript
  // parser, which cannot pick a root among four candidates. The same list is in `.prettierignore`.
  { ignores: ["dist/", "target/", ".whisper/", ".claude/", ".omc/", "ci-logs/"] },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    // CONTRIBUTING §9: every word the user reads comes from `src/i18n/en.ts`. See BACKLOG.md N156.
    files: ["src/**/*.tsx"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "JSXText[value=/\\S/]",
          message: "User-facing text belongs in src/i18n/en.ts, not in the markup.",
        },
        {
          selector: "JSXAttribute[name.name=/^(aria-label|title|placeholder|alt)$/] > Literal",
          message: "A label the user reads belongs in src/i18n/en.ts, not in the attribute.",
        },
      ],
    },
  },
);
