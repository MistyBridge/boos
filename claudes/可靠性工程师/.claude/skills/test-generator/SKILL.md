---
name: genskills:test-generator
description: >
  Generate comprehensive test suites for your code, supporting Jest, Vitest, pytest,
  and other frameworks. Triggers on: "generate tests", "write tests", "add tests",
  "create test", "test this".
user-invocable: true
argument-hint: "[file or function] [--framework jest|vitest|pytest|playwright] [--type unit|integration|e2e]"
allowed-tools: "Read, Write, Edit, Grep, Glob, Bash(npm test*), Bash(npm run*), Bash(npx vitest*), Bash(npx jest*), Bash(npx playwright*), Bash(npx stryker*), Bash(pytest*), Bash(python -m pytest*), Bash(cargo test*), Bash(go test*), Bash(mvn test*), Bash(./gradlew test*)"
genskills-version: "1.5.0"
genskills-category: "code-quality"
genskills-depends: []
---

# Test Generator

Generate comprehensive, well-structured, deterministic test suites that document behavior and catch regressions - across Jest, Vitest, pytest, Go testing, JUnit, and more.

## Core Principles

Internalize these before writing a single assertion:

1. **Test behavior, not implementation.** Assert on observable outcomes (return values, persisted records, rendered output, emitted events) - never on private internals. A test that breaks when you refactor without changing behavior is a liability, not an asset.
2. **Arrange-Act-Assert.** Every test has one setup, one action, and one logical assertion. More than one "Act" means you are testing more than one thing - split it.
3. **Deterministic and isolated.** A test must produce the same result every run, in any order, on any machine. Fake the clock, seed randomness, stub the network, reset state in teardown. No flakiness tolerated.
4. **Meaningful coverage over a coverage number.** 100% line coverage that never asserts anything proves nothing. Cover the branches, edge cases, and error paths that matter; justify what you deliberately leave uncovered.
5. **Fast and cheap to run.** Unit tests should run in milliseconds. Push slow dependencies (real DB, real network) up the pyramid to fewer integration/e2e tests. A suite developers won't run is a suite that doesn't protect them.
6. **One reason to fail.** When a test fails, its name and single focus should point straight at what broke. Vague mega-tests waste debugging time.

---

## Process

### Step 0: Load Project Context
- Check for `CLAUDE.md` at the project root - follow any testing conventions or patterns specified there
- Check `${CLAUDE_SKILL_DIR}/_config.json` for user preferences (framework overrides, coverage targets, etc.) - see Configuration below
- Find existing test files in the project to learn the established patterns (imports, structure, naming, mocking style, assertion library, fixture conventions)
- Identify the **test pyramid** posture: are most tests unit, or is the suite top-heavy with slow e2e tests? Generate at the lowest level that meaningfully exercises the behavior.

### Step 1: Parse Arguments & Analyze Target
Parse `$ARGUMENTS`:
- First positional: file or function to test
- `--framework`: override auto-detected framework - "jest" | "vitest" | "pytest" | "playwright" | "cypress" | "go" | "cargo" | "junit"
- `--type`: test type - "unit" | "integration" | "e2e" (default: "unit")
- `--coverage`: target coverage percentage (default: from config or 80%)
- `--changed`: generate tests for recently changed code (`git diff --name-only HEAD~1`)

**Analyze target code:**
- Read the file/function completely
- Identify: function signatures, input/output types, return types, side effects, thrown errors
- Map the dependency graph: imports, external service calls, database operations
- Identify pure functions (easy to test) vs. functions with side effects (need mocking)
- Enumerate every branch, guard clause, and early return - each is a path that needs coverage
- Check if tests already exist - augment rather than duplicate

**Template:** `templates/test-plan.md`
Fill out a behavior contract, dependency/mocking strategy, and an enumerated case checklist before writing code - especially for non-trivial targets.

### Step 2: Determine Test Framework
Check in order:
1. `--framework` argument (explicit override)
2. Existing test files - match their framework and patterns
3. Config files:

