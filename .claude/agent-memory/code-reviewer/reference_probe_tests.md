---
name: reference-probe-tests
description: How to run behavioural probe tests against bid-ad source during read-only reviews without touching repo files
metadata:
  type: reference
---

Read-only reviews of bid-ad can still prove findings by running probe tests from the session scratchpad:
- Plain `.mjs` vitest config (a `.ts` config outside the repo fails to resolve packages), importing `file:///D:/www/digitop/bid-ad/node_modules/@cloudflare/vitest-pool-workers/dist/pool/index.mjs`.
- Set `root: 'D:/www/digitop/bid-ad'`, copy the bindings from the repo's `vitest.config.ts`, and use `test.dir: <scratch dir>` with `include: ['**/*.probe.ts']` (an `include` path outside the root finds nothing).
- Run with `npx vitest run --config <scratch>/vitest.probe.config.mjs --reporter=verbose` from the repo root. Probe files import source and `test/helpers` by absolute path.
- Note: the pool loads `.dev.vars` automatically. Never print it.

**Why:** reviewers here are told not to edit repo files, but probes confirmed findings that reading alone could not (immutable cache headers in Hono, for example).
**How to apply:** use this for any "confirmed by probe" claim in a review of [[bid-ad]].
