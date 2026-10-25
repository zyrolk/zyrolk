# Zyro.lk homepage visual fixture

This disposable fixture renders the real `Navbar`, `MarketplaceHomePhase1`, and
`MobileBottomNav` components from a separately supplied source checkout. It
uses deterministic synthetic products/categories and a local Firebase mock.

Set `ZYRO_SOURCE_ROOT` to the source checkout before running the fixture. The
Vite server binds only to `127.0.0.1:4177`. No production credentials, live
catalog data, supplier calls, checkout handlers, or Firebase writes are used.

The Playwright package is pinned to `@playwright/test@1.55.0`. Chromium must be
provided by the runner or an already-approved local browser installation; the
fixture does not pass `--no-sandbox` or download browsers implicitly.

The visual test captures 320px, 390px, 768px, and 1440px full-page PNGs and
checks horizontal overflow, four collection cards, the responsive bottom dock,
and the existing mobile search open/close focus behavior.

For repository publication, place this fixture under
`tests/visual/homepage-premium` and set `ZYRO_SOURCE_ROOT` to the checked-out
repository root. The companion workflow expects that layout and remains
manual-only.
