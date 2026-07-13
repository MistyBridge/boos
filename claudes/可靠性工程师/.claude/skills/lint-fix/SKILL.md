---
name: genskills:lint-fix
description: >
  Detect and auto-fix linting issues across your codebase using ESLint, Prettier,
  Biome, Ruff, or other configured linters. Triggers on: "fix lint", "lint fix",
  "format code", "fix formatting", "fix style issues".
user-invocable: true
argument-hint: "[file or directory] [--staged] [--check-only]"
allowed-tools: "Read, Edit, Grep, Glob, Bash(npx eslint*), Bash(npx prettier*), Bash(npx biome*), Bash(npx oxlint*), Bash(npm run*), Bash(pnpm *), Bash(yarn *), Bash(ruff*), Bash(black*), Bash(isort*), Bash(flake8*), Bash(cargo fmt*), Bash(cargo clippy*), Bash(gofmt*), Bash(goimports*), Bash(golangci-lint*), Bash(rubocop*), Bash(git diff*), Bash(pre-commit*)"
genskills-version: "1.5.0"
genskills-category: "code-quality"
genskills-depends: []
---

# Lint Fix

Detect and auto-fix linting and formatting issues across a polyglot codebase - resolving what is safe automatically, fixing root causes by hand, and never papering over violations with blanket rule disables.

## Core Principles

Before running anything, internalize these:

1. **Auto-fix only what is provably safe.** A safe fix preserves behavior (whitespace, import ordering, quote style). An unsafe fix can change runtime semantics (removing a "useless" condition, rewriting an expression). Apply safe fixes freely; apply unsafe fixes only after reading the change.
2. **Fix the root, never suppress.** A `// eslint-disable-next-line` or `# noqa` hides the symptom and rots over time. Suppress only when the rule is genuinely wrong for that exact line, and say why in a comment.
3. **Never mass-disable rules to make the build pass.** Disabling a rule project-wide to clear violations trades a visible problem for an invisible one. If a rule is consistently wrong for this codebase, surface it for the user to decide - don't silently edit the config.
4. **Linting and formatting are separate concerns.** A linter finds bugs and bad patterns; a formatter enforces a canonical style. Keep them from fighting - the formatter's output is authoritative for style, and the linter must defer (e.g. `eslint-config-prettier`).
5. **Respect the configured tool and its config.** Detect what the project already uses. Do not introduce a new linter, change `printWidth`, or "improve" the config as a side effect of a fix.
6. **Verify clean after fixing.** Re-run every tool in check mode (no `--fix`). A fix that leaves new violations isn't done.

---

## Process

### Step 0: Load Project Context
- Check for `CLAUDE.md` at the project root - follow any linting conventions documented there
- Check `${CLAUDE_SKILL_DIR}/_config.json` for user preferences (see Configuration below)
- Check `package.json` for custom lint scripts (`lint`, `lint:fix`, `format`, `check`) and the package manager (`packageManager` field, or lockfile: `package-lock.json` -> npm, `pnpm-lock.yaml` -> pnpm, `yarn.lock` -> yarn)
- Note any pre-commit framework (`.pre-commit-config.yaml`, Husky `.husky/`, `lint-staged` config) - the project may expect linting to run through it

### Step 1: Detect the Configured Linter

Do not guess. Detect by config-file presence, then confirm the tool is installed. The detection order below is the priority order when multiple are present.

**JavaScript/TypeScript:**

| Tool | Config Files | Command |
|---|---|---|
| **Biome** | `biome.json`, `biome.jsonc` | `npx biome check --write` |
| **ESLint** | `eslint.config.*` (flat), `.eslintrc.*` (legacy) | `npx eslint --fix` |
| **Prettier** | `.prettierrc*`, `prettier` in package.json | `npx prettier --write` |
| **oxlint** | `.oxlintrc.json` | `npx oxlint --fix` |
| **deno lint** | `deno.json` | `deno lint --fix` |

