# Sprint 17: Storefront Redesign Implementation Plan

Date: 2026-07-09
Project: Zyro.lk
Scope: Customer-facing storefront redesign planning
Status: Planning only

## Executive Summary

Sprint 16 confirmed that the Zyro.lk storefront has a solid ecommerce foundation. The application already supports browsing, categories, search, wishlist, product detail views, cart, checkout, reviews, delivery calculation, and responsive navigation. The redesign should preserve this working foundation and improve clarity, trust, and conversion through incremental changes.

The safest redesign approach is to avoid a large rewrite. Start with low-risk conversion fixes, then redesign the homepage, then improve the product experience, then tune mobile behavior, and finally add premium polish. Each phase should be independently buildable, testable, and reversible.

### Current Storefront Strengths

- Complete shopping flow from product browsing to checkout.
- Responsive header, mobile bottom navigation, cart drawer, and product detail modal.
- Product cards already include images, price, discounts, stock, ratings, wishlist, and actions.
- Checkout has server-side validation, idempotency, rate limiting, stock checks, and sequential order numbering.
- Trust messaging already exists in hero, product detail, cart, checkout, and footer areas.
- Homepage has multiple merchandising sections: categories, featured products, new arrivals, best sellers, latest products, reviews, and footer.
- Supplier Hub, approval flow, review aggregate logic, and checkout backend should not need changes for storefront redesign.

### Current Storefront Weaknesses

- Hero area is visually strong but too tall, especially on mobile.
- Above-the-fold message is broad and not offer-led.
- Primary and secondary CTAs are not always distinct.
- "Buy Now" can mean WhatsApp order rather than app checkout, creating expectation mismatch.
- Product detail is modal-based, limiting SEO, shareability, and direct product links.
- Checkout works but lacks visible step/progress clarity.
- Mobile has several competing navigation and sticky surfaces.
- Production fallback text can weaken trust if business settings are incomplete.
- Auth modal contains developer/demo-oriented wording that should not appear in production.
- Newsletter behavior is not clearly backed by durable subscription storage.

### Overall Redesign Goals

- Increase customer confidence before checkout.
- Make the main shopping path obvious on desktop and mobile.
- Reduce decision friction in product cards and product detail.
- Improve homepage merchandising without changing backend contracts.
- Preserve checkout behavior exactly unless a future approved sprint explicitly changes it.
- Preserve Supplier Hub, approval workflow, review aggregate logic, and current API contracts.
- Keep every redesign phase small enough to verify and roll back independently.

## Implementation Principles

- Do not rewrite working features.
- Preserve existing checkout behavior and API contracts.
- Keep UI changes incremental and component-scoped.
- Prefer content, layout, and hierarchy improvements before structural changes.
- Avoid Firestore schema changes unless explicitly approved.
- Do not change Supplier Hub, approval, scheduled sync, review aggregates, or backend functions for this storefront redesign.
- Run lint, build, functions build, tests, and visual/manual checks when implementation begins in a future sprint.
- Use rollback points at the end of each phase.

## Phase 1: Quick Wins

Goal: improve customer clarity and trust with the smallest safe UI/content changes.

Recommended timing: first implementation phase.

| Improvement | Priority | Effort | Expected Customer Impact | Risk | Dependencies |
| --- | --- | --- | --- | --- | --- |
| Clarify product card CTA wording so WhatsApp ordering is not labeled like normal checkout | High | Small | Reduces purchase confusion and support questions | Low | Confirm desired label: "Order on WhatsApp" or similar |
| Make hero primary and secondary CTA destinations distinct | High | Small | Improves first action clarity | Low | Existing hero button handlers |
| Reduce hero height on mobile and desktop | High | Small | Shows products/categories sooner and improves shopping speed | Medium | Visual QA across breakpoints |
| Replace generic hero defaults with offer-led storefront copy | High | Small | Communicates value faster to first-time customers | Low | Final business messaging |
| Remove or hide visible "pending setup" fallback text in customer-facing areas | High | Small | Prevents trust loss from incomplete settings | Medium | Confirm required production contact fields |
| Replace auth modal developer/demo wording with production-safe customer copy | High | Small | Removes production trust risk | Low | Existing auth modal states |
| Add checkout step indicator: Cart, Delivery, Place Order | High | Medium | Reduces checkout uncertainty | Medium | Cart drawer layout QA |
| Add checkout reassurance copy near submit button | High | Small | Improves COD/customer confidence | Low | Existing checkout UI |
| Reword post-order WhatsApp action to confirm order is already placed | Medium | Small | Prevents order-status confusion | Low | Existing success screen |
| Make newsletter behavior production-honest: connect, disable, or relabel | High | Medium | Avoids fake subscription trust issue | Medium | Decision required: backend support or remove for launch |
| Verify wishlist entry points respect global wishlist setting | High | Small | Prevents disabled feature appearing in mobile nav | Medium | Existing settings behavior |
| Replace "No Reviews" product card text with neutral empty state | Medium | Small | Avoids negative trust signal for new products | Low | Product card text only |
| Add compact trust microcopy near product CTAs | Medium | Small | Reinforces COD, delivery, warranty, or support | Low | Final trust wording |

