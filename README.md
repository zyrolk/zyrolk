# Zyro.lk

Zyro.lk is a React, TypeScript, Firebase, and Express commerce platform with a public storefront, checkout flow, admin dashboard, Supplier Hub, approval workflow, scheduled supplier sync, and automated regression tests.

## Required Node Version

Use the latest Node.js LTS release for local development and CI. The GitHub Actions workflow uses `node-version: lts/*` so the CI runner automatically tracks the current LTS line.

## Local Setup

Install root dependencies:

```bash
npm install
```

Install Firebase Functions dependencies:

```bash
cd functions
npm install
cd ..
```

Start the local development server:

```bash
npm run dev
```

## Local Verification Commands

Run these checks before committing production work:

```bash
npm run lint
npm run build
cd functions
npm run build
cd ..
npm test
git diff --check
```

These commands verify TypeScript, the production root build, the Firebase Functions build, automated regression coverage, and whitespace safety.

## CI Workflow

The GitHub Actions CI workflow lives at `.github/workflows/ci.yml`.

It runs on:

- Pushes to `main`
- Pull requests

The workflow:

- Uses the latest Node.js LTS release.
- Caches npm dependencies using both root and `functions` lockfiles.
- Installs root dependencies with `npm ci`.
- Installs Firebase Functions dependencies with `npm ci --prefix functions`.
- Runs `npm run lint`.
- Runs `npm run build`.
- Builds Firebase Functions from the `functions` directory.
- Runs `npm test`.
- Cancels duplicate in-progress runs on the same branch.
- Uploads command logs as artifacts only when the workflow fails.

The CI workflow does not print secrets and does not perform deployment. It is a verification gate only.