Detecting ESLint config flavor matters: **flat config** (`eslint.config.js|mjs|cjs|ts`) is the v9 default and uses an exported array of config objects with `ignores`/`files` globs. **Legacy config** (`.eslintrc.{js,json,yml}` + `.eslintignore`) is read by older ESLint or via `ESLINT_USE_FLAT_CONFIG=false`. Read the file to confirm which you're dealing with before editing it.
**Template:** `templates/eslint.config.js`
Annotated ESLint v9 flat config for TypeScript, with the Prettier-conflict guard ordered last.

Prettier is format-only - it has no rules to "violate," only a canonical style. `--write` reformats; `--check` reports drift without writing.
**Template:** `templates/.prettierrc.json`
Sensible Prettier defaults with markdown/JSON overrides.

Biome is a single fast tool that both lints and formats. `biome check --write` applies safe fixes + formatting; add `--unsafe` to opt into unsafe fixes (review them).

**Python:**

| Tool | Config | Command |
|---|---|---|
| **Ruff** | `ruff.toml`, `.ruff.toml`, `[tool.ruff]` in pyproject.toml | `ruff check --fix && ruff format` |
| **Black** | `[tool.black]` in pyproject.toml | `black .` |
| **isort** | `[tool.isort]` in pyproject.toml | `isort .` |
| **flake8** | `.flake8`, `[tool.flake8]`, `setup.cfg` | `flake8` (report-only, no auto-fix) |
| **mypy** | `mypy.ini`, `[tool.mypy]` | defer to `/genskills:type-check` |

Ruff is the modern default and subsumes flake8, isort, and pyupgrade. `ruff check --fix` applies safe fixes; `ruff check --fix --unsafe-fixes` adds unsafe ones (e.g. removing unused imports that might be re-exports). `ruff format` replaces Black. If both Ruff and Black/isort are configured, prefer Ruff and note the redundancy.
**Template:** `templates/ruff.toml`
Ruff config selecting common rule families, with `unfixable` guarding unused-import deletion.

**Rust:**
- `rustfmt.toml` / `.rustfmt.toml` -> `cargo fmt` (formatting; safe)
- clippy -> `cargo clippy --fix` (applies machine-applicable lints; needs a clean working tree or `--allow-dirty`). Clippy lint levels: `allow` < `warn` < `deny` < `forbid` - don't downgrade levels to clear warnings.

**Go:**
- `gofmt -w .` or `goimports -w .` (goimports also fixes import grouping) - formatting; safe
- `golangci-lint run --fix` - meta-linter; only some sub-linters support `--fix`. Config in `.golangci.yml`.

**Ruby:**
- `.rubocop.yml` -> `rubocop -a` (safe autocorrect) or `rubocop -A` (includes unsafe autocorrect - review). RuboCop both lints and formats.

**Other:**
- `.editorconfig` -> baseline whitespace/charset rules that inform every formatter; respect it
- Prefer custom lint scripts in `package.json` over direct tool invocation (see Step 3)

### Step 2: Determine Scope
Parse `$ARGUMENTS`:
- First positional: file or directory to lint
- `--staged`: only lint staged files (`git diff --cached --name-only --diff-filter=ACMR`)
- `--check-only`: report issues without fixing (dry run - use `--check` / no `--fix`)
- `--changed`: lint files changed since last commit (`git diff --name-only HEAD`)

If no arguments, lint the full project. For large repos, **incremental fixing** (staged or changed files only) keeps diffs reviewable and avoids reformatting code you didn't touch - prefer it unless the user asked for a full sweep.

### Step 3: Run Linters
**Order matters - run in this sequence:**

1. **Linters with auto-fix first** (they fix logic/pattern issues that may move code around):
   - ESLint / Biome / oxlint / Ruff with `--fix`
   - Clippy with `--fix`, RuboCop with `-a`
2. **Formatters second** (their output is canonical for style; running them last cleans up after the linter):
   - Prettier / Biome format / Black / `ruff format`
   - `cargo fmt` / `gofmt` / `goimports`
3. **Import sorting** (only if separate from the linter):
   - isort (Python) - Ruff/ESLint usually handle this already; avoid double-sorting

**Prefer project scripts** so you match the team's exact flags:
```bash
npm run lint:fix    # or pnpm/yarn equivalent, or lint -- --fix
npm run format      # or prettier --write
```
Fall back to direct tool invocation only when no script exists.

