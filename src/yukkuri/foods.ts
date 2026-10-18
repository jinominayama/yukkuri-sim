/**
 * 食べ物の種類。品質ごとに、食べたときに減るストレスが違う（減る量は Stress の params.meal）。
 * 今あるのはおまんじゅう 1 種類で、中間品質（指示）。今後、種類を足していく
 */
export type FoodQuality = 'low' | 'normal' | 'high';

export const QUALITY_NAMES: Record<FoodQuality, string> = { low: '低品質', normal: '中間品質', high: '高品質' };

export interface FoodKind {
  id: string;
  name: string;
  quality: FoodQuality;
}

export const FOODS: FoodKind[] = [
  { id: 'manju', name: 'おまんじゅう', quality: 'normal' },
];

/** 「食べ物をあげる」で出すもの */
export const DEFAULT_FOOD = FOODS[0];