### Phase 1 Rollback Point

Rollback by reverting the changed UI components only. No backend, Firestore, or API changes should be included in this phase.

## Phase 2: Homepage Redesign

Goal: improve homepage merchandising and guide first-time customers into products faster.

Recommended timing: after Phase 1 quick wins are verified.

| Improvement | Priority | Effort | Expected Customer Impact | Risk | Dependencies |
| --- | --- | --- | --- | --- | --- |
| Redesign hero to show a clear shopping promise, one primary CTA, and one distinct secondary CTA | High | Medium | Improves first impression and action clarity | Medium | Final brand/value proposition |
| Add a compact trust strip immediately below hero | High | Small | Reinforces COD, delivery, warranty, and support early | Low | Confirm trust claims |
| Improve banner hierarchy so campaign banners point to real products or categories | Medium | Medium | Makes promotions more actionable | Medium | Active merchandising data |
| Promote category presentation higher in the page | High | Medium | Helps first-time customers find the right product path | Medium | Existing category data quality |
| Create featured collections instead of only repeated product grids | Medium | Medium | Improves browsing structure | Medium | Collection rules or manual curation |
| Add flash deals section only if real discounts and inventory exist | Medium | Medium | Adds urgency without fake scarcity | Medium | Reliable discount data |
| Strengthen best sellers section with clearer title, reason, and products | Medium | Small | Improves social proof and product discovery | Low | Existing product flags/order |
| Refine "Why choose Zyro.lk" into specific trust claims | High | Small | Builds confidence before product selection | Low | Business confirmation |
| Improve testimonial section with stronger empty state or hide when empty | Medium | Small | Avoids weak social proof when reviews are unavailable | Low | Existing review data |
| Improve footer production polish: real contact info, current categories, legal links | High | Medium | Increases launch trust | Medium | Complete settings and CMS pages |

### Phase 2 Rollback Point

Keep the existing homepage section order available until the redesigned homepage passes desktop and mobile QA. Avoid removing existing product sections until replacements are verified.

## Phase 3: Product Experience

Goal: improve product discovery, decision confidence, and product detail conversion.

Recommended timing: after homepage redesign because product experience touches more buying behavior.

| Improvement | Priority | Effort | Expected Customer Impact | Risk | Dependencies |
| --- | --- | --- | --- | --- | --- |
| Redesign product card hierarchy: title, price, discount, trust, rating, CTA | High | Medium | Makes products easier to scan and compare | Medium | ProductCard QA |
| Establish a single primary product card action | High | Medium | Reduces CTA competition | Medium | Approved CTA strategy |
| Add secondary WhatsApp action as explicit assisted order path | High | Small | Keeps WhatsApp flow without confusing checkout | Low | WhatsApp number configuration |
| Improve price presentation and savings messaging | Medium | Small | Makes discounts easier to understand | Low | Existing price/originalPrice fields |
| Normalize stock labels: In stock, Only X left, Out of stock | Medium | Small | Reduces stock-message noise | Low | Existing stock quantity |
| Add product trust badges: COD, warranty, delivery, genuine product | Medium | Medium | Improves product-level confidence | Medium | Confirm accurate trust claims |
| Improve image gallery spacing and mobile gesture QA | Medium | Medium | Improves product inspection | Medium | Product detail modal QA |
| Add sticky buy section in product detail for mobile | High | Medium | Keeps purchase action accessible | Medium | Must not overlap bottom nav |
| Improve related products relevance | Medium | Medium | Increases browsing depth and basket size | Medium | Existing category/product data |
| Add delivery information closer to buy buttons | High | Small | Answers purchase objections earlier | Low | Existing delivery settings |
| Plan route-based product detail pages | High | Large | Improves SEO, sharing, analytics, and back-button behavior | High | Routing strategy approval |
| Keep modal product detail as quick-view until routed PDP is fully verified | High | Medium | Reduces migration risk | Medium | Routed PDP implementation |

### Phase 3 Rollback Point

