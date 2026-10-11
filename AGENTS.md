# Zyro.lk Engineering Guidance for Codex

Zyro.lk is an existing production e-commerce system. Extend the current
implementation safely; do not treat it as a greenfield project.

## Required context and precedence

- Before relevant engineering changes, read `docs/project-constitution.md`,
  `docs/architecture.md`, `docs/ai-rules.md`, and applicable requirements in
  `MASTER_PROJECT.md` and focused companion documents.
- Preserve the constitution's documented precedence. `MASTER_PROJECT.md` is
  the deeper product authority when project documents disagree, unless the
  owner explicitly changes product direction.
- Do not weaken or override stricter repository or owner requirements.

## Engineering rules

- Inspect repository identity, branch, worktree, affected code paths, and
  existing tests before modifying files.
- Preserve the established React, Express, Firebase, Auth, Firestore,
  Storage, checkout, payment, and Supplier Hub architecture.
- Keep commerce server-authoritative: protect prices, stock, payments,
  customer data, credentials, publication, and security boundaries.
- Preserve the Supplier Hub review gate: supplier sync stages data; explicit
  admin approval is the publication authority.
- Prefer the smallest safe, backward-compatible change within the request.
- Preserve unrelated tracked, untracked, and ignored files; never clean them
  without explicit authorization.
- Require scope-appropriate tests and factual verification reports. Never
  fabricate test results, deployment status, evidence, or completion claims.
- Never expose secrets, credentials, private customer/order/payment data, or
  sensitive production information in code, logs, fixtures, prompts, or
  reports.

## Authorization boundaries

- Read-only investigation authorizes inspection only; it authorizes no writes.
- Local file modification requires explicit scope for the requested files.
- Commit, push, and merge each require separate explicit owner authorization.
- Deployment or configuration changes require separate explicit owner
  authorization, including Firebase, Hosting, Functions, rules, IAM, and
  secrets.
- Production data, supplier sync, taxonomy, stock, payment, order, media,
  approval, and publication operations require separate explicit owner
  authorization for the exact operation.

## Stop conditions

Stop and report when instructions conflict, required evidence is missing, the
baseline diverges, the requested scope is unclear, or a safe boundary cannot
be proven. Do not broaden scope by assumption.
