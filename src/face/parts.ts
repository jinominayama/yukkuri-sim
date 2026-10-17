import type { ExpressionDef, SweatSpot } from './types';

/**
 * 顔のパーツと、その選択肢。表情はパーツごとに選んだ選択肢の組み合わせで決まる。
 * 選択肢を足すときは、該当するパーツの options に1件足す（パーツ選択画面のボタンにもそのまま出る）。
 *
 * multi のパーツ（汗）は1つを選ぶのではなく、選択肢ごとにオン・オフする。
 * 選択は選んだ選択肢の id をカンマでつないだ文字列で持つ（なしは空文字）。
 */
export type FacePart = 'eyes' | 'brows' | 'mouth' | 'blush' | 'tears' | 'stream' | 'drool' | 'sweat' | 'strain' | 'pale';

export interface PartOption {
  id: string;
  /** ボタンに出す名前 */
  name: string;
  /** この選択肢が決める表情の値 */
  value: Partial<ExpressionDef>;
}

export interface PartDef {
  part: FacePart;
  /** パーツの名前 */
  label: string;
  options: PartOption[];
  /** 選択肢ごとにオン・オフする（複数選べる） */
  multi?: boolean;
  /** 左右反転のボタンを出さない（よだれは口の左右反転に従う） */
  noFlip?: boolean;
}

/** 汗を出せる場所 */
export const SWEAT_SPOTS: { id: SweatSpot; name: string }[] = [
  { id: 'forehead', name: 'おでこ' },
  { id: 'templeL', name: '左こめかみ' },
  { id: 'templeR', name: '右こめかみ' },
  { id: 'cheekL', name: '左頬' },
  { id: 'cheekR', name: '右頬' },
  { id: 'mouthL', name: '口の左下' },
  { id: 'mouthR', name: '口の右下' },
  { id: 'bodyL', name: '体の下・左' },
  { id: 'bodyC', name: '体の下・中' },
  { id: 'bodyR', name: '体の下・右' },
];

export const PARTS: PartDef[] = [
  {
    part: 'eyes',
    label: '目',
    options: [
      { id: 'normal', name: '普通', value: { eyes: { kind: 'open', open: 0.92 } } },
      { id: 'bright', name: 'ぱっちり', value: { eyes: { kind: 'open', open: 1 } } },
      { id: 'round', name: 'まんまる', value: { eyes: { kind: 'open', open: 1.1, teary: 0.3 } } },
      { id: 'half', name: '半目', value: { eyes: { kind: 'open', open: 0.6 } } },
      { id: 'troubled', name: '困り目', value: { eyes: { kind: 'open', open: 0.66, lid: 0.15, teary: 0.6 } } },
      { id: 'tearyNarrow', name: '涙目（細め）', value: { eyes: { kind: 'open', open: 0.68, lid: -0.35, teary: 0.5 } } },
      { id: 'cry', name: '泣き目', value: { eyes: { kind: 'open', open: 0.78, lid: 0.85, teary: 1, look: [0, 0.1] } } },
      { id: 'smile', name: 'にこ（^ ^）', value: { eyes: { kind: 'smile' } } },
      { id: 'closed', name: '閉じ', value: { eyes: { kind: 'closed' } } },
      { id: 'squeeze', name: 'ぎゅっ（> <）', value: { eyes: { kind: 'squeeze' } } },
      { id: 'wink', name: 'ウインク', value: { eyes: { kind: 'open', open: 0.95, other: 'smile' } } },
      { id: 'shock', name: '白目', value: { eyes: { kind: 'shock' } } },
    ],
  },
  {
    part: 'brows',
    label: '眉',
    options: [
      { id: 'none', name: 'なし', value: { brows: 'none' } },
      { id: 'neutral', name: '普通', value: { brows: 'neutral' } },
      { id: 'worried', name: '困り', value: { brows: 'worried' } },
      { id: 'angry', name: '怒り', value: { brows: 'angry' } },
    ],
  },
  {
    part: 'mouth',
    label: '口',
    options: [
      { id: 'smirk', name: 'にやり', value: { mouth: { kind: 'smirk' } } },
      { id: 'smile', name: 'にっこり', value: { mouth: { kind: 'smileOpen' } } },
      { id: 'smileSmall', name: 'ほほえみ', value: { mouth: { kind: 'smileOpen', open: 0.55 } } },
      { id: 'openSmall', name: 'ぽかん', value: { mouth: { kind: 'openSmall' } } },
      { id: 'o', name: 'お', value: { mouth: { kind: 'o' } } },
      { id: 'sob', name: '泣き', value: { mouth: { kind: 'sob' } } },
      { id: 'wail', name: '叫び', value: { mouth: { kind: 'wail', open: 1 } } },
      { id: 'grit', name: '食いしばり', value: { mouth: { kind: 'grit' } } },
      { id: 'grin', name: '歯見せ笑い', value: { mouth: { kind: 'grin' } } },
      { id: 'vomit', name: '吐く', value: { mouth: { kind: 'vomit' } } },
      { id: 'none', name: 'なし', value: { mouth: { kind: 'none' } } },
    ],
  },
  {
    part: 'blush',
    label: '頬',
    options: [
      { id: 'none', name: 'なし', value: { blush: 0 } },
      { id: 'faint', name: 'うっすら', value: { blush: 0.3 } },
      { id: 'mild', name: 'ほんのり', value: { blush: 0.5 } },
      { id: 'red', name: '赤い', value: { blush: 0.7 } },
    ],
  },
  {
    part: 'tears',
    label: '涙（粒）',
    options: [
      { id: 'none', name: 'なし', value: { tears: 0 } },
      { id: 'few', name: '少し', value: { tears: 0.4 } },
      { id: 'more', name: 'たまる', value: { tears: 0.7 } },
      { id: 'lots', name: 'あふれる', value: { tears: 0.9 } },
    ],
  },
  {
    part: 'stream',
    label: '涙（筋）',
    options: [
      { id: 'none', name: 'なし', value: { tearStream: 0 } },
      { id: 'few', name: '少し', value: { tearStream: 0.4 } },
      { id: 'lots', name: '大泣き', value: { tearStream: 0.7 } },
    ],
  },
  {
    part: 'drool',
    label: 'よだれ',
    noFlip: true,
    options: [
      { id: 'none', name: 'なし', value: { drool: 0 } },
      { id: 'few', name: '少し', value: { drool: 0.35 } },
      { id: 'drip', name: 'たらり', value: { drool: 0.7 } },
      { id: 'lots', name: 'だらだら', value: { drool: 1 } },
    ],
  },
  {
    part: 'sweat',
    label: '汗',
    multi: true,
    // 場所ごとにオン・オフ（左右は見る人から見た向き）
    options: SWEAT_SPOTS.map((s) => ({ id: s.id, name: s.name, value: { sweat: [s.id] } })),
  },
  {
    part: 'strain',
    label: 'しわ',
    options: [
      { id: 'none', name: 'なし', value: { strain: 0 } },
      { id: 'light', name: '少し', value: { strain: 0.3 } },
      { id: 'mid', name: '強め', value: { strain: 0.6 } },
      { id: 'max', name: '最大', value: { strain: 1 } },
    ],
  },
  {
    part: 'pale',
    label: '青ざめ',
    options: [
      { id: 'none', name: 'なし', value: { pale: 0 } },
      { id: 'some', name: '少し', value: { pale: 0.55 } },
      { id: 'lots', name: '真っ青', value: { pale: 1 } },
    ],
  },
];

