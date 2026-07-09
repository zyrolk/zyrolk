# Sprint 16: Storefront UX, UI, and Conversion Audit

Date: 2026-07-09
Project: Zyro.lk
Scope: Customer-facing storefront only
Status: Analysis and documentation only

## Executive Summary

The Zyro.lk storefront is functionally strong and already has many production-ready ecommerce building blocks: product browsing, category filtering, wishlist, cart, checkout, review display, product detail modal, delivery fee handling, and responsive navigation. The current experience can support a soft launch, but it should be tightened before a full public launch because several customer-facing details reduce clarity, trust, and conversion.

The main opportunity is not a full rewrite. The safest path is an incremental storefront UX pass that improves above-the-fold clarity, mobile buying flow, product card hierarchy, checkout confidence, and production trust signals while preserving the existing application behavior.

Overall storefront readiness score: 81/100

Primary conversion risks:

- Homepage hero is visually polished but very tall, pushing products and categories lower than necessary.
- "Buy Now" on product cards currently behaves like a WhatsApp quick order, which can confuse customers expecting app checkout.
- Product detail pages are modal-based, which weakens SEO, shareability, and browser navigation.
- Checkout is complete, but progress clarity and post-order confidence can be improved.
- Some production trust signals can show fallback copy such as pending setup text if settings are incomplete.
- Auth modal contains developer/demo-oriented fallback copy that should not be visible in production.
- Footer newsletter appears to subscribe locally without a durable backend workflow.
- Mobile has multiple navigation surfaces that can compete for attention.

## Readiness Scores

| Area | Score | Launch Interpretation |
| --- | ---: | --- |
| Homepage | 78/100 | Strong visuals, needs clearer conversion hierarchy |
| Navigation | 82/100 | Complete, but mobile/nav density should be simplified |
| Product Listing | 80/100 | Functional, needs stronger card hierarchy and buying clarity |
| Product Detail | 84/100 | Rich experience, but modal approach limits SEO/shareability |
| Cart | 86/100 | Solid ecommerce drawer, needs clearer step structure |
| Checkout | 82/100 | Functional and protected, needs better confidence and inline guidance |
| Visual Design | 80/100 | Modern, but hierarchy and palette variety can improve |
| Mobile Experience | 79/100 | Usable, but hero height, sticky elements, and drawer depth need tuning |
| Conversion Optimization | 76/100 | Several small friction points should be fixed before redesign |

## First-Time Customer Journey

A first-time customer sees a polished electronics storefront with a cinematic hero, product grids, categories, wishlist, cart, and checkout. The brand feels active and modern. The experience communicates that Zyro.lk sells electronics and offers COD, delivery, and WhatsApp contact.

The journey becomes less clear at the decision points:

- The hero communicates lifestyle more than a concrete shopping promise.
- Product cards offer both "Add to Cart" and "Buy Now", but "Buy Now" does not mean the same thing as checkout.
- The product detail modal has useful buying information, but it is not a true route that can be shared, indexed, or reopened directly.
- Checkout works, but the customer does not get a clear step-by-step sense of progress.
- Trust signals exist, but some depend heavily on settings being fully configured.

## 1. Homepage Audit

### What Works

- Strong visual first impression through `HeroBanner`.
- Homepage includes multiple merchandising sections: featured products, new arrivals, best sellers, latest products, testimonials, categories, and trust/benefit sections.
- Loading skeletons improve perceived quality.
- Category section is visible and uses real category data.
- The homepage has enough content depth for a first launch.

### Issues

Critical:

- No critical homepage blocker was found.

High:

- The hero is very tall across breakpoints. On many screens, the first viewport can be dominated by the hero, delaying exposure to products and categories.
- Primary and secondary hero CTAs can send users to the same destination, reducing decision clarity.
- Default hero copy is generic. It does not immediately communicate price advantage, delivery promise, warranty, COD, or top categories.
- If homepage settings are incomplete, the page may rely on generic defaults instead of a sharp brand offer.

Medium:

- Featured products and category discovery compete with several similar product sections. The page can feel long before the customer understands where to start.
- Trust signals are present, but they are not always tied to specific anxieties such as warranty, delivery time, returns, COD, genuine products, or support availability.
- Testimonials only show if review data exists; this is good technically, but empty states should avoid making the page feel less trusted.

