import { Braid } from './Braid';
import { HairShell, type HairColors, type HairStyle } from './HairShell';
import { WitchHat } from './WitchHat';
import type { CharacterDef } from './types';

/**
 * 魔理沙：金髪（とがった房の前髪、頬まで下りる横髪、頭の上に載ったお椀形。体の後ろは肌のまま）、
 * 向かって右の三つ編みと白いリボン、黒い魔女帽子（白い帯・大きなリボン・つばの下のフリル）。
 * 参考画像：草原の魔理沙、泣き叫ぶ魔理沙、横倒しの魔理沙
 */
const HAIR: HairColors = {
  lit: '#ffe07a',
  shade: '#f4b843',
  deep: '#d98d2c',
  line: '#7a4614',
  light: '#fffbe2',
};

/** 前髪の房：[中心の x, 毛先の y, 半幅, 毛先の横のずれ] */
const BANGS: [number, number, number, number][] = [
  [-1.0, -0.05, 0.2, -0.1],
  [-0.76, 0.22, 0.19, 0.07],
  [-0.5, 0.42, 0.18, -0.05],
  [-0.25, 0.28, 0.19, 0.08],
  [0.0, 0.16, 0.2, -0.02],
  [0.25, 0.28, 0.19, 0.07],
  [0.5, 0.43, 0.18, -0.06],
  [0.76, 0.22, 0.19, 0.06],
  [1.0, -0.08, 0.2, 0.1],
];
/** 前髪の付け根の高さ */
const BANG_ROOT = 0.9;
/**
 * 髪の範囲（顔座標）。
 *   横髪：顔の横（|x| が SIDE_FROM〜SIDE_TO）で、選んだ高さまで下りる
 *   後ろ髪：頭の上に載った形。外周は外へ跳ねた毛先で、選んだ高さあたりに終わる
 * 横髪と後ろ髪はひと続きの形で、後ろへ回るにつれ横髪の毛先の高さから後ろ髪の縁の高さへ移る
 */
const SIDE_FROM = 0.95;
const SIDE_TO = 1.65;

/**
 * 髪型のパーツと選択肢（先頭が初期値）。値は形を決める数
 *   前髪：毛先の長さの倍率（0 でなし）と、毛先を下げる量
 *   横髪：毛先の高さ（null は横髪なし＝後ろ髪の縁の高さ）
 *   後ろ髪：縁の高さ
 */
const BANG_OPTIONS = [
  { id: 'spiky', name: 'とがり房', scale: 1, drop: 0 },
  { id: 'long', name: '長め', scale: 1, drop: 0.2 },
  { id: 'short', name: '短め', scale: 0.45, drop: 0 },
  { id: 'none', name: 'なし', scale: 0, drop: 0 },
];
const SIDE_OPTIONS = [
  { id: 'cheek', name: '頬まで', tip: -0.42 as number | null },
  { id: 'short', name: '目の高さ', tip: 0.15 },
  { id: 'mid', name: '体の中ほど', tip: -0.95 },
  { id: 'long', name: '地面まで', tip: -1.78 },
  { id: 'none', name: 'なし', tip: null },
];
const BACK_OPTIONS = [
  { id: 'bowl', name: 'お椀', edge: 0.22 },
  { id: 'short', name: '短め', edge: 0.55 },
  { id: 'mid', name: '体の中ほど', edge: -0.7 },
  { id: 'long', name: '地面まで', edge: -1.78 },
];
const pick = <T extends { id: string }>(list: T[], id: string | undefined): T => list.find((o) => o.id === id) ?? list[0];
/** 毛先の房の深さ（房の間の切れ込みの、毛先からの高さ） */
const TUFT_DEPTH = 0.2;

