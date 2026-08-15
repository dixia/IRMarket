# Workflow: Updating the DeltaV Startup Form with Edge

The IRMarket startup profile lives at https://deltav.monad.xyz/startup-form and is behind a
Privy login. This workflow uses the **Edge browser MCP** to fill/update it, never submitting
until review.

## Prerequisites

- opencode has the `edge` MCP server enabled (global config: `~/.config/opencode/opencode.json`).
- The user is signed in to DeltaV in the Playwright-controlled Edge session.

## Steps

1. **Navigate** to https://deltav.monad.xyz/startup-form (sign in if a login modal appears).
2. **Survey the form** with an accessibility snapshot. It's a multi-section wizard.
3. **Fill each section** (text fields batched via fill_form; buttons/pills via click; dropdowns via click+find+Esc; dates as `YYYY-MM`; file uploads left blank).
4. **Navigate sections** via Next/Previous buttons.
5. **Do NOT submit** — leave on the final step for the user to review and save.

## Source of truth

- Fill content from this repo: `README.md`, `hackathon.md`,
  `deploy.md`/`deployment.json`, `plan/roadmap.md`.

## Security notes

- `docs/DELTAV_API_KEY.md` is gitignored — never commit it, and never paste the API key
  into chat/logs.