Low:

- The visual style is polished but can feel card-heavy and similar section-to-section.

### Recommendations

Critical:

- None.

High:

- Reduce mobile and desktop hero height so product/category content is visible sooner.
- Make the primary CTA a clear shopping action such as "Shop Products" or "Shop Best Deals".
- Make the secondary CTA a distinct action such as "View Categories" or "Contact Support".
- Add a concrete above-the-fold value proposition: COD, islandwide delivery, warranty/genuine products, or launch deals.

Medium:

- Reorder homepage sections around a buying path: hero, trust strip, categories, featured deals, best sellers, reviews, footer.
- Add stronger campaign banners only when they point to real products or collections.

Low:

- Use more varied section layouts so homepage scanning feels intentional rather than repetitive.

## 2. Navigation Audit

### What Works

- Sticky header exists.
- Desktop search is prominent.
- Cart and wishlist entry points are visible.
- User account dropdown supports guest, login/register, account, and admin access.
- Mobile bottom navigation provides fast access to Home, Shop, Cart, Wishlist, and Menu.
- Mobile menu includes search, account actions, categories, and support/location details.

### Issues

Critical:

- No critical navigation blocker was found.

High:

- Mobile has both a hamburger menu and a floating bottom navigation with an additional menu drawer. This can create duplicated navigation choices.
- Wishlist appears as a primary mobile destination even though wishlist can be disabled by settings in other parts of the app. This should be verified before launch.
- Search requires explicit submit and has no suggestion or quick result feedback.

Medium:

- Desktop navigation hides primary links until large breakpoints, leaving tablet sizes more dependent on search and icon actions.
- Category browsing is not as strong as product browsing. A first-time user may not immediately see the full category structure.
- Sticky navigation is useful, but the combination of sticky header, bottom dock, drawers, and modals can reduce usable mobile screen space.

Low:

- Hotline fallback copy can appear if settings are incomplete, which weakens trust.

### Recommendations

High:

- Simplify mobile navigation to one primary pattern: bottom nav plus drawer, or top menu plus bottom cart action.
- Hide wishlist entry points consistently if wishlist is disabled.
- Add search suggestions or at least a visible clear/search state after a query is applied.

Medium:

- Add a stronger category entry point in desktop navigation, such as a category menu or category landing page.
- Keep cart access persistent, but avoid multiple competing sticky controls on small screens.

Low:

- Replace all pending setup fallback text before launch with configured production values.

## 3. Product Listing Audit

### What Works

- Product cards show image, badges, category, rating, price, old price, stock, wishlist, and actions.
- Discounts, new products, bestsellers, and out-of-stock states are represented.
- Cards support add to cart and quick WhatsApp order.
- Grid layout is responsive.
- Products are filtered to avoid showing inactive products.

### Issues

Critical:

- No critical listing blocker was found.

High:

- "Buy Now" currently opens WhatsApp ordering rather than the normal checkout flow. This is a naming/expectation mismatch.
- Product cards have two visually strong CTAs of similar weight, which splits customer intent.
- Product cards do not clearly communicate delivery, warranty, or return confidence at the decision point.

Medium:

- Exact stock count can be useful, but showing "X left" for every product may create noise or unhelpful urgency.
- "No Reviews" can lower trust for new products. A neutral label such as "New arrival" or hiding empty review text may convert better.
- Category display can expose raw category naming rather than customer-friendly merchandising labels.
- Quick add is useful, but quantity selection only happens later in cart/product detail.

Low:

- Card hover effects and rounded card styling are modern, but many cards can visually blend together.

### Recommendations

High:

- Rename WhatsApp quick order action to "Order on WhatsApp" or make "Buy Now" open checkout/cart consistently.
- Establish CTA hierarchy: primary add/buy action, secondary wishlist or WhatsApp.
- Add compact trust microcopy to cards where useful: "COD available", "Islandwide delivery", or warranty badge.

Medium:

- Use stock messaging rules:
  - "In stock" for normal inventory.
  - "Only X left" only below a low-stock threshold.
  - "Out of stock" when unavailable.
- Replace "No Reviews" with a less negative empty state.
- Improve product card metadata order: title, price, benefit, rating, actions.

Low:

- Slightly reduce decorative effects where they compete with price and CTA clarity.

