import { Braid } from './Braid';
import { HairShell, type HairColors, type HairStyle } from './HairShell';
import { WitchHat } from './WitchHat';
import type { CharacterDef } from './types';

/**
 * 魔理沙：金髪（とがった房の前髪、地面近くまで届く波打った横髪）、
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
/** 横髪の毛先の高さ（とがった所と、房の間の切れ込み） */
const SIDE_TIP = -1.78;
const SIDE_NOTCH = -1.42;

const marisaHair: HairStyle = {
  colors: HAIR,
  draw({ mask, lines, light }) {
    const PI = Math.PI;
    // 頭の上はすべて髪
    mask.fillRect(-PI - 0.1, BANG_ROOT - 0.02, 2 * PI + 0.2, 3);

    // 前髪：付け根から毛先へすぼまる房
    for (const [c, tip, hw, bend] of BANGS) {
      const mid = (BANG_ROOT + tip) / 2;
      mask.beginPath();
      mask.moveTo(c - hw, BANG_ROOT);
      mask.bezierCurveTo(c - hw * 1.05, mid, c - hw * 0.4 + bend * 0.6, tip + (BANG_ROOT - tip) * 0.2, c + bend, tip);
      mask.bezierCurveTo(c + hw * 0.4 + bend * 0.6, tip + (BANG_ROOT - tip) * 0.2, c + hw * 1.05, mid, c + hw, BANG_ROOT);
      mask.closePath();
      mask.fill();
    }

    // 横髪と後ろ髪：顔の横から背中まで、地面近くまで垂れる。毛先はとがった房が並ぶ
    for (const s of [1, -1]) {
      mask.beginPath();
      mask.moveTo(s * 0.95, BANG_ROOT);
      // 顔の横の前の縁：頬の外側をゆるく波打ちながら下りる
      mask.bezierCurveTo(s * 1.06, 0.3, s * 0.98, -0.2, s * 1.04, -0.7);
      mask.bezierCurveTo(s * 1.1, -1.1, s * 1.02, -1.4, s * 1.06, SIDE_TIP + 0.05);
      // 毛先の房（後ろへ向かって）
      let x = 1.06;
      let i = 0;
      while (x < PI + 0.25) {
        const w = 0.2 + 0.05 * Math.sin(i * 2.3);
        const tip = SIDE_TIP + 0.12 * Math.sin(i * 1.7);
        mask.quadraticCurveTo(s * (x + w * 0.35), SIDE_NOTCH, s * (x + w * 0.5), SIDE_NOTCH + 0.04);
        mask.quadraticCurveTo(s * (x + w * 0.7), tip + 0.1, s * (x + w * 0.95), tip);
        x += w;
        i++;
      }
      mask.lineTo(s * (PI + 0.3), BANG_ROOT);
      mask.closePath();
      mask.fill();
    }

    // 毛の線：前髪の房の境目（毛先から付け根の手前まで）
    lines.globalAlpha = 0.85;
    lines.lineWidth = 0.009;
    for (let k = 0; k < BANGS.length - 1; k++) {
      const [c0, t0, hw0] = BANGS[k];
      const [c1, t1] = BANGS[k + 1];
      const x = (c0 + hw0 + c1 - BANGS[k + 1][2]) / 2;
      lines.beginPath();
      lines.moveTo(x, Math.max(t0, t1) + 0.04);
      lines.quadraticCurveTo(x + 0.02, (BANG_ROOT + Math.max(t0, t1)) / 2 + 0.05, x - 0.01, BANG_ROOT + 0.04);
      lines.stroke();
    }
    // 房の中の短い線（毛の流れ）
    lines.globalAlpha = 0.5;
    lines.lineWidth = 0.006;
    for (const [c, tip, , bend] of BANGS) {
      lines.beginPath();
      lines.moveTo(c + bend * 0.6, tip + 0.1);
      lines.quadraticCurveTo(c + bend * 0.2, (tip + BANG_ROOT) / 2, c - 0.01, BANG_ROOT - 0.02);
      lines.stroke();
    }
    // 横髪の毛の流れ：上から毛先へ波打つ長い線
    lines.globalAlpha = 0.55;
    lines.lineWidth = 0.008;
    for (const s of [1, -1]) {
      for (let x = 1.22; x < 2.5; x += 0.32) {
        lines.beginPath();
        lines.moveTo(s * x, 0.7);
        lines.bezierCurveTo(s * (x + 0.06), 0.0, s * (x - 0.06), -0.8, s * (x + 0.04), SIDE_NOTCH - 0.12);
        lines.stroke();
      }
    }

    // ツヤ：前髪の付け根あたりの短い光と、横髪の光の帯
    light.globalAlpha = 0.9;
    light.lineWidth = 0.022;
    for (const [c] of BANGS.slice(1, -1)) {
      light.beginPath();
      light.moveTo(c - 0.02, 0.74);
      light.lineTo(c + 0.01, 0.66);
      light.stroke();
    }
    light.globalAlpha = 0.6;
    light.lineWidth = 0.028;
    for (const s of [1, -1]) {
      for (let x = 1.2; x < 2.0; x += 0.33) {
        light.beginPath();
        light.moveTo(s * x, 0.32 + 0.06 * Math.sin(x * 7));
        light.lineTo(s * (x + 0.02), 0.16 + 0.06 * Math.sin(x * 7));
        light.stroke();
      }
    }
  },
};

export const MARISA: CharacterDef = {
  id: 'marisa',
  name: '魔理沙',
  iris: '#c9952a',
  defaults: { hatScale: 1, hatX: 0, hatY: 0, hatZ: 0, hatTilt: 5, hatSide: 6, hairThickness: 0.035 },
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
