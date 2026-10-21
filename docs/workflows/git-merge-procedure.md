# Git merge procedure — `main` is protected

> Status: active since 2026-10-20. Applies to `github.com/dixia/IRMarket`.
> Enforced by repo ruleset **"main: PR + CI + merge queue"** (id `25563325`) + repo settings.

## What is enforced

| Rule | Value |
|---|---|
| Direct pushes to `main` | **blocked** — every change lands via PR |
| Required status checks | `contracts`, `web`, `bot` |
| Branch up to date | **required** (strict) — CI runs on the PR head, which must contain the latest `main` |
| Force-push / branch deletion on `main` | blocked |
| Merge method | **squash only** (merge commit / rebase disabled repo-wide) |
| Auto-merge | enabled — `gh pr merge <n> --auto --squash` |
| Delete branch on merge | enabled |

Because checks are strict, "green on the PR" means "green on `main` + PR" — that is the
"test the combination before main" guarantee. No long-lived integration branch is needed.

## Feature branches

- One branch per change; one worktree per branch (`IRMarket-<topic>`).
- Before opening/updating a PR, bring the branch up to date:
  ```bash
  git fetch origin
  git rebase origin/main          # or: gh pr update-branch <n>
  ```
- Force-push **feature** branches freely (`git push --force-with-lease`); never `main`.
- Resolve conflicts **in the feature branch**, never on `main`.

## PR + merge

1. Open the PR against `main` (conventional title; body = what / test / notes; link the issue
   with `Resolves #N`).
2. Wait for `contracts`, `web`, `bot` to pass.
3. If `main` moved since the last run, update the branch and let CI re-run (required by the
   strict check).
4. Enable auto-merge:
   ```bash
   gh pr merge <n> --auto --squash
   ```
   GitHub merges as soon as the requirements are met, then deletes the branch.

## Merge order

- Merge **one PR at a time**; afterwards, rebase the remaining branches onto the new `main`.
- Do **not** merge a long-lived integration/staging branch into `main`. A staging branch may be
  used to validate a combination, but promote by merging the individual PRs. A staging *branch*
  is not a staging *environment*: `deployment-assets.json` is a single gitignored registry and
  markets/vaults live on the shared testnet.

## Rollback / release

- Roll back with `git revert <squash-sha>` through a revert PR (each PR is one commit — this is
  why squash is enforced).
- Tag promotions (`vX.Y.Z-stage`) when a release is validated.

## Deploy notes

- `main` is always deployable; Vercel production deploys from the repo root.
- `NEXT_PUBLIC_*` changes must be re-deployed for the value to be inlined.
- Bot tests: `py -m unittest discover -s bot/tests` (CI job `bot`).

## Merge queue (not available yet)

The GitHub merge-queue rule is not available for this repository (the ruleset API rejects
`merge_queue`). The strict up-to-date required check provides the equivalent guarantee. If it
becomes available:

1. add a `merge_queue` rule (`merge_method: SQUASH`, `grouping_strategy: ALLGREEN`);
2. add `merge_group:` to `.github/workflows/ci.yml` (`on:` block);
3. keep everything else in this document unchanged — the queue then performs the
   "latest `main` + PR" test itself.
