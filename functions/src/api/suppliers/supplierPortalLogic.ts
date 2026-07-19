import { ApiError } from "../errors";

export const SUPPLIER_REQUEST_STATUSES = ["draft", "pending", "approved", "rejected"] as const;
export const SUPPLIER_FULFILMENT_STATUSES = ["pending", "processing", "packed", "shipped"] as const;

export type SupplierRequestStatus = typeof SUPPLIER_REQUEST_STATUSES[number];
export type SupplierFulfilmentStatus = typeof SUPPLIER_FULFILMENT_STATUSES[number];

export interface SupplierProfileInput {
  companyName?: unknown;
  contactPerson?: unknown;
  phone?: unknown;
  address?: unknown;
  businessRegistrationNumber?: unknown;
  bankDetails?: unknown;
}

export interface SupplierProductDraftInput {
  name?: unknown;
  supplierSku?: unknown;
  brand?: unknown;
  category?: unknown;
  subcategory?: unknown;
  productType?: unknown;
  model?: unknown;
  barcode?: unknown;
  description?: unknown;
  shortDescription?: unknown;
  price?: unknown;
  stock?: unknown;
  imageUrl?: unknown;
  imageUrls?: unknown;
  tags?: unknown;
  keyFeatures?: unknown;
  whatsIncluded?: unknown;
  specs?: unknown;
}

export interface SanitizedSupplierProfile {
  companyName: string;
  contactPerson: string;
  phone: string;
  address: string;
  businessRegistrationNumber: string;
  bankDetails: {
    accountHolderName: string;
    bankName: string;
    branchName: string;
    accountNumber: string;
  };
}

export interface SanitizedSupplierProductDraft {
  name: string;
  supplierSku: string;
  brand: string;
  category: string;
  subcategory: string;
  productType: string;
  model: string;
  barcode: string;
  description: string;
  shortDescription: string;
  price: number;
  stock: number;
  imageUrl: string;
  imageUrls: string[];
  tags: string[];
  keyFeatures: string[];
  whatsIncluded: string[];
  specs: Record<string, string>;
}

const text = (value: unknown, maximum: number): string => typeof value === "string"
  ? value.normalize("NFKC").trim().replace(/\s+/gu, " ").slice(0, maximum)
  : "";

const textList = (value: unknown, maximumItems: number, maximumLength: number): string[] => {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => text(item, maximumLength)).filter(Boolean))].slice(0, maximumItems);
};

const numberValue = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

export const normalizeSupplierSku = (value: unknown): string => text(value, 80).toLocaleLowerCase().replace(/[^a-z0-9._-]+/gu, "-");

export const normalizeProductFingerprint = (draft: Pick<SanitizedSupplierProductDraft, "name" | "brand" | "model">): string => (
  [draft.name, draft.brand, draft.model].map((value) => text(value, 160).toLocaleLowerCase()).join("|")
);

export function sanitizeSupplierProfile(input: SupplierProfileInput): SanitizedSupplierProfile {
  const bankDetails = input.bankDetails && typeof input.bankDetails === "object"
    ? input.bankDetails as Record<string, unknown>
    : {};
  const profile: SanitizedSupplierProfile = {
    companyName: text(input.companyName, 160),
    contactPerson: text(input.contactPerson, 120),
    phone: text(input.phone, 30),
    address: text(input.address, 500),
    businessRegistrationNumber: text(input.businessRegistrationNumber, 80),
    bankDetails: {
      accountHolderName: text(bankDetails.accountHolderName, 160),
      bankName: text(bankDetails.bankName, 120),
      branchName: text(bankDetails.branchName, 120),
      accountNumber: text(bankDetails.accountNumber, 50),
    },
  };
  if (!profile.companyName) throw new ApiError("Company name is required", 400);
  if (!profile.contactPerson) throw new ApiError("Contact person is required", 400);
  if (!/^[+0-9][0-9 ()-]{8,29}$/u.test(profile.phone)) throw new ApiError("Enter a valid supplier phone number", 400);
  if (!profile.address) throw new ApiError("Supplier address is required", 400);
  const hasSomeBankDetails = Object.values(profile.bankDetails).some(Boolean);
  if (hasSomeBankDetails && Object.values(profile.bankDetails).some((value) => !value)) {
    throw new ApiError("Complete every bank detail before saving", 400);
  }
  return profile;
}

export function sanitizeSupplierProductDraft(input: SupplierProductDraftInput): SanitizedSupplierProductDraft {
  const specs = input.specs && typeof input.specs === "object" && !Array.isArray(input.specs)
    ? Object.fromEntries(Object.entries(input.specs as Record<string, unknown>)
      .map(([key, value]) => [text(key, 80), text(value, 240)] as const)
      .filter(([key]) => Boolean(key))
      .slice(0, 40))
    : {};
  return {
    name: text(input.name, 180),
    supplierSku: text(input.supplierSku, 80),
    brand: text(input.brand, 100),
    category: text(input.category, 100),
    subcategory: text(input.subcategory, 100),
    productType: text(input.productType, 100),
    model: text(input.model, 100),
    barcode: text(input.barcode, 20),
    description: text(input.description, 10_000),
    shortDescription: text(input.shortDescription, 500),
    price: numberValue(input.price),
    stock: Math.floor(numberValue(input.stock)),
    imageUrl: text(input.imageUrl, 2_000),
    imageUrls: textList(input.imageUrls, 8, 2_000),
    tags: textList(input.tags, 20, 60),
    keyFeatures: textList(input.keyFeatures, 20, 240),
    whatsIncluded: textList(input.whatsIncluded, 20, 240),
    specs,
  };
}

