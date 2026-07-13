---
name: genskills:code-review
description: >
  Perform comprehensive code reviews with security, performance, and best-practice analysis.
  Triggers on: "review this code", "code review", "check my code", "review PR", "review changes".
user-invocable: true
argument-hint: "[file or directory] [--mode quick|deep|security] [--pr <number>]"
allowed-tools: "Read, Edit, Grep, Glob, WebFetch, Bash(git diff*), Bash(git log*), Bash(git blame*), Bash(git show*), Bash(npm test*), Bash(npm run*), Bash(npx vitest*), Bash(npx jest*), Bash(gh pr*)"
genskills-version: "1.5.0"
genskills-category: "code-quality"
genskills-depends: []
---

# Code Review

A senior reviewer's playbook for a thorough, multi-dimensional code review - catching the bug that ships to production, the security hole that leaks data, and the abstraction that costs the team six months from now.

## Core Principles

Internalize these before you read a single line of the diff:

1. **Review the change, judge against the whole.** Read the diff to know what changed, but read the surrounding code to know whether it's correct. A line that looks fine in isolation can be wrong in context.
2. **Severity is about impact, not taste.** A finding's level reflects what breaks if it ships - not how much you dislike the style. State the failure mode, not the rule.
3. **Every finding is actionable.** "This is bad" is noise. "This is bad, here's why it matters, here's the fix" is a review. Anchor each item to `file:line`.
4. **Defer to the tools for what tools can see.** Formatting, import order, and lint rules belong to linters and formatters. Spend human attention on logic, security, and design - the things automation misses.
5. **Praise is part of the job.** Reinforcing good patterns scales quality across a team faster than catching bad ones. Call out what was done well.
6. **Calibrate confidence and say so.** Distinguish "I traced this and it's broken" from "this pattern often hides a bug." Labeling uncertainty earns trust and helps the author triage.

---

## Review Process

