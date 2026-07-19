# Product Field Permission Matrix

This document is the launch-phase authorization contract for Product Management.
No product, brand, subcategory, or specification-template field may be added
without defining its storage location and permissions here first.

`Supplier editable` means a supplier feed may propose a value through the
existing review queue. It does not grant a supplier direct write access to live
product documents. Sprint L2 does not change Supplier Hub workflows.

## Product fields

| Field | Storage | Customer read | Admin edit | Supplier | System generated |
| --- | --- | --- | --- | --- | --- |
| `id` | `products` document ID and field | Yes | Create only | Read only | Yes |
| `name` | `products` | Yes | Yes | Propose | No |
| `sku` | `products` | Yes | Read only after creation | Read only | Yes |
| `brand` | `products` (brand document ID) | Yes | Select only | Propose | No |
| `model` | `products` | Yes | Yes | Propose | No |
| `barcode` | `products` | Yes | Yes | Propose | No |
| `productType` | `products` | Yes | Yes | Propose | No |
| `category` | `products` (category document ID) | Yes | Select only | Propose/mapped | No |
| `subcategory` | `products` (subcategory ID) | Yes | Select only | Propose/mapped | No |
| `tags` | `products` | Yes | Yes | Propose | No |
| `description` | `products` | Yes | Yes | Propose | No |
| `shortDescription` | `products` | Yes | Yes | Propose | No |
| `keyFeatures` | `products` | Yes | Yes | Propose | No |
| `whatsIncluded` | `products` | Yes | Yes | Propose | No |
| `specs` | `products` | Yes | Yes | Propose | No |
| `price` | `products` | Yes | Yes | Propose | No |
| `originalPrice` | `products` | Yes | Yes | Propose | No |
| `discount` | `products` | Yes | No | Read only | Yes, derived from prices |
| `stock` | `products` | Yes | Yes | Propose/sync | Reservation logic also updates it |
| `imageUrl` | `products` | Yes | Yes | Propose | No |
| `imageUrls` | `products` | Yes | Yes | Propose | No |
| `isActive` | `products` | Yes | Yes | Read only | No |
| `isNew` | `products` | Yes | Yes | Read only | No |
| `isFeatured` | `products` | Yes | Yes | Read only | No |
| `isBestSeller` | `products` | Yes | Yes | Read only | No |
| `rating` | `products` | Yes | No | Read only | Yes, review aggregate |
| `reviewsCount` | `products` | Yes | No | Read only | Yes, review aggregate |
| `createdAt` | `products` | Yes | No | Read only | Yes |
| `updatedAt` | `products` | Yes | No | Read only | Yes |

## Private product commercial fields

Sprint L5.1 stores these fields in `product_private/{productId}` rather than the
public `products` document. The Admin Product Editor merges the private record;
Supplier Portal receives only the explicitly allowlisted supplier-required
projection through the trusted API.

| Field | Storage | Customer visible | Admin | Supplier | System generated |
| --- | --- | --- | --- | --- | --- |
| `supplierItemCode` | `product_private` | No | Read/edit | Propose and read for own product | No |
| `supplierItemCodeNormalized` | `product_private` | No | Read only | No direct access | Yes |
| `supplierId` | `product_private` | No | Read/edit assignment | Read own association through API | Authenticated workflow |
| `costPrice` | `product_private` | No | Read/edit | No access | Supplier feed may propose to admin queue |
| `marketPrice` | `product_private` | No | Read/edit | No access | Supplier feed may propose to admin queue |
| `supplierPurchasePrice` | `product_private` | No | Read/edit | No access | No |
| `supplierInternalNotes` | `product_private` | No | Read/edit | No access | No |
| `supplierProfit` | `product_private` | No | Read only | No access | Derived when used |
| `supplierPrice` | `product_private` | No | Read/edit | No access | No |
| `purchasePrice` | `product_private` | No | Read/edit | No access | No |
| `profitMargin` | `product_private` | No | Read only | No access | Derived when used |
| `commission` | `product_private` | No | Read/edit | No access | No |
| `supplierMetadata` | `product_private` | No | Read/edit | No access | Integration generated |
| `supplierCommercialMetadata` | `product_private` | No | Read/edit | No access | Integration generated |
| `wholesalePrice` | `product_private` | No | Read/edit | No access | Supplier feed may propose to admin queue |
| `recommendedRetailPrice` | `product_private` | No | Read/edit | No access | Supplier feed may propose to admin queue |
| `supplierCode` | `product_private` | No | Read/edit | Read own through allowlisted API when required | Integration generated |
| `supplierSku` / `supplierSKU` | `product_private` | No | Read/edit | Propose and read own through API | No |
| `supplierCost` / `internalCost` | `product_private` | No | Read/edit | No access | No |
| `margin` / `profit` | `product_private` | No | Read only | No access | Derived when used |
| `supplierSourceId` / `supplierSource` | `product_private` | No | Read/edit | No access | Integration generated |
| `supplierLeadTime` | `product_private` | No | Read/edit | Propose when supported | No |
| `supplierMoq` / `supplierMOQ` | `product_private` | No | Read/edit | Propose when supported | No |
| `productId` | `product_private` | No | Read only | No direct access | Mirrors document ID |
| `updatedAt` / `migratedAt` | `product_private` | No | Read only | No direct access | Yes |

