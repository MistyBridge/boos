---
name: review-doc-orchestrator
description: Entry point for producing a branded review document. Classifies the request into one of five artifact types (user-story, architecture, PRD, risk-analysis, test-charter), gathers evidence scope, delegates content authoring to the matching artifact skill, and renders/validates the result. Use when someone asks for a reviewable, company-themed doc from analysis (e.g. "make an architecture review", "turn this into a risk register HTML").
---

# review-doc-orchestrator

Routes a request to the right review-doc artifact skill and drives it through to
validated, rendered HTML. The model authors **content** (compact canonical
source); the renderer owns all chrome. Never hand-author HTML here.

## Workflow

1. **Classify.** Map the request to one artifact type (see `references/routing.md`).
   If the request is ambiguous, ask the user to confirm the type before authoring.
2. **Gather evidence scope.** Collect links to code, ADRs, docs, incidents the
   review should cite; record them as `evidence: [{label, href}]`.
3. **Pick theme + skin.** Default theme (`assets/default-theme.json`); the
   renderer picks the skin from the artifact type (architecture/test-charter →
   `docs-site`, PRD/user-story → `editorial`, risk-analysis → `brief`). Set
   `theme.layout` only when the user wants a different look (e.g. an
   executive `brief` of an architecture review).
4. **Delegate authoring.** Invoke the matching artifact skill to produce compact
   canonical YAML/JSON. Keep it content-only, 2–12 KB, one diagram per core section.
5. **Validate.** Run `validate-branded-doc` (schema first). Fix and re-author on failure.
6. **Render.** Run `render-branded-html`. Freeze diagrams / export PDF only if asked.

## Routing (quick reference)

| If the request is about… | Artifact type | Skill |
|---|---|---|
| stories, acceptance criteria, scope gaps | `user-story-review` | `user-story-review-doc` |
| topology, interfaces, design trade-offs | `architecture-review` | `architecture-review-doc` |
| PRD coverage, goals, readiness | `prd-review` | `prd-review-doc` |
| risks, mitigations, residual risk | `risk-analysis` | `risk-analysis-review-doc` |
| exploratory testing missions, charters | `test-charter` | `test-charter-review-doc` |

Full routing heuristics and disambiguation rules: `references/routing.md`.
Artifact field/overlay detail: `references/artifact-types.md`.

## Guardrails

- One artifact type per document. If a request spans two (e.g. architecture +
  risk), produce two artifacts or confirm the primary one with the user.
- Output canonical source that passes schema validation before rendering.
- Default to interactive Mermaid; freeze only for archival/PDF. Diagrams are
  expandable/zoomable in every skin — no extra work needed.
- Prefer widget section kinds over plain prose when data is structured
  (callouts, stats, steps, cards, heatmap, meters — see the artifact skill's
  Widgets section); overlay fields render automatically, never duplicate them.
- Keep this `SKILL.md` thin — load `references/*` only when needed.