Refactor product card and product detail changes in separate commits. If route-based product pages are introduced, keep modal detail behavior working until the new route is proven stable.

## Phase 4: Mobile Experience

Goal: make the storefront feel fast, clear, and easy to buy from on small screens.

Recommended timing: can overlap with Phases 1 to 3, but should be verified as its own release checkpoint.

| Improvement | Priority | Effort | Expected Customer Impact | Risk | Dependencies |
| --- | --- | --- | --- | --- | --- |
| Reduce mobile hero sizing and bring categories/products into first scroll | High | Small | Speeds up mobile shopping | Medium | Hero QA |
| Simplify mobile navigation surfaces | High | Medium | Reduces confusion and vertical crowding | Medium | Decision: bottom nav-first or top menu-first |
| Ensure bottom nav does not cover cart, checkout, or modal CTAs | High | Medium | Prevents blocked purchase actions | Medium | Manual device QA |
| Add safe bottom spacing to screens with fixed CTAs | High | Small | Improves touch usability | Low | CSS/layout QA |
| Improve mobile search access | Medium | Medium | Helps customers find products faster | Medium | Search UI strategy |
| Increase touch target consistency for thumbnails, close buttons, quantity controls, and drawer actions | Medium | Small | Reduces tap errors | Low | Component QA |
| Add sticky add-to-cart behavior where useful | Medium | Medium | Improves product detail conversion | Medium | Must not conflict with bottom nav |
| Tune mobile spacing in product cards and cart drawer | Medium | Small | Improves readability and checkout comfort | Low | Responsive QA |
| Reduce nonessential hover-style effects on touch screens | Low | Small | Improves performance perception | Low | CSS QA |

### Phase 4 Rollback Point

Validate mobile changes independently on narrow, medium, and tablet widths. Keep navigation changes isolated so they can be reverted without affecting checkout or product logic.

## Phase 5: Premium Polish

Goal: improve perceived quality after the conversion-critical work is stable.

Recommended timing: after Phases 1 to 4 and after real user feedback from soft launch.

| Improvement | Priority | Effort | Expected Customer Impact | Risk | Dependencies |
| --- | --- | --- | --- | --- | --- |
| Refine micro animations for add to cart, wishlist, drawer open, and success states | Medium | Medium | Makes interactions feel more premium | Medium | Performance QA |
| Improve skeleton loading by matching final card/layout dimensions | Medium | Small | Reduces perceived layout shift | Low | Existing loading states |
| Improve empty states for search, wishlist, cart, reviews, and categories | Medium | Medium | Keeps users moving when content is empty | Low | Empty state copy |
| Add subtle loading transitions between page states | Low | Small | Improves polish | Low | Existing routing/page state |
| Tune hover effects for desktop cards and buttons | Low | Small | Improves premium feel | Low | Desktop QA |
| Add analytics-friendly UI event names during future instrumentation | Medium | Medium | Enables conversion measurement | Medium | Analytics decision |
| Improve font loading strategy if performance metrics require it | Low | Medium | Improves perceived speed | Medium | Performance data |
| Add richer campaign visuals once real promotion assets exist | Low | Medium | Improves brand presentation | Low | Brand assets |

### Phase 5 Rollback Point

Premium polish must never block checkout, cart, auth, or product browsing. Keep visual polish separate from functional changes.

## Launch Blockers

These should be resolved before public launch or before paid marketing traffic.

| Blocker | Priority | Effort | Impact | Risk | Dependencies |
| --- | --- | --- | --- | --- | --- |
| Customer-facing pending setup fallback text appears in header/footer/contact areas | High | Small | Trust loss | Low | Production settings |
| Auth modal exposes developer/demo wording | High | Small | Trust and brand risk | Low | AuthModal copy |
| Product card "Buy Now" wording does not match behavior | High | Small | Checkout confusion | Low | CTA wording decision |
| Newsletter subscription appears real without durable backend behavior | High | Medium | Trust/legal concern | Medium | Decide connect vs remove |
| Mobile fixed controls may overlap important CTAs | High | Medium | Purchase friction | Medium | Mobile QA |
| Checkout lacks progress clarity | High | Medium | Checkout abandonment risk | Medium | Cart drawer UI |

No backend launch blocker was identified for this storefront redesign plan.

## Nice-To-Have Improvements

