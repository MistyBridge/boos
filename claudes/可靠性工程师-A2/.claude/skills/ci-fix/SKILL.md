---
name: genskills:ci-fix
description: >
  Diagnose and fix failing CI/CD pipeline issues. Analyzes build logs,
  test failures, and configuration problems. Triggers on: "fix CI", "CI failing",
  "pipeline broken", "build failed", "GitHub Actions failing".
user-invocable: true
argument-hint: "[run URL | run ID | 'latest']"
allowed-tools: "Read, Edit, Grep, Glob, Bash(gh run *), Bash(gh api *), Bash(gh workflow *), Bash(git log*), Bash(git diff*), Bash(git status*), Bash(npm *), Bash(npx *), Bash(yarn *), Bash(pnpm *), Bash(pytest *), Bash(python *), Bash(go *), Bash(make *), Bash(docker *)"
genskills-version: "1.5.0"
genskills-category: "workflow"
genskills-depends: []
---

# CI Fix

A senior engineer's playbook for turning a red pipeline green - by reproducing the failure locally, reading the log the way the runner actually executed it, and fixing the root cause instead of muting the symptom.

## Core Principles

Before you touch a workflow file, internalize these:

1. **Reproduce locally before you fix.** A CI failure you cannot reproduce on your machine is a guess. Recreate the runner's environment (versions, env vars, clean checkout) and run the exact failing command. A fix that only "passes CI" on retry is not a fix.
2. **Read the log bottom-up.** The first error line in a long log is rarely the real cause - it is often a downstream cascade. Start at the failing step's exit, find the first non-zero exit code, then walk upward to the originating error.
3. **Distinguish flaky from real.** Before fixing "the test," check whether the same commit passes on rerun. A test that fails non-deterministically is a flakiness bug (race, ordering, network, time) - retrying it hides the defect. A test that fails every time on this commit is a real regression.
4. **Fix the root cause, not the symptom.** Bumping a timeout, adding `continue-on-error`, pinning to an old runner, or retrying a flaky test are symptom patches. Find why the step failed - then the patch becomes unnecessary.
5. **CI is just a clean machine.** Most "works on my machine" failures are environment drift: a globally installed tool, a stale local cache, an uncommitted file, or an env var set in your shell. The runner has none of that. Treat divergence from a clean checkout as the prime suspect.
6. **Change one thing, then re-run.** CI round-trips are slow. Resist shotgun-debugging across five commits. Form one hypothesis, make the minimal change, verify locally, then push.

---

## Process

### Step 0: Load Project Context

