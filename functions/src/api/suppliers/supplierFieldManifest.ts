import type { RawA2ZProduct } from "./a2z/types";

export type SupplierFieldScope = "public" | "private" | "workflow";
export type SupplierFieldOwnership = "supplier" | "admin" | "derived" | "system";
export type SupplierFieldSyncGroup = "identity" | "pricing" | "inventory" | "content" | "media" | "category" | "status" | "metadata";
export type SupplierFieldComparison = "text" | "number" | "boolean" | "ordered_list" | "unordered_list" | "deep";
export type SupplierFieldEmptyBehavior = "reject" | "preserve_existing";
export type SupplierFieldValidation = "required_text" | "optional_text" | "non_negative_number" | "optional_number" | "boolean_or_text" | "http_url_list" | "string_list" | "record" | "array" | "any" | "iso_date";
export type SupplierFieldAuditRepresentation = "text" | "number" | "boolean" | "list" | "json" | "media" | "date";

export interface SupplierFieldDestination {
  scope: SupplierFieldScope;
  path: string;
  ownership: SupplierFieldOwnership;
  publication: "direct" | "mapped" | "derived" | "approval_gated" | "audit_only";
}

export interface CanonicalSupplierFieldDefinition {
  id: string;
  sourceFields: readonly string[];
  normalizedField: keyof RawA2ZProduct;
  presenceField?: string;
  catalogField?: keyof RawA2ZProduct;
  metadataField?: keyof RawA2ZProduct;
  existingPaths: readonly string[];
  validation: SupplierFieldValidation;
  comparison: SupplierFieldComparison;
  emptyBehavior: SupplierFieldEmptyBehavior;
  syncGroup: SupplierFieldSyncGroup;
  adminEditable: boolean;
  destinations: readonly SupplierFieldDestination[];
  audit: {
    key: string;
    label: string;
    representation: SupplierFieldAuditRepresentation;
  };
}

const publicDestination = (
  path: string,
  ownership: SupplierFieldOwnership = "admin",
  publication: SupplierFieldDestination["publication"] = "approval_gated",
): SupplierFieldDestination => ({ scope: "public", path, ownership, publication });

const privateDestination = (
  path: string,
  publication: SupplierFieldDestination["publication"] = "audit_only",
): SupplierFieldDestination => ({ scope: "private", path, ownership: "supplier", publication });

const workflowDestination = (path: string): SupplierFieldDestination => ({
  scope: "workflow",
  path,
  ownership: "system",
  publication: "audit_only",
});

/**
 * The single production contract for connector-provided product data.
 *
 * `providedFields` is deliberately not a manifest field: it is system-generated
 * normalization metadata used to distinguish a sparse feed from an explicit
 * supplier value. Every connector commerce field belongs in this manifest.
 */
