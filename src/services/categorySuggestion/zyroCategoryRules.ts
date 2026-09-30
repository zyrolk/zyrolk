export interface ZyroCategoryRule {
  categoryId: string;
  subcategoryId?: string;
  strongPhrases: string[];
  keywords: string[];
  negativeKeywords?: string[];
  aliases?: string[];
}

/**
 * Code-owned, conservative rules. IDs are validated against the active
 * taxonomy at runtime, so a rule is harmless when a deployment does not yet
 * contain one of these optional launch subcategories.
 */
export const ZYRO_CATEGORY_RULES: readonly ZyroCategoryRule[] = Object.freeze([
  {
    categoryId: 'home-kitchen', subcategoryId: 'small-kitchen-appliances',
    strongPhrases: ['air fryer', 'hand mixer', 'sandwich maker', 'crepe maker'],
    keywords: ['kitchen appliance', 'fryer', 'mixer'],
  },
  {
    categoryId: 'home-kitchen', subcategoryId: 'kitchen-tools',
    strongPhrases: ['vegetable slicer', 'food slicer', 'garlic press'],
    keywords: ['slicer', 'chopper', 'peeler', 'grater', 'kitchen'],
  },
  {
    categoryId: 'home-kitchen', subcategoryId: 'home-essentials',
    strongPhrases: ['towel rack', 'bathroom organizer', 'suction cup towel'],
    keywords: ['bathroom', 'towel', 'rack', 'organizer'],
  },
  {
    categoryId: 'home-garden', subcategoryId: 'home-essentials',
    strongPhrases: ['laundry basket', 'storage basket', 'storage organizer'],
    keywords: ['laundry', 'storage', 'cleaning', 'household'],
  },
  {
    categoryId: 'home-garden', subcategoryId: 'garden-tools',
    strongPhrases: ['garden hose', 'pruning shears', 'garden tool'],
    keywords: ['garden', 'hose', 'planting'],
  },
  {
    categoryId: 'home-garden',
    strongPhrases: ['household item'],
    keywords: ['household'],
  },
  {
    categoryId: 'automotive', subcategoryId: 'car-accessories',
    strongPhrases: ['car door guard', 'bike mount', 'car phone holder'],
    keywords: ['car', 'vehicle', 'motorcycle', 'mount'],
  },
  {
    categoryId: 'automotive', subcategoryId: 'car-care',
    strongPhrases: ['rust removal', 'car care', 'car polish', 'yellowish removal'],
    keywords: ['rust', 'polish', 'cleaner', 'removal'],
  },
  {
    categoryId: 'automotive', subcategoryId: 'vehicle-accessories',
    strongPhrases: ['bike signal light', 'signal light circuit', 'indicator light'],
    keywords: ['signal', 'indicator', 'brake', 'bike'],
    negativeKeywords: ['solar light', 'solar lamp'],
  },
  {
    categoryId: 'mobile-phones', subcategoryId: 'mobile-accessories',
    strongPhrases: ['phone case', 'phone holder', 'screen protector', 'charging cable'],
    keywords: ['phone', 'mobile', 'charger', 'cable', 'magnifier'],
    negativeKeywords: ['smart watch screen protector', 'smartwatch screen protector'],
  },
  {
    categoryId: 'mobile-phones', subcategoryId: 'smartphones',
    strongPhrases: ['smart phone', 'smartphone', 'android phone'],
    keywords: ['android', 'iphone', 'smartphone'],
  },
  {
    categoryId: 'electronics', subcategoryId: 'smart-watches',
    strongPhrases: ['smart watch', 'smartwatch', 'fitness band', 'fitness tracker'],
    keywords: ['smartwatch', 'wearable', 'bluetooth'],
    negativeKeywords: ['smart watch strap', 'smartwatch strap', 'smart watch case', 'smartwatch case', 'smart watch charger', 'smartwatch charger', 'smart watch screen protector', 'smartwatch screen protector'],
  },
  {
    categoryId: 'electronics', subcategoryId: 'smart-devices',
    strongPhrases: ['virtual reality', '3d vision'],
    keywords: ['vr', '3d', 'screen'],
    negativeKeywords: ['wrist watch', 'ladies watch'],
  },
  {
    categoryId: 'electronics',
    strongPhrases: ['electronic accessory'],
    keywords: ['electronics'],
  },
  {
    categoryId: 'fashion', subcategoryId: 'watches',
    strongPhrases: ['wrist watch', 'ladies watch'],
    keywords: ['watch', 'wrist'],
    negativeKeywords: ['smart watch', 'fitness band', 'vr', '3d'],
  },
  {
    categoryId: 'health-beauty', subcategoryId: 'health-wellness',
    strongPhrases: ['ankle support', 'knee brace', 'body shaper', 'detox foot'],
    keywords: ['support', 'brace', 'wellness', 'health'],
  },
  {
    categoryId: 'health-beauty', subcategoryId: 'beauty-personal-care',
    strongPhrases: ['lice comb', 'hair trimmer', 'makeup brush'],
    keywords: ['beauty', 'hair', 'comb', 'trimmer'],
  },
  {
    categoryId: 'baby-kids', subcategoryId: 'baby-care',
    strongPhrases: ['baby bottle', 'baby monitor', 'newborn care'],
    keywords: ['baby', 'infant', 'newborn'],
  },
  {
    categoryId: 'kids-toys', subcategoryId: 'educational-toys',
    strongPhrases: ['drawing pad', 'magic pad', 'drawing tablet'],
    keywords: ['drawing', 'learning', 'educational'],
  },
  {
    categoryId: 'kids-toys', subcategoryId: 'puzzles-games',
    strongPhrases: ['jigsaw puzzle', 'board game', 'building blocks'],
    keywords: ['toy', 'kids', 'puzzle', 'game'],
  },
  {
    categoryId: 'solar-lighting', subcategoryId: 'solar-lights',
    strongPhrases: ['solar light', 'solar lamp', 'solar street light'],
    keywords: ['solar', 'lamp', 'lighting'],
    negativeKeywords: ['signal', 'indicator', 'brake', 'bike'],
  },
  {
    categoryId: 'solar-lighting', subcategoryId: 'lighting-accessories',
    strongPhrases: ['led strip', 'light fitting', 'lighting accessory'],
    keywords: ['led', 'light', 'bulb'],
    negativeKeywords: ['signal', 'indicator', 'brake', 'bike'],
  },
  {
    categoryId: 'accessories', subcategoryId: 'personal-accessories',
    strongPhrases: [],
    keywords: ['gadget', 'combo', 'accessory'],
  },
]);