export type PartSelection = Record<FacePart, string>;
export type PartFlip = Record<FacePart, boolean>;

export const NO_FLIP: PartFlip = {
  eyes: false, brows: false, mouth: false, blush: false, tears: false, stream: false, drool: false, sweat: false, strain: false, pale: false,
};

export function findPart(part: FacePart): PartDef {
  return PARTS.find((p) => p.part === part)!;
}

/** パーツごとの選択と左右反転から、描画に渡す表情を組み立てる */
export function composeExpression(sel: PartSelection, flip: PartFlip): ExpressionDef {
  const ex: ExpressionDef = {
    id: 'custom',
    name: '',
    eyes: { kind: 'open' },
    brows: 'neutral',
    mouth: { kind: 'smirk' },
    blink: true,
    flip: { ...flip },
  };
  for (const def of PARTS) {
    if (def.multi) {
      // オンの選択肢の値をつなげる（配列は連結）
      const rec = ex as unknown as Record<string, unknown>;
      for (const id of selectedIds(sel[def.part])) {
        const opt = def.options.find((o) => o.id === id);
        if (!opt) continue;
        for (const [k, v] of Object.entries(opt.value)) {
          const cur = rec[k];
          rec[k] = Array.isArray(v) && Array.isArray(cur) ? [...cur, ...v] : v;
        }
      }
      continue;
    }
    const opt = def.options.find((o) => o.id === sel[def.part]) ?? def.options[0];
    Object.assign(ex, opt.value);
  }
  return ex;
}

/** multi のパーツの選択（カンマ区切り）→ id の一覧 */
export function selectedIds(value: string): string[] {
  return value ? value.split(',').filter(Boolean) : [];
}

/** multi のパーツで、選択肢 id のオン・オフを切り替えた選択を返す（並びは選択肢の順） */
export function toggleId(def: PartDef, value: string, id: string): string {
  const on = new Set(selectedIds(value));
  if (on.has(id)) on.delete(id);
  else on.add(id);
  return def.options.filter((o) => on.has(o.id)).map((o) => o.id).join(',');
}