| Config | Framework |
|---|---|
| `vitest.config.*` | Vitest |
| `jest.config.*` or `jest` in package.json | Jest |
| `playwright.config.*` | Playwright |
| `cypress.config.*` | Cypress |
| `pytest.ini` or `[tool.pytest]` in pyproject.toml | pytest |
| `Cargo.toml` | cargo test |
| `*_test.go` files | go test |
| `pom.xml` / `build.gradle` | JUnit |

Also detect test utilities already in use:
- Assertion: expect (Jest/Vitest), assert (Node/pytest), should (Chai), testify (Go), AssertJ/Hamcrest (Java)
- DOM: @testing-library/react, @testing-library/vue, enzyme
- HTTP: supertest, nock, msw, httpx, responses
- Mocking: jest.mock, vi.mock, unittest.mock, pytest-mock, gomock, Mockito
- Factories: factory_boy, fishery, faker, faker.js

#### Framework Specifics

**Jest**
- Mock modules with `jest.mock('./mod')`; auto-mock vs. factory mock. `jest.fn()` for spies.
- `jest.useFakeTimers()` + `jest.advanceTimersByTime()` to control time deterministically.
- `beforeEach(() => jest.clearAllMocks())` for isolation; `afterEach(() => jest.restoreAllMocks())`.
- `--coverage` flag; configure thresholds in `coverageThreshold`. Run a single file: `npx jest path/to/file.test.ts`.

**Vitest**
- API-compatible with Jest; use `vi` instead of `jest` (`vi.fn`, `vi.mock`, `vi.useFakeTimers`).
- Import test functions explicitly: `import { describe, it, expect, vi } from 'vitest'` (or enable `globals: true`).
- `vi.mock` is hoisted; use `vi.hoisted()` for shared mock state. `--coverage` via `@vitest/coverage-v8`.
- Run a single file: `npx vitest run path/to/file.test.ts`.

**pytest**
- Plain `assert` (rich introspection), no special assertion methods needed.
- Fixtures via `@pytest.fixture` (scope: function/class/module/session); `conftest.py` for shared fixtures.
- `@pytest.mark.parametrize` for table-driven tests; `pytest.raises(Err, match=...)` for exceptions.
- Mock with `pytest-mock` (`mocker` fixture) or `unittest.mock.patch`. Async needs `pytest-asyncio`.
- Coverage via `pytest --cov=pkg --cov-report=term-missing`.

**Go testing**
- Table-driven tests are idiomatic: a slice of struct cases looped with `t.Run(tc.name, ...)` for subtests.
- `t.Helper()` in assertion helpers; `t.Cleanup()` for teardown; `t.Parallel()` for parallel cases.
- Interfaces enable mocking - define narrow interfaces and pass fakes. `go test -race ./...` always.
- Coverage: `go test -cover ./...` / `go test -coverprofile=cover.out && go tool cover -html=cover.out`.

**JUnit (Java)**
- JUnit 5: `@Test`, `@BeforeEach`/`@AfterEach`, `@ParameterizedTest` with `@ValueSource`/`@CsvSource`/`@MethodSource`.
- `assertThrows(Exception.class, () -> ...)`; AssertJ `assertThat(x).isEqualTo(y)` for fluent assertions.
- Mock with Mockito: `@Mock`, `when(...).thenReturn(...)`, `verify(...)`. Coverage via JaCoCo.

**Template:** `templates/jest-test-template.ts`
Ready-to-adapt Jest/Vitest skeleton with AAA structure, `it.each` tables, async cases, and boundary mocking.

**Template:** `templates/pytest-test-template.py`
pytest skeleton with fixtures, `parametrize`, `pytest.raises`, async, and `mocker`-based boundary mocking.

### Step 3: Choose Test Type & Mocking Strategy