export function validateSupplierProductForSubmission(
  draft: SanitizedSupplierProductDraft,
  category: Record<string, unknown> | undefined,
  brand: Record<string, unknown> | undefined,
): string[] {
  const errors: string[] = [];
  if (!draft.name) errors.push("Product name is required.");
  if (!normalizeSupplierSku(draft.supplierSku)) errors.push("Supplier SKU is required.");
  if (!brand || brand.isActive === false) errors.push("Select an active registered brand.");
  if (!category || category.isActive === false) errors.push("Select an active category.");
  const subcategories = Array.isArray(category?.subcategories) ? category.subcategories as Array<Record<string, unknown>> : [];
  const subcategory = subcategories.find((item) => item.id === draft.subcategory);
  if (!subcategory || subcategory.isActive === false) errors.push("Select an active subcategory belonging to the category.");
  if (!draft.productType) errors.push("Product type is required.");
  if (!Number.isFinite(draft.price) || draft.price <= 0) errors.push("Proposed selling price must be greater than zero.");
  if (!Number.isInteger(draft.stock) || draft.stock < 0) errors.push("Stock must be a non-negative whole number.");
  if (!/^https?:\/\/[^\s]+$/iu.test(draft.imageUrl)) errors.push("A valid HTTP or HTTPS main image is required.");
  if (draft.imageUrls.some((url) => !/^https?:\/\/[^\s]+$/iu.test(url))) errors.push("Every gallery image must use HTTP or HTTPS.");
  if (draft.barcode && !/^\d{8,14}$/u.test(draft.barcode)) errors.push("Barcode must contain 8 to 14 digits.");
  const template = Array.isArray(category?.specificationTemplate) ? category.specificationTemplate as Array<Record<string, unknown>> : [];
  for (const field of template) {
    const fieldName = text(field.name, 80);
    if (field.required === true && fieldName && !text(draft.specs[fieldName], 240)) {
      errors.push(`Required specification "${fieldName}" must have a value.`);
    }
  }
  return errors;
}

export function assertSupplierOrderTransition(current: unknown, next: unknown, orderStatus: unknown): SupplierFulfilmentStatus {
  const currentStatus = text(current, 30).toLocaleLowerCase() || "pending";
  const nextStatus = text(next, 30).toLocaleLowerCase() as SupplierFulfilmentStatus;
  const allowedNext: Record<string, SupplierFulfilmentStatus[]> = {
    pending: ["processing"],
    processing: ["packed"],
    packed: ["shipped"],
    shipped: [],
  };
  if (["cancelled", "delivered"].includes(text(orderStatus, 30).toLocaleLowerCase())) {
    throw new ApiError("Completed or cancelled orders cannot be changed by suppliers", 409);
  }
  if (!allowedNext[currentStatus]?.includes(nextStatus)) {
    throw new ApiError(`Fulfilment cannot move from ${currentStatus} to ${nextStatus}`, 409);
  }
  return nextStatus;
}

export function supplierOwnsOrder(order: Record<string, unknown>, supplierId: string): boolean {
  return order.supplierId === supplierId
    || (Array.isArray(order.supplierIds) && order.supplierIds.includes(supplierId));
}

export function calculateSupplierSummary(
  products: Array<Record<string, unknown>>,
  requests: Array<Record<string, unknown>>,
  orders: Array<Record<string, unknown>>,
  now = new Date(),
): Record<string, number> {
  const month = now.getUTCMonth();
  const year = now.getUTCFullYear();
  const monthlySales = orders.reduce((total, order) => {
    const createdAt = new Date(String(order.createdAt || ""));
    if (order.status !== "delivered" || Number.isNaN(createdAt.getTime()) || createdAt.getUTCMonth() !== month || createdAt.getUTCFullYear() !== year) return total;
    return total + Number(order.supplierTotal || 0);
  }, 0);
  return {
    totalProducts: products.length,
    pendingProducts: requests.filter((request) => request.status === "pending").length,
    approvedProducts: products.filter((product) => product.isActive !== false).length,
    rejectedProducts: requests.filter((request) => request.status === "rejected").length,
    activeOrders: orders.filter((order) => !["delivered", "cancelled"].includes(String(order.status || ""))).length,
    monthlySales,
    lowStockProducts: products.filter((product) => Number(product.stock || 0) <= Number(product.lowStockLimit || 5)).length,
  };
}
