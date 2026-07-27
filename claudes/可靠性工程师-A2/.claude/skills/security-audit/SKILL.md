---
name: genskills:security-audit
description: >
  Perform a security audit of the codebase, checking for vulnerabilities,
  misconfigurations, and security anti-patterns. Triggers on: "security audit",
  "check security", "find vulnerabilities", "security scan".
user-invocable: true
argument-hint: "[file, directory, or 'full'] [--severity critical|high|medium|low] [--focus owasp|secrets|infra|supply-chain]"
allowed-tools: "Read, Grep, Glob, WebFetch, Bash(git log*), Bash(git diff*), Bash(git grep*), Bash(npm audit*), Bash(pnpm audit*), Bash(yarn audit*), Bash(pip-audit*), Bash(cargo audit*), Bash(npx *), Bash(semgrep *), Bash(gitleaks *), Bash(trivy *), Bash(docker *), Bash(gh *)"
genskills-version: "1.5.0"
genskills-category: "code-quality"
genskills-depends: []
---

# Security Audit

A senior application-security engineer's playbook for finding exploitable weaknesses before an attacker does - from a single hardcoded secret to systemic authorization gaps and supply-chain compromise.

## Core Principles

Internalize these before reporting anything. They shape both what you flag and how you fix it.

1. **Defense in depth.** Never rely on a single control. A WAF, input validation, parameterized queries, and least-privilege DB accounts are layers - the failure of one must not breach the system.
2. **Least privilege.** Every credential, process, container, token, and DB role should hold the minimum rights needed. Flag anything running as root, any wildcard scope, any over-broad IAM policy.
3. **Validate and encode at boundaries.** Untrusted data is validated on input and encoded on output, at every trust boundary. Validation deep in the call stack is too late; output encoding is contextual (HTML vs. attribute vs. JS vs. SQL).
4. **No security through obscurity.** A hidden endpoint, an obfuscated key, or an undocumented parameter is not a control. Assume the attacker has the source. Real security survives full disclosure.
5. **Fail securely and deny by default.** When a check errors or a guard is missing, the safe outcome is denial. An exception in an auth path must never fall through to "allowed".
6. **Ground every finding in a standard.** Map each issue to OWASP Top 10 and a CWE. This makes severity defensible, fixes searchable, and reports actionable - not opinion.

---

## Audit Process

### Step 0: Load Project Context
- Check for `CLAUDE.md` at the project root - follow any security policies, known exceptions, or accepted-risk notes documented there.
- Check `${CLAUDE_SKILL_DIR}/_config.json` for user preferences (see Configuration below).
- Identify the tech stack: languages, frameworks, databases, auth providers, cloud services, and how secrets are managed (env vars, vault, KMS).
- Note the trust boundaries: where does untrusted data enter (HTTP handlers, queues, file uploads, webhooks, CLI args)?

### Step 1: Parse Arguments & Scope
Parse `$ARGUMENTS`:
- First positional: file, directory, or "full" for entire project.
- `--severity`: minimum severity to report - "critical" | "high" | "medium" | "low" (default: "low").
- `--focus`: limit to an area - "owasp" | "secrets" | "infra" | "supply-chain" | "all" (default: "all").
- `--changed`: only audit recently changed files (`git diff --name-only HEAD~5`).

If no arguments, scan recently changed files by default. For a full audit, walk the OWASP checklist top to bottom.

**Template:** `templates/owasp-checklist.md`
A pass/finding/N-A checklist covering all OWASP Top 10 (2021) categories with their CWEs - work through it item by item during a full audit.

### Step 2: Check for OWASP Top 10 (2021)

Each category below lists what to look for plus concrete `grep`/`rg` patterns. Patterns are PCRE2 (`rg -nP`); tune for the stack. A pattern match is a *candidate*, not a confirmed finding - read the surrounding code.

**A01 - Broken Access Control** (CWE-284, 285, 639, 22)
- Missing authorization checks on route handlers / API endpoints (authn != authz).
- IDOR: direct object references without ownership/tenant validation.
- Privilege escalation: missing role/permission guards; client-supplied role fields.
- Path traversal: user input in file paths without sanitization.
- Overly permissive or credentialed CORS; missing CSRF on state-changing endpoints.
```bash
rg -nP "app\.(get|post|put|delete|patch)\(" --glob '!**/test*'   # enumerate routes, then verify each has a guard
rg -nP "(\.\./|path\.join\([^)]*req\.|os\.path\.join\([^)]*request)" # path traversal candidates
rg -nP "Access-Control-Allow-Origin['\"]?\s*[:,]\s*['\"]\*"        # wildcard CORS
```