#### Test Types
- **Unit**: one function/class in isolation; mock all external boundaries. Fast, numerous, the base of the pyramid.
- **Integration**: multiple real units together (service + real DB via test container, route + handler + repository). Mock only the truly external (third-party APIs). Fewer, slower.
- **e2e**: full system through the public interface (HTTP, browser via Playwright/Cypress). Slowest, fewest - reserve for critical user journeys.

#### Mocking Strategy
- **Mock at the boundary, not the internals.** Mock the HTTP client, DB driver, clock, filesystem, message queue - never internal pure helpers.
- **Stubs vs. mocks vs. spies**: stub returns canned data; spy records calls for verification; mock asserts on interactions. Use the lightest one that proves the behavior.
- **HTTP**: prefer `msw` (intercepts at network layer, framework-agnostic) over hand-mocking fetch; `nock` for Node; `responses`/`respx` for Python.
- **Time**: never `sleep`. Use fake timers (`jest.useFakeTimers`, `vi.useFakeTimers`, `freezegun` in Python, injectable clock in Go).
- **Randomness**: seed it or inject the RNG so output is reproducible.
- **Don't over-mock.** A test that mocks everything tests nothing but the mocks. If you mock the unit under test's core logic, delete the test.

### Step 4: Enumerate Test Cases
For each function/method, generate tests across categories:

**Happy Path** (at least 2 variations): normal expected inputs to expected outputs; different valid input shapes; common real-world usage.

**Edge Cases:**
- Empty inputs: `""`, `[]`, `{}`, `null`, `undefined`, `0`
- Boundary values: max/min int, off-by-one, empty string, single character
- Special characters, unicode, emoji/surrogate pairs, very long strings
- Large arrays/objects, deeply nested structures
- Concurrent calls, rapid successive calls

**Error Cases:** invalid inputs raise the expected error type AND message; rejected promises with correct error; network failures, timeouts; missing required fields, wrong types.

**Integration Points** (`--type integration`): DB CRUD, transactions, constraint violations; API success/error-status/timeout/network-failure; filesystem read/write/permissions/missing-files - using the project's existing mocking patterns.

**Async Behavior:** promise resolution and rejection; timeout handling; concurrent operations (`Promise.all`, races); event emitters; streaming data.

**State Transitions:** before/after states; React hooks state + effect cleanup; store/reducer mutations; transaction states.

**Component Tests** (React/Vue/Svelte): render with default and edge-case props; user interactions (click, type, submit); conditional rendering (loading/error/empty); accessibility (roles, labels, keyboard nav); snapshots only for stable UI.

#### Property-Based Testing
For functions with broad input domains (parsers, serializers, math, encoders), assert invariants over generated inputs instead of hand-picked examples:
- JS/TS: `fast-check` - `fc.assert(fc.property(fc.string(), (s) => decode(encode(s)) === s))`
- Python: `hypothesis` - `@given(st.lists(st.integers()))`
- Common invariants: round-trip (`decode(encode(x)) == x`), idempotence, commutativity, never-throws-on-valid-input, output always in range. Let the framework shrink failures to a minimal case.

#### Snapshot Testing
- Use for stable, serializable output (rendered component markup, generated config, normalized AST).
- **Normalize volatile values** (timestamps, UUIDs, hashes) before snapshotting, or the snapshot is non-deterministic.
- Review every snapshot diff intentionally - blindly running `--updateSnapshot` defeats the purpose. Avoid snapshots for frequently changing UI.

#### Edge-Case Enumeration Checklist
Walk each parameter through: zero / one / many; empty / full; smallest / largest; first / middle / last; valid / invalid / malformed; present / absent / null. Walk each branch: every `if`, `switch`, `&&`, ternary, and early return needs at least one test that takes each side.

### Step 5: Write Tests
**File placement:** follow the project's existing naming convention exactly (co-located `*.test.*`, `__tests__/`, `test/`, or `*_test.go`); match the import style of existing tests.

**Template:** `templates/aaa-skeleton.txt`
Framework-agnostic Arrange-Act-Assert reference with naming patterns and anti-patterns to avoid.