- Check for `CLAUDE.md` at the project root - it may document CI quirks, required secrets, or known-flaky suites.
- Check `${CLAUDE_SKILL_DIR}/_config.json` for user preferences (see [Configuration](#configuration)).
- Identify the CI provider by config file:
  - **GitHub Actions**: `.github/workflows/*.yml`
  - **GitLab CI**: `.gitlab-ci.yml`
  - **CircleCI**: `.circleci/config.yml`
  - **Jenkins**: `Jenkinsfile`
  - **Bitbucket**: `bitbucket-pipelines.yml`
  - **Azure Pipelines**: `azure-pipelines.yml`
- Note the language/runtime and package manager - this determines reproduction commands.

### Step 1: Fetch the CI Logs

The goal is to get the *failed step's output* with as little noise as possible.

**GitHub Actions (via `gh` CLI):**
```bash
# Resolve which run to inspect
gh run list --limit 10                      # recent runs with status
gh run list --status failure --limit 5      # only failures
gh run list --branch "$(git branch --show-current)" --limit 5

# Drill into one run
gh run view <run-id>                        # job/step summary
gh run view <run-id> --log-failed           # ONLY the failed steps' logs
gh run view <run-id> --job <job-id> --log   # full log for one job
```

For artifacts (test reports, coverage, core dumps, screenshots):
```bash
gh run download <run-id>                    # all artifacts
gh run download <run-id> -n <artifact-name> # a specific artifact
```

For the raw failing annotations and conclusion via the API:
```bash
gh api repos/{owner}/{repo}/actions/runs/<run-id>/jobs --jq '.jobs[] | select(.conclusion=="failure") | {name, steps: [.steps[] | select(.conclusion=="failure") | .name]}'
```

- If `$ARGUMENTS` contains a run URL or ID, fetch that run directly.
- If `$ARGUMENTS` is `"latest"` or empty, take the most recent failed run on the current branch.

**Other providers** (when `gh` does not apply):
- **GitLab**: `glab ci view`, `glab ci trace <job-id>`, or download from the pipeline's job page.
- **CircleCI**: `circleci` CLI or the run's "Steps" tab; the API exposes step output JSON.
- **Jenkins**: the job's "Console Output" page; `?start=0` for raw text.
- If no CLI is available, ask the user to paste the failing step's log tail.

### Step 2: Parse the Log

Read the failed step bottom-up and extract the structured facts:

1. **The failing command** - the exact line the runner ran (echoed by `set -x` or the step's `run:` block).
2. **The exit code** - non-zero. `Error: Process completed with exit code 1` is the boundary; the cause is above it.
3. **The first real error** - skip the cascade. A `npm ERR!` summary at the end points to a `node-gyp` failure 200 lines up; that is the real line.
4. **The job matrix cell** - if a matrix is used, note *which* cell failed (e.g. `node-18 / ubuntu` passes but `node-20 / windows` fails) - that contrast is the diagnosis.
5. **Timing** - did the step hang to a timeout, or fail fast? A timeout points to a different class than an immediate error.

**Template:** `templates/failure-triage.md`
A fill-in triage checklist that walks the log from exit code to root-cause hypothesis.

### Step 3: Classify the Failure

Match the parsed evidence to a failure class. Each class has a distinct fix strategy.

#### Dependency failures
- **Symptoms**: `npm ERR! ERESOLVE`, `Could not resolve dependency`, `package X not found`, `lockfile out of sync`, `node-gyp` build errors, `pip` resolution conflicts.
- **Causes**: lockfile not committed or out of date; a transitive dep published a breaking patch; peer-dependency conflict; private registry auth missing; native module needs a toolchain absent from the runner.
- **Fixes**: regenerate and commit the lockfile (`npm ci` requires `package-lock.json` to match `package.json`); pin the offending transitive dep via `overrides`/`resolutions`; ensure the registry token secret is present; install system build deps in a setup step. Prefer `npm ci` / `pip install --require-hashes` in CI for reproducibility.

#### Cache corruption / cache misses
- **Symptoms**: passes on a fresh runner but fails after a cache restore; stale build artifacts; `actions/cache` restoring a key from a different lockfile.
- **Causes**: cache key not keyed on the lockfile hash; partial cache from a cancelled run; OS/arch mismatch in the cache key.
- **Fixes**: key the cache on `hashFiles('**/package-lock.json')` (or equivalent) plus OS and runtime version; bump a cache-version suffix to invalidate; never cache build *output* that should be regenerated.

#### Environment / configuration
- **Symptoms**: `command not found`, wrong language version, missing env var/secret, `undefined` config, `permission denied`.
- **Causes**: runtime version differs from local (`.nvmrc` ignored, `setup-node` pinned to old); a required secret not set in repo/org settings; env var set in your local shell but not in CI; expired token.
- **Fixes**: pin the runtime explicitly (`actions/setup-node` `node-version-file: .nvmrc`); add the missing secret and reference it via `${{ secrets.NAME }}`; document required secrets in `CLAUDE.md`; never `echo` a secret to the log.

#### Flaky tests
- **Symptoms**: same commit passes on rerun; failures cluster around timing, ordering, network, randomness, or shared state.
- **Causes**: race conditions, unawaited promises, fixed `sleep` instead of polling, test-order dependence, real network calls, non-seeded randomness, timezone/locale assumptions, leaked global state between tests.
- **Fixes**: fix the underlying nondeterminism - poll/await instead of sleeping, mock network/clock, isolate fixtures, seed RNG. **Do not** add blanket retries; they mask the bug. If you must quarantine, mark the single test and file a follow-up, do not disable the suite.

#### Out of memory (OOM)
- **Symptoms**: `JavaScript heap out of memory`, `Killed` with exit 137, `OOMKilled`, runner terminates mid-step.
- **Causes**: test runner spawning too many workers; large in-memory fixtures; a genuine leak; bundler holding the whole module graph.
- **Fixes**: cap parallelism (Jest `--maxWorkers=2`, pytest `-n 2`); raise `NODE_OPTIONS=--max-old-space-size=4096` only after confirming it is not a leak; split the job; use a larger runner as a last resort.

#### Timeouts / hangs
- **Symptoms**: step runs to the job `timeout-minutes` and is cancelled; no error, just a kill.
- **Causes**: a test awaiting a connection that never resolves; an open handle keeping the process alive; an interactive prompt waiting on stdin; a watch-mode command that never exits.
- **Fixes**: run test commands in CI mode (`CI=true`, `--watchAll=false`, `--ci`); add `--forceExit`/`--detectOpenHandles` to find the leaked handle; set realistic per-job `timeout-minutes`; ensure servers are health-checked, not slept on.

#### Build / compile errors
- **Symptoms**: `tsc` errors, webpack/vite/esbuild failures, missing files, syntax errors only on CI.
- **Causes**: a file not committed (case-sensitive path works on macOS, fails on Linux); a type error suppressed locally by an editor but not by `tsc --noEmit`; a generated file expected but not generated in CI.
- **Fixes**: commit the missing file; reproduce with `tsc --noEmit`; add the codegen step to the workflow; check filename casing (`git config core.ignorecase`).

#### Matrix-specific failures
- **Symptoms**: one matrix cell red, the rest green.
- **Diagnosis**: the contrast *is* the answer - OS path separators, line endings (`.gitattributes`/`core.autocrlf`), runtime version behavior change, arch-specific binaries.
- **Fixes**: normalize the divergent axis; conditionally skip or `include`/`exclude` cells with a documented reason; never delete the whole matrix to hide one cell.

#### Permissions / auth
- **Symptoms**: `403`, `Resource not accessible by integration`, push/deploy rejected, package publish denied.
- **Causes**: `GITHUB_TOKEN` lacks a scope; `permissions:` block too narrow; protected-branch rules; expired deploy key or PAT.
- **Fixes**: grant the minimal `permissions:` the job needs; rotate the expired credential; for cross-repo or fork PRs, understand that secrets are intentionally unavailable.

### Step 4: Reproduce Locally

This is the step most people skip and most regret skipping.

- Recreate the environment the runner used:
  - Same runtime version (read it from the workflow's `setup-*` step, not your local default).
  - Same install command - `npm ci`, not `npm install`; `pip install -r requirements.txt`, etc.
  - A **clean checkout** or at least `git status` clean - uncommitted files are a classic culprit.
  - Same env vars (`CI=true` flips many tools into non-interactive mode).
- Run the *exact* failing command from the log, not your usual local shortcut.
- For provider-faithful reproduction, run the job in a container matching the runner image, or use a local runner (`act` for GitHub Actions, `gitlab-runner exec` for GitLab) when the failure resists reproduction.
- If it reproduces locally, you are most of the way to a fix. If it does not, the cause is environmental - diff your environment against the runner's.

**Template:** `templates/local-repro.sh`
A scaffold that pins the runtime, does a clean install, exports `CI=true`, and runs the failing command the way the runner does.

### Step 5: Fix

- Apply the **minimal** change that addresses the classified root cause.
- **Real test failure**: fix the code, not the test - unless the test's expectation is genuinely wrong, in which case fix the assertion and explain why.
- **Flaky test**: fix the nondeterminism (await/mock/seed/isolate). Do not add retries.
- **Config/workflow issue**: edit the workflow file; add a comment explaining the change so the next person understands it.
- **Dependency issue**: update and commit the lockfile; pin the offender narrowly.
- **Env/secret issue**: you cannot set a secret from here - document exactly which secret/var is missing and where to add it.
- Do not refactor unrelated code while fixing CI. One concern per change.

### Step 6: Verify Locally

- Re-run the exact failing command - it must now pass.
- Run the adjacent gates so your fix does not turn a different step red:
  ```bash
  npm run build && npm test && npm run lint
  ```
  (or the project's equivalent: `make ci`, `tox`, `go build ./... && go test ./...`).
- For flaky fixes, run the affected test in a loop to build confidence it is actually stable:
  ```bash
  for i in $(seq 1 20); do npm test -- <test-path> || break; done
  ```

### Step 7: Report and Push

**Template:** `templates/ci-fix-report.md`
Structured report covering the run, failure class, root cause, fix, local verification, and follow-up.

After pushing, watch the run reach green before declaring victory:
```bash
gh run watch                 # follow the triggered run live
gh run view --log-failed     # if it fails again, re-enter at Step 2
```

---

## Common Fixes Cheat Sheet

**Template:** `templates/common-fixes.md`
A scannable lookup table mapping log signatures to the fastest correct fix per provider.

A few high-frequency ones, inline:

| Signature | Likely cause | Fix |
| --- | --- | --- |
| `npm ERR! ERESOLVE` | peer-dep conflict | `overrides` in `package.json`, regenerate lockfile |
| exit code `137` / `OOMKilled` | out of memory | cap workers; raise heap only if not a leak |
| step hits `timeout-minutes` | hang / open handle | `--ci --watchAll=false`, `--detectOpenHandles` |
| passes on rerun | flaky | fix the race/ordering, do not retry |
| green on Linux, red on Windows | path/EOL | normalize paths, set `.gitattributes` |
| `Resource not accessible by integration` | token scope | widen `permissions:` minimally |
| fails only after cache restore | stale cache | key cache on lockfile hash; bump cache version |

---

## Provider Notes

**GitHub Actions**
- `gh run view --log-failed` is the fastest path to signal. Annotations surface as job-level errors.
- Reusable workflows and composite actions hide steps - follow `uses:` to the called workflow to read its `run:` blocks.
- Fork PRs run without secrets by design; a "works on push, fails on PR" pattern often means a secret-gated step.
- Concurrency cancellations show as `cancelled`, not `failure` - do not chase a cancel as if it were an error.

**GitLab CI**
- `.gitlab-ci.yml` stages run sequentially; a failure in an early stage skips later ones - read the first failed stage.
- `rules:`/`only:`/`except:` decide whether a job even runs; an "expected" job that did not run is usually a rule, not a failure.
- Reproduce a single job locally with `gitlab-runner exec docker <job-name>`.

**CircleCI**
- Config is `.circleci/config.yml`; orbs expand into steps - inspect the orb if a step is opaque.
- Workspace/`persist_to_workspace` mismatches cause "file not found" in later jobs - verify what was persisted.
- `circleci config validate` catches schema errors before pushing.

For deeper investigation of an actual test or code defect surfaced by CI, hand off to `/genskills:debug`. For lint-only failures, `/genskills:lint-fix` is faster. For type errors, `/genskills:type-check`.

---

## Configuration

Check `${CLAUDE_SKILL_DIR}/_config.json` for user preferences (file is optional; defaults apply when absent or partial):

- `ciProvider`: `"github" | "gitlab" | "circleci" | "jenkins" | "auto"` - override auto-detected provider (default: `"auto"`).
- `verifyLocally`: boolean - reproduce and verify the failing command locally before pushing (default: `true`).
- `localRunner`: boolean - use a local runner (`act` / `gitlab-runner exec`) for provider-faithful reproduction when available (default: `false`).
- `autoCommit`: boolean - commit the fix automatically after local verification passes (default: `false`).
- `retryFlaky`: boolean - permit adding a bounded retry as a *temporary* quarantine when a flaky root cause cannot be fixed immediately; always files a follow-up note (default: `false`).
- `flakyRerunCount`: number - how many local loops to run when confirming a flaky fix is stable (default: `20`).
- `maxLogLines`: number - tail length to parse when a full log is fetched, to stay focused on the failing region (default: `500`).
- `verbosity`: `"minimal" | "detailed"` - how much of the analysis to include in the report (default: `"detailed"`).