## 4. Product Detail Audit

### What Works

- Product detail modal is rich and feature-complete.
- Image gallery supports thumbnails, arrows, swipe, hover zoom, and lightbox.
- Price, discount, stock, brand, SKU, reviews, specs, related products, and delivery/trust information are present.
- Low-stock urgency appears when relevant.
- Review creation, update, and display are integrated.
- Related products help keep customers browsing.

### Issues

Critical:

- No critical product detail purchase blocker was found.

High:

- Product detail is modal-based instead of route-based. This weakens SEO, shareability, browser back behavior, analytics, and direct product links.
- The page contains many visual modules in a constrained modal, which can feel dense on mobile.
- Buy actions can be confusing if cart checkout and WhatsApp order are both presented as similar paths.

Medium:

- Review submission uses browser-style alerts for some validation/auth states, which feels less polished than inline messaging.
- Customers who are not logged in may not get a clear inline reason or path to review.
- Delivery information is helpful but could be more specific by district or estimated time.
- Specifications are present but may need normalization to avoid inconsistent supplier data presentation.

Low:

- Lightbox/gallery behavior is strong, but it should be tested on small mobile devices for gesture conflicts.

### Recommendations

High:

- Plan a future route-based product detail page while keeping the modal as a quick-view option if desired.
- Clarify purchase options:
  - "Add to Cart" for normal checkout.
  - "Order on WhatsApp" for assisted ordering.
  - Avoid using "Buy Now" for two different mental models.

Medium:

- Replace alert-based review/auth feedback with inline messages and direct sign-in prompts.
- Add product-level trust details: warranty period, return terms, delivery estimate, genuine product assurance.
- Ensure related products are highly relevant by category, price range, and availability.

Low:

- Keep image zoom/lightbox, but make sure it does not trap mobile users or hide checkout actions.

## 5. Cart Audit

### What Works

- Cart drawer is polished and complete.
- Quantity controls and removal flow are available.
- Empty cart state is clear.
- Delivery fee calculation is integrated with district selection.
- Free delivery progress indicator is useful.
- Summary displays subtotal, delivery, savings, and total.
- Checkout CTA is visually prominent.
- Success state includes order reference, customer details, total, and WhatsApp notification option.

### Issues

Critical:

- No critical cart blocker was found.

High:

- Cart and checkout are combined in one drawer, which can feel long on mobile.
- There is no explicit step indicator such as Cart -> Delivery -> Confirm.
- "Notify via WhatsApp" after success could make customers wonder whether the order was already submitted.

Medium:

- Delivery fee appears before district is selected, but the final delivery confidence depends on district choice.
- Remove flow is immediate; there is no undo.
- The success screen should emphasize the official order number if available, not only the internal order id.

Low:

- Cart summary is visually good, but repeated trust badges could be consolidated.

### Recommendations

High:

- Add a lightweight checkout step indicator without changing the checkout contract.
- Reword post-order WhatsApp action to make it clear the order is already placed, for example "Send order details on WhatsApp".

Medium:

- Add undo for removed cart items.
- Show delivery estimate once district is selected.
- Prefer human-friendly order number on success if already returned by the API.

Low:

- Keep the drawer pattern, but ensure bottom CTAs are never hidden by the mobile bottom navigation.

## 6. Checkout Audit

### What Works

- Checkout collects name, primary phone, optional secondary phone, email, district, city, address, and payment method.
- COD is clearly represented.
- Validation errors are shown before submission.
- Server-side checkout protection, validation, rate limiting, and idempotency are already implemented from prior sprints.
- Button disables during submission.
- Checkout success state is strong enough for launch.

### Issues

Critical:

- No critical checkout blocker was found in the UI read-through.

High:

- Progress clarity is weak. Customers do not see a clear checkout journey.
- Error handling exists, but messages can be more actionable and field-specific.
- Customer confidence can be improved at the exact submit moment with short reassurance copy.

Medium:

- Phone formatting guidance is minimal.
- Address field could benefit from clearer local delivery hints.
- Payment method is fixed to COD, but the UI should make this feel like a deliberate supported choice rather than a missing payment feature.

Low:

- The form is visually consistent but dense inside a drawer on mobile.

### Recommendations

High:

