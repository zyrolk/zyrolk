export interface SupplierPortalProfile {
  supplierId: string;
  companyName: string;
  contactPerson: string;
  phone: string;
  email: string;
  address: string;
  businessRegistrationNumber: string;
  profileStatus: string;
  bankDetails: {
    accountHolderName?: string;
    bankName?: string;
    branchName?: string;
    accountNumber?: string;
  };
}

export interface SupplierPortalProduct {
  id: string;
  name: string;
  sku: string;
  supplierItemCode: string;
  brand: string;
  model: string;
  barcode: string;
  productType: string;
  category: string;
  subcategory: string;
  description: string;
  shortDescription: string;
  price: number;
  stock: number;
  lowStockLimit: number;
  imageUrl: string;
  imageUrls: string[];
  tags: string[];
  keyFeatures: string[];
  whatsIncluded: string[];
  specs: Record<string, string>;
  isActive: boolean;
  updatedAt: string;
}

export interface SupplierProductDraft extends Omit<SupplierPortalProduct, 'id' | 'sku' | 'lowStockLimit' | 'isActive' | 'updatedAt' | 'supplierItemCode'> {
  supplierSku: string;
}

export interface SupplierProductRequest {
  id: string;
  requestType: 'new_product' | 'product_change' | 'stock_change';
  productId: string;
  productName: string;
  supplierSku: string;
  status: 'draft' | 'pending' | 'approved' | 'rejected';
  rejectionReason: string;
  productPayload: Partial<SupplierPortalProduct>;
  createdAt: string;
  updatedAt: string;
  submittedAt: string;
  reviewedAt: string;
}

export interface SupplierPortalOrder {
  id: string;
  orderNumber: string;
  customerName: string;
  customerPhone: string;
  customerAddress: string;
  district: string;
  city: string;
  items: Array<{ productId: string; name: string; price: number; quantity: number; imageUrl: string }>;
  supplierTotal: number;
  status: string;
  supplierFulfilmentStatus: 'pending' | 'processing' | 'packed' | 'shipped';
  paymentMethod: string;
  paymentStatus: string;
  createdAt: string;
  supplierFulfilmentUpdatedAt: string;
}

export interface SupplierPortalNotification {
  id: string;
  type: 'product_approved' | 'product_rejected' | 'new_order' | 'low_stock' | string;
  title: string;
  message: string;
  isRead: boolean;
  createdAt: string;
}

export interface SupplierCatalogCategory {
  id: string;
  name: string;
  subcategories: Array<{ id: string; name: string; isActive?: boolean }>;
  specificationTemplate: Array<{ name: string; required?: boolean }>;
}

export interface SupplierPortalData {
  success: true;
  profile: SupplierPortalProfile;
  products: SupplierPortalProduct[];
  requests: SupplierProductRequest[];
  orders: SupplierPortalOrder[];
  notifications: SupplierPortalNotification[];
  summary: {
    totalProducts: number;
    pendingProducts: number;
    approvedProducts: number;
    rejectedProducts: number;
    activeOrders: number;
    monthlySales: number;
    lowStockProducts: number;
  };
  catalog: {
    categories: SupplierCatalogCategory[];
    brands: Array<{ id: string; name: string }>;
  };
}
