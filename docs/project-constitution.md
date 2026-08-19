<!-- builderai-document
type: project-constitution
version: 1
-->

# Target Project Constitution

## Authority

Zyro.lk owns its architecture, commerce rules, Firebase schema, and security boundaries. BuilderAI
reads this constitution, `docs/architecture.md`, and `docs/ai-rules.md` before proposing or applying
changes. `.builderai/target-project.json` supplies external-target identity, protected areas, and
source layout hints.

When this constitution conflicts with generic assistant defaults, **this constitution wins**. When it
conflicts with `MASTER_PROJECT.md`, treat `MASTER_PROJECT.md` as the deeper product authority unless
the operator explicitly updates direction.

## Precedence

1. This constitution — process, non-negotiable principles, and change protocol.
2. `docs/architecture.md` — module boundaries, runtime layers, and in-scope systems.
3. `docs/ai-rules.md` — AI-assisted development behavior and verification duties.
4. `MASTER_PROJECT.md` and focused companion docs — detailed product and workflow invariants.
5. Root `package.json` and `functions/package.json` — build, lint, and test command discovery.

## Non-negotiable principles

1. **Preserve production architecture.** Do not replace the Firebase + modular Express API model, the
   review-first Supplier Hub workflow, or existing customer checkout/auth flows with unrelated
   redesigns.
2. **Continue from current code.** BuilderAI must build on implemented storefront, admin, supplier,
   and payment behavior; no greenfield restarts of working modules.
3. **Smallest safe change.** Prefer backward-compatible, narrowly scoped diffs. Do not revert,
   reformat, or rewrite unrelated files.
4. **Server-authoritative security.** Never trust client-provided prices, totals, stock, roles,
   supplier URLs, or credentials. Keep secrets and PayHere merchant material out of client bundles
   and AI prompts.
5. **Protect live catalog integrity.** Supplier ingestion must not publish unreviewed data to
   `products`. Do not weaken `firestore.rules` or `storage.rules` without explicit approval.
6. **Protect secrets and environments.** Do not commit, paste, or send `.env*`, service account
   keys, supplier passwords, or `firebase-applet-config.json` contents to external providers.
7. **Use project verification.** Run the repository's declared lint, build, and test commands before
   declaring executable work complete.

## Change protocol

1. Read `docs/architecture.md`, this file, `docs/ai-rules.md`, and `.builderai/target-project.json`.
2. Identify affected layers (UI, API route, scheduled job, rules, tests) before editing.
3. State assumptions when evidence is incomplete; do not invent modules or paths.
4. Keep changes within the requested scope; preserve unrelated work.
5. For high-risk areas — checkout, payments, supplier approval, auth, security rules, Firebase
   schema — require explicit operator awareness and targeted regression tests.
6. Report exact validation commands and outcomes in the handoff. If a check cannot run locally,
   explain why and the remaining risk.