- Add a visible checkout step model: Review Cart, Delivery Details, Place Order.
- Add reassurance near submit: "No online payment required. We will confirm before delivery."
- Make validation messages field-level where possible.

Medium:

- Add Sri Lanka phone format guidance.
- Add district/city delivery helper text.
- Clarify COD terms and inspection-on-delivery messaging.

Low:

- Preserve current contract and backend behavior; this is a UI-only improvement area.

## 7. Visual Design Audit

### What Works

- The storefront uses a modern visual language.
- Cards, shadows, rounded corners, transitions, and icons are consistently applied.
- Product imagery is prioritized.
- Brand blue and dark slate create a trustworthy electronics feel.
- Loading states and overlays are polished.

### Issues

Critical:

- No critical visual design blocker was found.

High:

- Visual hierarchy can become flat because many sections use similar card, shadow, and rounded styles.
- The dominant blue/slate palette is professional but risks feeling repetitive.
- Some CTAs compete visually instead of creating one obvious next action.

Medium:

- Hero imagery can feel atmospheric instead of product-specific.
- Typography is modern, but section headings and product cards should have clearer scale differences.
- Some badges and pills add noise when many products are shown at once.

Low:

- External Google Fonts improve design but add a third-party performance dependency.

### Recommendations

High:

- Define a stricter CTA system:
  - Primary purchase action.
  - Secondary support/contact action.
  - Tertiary icon-only wishlist/share actions.
- Add more visual variation between homepage bands.
- Use accent colors only for meaningful states: discount, success, warning, stock, trust.

Medium:

- Use product/category-specific imagery in hero and campaign banners.
- Tighten badge rules so badges communicate only meaningful buying signals.

Low:

- Consider self-hosting critical fonts or improving fallback strategy if performance becomes an issue.

## 8. Mobile Experience Audit

### What Works

- Mobile bottom navigation gives quick access to core actions.
- Product cards are mobile-aware with shortened CTA labels.
- Product detail modal includes mobile gestures.
- Cart drawer and checkout are responsive.
- Sticky/fixed actions help keep shopping controls available.

### Issues

Critical:

- No critical mobile blocker was found.

High:

- Hero height is too large for fast mobile shopping.
- Multiple fixed/sticky surfaces can compete: header, bottom nav, product modal sticky actions, cart drawer CTA.
- Cart and checkout inside a drawer can become deep and scroll-heavy.

Medium:

- Touch targets appear generally good, but dense areas such as thumbnails, quantity controls, modal close, and drawer controls should be manually tested on small screens.
- The bottom navigation may cover content near the bottom unless all screens account for safe padding.
- Mobile search is available in drawer/menu, but not as fast as an always-visible mobile search pattern.

Low:

- Some animation and hover-oriented affordances are less valuable on touch devices.

### Recommendations

High:

- Reduce mobile hero height and bring categories/products into the first scroll.
- Audit every modal/drawer screen with bottom navigation visible.
- Add bottom safe spacing where content or CTAs can be occluded.

Medium:

- Consider a mobile search bar directly below the header on storefront pages.
- Test key flows on narrow devices:
  - Open product.
  - Add to cart.
  - Change quantity.
  - Checkout.
  - Submit invalid form.
  - Submit successful order.

Low:

- Reduce nonessential hover transitions on mobile if performance perception suffers.

## 9. Conversion Optimization Audit

### Conversion Reducers Found

Critical:

- No immediate critical conversion blocker was found.

High:

- CTA ambiguity between app checkout and WhatsApp order.
- Above-the-fold content does not expose products quickly enough.
- Hero message is broad instead of offer-led.
- Product detail is not shareable or SEO-friendly as a direct route.
- Production settings fallbacks can display "pending setup" style copy.
- Auth modal includes developer/demo-oriented fallback messaging that should not appear in production.
- Newsletter subscription is not clearly backed by a durable subscription system.

Medium:

- Search has no suggestions, recent searches, or quick results.
- Category discovery can be stronger.
- Empty review states may reduce trust.
- Checkout lacks visible steps.
- Trust badges are generic and not always near the exact decision point.
- No obvious order tracking/account order history entry point for customers.
- Delivery estimate is not specific enough before checkout.
- Missing urgency on real offers, promotions, or limited stock except low stock labels.

Low:

