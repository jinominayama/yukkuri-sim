import type { FaceStyle } from '../types';
import { AnimeStyle } from './anime';
import { SimpleStyle } from './simple';

/** 絵柄の一覧。新しい絵柄はファイルを足してここに1行加える */
export const STYLES: FaceStyle[] = [new AnimeStyle(), new SimpleStyle()];

export const DEFAULT_STYLE_ID = 'anime';

export function findStyle(id: string): FaceStyle {
  return STYLES.find((s) => s.id === id) ?? STYLES[0];
}
