<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

<!-- BEGIN:frontend-tests -->
# Frontend Tests

Run E2E tests with Playwright:
```bash
npx playwright test          # headless
npx playwright test --headed # headed
```

Browser: **Microsoft Edge** (`channel: "msedge"` in playwright config).

Tests require a local Hardhat node + contract deployments (handled by `tests/setup.ts`). The setup writes `.env.local` with deployed addresses before starting the Next.js dev server.
<!-- END:frontend-tests -->