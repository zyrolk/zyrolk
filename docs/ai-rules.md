<!-- builderai-document
type: ai-rules
version: 1
-->

# AI-assisted development rules

These rules govern BuilderAI and other coding assistants working in the Zyro.lk repository under
trusted-local external-target sessions.

## Required behavior

1. Read `docs/architecture.md`, `docs/project-constitution.md`, and `.builderai/target-project.json`
   before changing code.
2. Continue from the **existing** Zyro.lk implementation. Do not redesign the storefront, restart
   modules, or introduce parallel architectures when an incremental extension suffices.
3. Preserve unrelated work and stay within the requested task scope.
4. Match existing TypeScript, React, Express, and Firebase patterns in the touched area.
5. Use the smallest backward-compatible change that satisfies the task.
6. Never fabricate test results, emulator output, deployment status, or completion claims.
7. Do not expose secrets in prompts, logs, fixtures, commits, or onboarding documents — including
   `.env*` values, supplier credentials, PayHere secrets, private keys, and
   `firebase-applet-config.json` fields.

## Prohibited actions without explicit approval

- Modifying paths listed in `protectedAreas` inside `.builderai/target-project.json`.
- Changing `firestore.rules`, `storage.rules`, or Firebase schema/collection shapes.
- Deploying, running production migrations, or executing credential/admin-claim scripts under
  `scripts/` with `--apply`.
- Adding dependencies or changing `package.json` / lockfiles unless the task explicitly requires it
  and the operator approves.
- Writing unapproved supplier data directly into live `products`.
- Bypassing lint, build, or test failures to claim completion.
- Sending repository content to external AI providers outside the operator-controlled BuilderAI
  trusted-local session.

## Verification and handoff

Use the **root** `package.json` scripts for BuilderAI verification stages:

| Stage | Root script | Notes |
| --- | --- | --- |
| Lint / typecheck | `npm run lint` (`tsc --noEmit`) | No separate `typecheck` script; lint covers TypeScript checking |
| Build | `npm run build` | Vite client build + esbuild server bundle to `dist/` |
| Test | `npm run test` | Node test runner over `tests/**/*.test.ts` |

When changes touch Firebase Functions server modules, also run `npm run build` inside
`functions/` before handoff (CI runs both builds; Functions build is not a separate BuilderAI
verification stage today).

Report the exact commands executed and their outcomes. If emulator-backed tests cannot run in the
current environment, say so explicitly and list the remaining risk.

For supplier, checkout, payment, or security-rule work, cite the relevant tests under `tests/` that
should pass before merge.
