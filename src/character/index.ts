import { MARISA } from './marisa';
import type { CharacterDef } from './types';

/** 何も着けない（饅頭のまま） */
const NONE: CharacterDef = { id: 'none', name: 'なし', create: () => [] };

/** キャラクターの一覧。新しいキャラクターはファイルを足してここに1行加える */
export const CHARACTERS: CharacterDef[] = [NONE, MARISA];

export function findCharacter(id: string): CharacterDef {
  return CHARACTERS.find((c) => c.id === id) ?? NONE;
}