### Step 0: Load Project Context
- Check for `CLAUDE.md` at the project root - it contains project conventions, patterns, and rules you MUST follow. Treat its rules as Critical-level if violated.
- Check `${CLAUDE_SKILL_DIR}/_config.json` for user preferences (see Configuration below)
- Identify the tech stack from `package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, or equivalent - this dictates which dimensions matter most and which tools to run
- Note the test runner, linter, and CI configuration so your findings align with what the pipeline will enforce

### Step 1: Parse Arguments & Gather Context
Parse `$ARGUMENTS`:
- First positional: file or directory to review
- `--mode`: "quick" (surface-level, diff-only) | "deep" (thorough, read full files + history) | "security" (security-focused, threat-model the change)
- `--pr <number>`: review a specific PR via `gh pr diff <number>`
- `--staged`: review only staged changes
- `--since <ref>`: review changes since a git ref (commit, tag, branch)

**Gathering changes:**
- If `--pr` specified: `gh pr diff <number>` and `gh pr view <number> --json title,body,files,reviews` - the title and body tell you the *intended* behavior to judge against
- If file/directory specified: focus review on that path
- If `--staged`: `git diff --cached`
- If `--since <ref>`: `git diff <ref>...HEAD`
- If nothing specified: `git diff HEAD~1` (latest commit changes)

**Always also:**
- Read the full files being reviewed (not just the diff) to understand surrounding context, invariants, and call sites
- Run `git log --oneline -5 -- <file>` to understand recent change history
- Use `git blame` on critical sections to understand authorship and the reasoning behind nearby code
- For a PR, scan existing review comments so you don't duplicate or contradict prior feedback

### Step 2: Analyze Code Quality
Check for issues across these dimensions. Match scrutiny to `--mode`: "quick" focuses on Correctness and Security; "deep" covers all dimensions; "security" threat-models every new input and trust boundary.

**Correctness:**
- Logic errors, edge cases, off-by-one errors
- Null/undefined handling, optional chaining misuse
- Race conditions in async code, promise handling
- Missing return statements, unreachable code
- Incorrect regex patterns, string handling edge cases
- Boundary inputs left unhandled: empty collections, zero, negative numbers, single-element lists, very large inputs
- Incorrect assumptions about ordering, idempotency, or retry behavior

**Security:**
- Injection vulnerabilities: SQL, XSS, command injection, template injection, path traversal
- Auth/authz issues: missing checks, IDOR, privilege escalation, missing checks on new entry points
- Data exposure: PII logging, verbose error messages, leaked secrets, overly broad API responses
- Hardcoded secrets, API keys, tokens (regex: `(?i)(api[_-]?key|secret|password|token)\s*[=:]\s*['"][^'"]+`)
- Unsafe deserialization, eval usage, prototype pollution
- Missing input validation/sanitization at trust boundaries
- New dependencies: reputable, pinned, and actually necessary?

**Performance:**
- N+1 queries, missing database indexes, per-iteration I/O hidden in loops
- Unnecessary iterations, O(n²) when O(n) is possible
- Memory leaks: unclosed connections, event listener accumulation, subscription cleanup, orphaned timers
- Missing request/response caching, unnecessary re-renders (React)
- Unintended synchronous blocking, unbounded data fetching
- Large payloads without pagination or streaming

**Maintainability:**
- Code complexity: cyclomatic complexity, deep nesting (>3 levels)
- Naming clarity: variable/function names that don't convey intent
- DRY violations: repeated patterns (3+ occurrences)
- Function length: >50 lines is a warning, >100 is critical
- Over-engineering: unnecessary abstractions, premature generalization, speculative generality
- Under-documentation: complex business logic without comments explaining the *why*
- Dead code, commented-out blocks, or stray debug logging left behind

**Error Handling:**
- Missing try/catch on async operations
- Unhandled promise rejections, missing `.catch()`
- Error propagation: swallowed errors, empty catch blocks, errors logged but not surfaced
- Missing error boundaries (React), error pages (Next.js/Remix)
- Generic error messages that hide root cause; errors that leak internals to the client

**Type Safety:**
- Type mismatches, unsafe `as` casts, `any` usage
- Missing null checks, non-null assertions (`!`) without validation
- API contract: request/response types matching actual data
- Generic type constraints too loose or missing
- Discriminated unions not exhaustively handled (missing `never` check)

**Concurrency:**
- Race conditions in shared state access
- Missing locks, atomic operations, or optimistic concurrency
- Deadlock potential in multi-resource locking
- Stale closure bugs in React useEffect/useCallback dependency arrays
- Read-modify-write sequences without isolation

**API & Contracts:**
- Breaking changes to public APIs without version bump
- Missing backward compatibility for consumers
- Request/response validation (zod, joi, class-validator)
- Missing or incorrect HTTP status codes
- Missing rate limiting on public endpoints
- Pagination, idempotency keys, and error envelope consistency

### Step 3: Check Project Patterns
- Read nearby files to understand existing patterns and conventions
- Cross-reference with `CLAUDE.md` rules if present - a documented rule is non-negotiable
- Flag deviations from established patterns (naming, imports, file structure, error handling style)
- Check for consistent import ordering, barrel exports, naming conventions
- Verify new dependencies are justified and align with project choices
- Confirm the change fits the architecture - new code in the right layer, no shortcuts across boundaries

### Step 4: Verify Test Coverage
- Check if changed code has corresponding tests
- Run relevant test suites to verify they pass: `npm test`, `npx vitest run`, or `npx jest`
- Flag changed logic that lacks test coverage
- Check for missing edge-case tests on new logic
- Verify that new error paths have test coverage
- Distinguish "tested" from "asserted meaningfully" - a test that exercises code without asserting on the outcome is not coverage

### Step 5: Classify Findings
Assign every finding exactly one severity level, stating the impact rather than the rule. Attach a confidence label to non-obvious findings.

**Template:** `templates/severity-rubric.md`
Severity definitions (Critical / Warning / Suggestion / Praise) with examples, tie-breakers, and confidence labeling.

| Level | Meaning | Action Required |
|---|---|---|
| **Critical** | Bug, security vulnerability, data loss risk | Must fix before merge |
| **Warning** | Performance issue, poor error handling, maintainability concern | Should fix |
| **Suggestion** | Code quality improvement, better pattern available | Nice to have |
| **Praise** | Well-written code, good patterns, clever solutions | Positive reinforcement |

For a methodical pre-flight sweep across all dimensions before writing up findings, work through the checklist:

**Template:** `templates/review-checklist.md`
Per-dimension reviewer checklist (correctness, security, performance, maintainability, types, tests, project fit).

### Step 6: Generate Report
Produce the review in the standard structure below.

**Template:** `templates/code-review-report.md`
Structured review report: critical issues, warnings, suggestions, praise, test coverage, and an overall verdict with confidence.

Keep the report tight: lead with what blocks the merge, anchor every item to `file:line`, and pair each problem with a fix. End with a clear verdict (✅ Approve / ⚠️ Request Changes / 💬 Needs Discussion), a confidence level, and the one-to-three risk areas a maintainer should double-check.

### Step 7: Offer Follow-up Actions
After the report, suggest relevant next steps:
- "Run `/genskills:test-generator` to add missing tests for uncovered code"
- "Run `/genskills:security-audit` for a deeper security analysis" (if security issues found)
- "Run `/genskills:refactor` on [file] to address complexity warnings"
- "Run `/genskills:type-check` to validate type safety" (if type issues found)
- "Run `/genskills:lint-fix` to clear style-level findings" (so the next review focuses on substance)

---

## Auto-Fix Mode

When `autoFix` is enabled (config) and a finding has a mechanical, unambiguous fix, apply it directly with the Edit tool rather than only describing it:
- Safe to auto-apply: adding a missing `await`, a null guard, a missing `.catch()`, removing dead code, tightening an obvious type
- Never auto-apply: anything that changes behavior in a non-obvious way, security-sensitive logic, or anything you flagged at low confidence
- Always note in the report which findings were auto-fixed vs. left for the author
- Re-run the test suite after auto-fixing to confirm nothing regressed

---

## Configuration
Check `${CLAUDE_SKILL_DIR}/_config.json` for user preferences:
- `defaultMode`: "quick" | "deep" | "security-focused" - review depth when `--mode` is not passed (default: "deep")
- `languages`: string[] - focus languages
- `ignorePaths`: string[] - paths to skip (e.g. generated code, vendored deps, lockfiles)
- `autoFix`: boolean - if true, apply simple mechanical fixes directly with the Edit tool (default: false)
- `maxFileLines`: number - skip files larger than N lines (default: 1000)
- `focusAreas`: string[] - prioritize specific review dimensions (e.g. ["security", "performance"])
- `runTests`: boolean - run the test suite as part of the review (default: true)
- `minSeverity`: "suggestion" | "warning" | "critical" - suppress findings below this level in the report (default: "suggestion")
