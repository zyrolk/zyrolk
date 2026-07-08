export interface RawA2ZProduct {
  sku: string;
  title: string;
  longDescription: string;
  mediaGallery: string[];
  wholesalePrice: number;
  recommendedRetailPrice: number;
  inventoryLevel: number;
  categoryHierarchy?: string[];
  specifications?: Record<string, string>;
}