- Some product sections may be too similar.
- Badge density can distract from price and CTA.
- Footer category links may not always match active merchandising strategy.

### Highest-Impact Pre-Redesign Fixes

1. Clarify purchase CTAs across card, product detail, cart, and checkout.
2. Reduce hero height and add concrete value proposition above the fold.
3. Remove or replace all production fallback text before launch.
4. Replace developer/demo auth copy with customer-safe messaging.
5. Make checkout progress clearer.
6. Improve mobile bottom spacing and sticky control behavior.
7. Make newsletter behavior production-real or remove it from launch.
8. Add delivery, warranty, and COD reassurance closer to product CTAs.
9. Plan route-based product detail pages for SEO and shareability.
10. Add analytics events for search, product view, add to cart, checkout start, checkout success, WhatsApp order, wishlist, and review submission.

## Priority Roadmap For Storefront UX

### Critical

No critical storefront blocker was identified from static code review. Critical status should be reserved for issues discovered during live manual QA, such as broken checkout, broken product rendering, broken mobile cart, or broken auth.

Estimated remaining UX work: 0% critical.

### High

- Clarify "Buy Now" versus WhatsApp ordering.
- Reduce hero height and improve first-viewport merchandising.
- Remove production fallback copy from visible customer UI.
- Remove developer/demo auth fallback messaging.
- Add checkout step/progress clarity.
- Verify wishlist visibility respects global settings everywhere.
- Ensure mobile bottom navigation never hides drawer/modal CTAs.
- Make newsletter production-real or remove it before launch.

Estimated remaining UX work: 45%.

### Medium

- Improve category discovery and search experience.
- Add route-based product detail pages.
- Improve empty review states.
- Add delivery ETA and warranty details near CTAs.
- Add undo for cart item removal.
- Add field-level checkout validation messaging.
- Strengthen product card hierarchy and trust microcopy.
- Add analytics instrumentation for funnel analysis.

Estimated remaining UX work: 40%.

### Low

- Refine visual variation between homepage sections.
- Reduce badge noise.
- Tune animation/hover behavior on mobile.
- Improve footer category strategy.
- Consider self-hosted fonts or optimized font loading.

Estimated remaining UX work: 15%.

## Recommended Redesign Strategy

### Phase 1: Conversion Cleanup Without Architecture Changes

Goal: improve customer clarity while preserving all existing behavior.

- Rename or separate WhatsApp order actions.
- Tighten hero height, copy, and CTA destinations.
- Replace pending setup text with production-safe fallbacks or hide incomplete fields.
- Remove developer/demo language from customer auth flows.
- Add checkout progress and confidence messaging.
- Ensure mobile bottom nav, cart drawer, and product modal do not overlap.
- Make newsletter behavior honest and durable.

Rollback point: all changes should be UI text/layout changes only and can be reverted component by component.

### Phase 2: Storefront Redesign

Goal: improve merchandising, SEO, and browsing.

- Add route-based product detail pages.
- Improve category landing pages and filtering.
- Add search suggestions or instant search results.
- Improve product cards with stronger price, trust, and CTA hierarchy.
- Add more specific delivery and warranty modules.
- Improve review prompts and logged-out review UX.

Rollback point: keep modal PDP available until routed PDP is fully verified.

### Phase 3: Optimization And Experimentation

Goal: measure and optimize.

- Add funnel analytics.
- Add A/B testing for hero, CTA labels, and checkout wording.
- Add performance monitoring for storefront routes.
- Add structured product data for SEO.
- Add customer order tracking and account order history if not already planned.

Rollback point: analytics and experiments must not block checkout or product browsing.

## Final Recommendation

Zyro.lk storefront is ready for a controlled soft launch after a focused UX cleanup pass. It should not be fully redesigned before validating the current funnel with real users, because the existing foundation is strong and the highest-value fixes are mostly clarity, trust, mobile spacing, and conversion hierarchy.

Recommended next action: implement the High priority Phase 1 storefront UX cleanup as Sprint 17, with no backend contract changes and no changes to checkout logic.

## Verification Notes

- This report was produced from static code and documentation review.
- No application code was modified.
- No Firebase schema, rules, API contracts, checkout logic, Supplier Hub logic, review aggregate logic, or deployment configuration was changed.
- No commit or push was performed.