| Improvement | Priority | Effort | Customer Impact | Risk | Dependencies |
| --- | --- | --- | --- | --- | --- |
| Category mega menu or richer category drawer | Medium | Medium | Better discovery | Medium | Category data |
| Search suggestions or instant search preview | Medium | Medium | Faster product finding | Medium | Search UX |
| Product card delivery/warranty microcopy | Medium | Small | Better confidence | Low | Accurate claims |
| Undo after cart item removal | Medium | Medium | Safer cart editing | Low | Cart state handling |
| Field-level checkout validation messages | Medium | Medium | Easier form correction | Medium | Form UI |
| Route-based product detail pages | High | Large | SEO/shareability | High | Routing plan |

## Post-Launch Improvements

| Improvement | Priority | Effort | Customer Impact | Risk | Dependencies |
| --- | --- | --- | --- | --- | --- |
| Funnel analytics events | High | Medium | Enables data-driven optimization | Medium | Analytics provider decision |
| A/B tests for hero, CTA labels, and checkout reassurance | Medium | Medium | Conversion learning | Medium | Analytics baseline |
| Customer order tracking page | Medium | Large | Better post-order trust | Medium | Order lookup/auth strategy |
| Account order history | Medium | Large | Better returning customer experience | Medium | Account UX |
| Structured product SEO data | Medium | Medium | Better search visibility | Medium | Route-based PDP preferred |
| Product comparison | Low | Large | Better electronics shopping | Medium | Product spec quality |
| Recently viewed products | Low | Medium | Better browsing continuity | Low | Local storage or user profile decision |

## Safest Implementation Order

1. Phase 1A: Production wording cleanup
   - Remove pending setup text from customer-facing views.
   - Remove developer/demo auth wording.
   - Clarify newsletter behavior.
   - This has the lowest technical risk and highest trust impact.

2. Phase 1B: CTA clarity
   - Rename WhatsApp order actions.
   - Establish product card CTA hierarchy.
   - Make hero CTAs distinct.
   - This improves conversion without backend changes.

3. Phase 1C: Checkout clarity
   - Add step indicator.
   - Add COD reassurance copy.
   - Improve post-order WhatsApp wording.
   - Keep checkout API contract unchanged.

4. Phase 2A: Hero and trust-strip redesign
   - Reduce hero height.
   - Add concrete value proposition.
   - Add early trust strip.
   - Verify mobile first.

5. Phase 2B: Homepage merchandising
   - Improve category section.
   - Refine featured collections, best sellers, and testimonial behavior.
   - Improve footer content.

6. Phase 3A: Product card redesign
   - Improve card hierarchy.
   - Normalize stock and review empty states.
   - Add trust microcopy.

7. Phase 3B: Product detail conversion improvements
   - Improve delivery/trust placement.
   - Improve review prompts.
   - Add mobile sticky buy behavior only after overlap QA.

8. Phase 4: Mobile navigation and spacing pass
   - Simplify navigation surfaces.
   - Add bottom safe spacing.
   - Verify all drawer/modal flows on mobile.

9. Phase 3C: Route-based product detail planning and implementation
   - Treat this as a separate approved sprint because it affects routing, SEO, and browser behavior.
   - Keep the existing product modal until the new route is fully verified.

10. Phase 5: Premium polish
    - Add animations, improved skeletons, empty states, and transitions after the purchase path is stable.

## Verification Plan For Future Implementation

Each implementation sprint should verify:

- `npm.cmd run lint`
- `npm.cmd run build`
- `cd functions` then `npm.cmd run build`
- `npm.cmd test`
- `git diff --check`
- Desktop visual QA
- Mobile visual QA
- Checkout manual QA
- Product detail manual QA
- Cart drawer manual QA
- Auth modal manual QA

Manual storefront checks:

- First viewport shows a clear offer and a clear shopping path.
- Product cards have one obvious primary action.
- WhatsApp order path is explicit.
- Checkout still creates orders exactly as before.
- Cart quantity and remove flows still work.
- Mobile bottom navigation does not hide key actions.
- Product detail remains usable on narrow screens.
- Footer contact, legal, and category links look production-ready.

## Non-Goals For This Plan

- Do not change checkout backend behavior.
- Do not change Supplier Hub behavior.
- Do not change review aggregate logic.
- Do not change Firestore schema.
- Do not change API contracts.
- Do not introduce marketplace, trading, or AI features.
- Do not redesign admin dashboard in this storefront sprint.

## Final Recommendation

Proceed with Phase 1 first. It delivers the highest customer trust and conversion impact with the least technical risk. The redesign should then move through homepage, product experience, mobile, and premium polish in that order.

The biggest architectural decision is route-based product detail pages. That should be treated as its own future sprint with an explicit implementation plan because it touches routing, SEO, analytics, and browser navigation.

## Verification Notes

- This file is documentation only.
- No application code was changed.
- No commit was created.
- No push was performed.