/** 毛先の房を並べる：x0 から x1 へ（s で左右）、毛先の高さは tipAt(x)。描き始めの点は呼ぶ側で置く */
function tufts(
  ctx: CanvasRenderingContext2D, s: number, x0: number, x1: number,
  tipAt: (x: number) => number, width: number, seed: number,
): void {
  let x = x0;
  let i = 0;
  while (x < x1 - 1e-3) {
    const w = Math.min(x1 - x, width * (0.85 + 0.3 * Math.abs(Math.sin((i + seed) * 2.3))));
    const tip = tipAt(x + w * 0.6) - 0.05 * Math.sin((i + seed) * 1.7);
    const notch = tipAt(x + w) + TUFT_DEPTH;
    // 毛先は後ろ（外）へ流れる：とがった先は房の後ろ寄り
    ctx.quadraticCurveTo(s * (x + w * 0.35), tip + TUFT_DEPTH * 0.5, s * (x + w * 0.7), tip);
    ctx.quadraticCurveTo(s * (x + w * 0.85), (tip + notch) / 2, s * (x + w), notch);
    x += w;
    i++;
  }
}

const marisaHair: HairStyle = {
  colors: HAIR,
  draw({ mask, lines, light }, parts) {
    const PI = Math.PI;
    const bang = pick(BANG_OPTIONS, parts.bangs);
    const CAP_EDGE = pick(BACK_OPTIONS, parts.back).edge;
    const SIDE_TIP = pick(SIDE_OPTIONS, parts.side).tip ?? CAP_EDGE;
    // 前髪の房（選んだ長さに合わせる）
    const bangs = BANGS.map(([c, tip, hw, bend]) =>
      [c, BANG_ROOT - (BANG_ROOT - tip) * bang.scale - bang.drop, hw, bend] as [number, number, number, number]);
    // 頭の上はすべて髪
    mask.fillRect(-PI - 0.1, BANG_ROOT - 0.02, 2 * PI + 0.2, 3);

    // 前髪：付け根から毛先へすぼまる房
    for (const [c, tip, hw, bend] of bang.scale > 0 ? bangs : []) {
      const mid = (BANG_ROOT + tip) / 2;
      mask.beginPath();
      mask.moveTo(c - hw, BANG_ROOT);
      mask.bezierCurveTo(c - hw * 1.05, mid, c - hw * 0.4 + bend * 0.6, tip + (BANG_ROOT - tip) * 0.2, c + bend, tip);
      mask.bezierCurveTo(c + hw * 0.4 + bend * 0.6, tip + (BANG_ROOT - tip) * 0.2, c + hw * 1.05, mid, c + hw, BANG_ROOT);
      mask.closePath();
      mask.fill();
    }

    // 横髪と後ろ：顔の横は頬まで下り、後ろへ回るにつれ上がって、頭の上のお椀の縁になる
    const tipAt = (x: number) => {
      if (x <= SIDE_TO) return SIDE_TIP + 0.08 * Math.sin((x - SIDE_FROM) * 4);
      const t = Math.min(1, (x - SIDE_TO) / 0.5);
      const e = t * t * (3 - 2 * t);
      return SIDE_TIP + (CAP_EDGE - SIDE_TIP) * e;
    };
    for (const s of [1, -1]) {
      mask.beginPath();
      mask.moveTo(s * SIDE_FROM, BANG_ROOT);
      // 顔の横の前の縁：頬の外側をゆるく波打ちながら下りる
      mask.bezierCurveTo(s * (SIDE_FROM + 0.1), 0.4, s * (SIDE_FROM - 0.03), 0.0, s * (SIDE_FROM + 0.06), tipAt(SIDE_FROM));
      tufts(mask, s, SIDE_FROM + 0.06, PI + 0.3, tipAt, 0.2, s > 0 ? 0 : 3);
      mask.lineTo(s * (PI + 0.3), BANG_ROOT);
      mask.closePath();
      mask.fill();
    }

    // 毛の線：前髪の房の境目（毛先から付け根の手前まで）
    lines.globalAlpha = 0.85;
    lines.lineWidth = 0.009;
    for (let k = 0; bang.scale > 0 && k < bangs.length - 1; k++) {
      const [c0, t0, hw0] = bangs[k];
      const [c1, t1] = bangs[k + 1];
      const x = (c0 + hw0 + c1 - bangs[k + 1][2]) / 2;
      lines.beginPath();
      lines.moveTo(x, Math.max(t0, t1) + 0.04);
      lines.quadraticCurveTo(x + 0.02, (BANG_ROOT + Math.max(t0, t1)) / 2 + 0.05, x - 0.01, BANG_ROOT + 0.04);
      lines.stroke();
    }
    // 房の中の短い線（毛の流れ）
    lines.globalAlpha = 0.5;
    lines.lineWidth = 0.006;
    for (const [c, tip, , bend] of bang.scale > 0 ? bangs : []) {
      lines.beginPath();
      lines.moveTo(c + bend * 0.6, tip + 0.1);
      lines.quadraticCurveTo(c + bend * 0.2, (tip + BANG_ROOT) / 2, c - 0.01, BANG_ROOT - 0.02);
      lines.stroke();
    }
    // 横髪とお椀の毛の流れ：頭の上から毛先へ、少し後ろへ流れる線
    lines.globalAlpha = 0.55;
    lines.lineWidth = 0.008;
    for (const s of [1, -1]) {
      for (let x = SIDE_FROM + 0.12; x < PI; x += 0.24) {
        const end = tipAt(x + 0.08) + TUFT_DEPTH + 0.06;
        lines.beginPath();
        lines.moveTo(s * (x - 0.1), 1.25);
        lines.bezierCurveTo(s * (x - 0.02), 0.9, s * (x - 0.04), (0.9 + end) / 2, s * (x + 0.06), end);
        lines.stroke();
      }
    }

    // ツヤ：頭の丸みに沿った光の帯（短い斜めの線を並べる）
    light.globalAlpha = 0.9;
    light.lineWidth = 0.022;
    for (const [c] of bang.scale > 0 ? bangs.slice(1, -1) : []) {
      light.beginPath();
      light.moveTo(c - 0.02, 0.74);
      light.lineTo(c + 0.01, 0.66);
      light.stroke();
    }
    light.globalAlpha = 0.6;
    light.lineWidth = 0.026;
    for (const s of [1, -1]) {
      for (let x = SIDE_FROM + 0.2; x < 2.6; x += 0.3) {
        const y = 0.72 + 0.05 * Math.sin(x * 7);
        light.beginPath();
        light.moveTo(s * x, y);
        light.lineTo(s * (x + 0.03), y - 0.14);
        light.stroke();
      }
    }
  },
};