export const SUPPLIER_FIELD_MANIFEST = [
  {
    id: "supplierProductId", sourceFields: ["supplierProductId", "supplier_product_id", "productId", "product_id", "pro_id", "id"], normalizedField: "supplierProductId",
    metadataField: "supplierProductId", existingPaths: ["supplierMetadata.supplierProductId"], validation: "optional_text", comparison: "text", emptyBehavior: "preserve_existing",
    syncGroup: "identity", adminEditable: false, destinations: [privateDestination("supplierMetadata.supplierProductId")], audit: { key: "supplierProductId", label: "Supplier Product ID", representation: "text" },
  },
  {
    id: "sku", sourceFields: ["sku", "pro_code", "supplier_code", "supplierSku", "supplier_sku", "product_code"], normalizedField: "sku",
    metadataField: "sku", existingPaths: ["supplierMetadata.sku", "supplierItemCode", "sku"], validation: "required_text", comparison: "text", emptyBehavior: "reject",
    syncGroup: "identity", adminEditable: false, destinations: [privateDestination("supplierItemCode", "direct"), privateDestination("supplierMetadata.sku")], audit: { key: "supplierSku", label: "Supplier SKU", representation: "text" },
  },
  {
    id: "barcode", sourceFields: ["barcode", "barCode", "ean", "EAN", "upc", "UPC", "isbn", "ISBN", "gtin"], normalizedField: "barcode",
    catalogField: "barcode", metadataField: "barcode", existingPaths: ["supplierMetadata.barcode", "barcode"], validation: "optional_text", comparison: "text", emptyBehavior: "preserve_existing",
    syncGroup: "identity", adminEditable: true, destinations: [publicDestination("barcode"), privateDestination("supplierMetadata.barcode")], audit: { key: "barcode", label: "Barcode", representation: "text" },
  },
  {
    id: "title", sourceFields: ["title", "pro_name", "name", "product_name", "productName"], normalizedField: "title",
    metadataField: "title", existingPaths: ["supplierMetadata.title", "name", "title"], validation: "required_text", comparison: "text", emptyBehavior: "reject",
    syncGroup: "content", adminEditable: true, destinations: [publicDestination("name"), privateDestination("supplierMetadata.title")], audit: { key: "title", label: "Product Name", representation: "text" },
  },
  {
    id: "shortDescription", sourceFields: ["shortDescription", "short_description", "short_desc", "summary", "excerpt"], normalizedField: "shortDescription",
    catalogField: "shortDescription", metadataField: "shortDescription", existingPaths: ["supplierMetadata.shortDescription", "shortDescription"], validation: "optional_text", comparison: "text", emptyBehavior: "preserve_existing",
    syncGroup: "content", adminEditable: true, destinations: [publicDestination("shortDescription"), privateDestination("supplierMetadata.shortDescription")], audit: { key: "shortDescription", label: "Short Description", representation: "text" },
  },
  {
    id: "longDescription", sourceFields: ["longDescription", "fullDescription", "full_description", "pro_desc", "description", "details"], normalizedField: "longDescription",
    metadataField: "longDescription", existingPaths: ["supplierMetadata.longDescription", "description", "fullDescription"], validation: "optional_text", comparison: "text", emptyBehavior: "preserve_existing",
    syncGroup: "content", adminEditable: true, destinations: [publicDestination("description"), privateDestination("supplierMetadata.longDescription")], audit: { key: "description", label: "Description", representation: "text" },
  },
  {
    id: "brand", sourceFields: ["brand", "brand_name", "brandName"], normalizedField: "brand",
    metadataField: "brand", existingPaths: ["supplierMetadata.brand"], validation: "optional_text", comparison: "text", emptyBehavior: "preserve_existing",
    syncGroup: "category", adminEditable: true, destinations: [privateDestination("supplierMetadata.brand"), publicDestination("brand", "admin", "mapped")], audit: { key: "supplierBrand", label: "Supplier Brand", representation: "text" },
  },
  {
    id: "manufacturer", sourceFields: ["manufacturer", "manufacturer_name", "manufacturerName", "maker"], normalizedField: "manufacturer",
    catalogField: "manufacturer", metadataField: "manufacturer", existingPaths: ["supplierMetadata.manufacturer", "manufacturer"], validation: "optional_text", comparison: "text", emptyBehavior: "preserve_existing",
    syncGroup: "content", adminEditable: true, destinations: [publicDestination("manufacturer"), privateDestination("supplierMetadata.manufacturer")], audit: { key: "manufacturer", label: "Manufacturer", representation: "text" },
  },
  {
    id: "model", sourceFields: ["model", "model_number", "modelNumber", "mpn"], normalizedField: "model",
    catalogField: "model", metadataField: "model", existingPaths: ["supplierMetadata.model", "model"], validation: "optional_text", comparison: "text", emptyBehavior: "preserve_existing",
    syncGroup: "content", adminEditable: true, destinations: [publicDestination("model"), privateDestination("supplierMetadata.model")], audit: { key: "model", label: "Model", representation: "text" },
  },
  {
    id: "categoryHierarchy", sourceFields: ["categoryHierarchy", "category_hierarchy", "categories", "breadcrumbs"], normalizedField: "categoryHierarchy",
    metadataField: "categoryHierarchy", existingPaths: ["supplierMetadata.categoryHierarchy"], validation: "string_list", comparison: "ordered_list", emptyBehavior: "preserve_existing",
    syncGroup: "category", adminEditable: true, destinations: [privateDestination("supplierMetadata.categoryHierarchy"), publicDestination("category", "admin", "mapped"), publicDestination("subcategory", "admin", "mapped")], audit: { key: "categoryHierarchy", label: "Category Hierarchy", representation: "list" },
  },
  {
    id: "supplierCategory", sourceFields: ["supplierCategory", "supplier_category", "cat_name", "category", "category_name", "categoryName"], normalizedField: "supplierCategory",
    metadataField: "supplierCategory", existingPaths: ["supplierMetadata.supplierCategory"], validation: "optional_text", comparison: "text", emptyBehavior: "preserve_existing",
    syncGroup: "category", adminEditable: true, destinations: [privateDestination("supplierMetadata.supplierCategory"), publicDestination("category", "admin", "mapped")], audit: { key: "supplierCategory", label: "Supplier Category", representation: "text" },
  },
  {
    id: "supplierSubcategory", sourceFields: ["supplierSubcategory", "supplier_subcategory", "sub_category", "subcategory", "subcategory_name", "subCategory"], normalizedField: "supplierSubcategory",
    metadataField: "supplierSubcategory", existingPaths: ["supplierMetadata.supplierSubcategory"], validation: "optional_text", comparison: "text", emptyBehavior: "preserve_existing",
    syncGroup: "category", adminEditable: true, destinations: [privateDestination("supplierMetadata.supplierSubcategory"), publicDestination("subcategory", "admin", "mapped")], audit: { key: "supplierSubcategory", label: "Supplier Subcategory", representation: "text" },
  },
  {
    id: "tags", sourceFields: ["tags", "product_tags", "tag_list"], normalizedField: "tags",
    catalogField: "tags", metadataField: "tags", existingPaths: ["supplierMetadata.tags", "tags"], validation: "string_list", comparison: "unordered_list", emptyBehavior: "preserve_existing",
    syncGroup: "content", adminEditable: true, destinations: [publicDestination("tags"), privateDestination("supplierMetadata.tags")], audit: { key: "tags", label: "Tags", representation: "list" },
  },
  {
    id: "keywords", sourceFields: ["keywords", "search_keywords", "searchKeywords"], normalizedField: "keywords",
    catalogField: "keywords", metadataField: "keywords", existingPaths: ["supplierMetadata.keywords", "keywords"], validation: "string_list", comparison: "unordered_list", emptyBehavior: "preserve_existing",
    syncGroup: "content", adminEditable: true, destinations: [publicDestination("keywords"), privateDestination("supplierMetadata.keywords")], audit: { key: "keywords", label: "Keywords", representation: "list" },
  },
  {
    id: "productType", sourceFields: ["productType", "product_type", "type"], normalizedField: "productType",
    catalogField: "productType", metadataField: "productType", existingPaths: ["supplierMetadata.productType", "productType"], validation: "optional_text", comparison: "text", emptyBehavior: "preserve_existing",
    syncGroup: "content", adminEditable: true, destinations: [publicDestination("productType"), privateDestination("supplierMetadata.productType")], audit: { key: "productType", label: "Product Type", representation: "text" },
  },
  {
    id: "collection", sourceFields: ["collection", "collection_name", "collectionName"], normalizedField: "collection",
    catalogField: "collection", metadataField: "collection", existingPaths: ["supplierMetadata.collection", "collection"], validation: "optional_text", comparison: "text", emptyBehavior: "preserve_existing",
    syncGroup: "content", adminEditable: true, destinations: [publicDestination("collection"), privateDestination("supplierMetadata.collection")], audit: { key: "collection", label: "Collection", representation: "text" },
  },
  {
    id: "attributes", sourceFields: ["attributes", "product_attributes", "custom_attributes", "color", "colour", "size", "storage", "storage_capacity", "ram", "memory", "capacity", "pattern", "style"], normalizedField: "attributes",
    catalogField: "attributes", metadataField: "attributes", existingPaths: ["supplierMetadata.attributes", "attributes"], validation: "record", comparison: "deep", emptyBehavior: "preserve_existing",
    syncGroup: "content", adminEditable: true, destinations: [publicDestination("attributes"), privateDestination("supplierMetadata.attributes")], audit: { key: "attributes", label: "Attributes", representation: "json" },
  },
  {
    id: "variants", sourceFields: ["variants", "product_variants", "variations"], normalizedField: "variants",
    catalogField: "variants", metadataField: "variants", existingPaths: ["supplierMetadata.variants", "variants"], validation: "array", comparison: "deep", emptyBehavior: "preserve_existing",
    syncGroup: "content", adminEditable: true, destinations: [publicDestination("variants"), privateDestination("supplierMetadata.variants")], audit: { key: "variants", label: "Variants", representation: "json" },
  },
  {
    id: "options", sourceFields: ["options", "product_options", "variant_options"], normalizedField: "options",
    catalogField: "options", metadataField: "options", existingPaths: ["supplierMetadata.options", "options"], validation: "any", comparison: "deep", emptyBehavior: "preserve_existing",
    syncGroup: "content", adminEditable: true, destinations: [publicDestination("options"), privateDestination("supplierMetadata.options")], audit: { key: "options", label: "Options", representation: "json" },
  },
  {
    id: "specifications", sourceFields: ["specifications", "specs", "technical_specifications"], normalizedField: "specifications",
    metadataField: "specifications", existingPaths: ["supplierMetadata.specifications", "specs", "specifications"], validation: "record", comparison: "deep", emptyBehavior: "preserve_existing",
    syncGroup: "content", adminEditable: true, destinations: [publicDestination("specs"), privateDestination("supplierMetadata.specifications")], audit: { key: "specifications", label: "Specifications", representation: "json" },
  },
  {
    id: "features", sourceFields: ["features", "key_features", "keyFeatures", "highlights"], normalizedField: "features",
    catalogField: "features", metadataField: "features", existingPaths: ["supplierMetadata.features", "features"], validation: "string_list", comparison: "unordered_list", emptyBehavior: "preserve_existing",
    syncGroup: "content", adminEditable: true, destinations: [publicDestination("features"), privateDestination("supplierMetadata.features")], audit: { key: "features", label: "Features", representation: "list" },
  },
  {
    id: "dimensions", sourceFields: ["dimensions", "product_dimensions", "dimension"], normalizedField: "dimensions",
    catalogField: "dimensions", metadataField: "dimensions", existingPaths: ["supplierMetadata.dimensions", "dimensions"], validation: "any", comparison: "deep", emptyBehavior: "preserve_existing",
    syncGroup: "content", adminEditable: true, destinations: [publicDestination("dimensions"), privateDestination("supplierMetadata.dimensions")], audit: { key: "dimensions", label: "Dimensions", representation: "json" },
  },
  {
    id: "weight", sourceFields: ["weight", "product_weight", "shipping_weight"], normalizedField: "weight",
    catalogField: "weight", metadataField: "weight", existingPaths: ["supplierMetadata.weight", "weight"], validation: "any", comparison: "deep", emptyBehavior: "preserve_existing",
    syncGroup: "content", adminEditable: true, destinations: [publicDestination("weight"), privateDestination("supplierMetadata.weight")], audit: { key: "weight", label: "Weight", representation: "json" },
  },
  {
    id: "packageSize", sourceFields: ["packageSize", "package_size", "package_dimensions", "pack_size"], normalizedField: "packageSize",
    catalogField: "packageSize", metadataField: "packageSize", existingPaths: ["supplierMetadata.packageSize", "packageSize"], validation: "any", comparison: "deep", emptyBehavior: "preserve_existing",
    syncGroup: "content", adminEditable: true, destinations: [publicDestination("packageSize"), privateDestination("supplierMetadata.packageSize")], audit: { key: "packageSize", label: "Package Size", representation: "json" },
  },
  {
    id: "shippingClass", sourceFields: ["shippingClass", "shipping_class"], normalizedField: "shippingClass",
    catalogField: "shippingClass", metadataField: "shippingClass", existingPaths: ["supplierMetadata.shippingClass", "shippingClass"], validation: "optional_text", comparison: "text", emptyBehavior: "preserve_existing",
    syncGroup: "content", adminEditable: true, destinations: [publicDestination("shippingClass"), privateDestination("supplierMetadata.shippingClass")], audit: { key: "shippingClass", label: "Shipping Class", representation: "text" },
  },
  {
    id: "warranty", sourceFields: ["warranty", "warranty_period", "warrantyPeriod"], normalizedField: "warranty",
    catalogField: "warranty", metadataField: "warranty", existingPaths: ["supplierMetadata.warranty", "warranty"], validation: "any", comparison: "deep", emptyBehavior: "preserve_existing",
    syncGroup: "content", adminEditable: true, destinations: [publicDestination("warranty"), privateDestination("supplierMetadata.warranty")], audit: { key: "warranty", label: "Warranty", representation: "json" },
  },
  {
    id: "countryOfOrigin", sourceFields: ["countryOfOrigin", "country_of_origin", "origin_country", "made_in"], normalizedField: "countryOfOrigin",
    catalogField: "countryOfOrigin", metadataField: "countryOfOrigin", existingPaths: ["supplierMetadata.countryOfOrigin", "countryOfOrigin"], validation: "optional_text", comparison: "text", emptyBehavior: "preserve_existing",
    syncGroup: "content", adminEditable: true, destinations: [publicDestination("countryOfOrigin"), privateDestination("supplierMetadata.countryOfOrigin")], audit: { key: "countryOfOrigin", label: "Country of Origin", representation: "text" },
  },
  {
    id: "mediaGallery", sourceFields: ["mediaGallery", "images", "imageUrls", "productImages", "pro_img", "pro_image", "image", "image_url", "imageUrl", "img", "photo", "product_image", "productImage"], normalizedField: "mediaGallery",
    metadataField: "mediaGallery", existingPaths: ["supplierMetadata.mediaGallery", "imageUrls"], validation: "http_url_list", comparison: "ordered_list", emptyBehavior: "preserve_existing",
    syncGroup: "media", adminEditable: true, destinations: [privateDestination("supplierMetadata.mediaGallery"), publicDestination("imageUrl", "admin", "approval_gated"), publicDestination("imageUrls", "admin", "approval_gated"), workflowDestination("managedMedia")], audit: { key: "mediaGallery", label: "Images", representation: "media" },
  },
  {
    id: "videoUrls", sourceFields: ["videoUrls", "video_urls", "videos", "video", "product_video", "video_url"], normalizedField: "videoUrls",
    catalogField: "videoUrls", metadataField: "videoUrls", existingPaths: ["supplierMetadata.videoUrls", "videoUrls"], validation: "http_url_list", comparison: "ordered_list", emptyBehavior: "preserve_existing",
    syncGroup: "media", adminEditable: true, destinations: [publicDestination("videoUrls"), privateDestination("supplierMetadata.videoUrls")], audit: { key: "videoUrls", label: "Videos", representation: "list" },
  },
  {
    id: "price", sourceFields: ["price", "selling_price", "sellingPrice", "website_price", "price_min"], normalizedField: "price",
    metadataField: "price", existingPaths: ["supplierMetadata.price"], validation: "optional_number", comparison: "number", emptyBehavior: "preserve_existing",
    syncGroup: "pricing", adminEditable: true, destinations: [privateDestination("supplierMetadata.price"), publicDestination("price", "derived", "derived")], audit: { key: "supplierPrice", label: "Supplier Selling Price", representation: "number" },
  },
  {
    id: "comparePrice", sourceFields: ["comparePrice", "compare_price", "regular_price", "price_max", "recommendedRetailPrice", "marketPrice", "retail_price"], normalizedField: "recommendedRetailPrice",
    metadataField: "comparePrice", existingPaths: ["marketPrice", "supplierMetadata.comparePrice", "supplierMetadata.recommendedRetailPrice"], validation: "optional_number", comparison: "number", emptyBehavior: "preserve_existing",
    syncGroup: "pricing", adminEditable: true, destinations: [privateDestination("marketPrice", "derived"), privateDestination("supplierMetadata.comparePrice"), publicDestination("originalPrice", "derived", "derived")], audit: { key: "comparePrice", label: "Market Price", representation: "number" },
  },
  {
    id: "costPrice", sourceFields: ["costPrice", "cost_price", "wholesale_price", "wholesalePrice", "supplier_price", "purchase_price"], normalizedField: "wholesalePrice",
    metadataField: "costPrice", existingPaths: ["costPrice", "supplierMetadata.costPrice", "supplierMetadata.wholesalePrice"], validation: "optional_number", comparison: "number", emptyBehavior: "preserve_existing",
    syncGroup: "pricing", adminEditable: true, destinations: [privateDestination("costPrice", "direct"), privateDestination("supplierMetadata.costPrice")], audit: { key: "supplierCost", label: "Cost Price", representation: "number" },
  },
  {
    id: "currency", sourceFields: ["currency", "currency_code", "currencyCode"], normalizedField: "currency",
    catalogField: "currency", metadataField: "currency", existingPaths: ["supplierMetadata.currency", "currency"], validation: "optional_text", comparison: "text", emptyBehavior: "preserve_existing",
    syncGroup: "pricing", adminEditable: true, destinations: [publicDestination("currency"), privateDestination("supplierMetadata.currency")], audit: { key: "currency", label: "Currency", representation: "text" },
  },
  {
    id: "tax", sourceFields: ["tax", "tax_rate", "taxRate", "tax_class", "taxClass"], normalizedField: "tax",
    catalogField: "tax", metadataField: "tax", existingPaths: ["supplierMetadata.tax", "tax"], validation: "any", comparison: "deep", emptyBehavior: "preserve_existing",
    syncGroup: "pricing", adminEditable: true, destinations: [publicDestination("tax"), privateDestination("supplierMetadata.tax")], audit: { key: "tax", label: "Tax", representation: "json" },
  },
  {
    id: "discount", sourceFields: ["discount", "discount_percent", "discountPercent", "discount_percentage"], normalizedField: "discount",
    metadataField: "discount", existingPaths: ["supplierMetadata.discount"], validation: "optional_number", comparison: "number", emptyBehavior: "preserve_existing",
    syncGroup: "pricing", adminEditable: false, destinations: [privateDestination("supplierMetadata.discount"), publicDestination("discount", "derived", "derived")], audit: { key: "supplierDiscount", label: "Supplier Discount", representation: "number" },
  },
  {
    id: "stock", sourceFields: ["inventoryLevel", "inventory_level", "stock", "quantity", "qty", "bal"], normalizedField: "inventoryLevel", presenceField: "stock",
    metadataField: "inventoryLevel", existingPaths: ["supplierMetadata.inventoryLevel", "stock"], validation: "non_negative_number", comparison: "number", emptyBehavior: "reject",
    syncGroup: "inventory", adminEditable: true, destinations: [privateDestination("supplierMetadata.inventoryLevel"), publicDestination("stock", "derived", "approval_gated")], audit: { key: "stock", label: "Stock", representation: "number" },
  },
  {
    id: "availability", sourceFields: ["availability", "stock_status", "stockStatus"], normalizedField: "availability",
    catalogField: "availability", metadataField: "availability", existingPaths: ["supplierMetadata.availability", "availability"], validation: "optional_text", comparison: "text", emptyBehavior: "preserve_existing",
    syncGroup: "inventory", adminEditable: true, destinations: [publicDestination("availability"), privateDestination("supplierMetadata.availability")], audit: { key: "availability", label: "Availability", representation: "text" },
  },
  {
    id: "leadTime", sourceFields: ["leadTime", "lead_time", "delivery_lead_time"], normalizedField: "leadTime",
    metadataField: "leadTime", existingPaths: ["supplierMetadata.leadTime", "supplierLeadTime"], validation: "any", comparison: "deep", emptyBehavior: "preserve_existing",
    syncGroup: "inventory", adminEditable: true, destinations: [privateDestination("supplierMetadata.leadTime"), privateDestination("supplierLeadTime", "direct")], audit: { key: "leadTime", label: "Lead Time", representation: "json" },
  },
  {
    id: "minimumOrderQuantity", sourceFields: ["minimumOrderQuantity", "minimum_order_quantity", "min_order_quantity", "moq"], normalizedField: "minimumOrderQuantity",
    metadataField: "minimumOrderQuantity", existingPaths: ["supplierMetadata.minimumOrderQuantity", "supplierMoq", "supplierMOQ"], validation: "optional_number", comparison: "number", emptyBehavior: "preserve_existing",
    syncGroup: "inventory", adminEditable: true, destinations: [privateDestination("supplierMetadata.minimumOrderQuantity"), privateDestination("supplierMoq", "direct")], audit: { key: "minimumOrderQuantity", label: "Minimum Order Quantity", representation: "number" },
  },
  {
    id: "maximumOrderQuantity", sourceFields: ["maximumOrderQuantity", "maximum_order_quantity", "max_order_quantity"], normalizedField: "maximumOrderQuantity",
    metadataField: "maximumOrderQuantity", existingPaths: ["supplierMetadata.maximumOrderQuantity"], validation: "optional_number", comparison: "number", emptyBehavior: "preserve_existing",
    syncGroup: "inventory", adminEditable: true, destinations: [privateDestination("supplierMetadata.maximumOrderQuantity")], audit: { key: "maximumOrderQuantity", label: "Maximum Order Quantity", representation: "number" },
  },
  {
    id: "visibility", sourceFields: ["visibility", "visible", "is_visible"], normalizedField: "visibility",
    metadataField: "visibility", existingPaths: ["supplierMetadata.visibility"], validation: "boolean_or_text", comparison: "deep", emptyBehavior: "preserve_existing",
    syncGroup: "status", adminEditable: true, destinations: [privateDestination("supplierMetadata.visibility"), publicDestination("visible", "admin", "approval_gated")], audit: { key: "supplierVisibility", label: "Supplier Visibility", representation: "json" },
  },
  {
    id: "status", sourceFields: ["status", "product_status"], normalizedField: "status",
    metadataField: "status", existingPaths: ["supplierMetadata.status"], validation: "optional_text", comparison: "text", emptyBehavior: "preserve_existing",
    syncGroup: "status", adminEditable: true, destinations: [privateDestination("supplierMetadata.status"), publicDestination("status", "admin", "approval_gated")], audit: { key: "supplierStatus", label: "Supplier Status", representation: "text" },
  },
  {
    id: "lastUpdated", sourceFields: ["lastUpdated", "last_updated", "updatedAt", "updated_at", "date_modified"], normalizedField: "lastUpdated",
    metadataField: "lastUpdated", existingPaths: ["supplierMetadata.lastUpdated"], validation: "iso_date", comparison: "text", emptyBehavior: "preserve_existing",
    syncGroup: "metadata", adminEditable: false, destinations: [privateDestination("supplierMetadata.lastUpdated")], audit: { key: "supplierLastUpdated", label: "Supplier Last Updated", representation: "date" },
  },
  {
    id: "createdDate", sourceFields: ["createdDate", "created_date", "createdAt", "created_at", "date_created"], normalizedField: "createdDate",
    metadataField: "createdDate", existingPaths: ["supplierMetadata.createdDate"], validation: "iso_date", comparison: "text", emptyBehavior: "preserve_existing",
    syncGroup: "metadata", adminEditable: false, destinations: [privateDestination("supplierMetadata.createdDate")], audit: { key: "supplierCreatedDate", label: "Supplier Created Date", representation: "date" },
  },
  {
    id: "slug", sourceFields: ["slug", "url_slug", "handle"], normalizedField: "slug",
    catalogField: "slug", metadataField: "slug", existingPaths: ["supplierMetadata.slug", "slug"], validation: "optional_text", comparison: "text", emptyBehavior: "preserve_existing",
    syncGroup: "content", adminEditable: true, destinations: [publicDestination("slug"), privateDestination("supplierMetadata.slug")], audit: { key: "slug", label: "SEO Slug", representation: "text" },
  },
  {
    id: "metaDescription", sourceFields: ["metaDescription", "meta_description", "seo_description"], normalizedField: "metaDescription",
    catalogField: "metaDescription", metadataField: "metaDescription", existingPaths: ["supplierMetadata.metaDescription", "metaDescription"], validation: "optional_text", comparison: "text", emptyBehavior: "preserve_existing",
    syncGroup: "content", adminEditable: true, destinations: [publicDestination("metaDescription"), privateDestination("supplierMetadata.metaDescription")], audit: { key: "metaDescription", label: "Meta Description", representation: "text" },
  },
  {
    id: "extraAttributes", sourceFields: ["extraAttributes"], normalizedField: "extraAttributes",
    metadataField: "extraAttributes", existingPaths: ["supplierMetadata.extraAttributes"], validation: "record", comparison: "deep", emptyBehavior: "preserve_existing",
    syncGroup: "metadata", adminEditable: false, destinations: [privateDestination("supplierMetadata.extraAttributes")], audit: { key: "extraAttributes", label: "Extra Attributes", representation: "json" },
  },
] as const satisfies readonly CanonicalSupplierFieldDefinition[];

export type CanonicalSupplierFieldId = typeof SUPPLIER_FIELD_MANIFEST[number]["id"];

export const SUPPLIER_FIELD_BY_ID = new Map<CanonicalSupplierFieldId, typeof SUPPLIER_FIELD_MANIFEST[number]>(
  SUPPLIER_FIELD_MANIFEST.map((field) => [field.id, field]),
);

export const SUPPLIER_FIELD_SOURCE_ALIASES = Object.fromEntries(
  SUPPLIER_FIELD_MANIFEST.map((field) => [field.id, field.sourceFields]),
) as unknown as Record<CanonicalSupplierFieldId, readonly string[]>;

export const supplierFieldForAuditLabel = (label: string): typeof SUPPLIER_FIELD_MANIFEST[number] | undefined => (
  SUPPLIER_FIELD_MANIFEST.find((field) => field.audit.label === label || (field.id === "mediaGallery" && label === "Primary Image"))
);
