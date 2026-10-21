/**
 * 顔（表情）の型定義。
 *
 * 顔は「表情」と「絵柄」の組み合わせで描く。
 *   ・表情（ExpressionDef）… どのパーツをどの形にするかを書いたデータ。描き方は持たない。
 *                            パーツごとの選択肢（parts.ts）の組み合わせから作る
 *   ・絵柄（FaceStyle）    … パーツの種類ごとの描き方。同じ表情を別の絵柄で描ける
 * パーツの選択肢を足すときは parts.ts に、表情セットを足すときは expressions.ts に1件足す。
 * 絵柄を足すときは styles/ に1ファイル足して styles/index.ts に登録する（README を参照）。
 *
 * 座標（顔座標）：頭の中心から見た正面を原点に、右（見る人から見て）が +x、上が +y。
 * 単位は頭の半径。体の表面に沿った長さなので、体型を伸縮しても顔は歪まない。
 */

/** 目の形 */
export type EyeKind =
  | 'open'    // 開いた目
  | 'smile'   // 笑って細めた目（^ ^）
  | 'closed'  // 穏やかに閉じた目
  | 'squeeze' // ぎゅっとつぶった目（> <）
  | 'shock'   // 白目をむく（見開いた真っ白な目。瞳は描かない）
  | 'cross'   // デフォルメした×（目を回して気絶する）
  | 'swirl';  // ぐるぐる目（＠ ＠。白い丸に渦巻き）

/** 眉の形 */
export type BrowKind =
  | 'none'
  | 'neutral'
  | 'worried' // 困り眉（内側が上がる）
  | 'angry'   // 怒り・力み（内側が下がる）
  | 'strain'; // 力み（怒りより目頭に寄り、太く、目頭側を強く下げて寄せる）

/** 口の形 */
export type MouthKind =
  | 'none'
  | 'smirk'     // ゆっくりらしい、にやっとした閉じた口（中央が少しへこんだ〜形の細い線）
  | 'grin'      // 歯を見せて笑う（強がり）
  | 'smileOpen' // 開けて笑う（口角の跳ねた上の線の下に、舌の見える器形の口）
  | 'openSmall' // 小さく開ける（傾いた上の線の下に細いレンズ形）
  | 'sob'       // 泣いて開ける（角ばった斜めの台形）
  | 'wail'      // 大きく開けて泣き叫ぶ（口角が下がる）
  | 'grit'      // 歯を食いしばる
  | 'vomit'     // 吐く（縦に大きく開いた口から、餡子があふれて顎を伝う）
  | 'pout';     // 頬に空気をためて口を横に結ぶ（両脇に頬の輪郭「)—(」。ぷくー）

import type { FacePart } from './parts';

export interface ExpressionDef {
  id: string;
  /** 一覧に出す名前 */
  name: string;
  eyes: {
    kind: EyeKind;
    /** 左目（見る人から見て左）だけ別の形にする（ウインクなど）。左右反転で入れ替わる */
    other?: EyeKind;
    /** 涙ぐむ（瞳のうるみ・下まぶたの涙だまり）0〜1。open のときのみ */
    teary?: number;
    /** 目の開き具合 0〜1（1 が標準）。open のときのみ */
    open?: number;
    /** まぶたの傾き。+ で困り目（目尻が下がる）、- でつり目。open のときのみ */
    lid?: number;
    /** 視線のずれ（目の大きさに対する比） */
    look?: [number, number];
  };
  brows: BrowKind;
  mouth: {
    kind: MouthKind;
    /** 開き具合 0〜1（1 が標準） */
    open?: number;
    /** 幅の倍率（1 が標準） */
    width?: number;
  };
  /** 頬の赤み 0〜1 */
  blush?: number;
  /** 目尻・目頭にたまる涙の粒 0〜1 */
  tears?: number;
  /** 頬を流れる涙の筋 0〜1（大泣きのときだけ） */
  tearStream?: number;
  /** よだれ 0〜1（長さ。1 で2本に分かれる）。垂れ始めの位置は口の形で決まる */
  drool?: number;
  /** 汗を出す場所（parts.ts の SWEAT_SPOTS の id）。描く位置は絵柄が決める */
  sweat?: SweatSpot[];
  /** 眉間のしわ（力み）0〜1 */
  strain?: number;
  /** 青ざめ（顔の上の方が青くなり、縦線が入る）0〜1 */
  pale?: number;
  /** 自動でまばたきするか（目が開いている表情のみ意味がある） */
  blink?: boolean;
  /** パーツごとの左右反転 */
  flip?: Partial<Record<FacePart, boolean>>;
}

/** 汗を出す場所。左右は見る人から見た向き */
export type SweatSpot =
  | 'forehead' | 'templeL' | 'templeR' | 'cheekL' | 'cheekR'
  | 'mouthL' | 'mouthR' | 'bodyL' | 'bodyC' | 'bodyR';

/** 個体ごとの見た目（絵柄によらない） */
export interface FaceLook {
  /** 瞳の色 */
  iris: string;
}

/** 1回分の描画に渡す状態 */
export interface FaceState {
  expression: ExpressionDef;
  look: FaceLook;
  /** まばたきでまぶたが閉じている量 0〜1 */
  blink: number;
  /** 視線のずれ（見る人から見て右 +・上 +。目の半幅・半高に対する比。両目とも同じ向きへ）。物を見るときなど */
  gaze?: [number, number];
}

export interface FaceStyle {
  id: string;
  /** 一覧に出す名前 */
  name: string;
  /**
   * 顔座標（単位：頭の半径、y が上）に変換済みの ctx に顔全体を描く。
   * 何も描かないところは透明のままにする（体の塗りが見える）
   */
  draw(ctx: CanvasRenderingContext2D, state: FaceState): void;
}

/** 顔の絵を描く範囲（顔座標）。この外には描けない */
export const FACE_RECT = { xMin: -1.7, yMin: -1.3, xMax: 1.7, yMax: 1.1 } as const;