export const MARISA: CharacterDef = {
  id: 'marisa',
  name: '魔理沙',
  iris: '#c9952a',
  hairParts: [
    { part: 'bangs', label: '前髪', options: BANG_OPTIONS },
    { part: 'side', label: '横髪', options: SIDE_OPTIONS },
    { part: 'back', label: '後ろ髪', options: BACK_OPTIONS },
  ],
  defaults: {
    hatScale: 1, hatX: 0, hatY: 0, hatZ: 0, hatTilt: 5, hatSide: 6, hairThickness: 0.035, braidLength: 0.75,
    hairParts: { bangs: 'spiky', side: 'cheek', back: 'bowl' },
  },
  // 体型ごとに合わせた値。帽子の上下の位置は、もるんもるんでお尻を丸い玉にしたとき帽子のフリルに当たらないように。
  // いもむし型は帽子を小さく、扁平型・ひよこ型は三つ編みを短く
  presetDefaults: {
    ball: { hatY: 0.04 },
    chick: { hatY: 0.08, braidLength: 0.5 },
    flat: { braidLength: 0.55 },
    eggplant: { hatY: 0.01 },
    caterpillar: { hatScale: 0.65, hatY: -0.03 },
  },
  create(ctx, params) {
    return [
      new HairShell(ctx, marisaHair, params),
      new Braid(ctx, {
        fx: 0.92,
        top: 0.55,
        bottomMargin: 0.03,
        width: 0.32,
        segment: 0.3,
        lift: 0.09,
        bowAt: 0.6,
        bowSize: 0.55,
        hair: { lit: HAIR.lit, shade: HAIR.shade, deep: HAIR.deep, rim: '#fff4c8' },
        bow: { lit: '#ffffff', shade: '#e6e3f1', deep: '#c6c2da', rim: '#ffffff' },
      }, params),
      new WitchHat(ctx, {
        cloth: { lit: '#3f3c66', shade: '#2a2847', deep: '#1a192d', rim: '#7a78b0' },
        trim: { lit: '#ffffff', shade: '#e6e3f1', deep: '#c6c2da', rim: '#ffffff' },
        brim: 2.15,
        height: 1.55,
        bendAngle: 35,
        bowAngle: 32,
        frill: true,
      }, params),
    ];
  },
};