**Safe vs. unsafe auto-fixes.** By default apply only safe fixes. Surface unsafe fixes rather than applying blindly:
- ESLint: `--fix` applies fixes; some plugins mark fixes as "suggestions" (not auto-applied). There is no global unsafe flag - review any fix that deletes code.
- Ruff: `--fix` = safe; `--unsafe-fixes` = behavior-changing. Read each unsafe change.
- Biome: `--write` = safe; `--unsafe` adds risky rewrites.
- Clippy: `--fix` applies only machine-applicable suggestions (already conservative).

Capture all output and distinguish: auto-fixed issues, formatting changes applied, and remaining issues needing manual work.

### Step 4: Fix Remaining Issues Manually
For issues auto-fix can't resolve:
- Read the flagged file and understand the rule violation before editing
- Apply the minimal manual fix that satisfies the rule's intent (the root cause), not the rule's letter
- Common manual fixes:
  - Unused imports/variables - remove only if truly unused (not dynamic access, re-exports, or side-effect imports)
  - Accessibility issues (eslint-plugin-jsx-a11y) - add the missing label/role, don't disable
  - Naming-convention violations - rename and update references
  - Complexity / max-lines warnings - extract functions; don't bump the threshold
  - Type-related lint issues - defer to `/genskills:type-check`

**Handling rule conflicts.** When two tools disagree (classically ESLint stylistic rules vs. Prettier):
- The formatter wins on style. Install/keep `eslint-config-prettier` **last** in the ESLint config so it turns off conflicting ESLint rules (see the flat-config template).
- For Ruff vs. Black/isort overlap, let Ruff own it and disable the redundant tool rather than running both.
- If a single rule fights the formatter and there's no config guard, report it - don't hand-edit code into a state the formatter will revert.

**Rules for suppressions:**
- Do NOT add `// eslint-disable` / `# noqa` / `# rubocop:disable` unless the rule is genuinely wrong for that line, and add a reason
- Do NOT disable rules project-wide to clear violations
- Preserve existing suppression comments - don't remove them without understanding why they exist
- If a rule is consistently wrong, note it in the report for the user to decide

### Step 5: Re-run and Verify
Run every tool again in check mode (no `--fix`) to confirm clean:
```bash
npx eslint .              # expect 0 errors
npx prettier --check .    # expect "All matched files use Prettier code style!"
ruff check . && ruff format --check .
```
If issues remain after manual fixes, report them with rule name and reason - do not loop indefinitely or start suppressing to force a clean exit.

### Step 6: Report

**Template:** `templates/lint-fix-report.md`
Structured report: tools detected, safe auto-fixes, formatting changes, manual fixes, skipped unsafe fixes, rule conflicts, remaining issues, and a metrics table.

---

## Pre-commit Integration

Linting is most valuable when it runs automatically, not just on demand. If the project uses a pre-commit framework, route fixes through it for consistency:

- **JS/TS - Husky + lint-staged:** `lint-staged` runs linters on staged files only. Confirm its config (in `package.json` or `.lintstagedrc`) and run `npx lint-staged` to mirror what the commit hook does.
- **Python/polyglot - `pre-commit`:** `.pre-commit-config.yaml` pins hook versions. `pre-commit run --all-files` applies every hook; `pre-commit run --files <paths>` scopes it. Match the pinned versions rather than the globally installed tool.
- When fixing for a commit, prefer `--staged` scope so the hook and this skill agree on what gets touched.
- Do not add or modify hook configuration unless the user asks - report the recommendation instead.

---

## Configuration
Check `${CLAUDE_SKILL_DIR}/_config.json` for user preferences (this skill reads the file; it does not create it):
- `preferScript`: boolean - prefer `npm run lint:fix` over direct tool invocation (default: true)
- `ignorePaths`: string[] - paths to skip
- `formatOnFix`: boolean - also run the formatter after linting (default: true)
- `stagedOnly`: boolean - default to only linting staged files (default: false)
- `maxWarnings`: number - fail if more than N warnings remain (default: unlimited)
- `applyUnsafeFixes`: boolean - apply unsafe/behavior-changing auto-fixes after review (default: false)
- `usePreCommit`: boolean - route fixes through the project's pre-commit framework when present (default: true)