**A02 - Cryptographic Failures** (CWE-327, 328, 759, 798)
- Weak hashing for passwords (MD5/SHA1) - should be bcrypt/scrypt/argon2.
- Hardcoded secrets, API keys, encryption keys in source.
- Plaintext storage of PII, passwords, or tokens.
- Missing HTTPS enforcement; insecure cookie flags; weak/`none` JWT algorithms.
```bash
rg -nP "\b(md5|sha1)\b\s*\(" --glob '!**/test*'                   # weak hashes
rg -nP "(createCipher\(|DES|RC4|ECB)"                             # legacy/weak ciphers & modes
rg -nP "algorithms?\s*[:=]\s*\[?['\"]none['\"]"                   # JWT alg:none
```

**A03 - Injection** (CWE-89, 79, 78, 90, 643, 917)
- SQL: string concatenation / template literals in queries (use parameterized queries).
- NoSQL: raw user objects in Mongo/Firestore queries (operator injection).
- OS command: user input in `exec`/`spawn`/`os.system` (use arg arrays, never a shell string).
- XSS: unsanitized input in HTML/templates, `dangerouslySetInnerHTML`, `v-html`, `innerHTML`.
- Server-side template injection; LDAP/XPath/header/log injection.
```bash
rg -nP "(query|execute)\(\s*[\"'\`].*(\+|\$\{|%s|%d).*[\"'\`]"     # SQL string-building
rg -nP "(child_process|exec|execSync|spawn)\(.*(req\.|request\.|\$\{)" # command injection
rg -nP "(dangerouslySetInnerHTML|v-html|\.innerHTML\s*=)"          # XSS sinks
rg -nP "(yaml\.load\(|pickle\.loads\(|eval\(|new Function\()"      # eval / unsafe load
```

**A04 - Insecure Design** (CWE-209, 256, 501, 522)
- Missing rate limiting on auth endpoints (login, register, password reset).
- No account lockout / backoff after failed logins.
- Business-logic flaws: negative quantities, price manipulation, race conditions in transactions.
- Missing input validation on business-critical operations.

**A05 - Security Misconfiguration** (CWE-16, 548, 614)
- Debug mode enabled in production (`NODE_ENV`, `DEBUG`, Flask `debug=True`).
- CORS `*`; missing security headers (CSP, HSTS, X-Frame-Options, X-Content-Type-Options, Permissions-Policy).
- Default credentials; verbose errors leaking stack traces; directory listing; GraphQL introspection in prod.
```bash
rg -nP "(debug\s*=\s*True|DEBUG\s*[:=]\s*true|app\.run\([^)]*debug\s*=\s*True)"
rg -nP "(helmet|contentSecurityPolicy|Strict-Transport-Security)"  # presence check - absence is the finding
```

**A06 - Vulnerable & Outdated Components** (CWE-1104, 937)
Run the audit tool for the detected ecosystem; prefer JSON output for parsing:
```bash
npm audit --json                       # npm
pnpm audit --json                      # pnpm
yarn npm audit --all --json            # yarn berry
pip-audit -f json                      # Python (preferred over deprecated `safety`)
cargo audit --json                     # Rust
trivy fs --scanners vuln,secret .      # polyglot: deps + filesystem secrets
```
- Flag known-CVE versions, especially in production deps; note the fixed-in version.
- Check for deprecated/unmaintained packages and confirm a lock file is committed.

**A07 - Identification & Authentication Failures** (CWE-287, 384, 521, 613)
- Hardcoded/default credentials; weak JWT secrets; missing token expiry / refresh rotation; session fixation.
- Tokens in URLs or localStorage (should be `httpOnly` cookies).
- Missing password complexity, MFA on sensitive operations, OAuth `state`, strict redirect-URI validation.

**A08 - Software & Data Integrity Failures** (CWE-502, 829, 494)
- Insecure deserialization: `pickle.loads`, `yaml.load` (use `yaml.safe_load`), Java `readObject`, PHP `unserialize`.
- Unsigned webhooks processed without signature verification.
- Missing integrity checks on CI/CD artifacts / auto-update; third-party scripts without SRI or version pinning.

**A09 - Security Logging & Monitoring Failures** (CWE-117, 532, 778)
- PII/secrets in logs (emails, passwords, tokens, SSNs, cards).
- Missing audit logging for auth events; sensitive data in client-facing errors; world-readable log files.
```bash
rg -nP "(console\.log|logger\.(info|debug)|print)\(.*(password|token|secret|ssn|credit)"
```

**A10 - Server-Side Request Forgery (SSRF)** (CWE-918)
- User-controlled URLs passed to `fetch`/`axios`/`requests` without an allowlist.
- Internal/metadata IPs reachable (169.254.169.254, 10/8, 127/8, 192.168/16); unvalidated redirect targets.
- URL-based uploads, imports, and webhooks not SSRF-hardened.
```bash
rg -nP "(fetch|axios|requests\.(get|post)|urllib|http\.get)\(\s*[^,)]*(req\.|request\.|params|query)"
```

### Step 3: Check Secrets & Credentials

**Template:** `templates/secret-patterns.txt`
A ready-to-run set of regexes for AWS/GitHub/OpenAI/Stripe/JWT/PEM/DB-URL secrets - feed it to ripgrep with `rg -nP -f templates/secret-patterns.txt .`.

