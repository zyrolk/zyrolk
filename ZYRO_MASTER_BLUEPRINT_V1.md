# Zyro.lk Master Blueprint v1.0

> Authoritative project direction saved on 2026-07-15.

## Vision

Zyro.lk is not a conventional e-commerce website. It is an AI-powered Sri Lankan commerce platform intended to grow into a marketplace, Supplier Hub, AI Manager, and international trading platform.

## Project Modules

```text
Zyro.lk
|
+-- Shop
+-- Admin
+-- Supplier Hub
+-- AI Manager
+-- Marketing Hub
+-- Inventory
+-- Analytics
+-- Marketplace
`-- Core Platform
```

## Module 1 — Shop

### Completed

- Homepage
- Products
- Categories
- Product Details
- Wishlist
- Cart
- Checkout
- Orders
- CMS Pages
- Contact Page

### Remaining

- React Router
- Product URLs
- Category URLs
- Search improvements
- Filters
- Sorting
- Customer order tracking
- Better notifications

## Module 2 — Admin

### Completed

- Dashboard
- Products
- Categories
- Orders
- Customers
- CMS
- Website Settings

### Remaining

- Component split
- Audit logs
- Roles and permissions
- Better reports
- Pagination

## Module 3 — Supplier Hub (Current Focus)

### Completed

- Supplier Sources
- A2Z Connector
- Supplier Sync
- Product Compare
- Approval Workflow
- Reject Workflow
- Direct Product Write bug fix
- Architecture planning
- Production planning

### Remaining sequence

1. API deployment parity
2. Server-side admin authentication
3. SSRF protection
4. Durable Review Queue
5. Approval audit trail
6. Scheduled sync
7. Multi-supplier support

## Module 4 — AI Manager (Future)

- AI product descriptions
- AI SEO
- AI pricing
- AI margin
- AI trend analysis
- AI inventory
- AI marketing
- AI business assistant

## Module 5 — Marketing Hub (Future)

- Facebook posts
- TikTok scripts
- WhatsApp campaigns
- Email campaigns
- Coupons
- Promotions

## Module 6 — Inventory (Future)

- Stock management
- Inventory history
- Supplier deliveries
- Low-stock alerts
- Warehouse management

## Module 7 — Analytics (Future)

- Sales reports
- Profit reports
- Supplier analytics
- Customer analytics
- AI reports

## Module 8 — Marketplace (Future)

- Multiple suppliers
- Auto import
- Auto price updates
- Auto stock updates
- Supplier ranking
- Conflict resolution

## Backend Architecture

```text
Customer
   |
   v
Firebase Hosting
   |
   v
/api/**
   |
   v
Express API (Firebase HTTPS Function)
   |
   +-- Checkout
   +-- Supplier Hub
   +-- Admin API
   +-- Customer API
   +-- AI API
   `-- Marketplace API

Background Functions
   +-- Scheduled Supplier Sync
   +-- Notifications
   +-- Review Aggregation
   +-- Automation
   `-- AI Jobs

Future: Cloud Run
   +-- Heavy AI
   +-- Trading Engine
   `-- Marketplace Workers
```

## Database Domains

- Products
- Categories
- Orders
- Users
- Reviews
- Pages
- Website Settings
- Supplier Sources
- Supplier Review Queue
- Supplier Import Queue
- Supplier Pending Changes
- Supplier Sync History
- Inventory
- Analytics

## Security

- Firebase Auth
- Firestore Rules
- Admin roles
- Server-side validation
- Rate limiting
- SSRF protection
- Admin middleware

## Development Rules

1. Develop module by module.
2. Never rewrite working features.
3. Make incremental changes only.
4. Lint must pass.
5. Build must pass.
6. Perform manual verification.
7. Commit and push only after verification and when explicitly authorized.
8. Keep the working tree clean after delivery.

## Development Order

1. Supplier Hub
2. Shop improvements
3. Admin improvements
4. AI Manager
5. Marketing Hub
6. Inventory
7. Analytics
8. Marketplace

## Final Goal

```text
Supplier
   |
   v
Supplier Hub
   |
   v
Approval
   |
   v
Live Products
   |
   v
Orders
   |
   v
Inventory
   |
   v
AI Manager
   |
   v
Marketing Hub
   |
   v
Analytics
   |
   v
Marketplace
   |
   v
International Trading
```

## Status Snapshot — Blueprint v1.0

| Area | Progress |
|---|---:|
| Foundation | 100% |
| Documentation | 100% |
| Architecture | 100% |
| Supplier Hub | 60% |
| Shop | 80% |
| Admin | 75% |
| Security | 70% |
| Performance | 60% |
| AI Manager | 10% |
| Marketplace | 5% |
| Overall | Approximately 70% |

## Governing Direction

This blueprint is the master map for Zyro.lk. Future work should follow the module order above, preserve working functionality, and keep Supplier Hub as the immediate development priority until its production workflow is complete.