## Brand fields

| Field | Storage | Customer read | Admin edit | Supplier | System generated |
| --- | --- | --- | --- | --- | --- |
| `id` | `brands` document ID and field | Yes | Create only | Read only | Derived from name at creation |
| `name` | `brands` | Yes | Yes | Read only | No |
| `isActive` | `brands` | Yes | Yes | Read only | No |
| `createdAt` | `brands` | Yes | No | Read only | Yes |
| `updatedAt` | `brands` | Yes | No | Read only | Yes |

Brand deletion is blocked while any product references the brand ID. Products
select registered brands; Product Management never accepts a free-text brand.

## Category blueprint fields

| Field | Storage | Customer read | Admin edit | Supplier | System generated |
| --- | --- | --- | --- | --- | --- |
| `subcategories[].id` | `categories` | Yes | Create only within category | Propose/mapped | Derived from name at creation |
| `subcategories[].name` | `categories` | Yes | Yes | Read only | No |
| `subcategories[].isActive` | `categories` | Yes | Yes | Read only | No |
| `specificationTemplate[].name` | `categories` | Yes | Yes | Read only | No |
| `specificationTemplate[].required` | `categories` | Yes | Yes | Read only | No |
| `updatedAt` | `categories` | Yes | No | Read only | Yes |

Category deletion remains blocked while products reference it. A subcategory
must belong to its selected category, and a required specification must contain
a non-empty product value before a product can be saved.

## Enforcement

- Admin Product Management never renders editable controls for `rating`,
  `reviewsCount`, or `discount`.
- New products initialize `rating` and `reviewsCount` to zero.
- Edits preserve review aggregates from the stored product, not form input.
- Discount is recalculated from `price` and `originalPrice` during every save.
- Supplier Hub is unchanged by Sprint L2.
- Firestore rules permit public reads and admin-only writes for the `brands`
  registry, matching the existing category registry boundary.

## Sprint L3 Supplier Portal fields

Supplier Portal writes are server-authoritative. `Supplier editable` below means
the supplier may send a validated proposal to the trusted API; it never grants
direct write access to live products, orders, approval queues, or inventory.

| Field | Storage | Customer visible | Admin | Supplier | System generated |
| --- | --- | --- | --- | --- | --- |
| `supplierId` | supplier profile, request, notification, assigned product/order | No | Read/write | Read only | Yes, authenticated UID |
| `companyName` | `supplier_profiles` | No | Read/write | Edit own | No |
| `contactPerson` | `supplier_profiles` | No | Read/write | Edit own | No |
| `phone` | `supplier_profiles` | No | Read/write | Edit own | No |
| `email` | `supplier_profiles` | No | Read/write | Read only | Yes, authenticated email |
| `address` | `supplier_profiles` | No | Read/write | Edit own | No |
| `bankDetails` | `supplier_profiles` | No | Read/write | Edit/read own | No |
| `businessRegistrationNumber` | `supplier_profiles` | No | Read/write | Edit own | No |
| `profileStatus` | `supplier_profiles` | No | Read/write | Read only | Admin-controlled |
| `requestType` | `supplier_product_requests` | No | Read/write | Select through allowed actions | No |
| `productPayload` | `supplier_product_requests`, approval queue | No until approved | Review/edit/approve | Propose and edit while draft | No |
| `supplierSku` | product request | No until approved | Review | Propose; read only after submission | No |
| `request.status` | product request | No | Approve/reject | Read only | Workflow generated |
| `rejectionReason` | product request | No | Edit | Read own | Admin generated |
| `supplierFulfilmentStatus` | assigned order | Customer order UI unchanged | Read/write | Advance assigned orders only | Workflow generated |
| `supplierFulfilmentUpdatedAt` | assigned order | No | Read | Read own assigned order | Yes |
| `notification.type/message/isRead` | `supplier_notifications` | No | Read/write | Read own; mark own stored notification read | System/admin generated |
| SKU/product duplicate claims | private claim collections | No | Trusted server only | No access | Yes |

The Supplier Portal API returns allowlisted projections. Supplier responses do
not include approval audit data, source credentials, internal synchronization
settings, payment references, inventory reservation fields, or legacy product
cost fields.