**Test structure:**
```
describe('ModuleName', () => {
  describe('functionName', () => {
    beforeEach(() => { /* arrange shared state */ });
    afterEach(() => { /* clean up side effects */ });

    it('should return X when given Y', () => { /* happy */ });
    it('should handle empty input gracefully', () => { /* edge */ });
    it('should throw TypeError when input is invalid', () => { /* error */ });
  });
});
```

**Rules:**
- Use `describe`/`it`/`test` (or table-driven subtests in Go) matching existing patterns
- Include setup/teardown for isolation; clean up side effects in `afterEach`/`afterAll`/`t.Cleanup`
- Test names describe **behavior**, not implementation ("should calculate total with tax", not "should call calculateTax")
- Use the project's existing assertion style (expect, assert, should, AssertJ)
- Mock at external boundaries only, never internal functions
- Each test independently runnable - no order dependence, no shared mutable state
- Use the project's test data factories/builders if present
- Prefer `toEqual` for objects, `toBe` for primitives, `toThrow` for errors
- One logical assertion per test where practical

### Step 6: Verify & Analyze Coverage
Run the generated tests:
```bash
npx vitest run <test-file>    # or npx jest <test-file> / pytest <test-file> / go test ./...
```

If any test fails, distinguish:
- **Test bug**: fix the test (wrong assertion, missing mock) and re-run
- **Code bug**: report to user (actual behavior doesn't match expected) - do not paper over it
- Iterate up to 3 times.

**Coverage analysis** - read the report critically:
```bash
npx vitest run --coverage          # or npx jest --coverage
pytest --cov=pkg --cov-report=term-missing
go test -coverprofile=cover.out ./... && go tool cover -func=cover.out
```
- Look at **branch** coverage, not just line coverage - uncovered branches are untested logic.
- For high-value code, consider **mutation testing** (`npx stryker run`, `mutmut`/`cosmic-ray` in Python) to verify the tests actually catch bugs, not just execute lines.

Report results: `Tests: 15 passed, 0 failed | Coverage: 87% statements, 82% branches`.

### Step 7: Report & Recommendations
```
## Test Generation Report

### Tests Created
- [test-file] N tests for [source-file]
  - N happy path | N edge cases | N error cases | N async | N integration

### Coverage
| Metric | Before | After |
|---|---|---|
| Statements | N% | N% |
| Branches | N% | N% |
| Functions | N% | N% |
| Lines | N% | N% |

### Verification
- All N tests passing
- No flaky tests detected (ran twice, stable)

### Uncovered Code
- [file:line-range] Complex conditional - needs manual test design
- [file:line-range] Error recovery path - requires specific mock setup

### Recommendations
- Add property-based tests for [function] (broad input domain)
- Add mutation testing (`npx stryker run`) to verify test quality
- Run `/genskills:code-review` to verify test quality and coverage
- Run `/genskills:debug` if a generated test surfaced a real code bug

### Follow-up
- Keep tests focused on behavior, not implementation
- If refactoring target code, run tests first to verify baseline
```

---

## Configuration
Check `${CLAUDE_SKILL_DIR}/_config.json` for user preferences (this skill reads it; do not create it):
- `framework`: string - override auto-detected framework
- `coverageTarget`: number - minimum coverage percentage to aim for (default: 80)
- `mockingStrategy`: "minimal" | "comprehensive" - how aggressively to mock external boundaries
- `testLocation`: "colocated" | "__tests__" | "test/" - where to place test files
- `includeSnapshots`: boolean - generate snapshot tests for components (default: false)
- `testNaming`: "should" | "it" | "descriptive" - test name style preference
- `testType`: "unit" | "integration" | "e2e" - default test type when not specified (default: "unit")
- `propertyBased`: boolean - generate property-based tests for pure functions with broad input domains (default: false)
- `mutationTesting`: boolean - suggest/run mutation testing to validate test quality (default: false)
