import type { PartSelection } from './parts';

/**
 * 表情セット：パーツの選択の組み合わせに名前を付けたもの。
 * パーツ選択画面の「まとめて設定」ボタンと、プログラムからの切り替え（yukkuri.face.setExpression）に使う。
 * 表情セットを足すときはここに1件足す。各パーツの選択肢は parts.ts を参照。
 *
 * 参考画像に共通する描き方：
 *   ・口は細い線で小さく、基本は左右非対称の「〜」形のにやっとした口
 *   ・笑っていても困り眉・涙目のことが多い（やせ我慢・強がり・困り笑い）
 *   ・涙は頬を流れるより、目尻・目頭に薄桃色の粒としてたまる
 *   ・汗は顔だけでなく体の下の方にも散る
 */
export interface ExpressionSet {
  id: string;
  name: string;
  parts: PartSelection;
}

/** 汗の場所の組み合わせ（以前の「少し・多め・汗だく」に相当） */
const SWEAT_FEW = 'forehead,cheekR,mouthL';
const SWEAT_SOME = 'forehead,templeL,cheekL,cheekR,mouthL,bodyC';
const SWEAT_LOTS = 'forehead,templeL,templeR,cheekL,cheekR,mouthL,mouthR,bodyL,bodyC,bodyR';

const base: PartSelection = {
  eyes: 'normal', brows: 'neutral', mouth: 'smirk', blush: 'none', tears: 'none', stream: 'none', drool: 'none', sweat: '', strain: 'none', pale: 'none',
};

export const EXPRESSIONS: ExpressionSet[] = [
  { id: 'normal', name: '通常', parts: { ...base, blush: 'faint' } },
  // 参考：草原でにっこり
  { id: 'happy', name: 'にっこり', parts: { ...base, eyes: 'bright', mouth: 'smile', blush: 'red' } },
  // 参考：困り目で涙をためつつ、口はにやっと
  { id: 'troubled', name: '困り笑い', parts: { ...base, eyes: 'troubled', brows: 'worried', blush: 'mild', tears: 'more', sweat: SWEAT_FEW, strain: 'light' } },
  // 参考：目を閉じて涙をにじませ、口はにやっと（ぐっとこらえる）
  { id: 'bear', name: 'こらえる', parts: { ...base, eyes: 'smile', brows: 'worried', blush: 'mild', tears: 'more', sweat: SWEAT_FEW } },
  // 参考：しかめ眉で涙ぐみながら歯を見せて笑う
  { id: 'bravado', name: '強がり', parts: { ...base, eyes: 'tearyNarrow', brows: 'angry', mouth: 'grin', blush: 'faint', tears: 'more', sweat: SWEAT_SOME, strain: 'mid' } },
  // 参考：目を丸くして小さく口を開ける
  { id: 'blank', name: 'きょとん', parts: { ...base, eyes: 'round', brows: 'worried', mouth: 'openSmall', blush: 'mild', tears: 'few', sweat: SWEAT_FEW } },
  // 参考：道路で泣く
  { id: 'cry', name: '泣く', parts: { ...base, eyes: 'cry', brows: 'worried', mouth: 'sob', blush: 'faint', tears: 'lots', stream: 'lots', sweat: SWEAT_SOME, strain: 'light' } },
  // 参考：目をぎゅっとつぶって泣き叫ぶ
  { id: 'wail', name: '泣き叫ぶ', parts: { ...base, eyes: 'squeeze', brows: 'worried', mouth: 'wail', blush: 'faint', tears: 'lots', stream: 'few', sweat: SWEAT_LOTS } },
  // 参考：歯を食いしばって耐える
  { id: 'endure', name: '食いしばる', parts: { ...base, eyes: 'squeeze', brows: 'angry', mouth: 'grit', blush: 'red', tears: 'more', sweat: SWEAT_SOME, strain: 'max' } },
  { id: 'content', name: 'ほっこり', parts: { ...base, eyes: 'smile', mouth: 'smileSmall', blush: 'mild' } },
  { id: 'surprised', name: 'びっくり', parts: { ...base, eyes: 'round', brows: 'worried', mouth: 'openSmall', sweat: SWEAT_FEW } },
  { id: 'sleep', name: '眠る', parts: { ...base, eyes: 'closed' } },
  // 参考：落ちた・毒を食べたなどで餡子を吐く（白目をむいて青ざめる）
  { id: 'vomit', name: '吐餡', parts: { ...base, eyes: 'shock', brows: 'worried', mouth: 'vomit', tears: 'more', sweat: SWEAT_LOTS, pale: 'lots' } },
];

export const DEFAULT_EXPRESSION_ID = 'normal';

export function findExpression(id: string): ExpressionSet {
  return EXPRESSIONS.find((e) => e.id === id) ?? EXPRESSIONS[0];
}