- Scan the working tree with the pattern file above (or a dedicated scanner):
```bash
rg -nP -f templates/secret-patterns.txt .
gitleaks detect --no-banner --redact -v          # scans working tree + staged
gitleaks detect --log-opts="--all" --redact      # scans entire git history
trivy fs --scanners secret .                      # alternative secret scan
```
- Confirm `.gitignore` covers `.env`, `.env.*`, `*.pem`, `*.key`, `*.p12`, `credentials*`.
- Verify `.env.example` holds placeholders, not real values.
- Check git history for committed secrets, then **rotate** anything found (removing from HEAD is not enough):
```bash
git log --all --oneline -- '*.env' '*.pem' '*.key' 'credentials*'
git log --all -p -S '<token-fragment>'
```
- Check Docker build args, CI/CD config, and Terraform variables for leaked secrets. Always redact values in the report.

### Step 4: Check Infrastructure
- **Docker**: running as root, exposed ports, secrets in `Dockerfile`/build args, vulnerable base images (`trivy image <img>`).
- **CI/CD**: secret exposure in logs, unsafe artifact handling, untrusted PR code execution, missing least-privilege on workflow `permissions:`.
- **Cookies**: missing `httpOnly`, `secure`, `sameSite`.
- **TLS**: HTTPS enforcement, minimum TLS 1.2+.
- **Headers**: CSP, HSTS, X-Frame-Options, X-Content-Type-Options, Permissions-Policy.
- **File uploads**: type/size validation, path-traversal-safe filenames, content-type sniffing.

### Step 5: Supply Chain Checks
- Postinstall/lifecycle scripts in dependencies that execute arbitrary code (`rg -n "preinstall|postinstall|prepare" package.json`).
- Typosquatting (names close to popular packages) and dependency confusion (private names resolvable from public registries).
- Lock file present with integrity hashes and consistent with the manifest.
- GitHub Actions pinned to a full commit SHA, not a mutable tag.
- Optional deeper static analysis across the codebase:
```bash
semgrep --config auto --severity ERROR --severity WARNING .
semgrep --config p/owasp-top-ten .
```

### Step 6: Classify & Generate Report

**Severity Classification:**

| Severity | Criteria | Example |
|---|---|---|
| **Critical** | Actively exploitable, data-breach or RCE risk | SQL injection, hardcoded production secret, RCE via deserialization |
| **High** | Exploitable with effort, significant impact | Stored XSS, missing auth check, weak password hashing |
| **Medium** | Requires specific preconditions, moderate impact | CSRF, verbose errors, missing security headers |
| **Low** | Informational, minimal direct impact | Missing a single hardening header, best-practice gap |

**Template:** `templates/security-audit-report.md`
The full report structure - executive summary, severity-grouped findings with CWE/OWASP tags and fixes, dependency table, secrets, infra, supply chain, and prioritized recommendations.

Each finding must carry: severity, CWE, OWASP category, `file:line`, evidence, impact, a concrete fix, and how to verify the fix. Redact secret values.

---

## Remediation & Verification Mindset

A finding without a verifiable fix is half a job.

1. **Prioritize by exploitability x impact**, not by count. One Critical outranks fifty Lows.
2. **Rotate first, then patch.** A leaked credential is compromised the moment it touches a repo - removing it from source does not un-leak it. Rotate, then scrub history.
3. **Prefer framework-native controls.** Parameterized queries, an ORM's escaping, a battle-tested auth library, and `helmet`/CSP middleware beat hand-rolled fixes.
4. **Fix the class, not just the instance.** One SQL-injection often means a pattern repeated across the codebase - grep for siblings and fix them together.
5. **Verify the fix closes the hole.** Re-run the audit pattern or scanner; for injection, confirm the payload is now treated as data, not code.
6. **Add a regression test.** Run `/genskills:test-generator` to lock in a security test so the vulnerability cannot silently return.

---

## Configuration
Check `${CLAUDE_SKILL_DIR}/_config.json` for user preferences (do not create this file - read it if present):
- `scope`: "full" | "changed" | "critical-paths" - default scan scope (default: "changed").
- `ignorePaths`: string[] - paths to skip (e.g., test fixtures, vendor, generated code).
- `severityThreshold`: "low" | "medium" | "high" | "critical" - minimum severity to report (default: "low").
- `includeInfra`: boolean - scan Docker/CI configs (default: true).
- `includeSupplyChain`: boolean - run supply-chain checks (default: true).
- `secretPatterns`: string[] - additional regex patterns appended to `templates/secret-patterns.txt`.
- `tools`: object - enable/disable external scanners, e.g. `{ "semgrep": true, "gitleaks": true, "trivy": false }` (default: all true when the binary is available).

## Follow-up
- Run `/genskills:test-generator` to add security-focused regression tests for each fixed finding.
- Run `/genskills:code-review` on the remediation PR for a second pass.
- Re-audit changed files after fixes: `/genskills:security-audit --changed`.
