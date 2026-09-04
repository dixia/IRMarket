# Cluster D — Docs

**Area:** `docs/`, `AGENTS.md`, `TODO.md`
**Owner:** Documentation / spec sync

## Goal
Keep IRMarket documentation accurate, consistent, and useful for contributors.

## Scope
- `docs/sc-tech-spec.md` — smart contract tech spec
- `docs/prd.md` — product requirements
- `docs/web-tech-design.md` — web architecture
- `docs/product/ui_copy.md` — canonical copy registry
- `AGENTS.md` — repo conventions and workflow rules
- `TODO.md` — GH issue index

## Tasks
1. Review docs for accuracy against current codebase.
2. Update screenshots / flows / addresses after contract changes.
3. Ensure `TODO.md` is a clean index (one GH issue link + status per line).
4. Fix broken markdown links and formatting.

## STOP condition
- Doc requires deep technical clarification from another cluster — escalate instead of guessing.

## Commit
```
docs: <describe the doc update>
```
