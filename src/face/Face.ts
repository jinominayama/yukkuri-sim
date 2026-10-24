import * as THREE from 'three';
import { DEFAULT_EXPRESSION_ID, findExpression } from './expressions';
import { composeExpression, NO_FLIP, PARTS, selectedIds, type FacePart, type PartFlip, type PartSelection } from './parts';
import { DEFAULT_STYLE_ID, findStyle } from './styles';
import { FACE_RECT, type FaceLook } from './types';
import { loadJSON, saveJSON } from '../platform/storage';

/** 顔の絵の解像度（横）。縦は描く範囲の縦横比に合わせる */
const TEX_WIDTH = 2048;
/** まばたきの間隔（秒）と、閉じて開くまでの時間 */
const BLINK_MIN = 2.5;
const BLINK_MAX = 6;
const BLINK_TIME = 0.16;
const STORAGE_KEY = 'face';

export interface FaceSettings extends FaceLook {
  style: string;
  /** 自動でまばたきする */
  blink: boolean;
  /** パーツごとに選んだ選択肢（parts.ts の id） */
  parts: PartSelection;
  /** パーツごとの左右反転 */
  flip: PartFlip;
}

export const DEFAULT_FACE: FaceSettings = {
  style: DEFAULT_STYLE_ID,
  iris: '#7a4a2a',
  blink: true,
  parts: { ...findExpression(DEFAULT_EXPRESSION_ID).parts },
  flip: { ...NO_FLIP },
};

/**
 * 顔の絵（パーツの組み合わせ × 絵柄）をキャンバスに描き、体に貼るテクスチャにする。
 * 描き直すのは、パーツ・絵柄・色・まばたきの段階が変わったときだけ。
 */
/** 視線が見たい向きへ寄る速さ（1/s） */
const GAZE_FOLLOW = 8;

export class Face {
  readonly settings: FaceSettings = loadSettings();
  readonly texture: THREE.CanvasTexture;
  private readonly canvas = document.createElement('canvas');
  private readonly ctx: CanvasRenderingContext2D;
  private blinkWait = randomBlinkWait();
  private blinkT = -1;
  /** 最後に描いた内容（変化の判定用） */
  private drawnKey = '';
  /**
   * 一時的な表情（食べる動きなどの演出用）。指定したパーツだけ選択を上書きして描く。
   * 設定（settings）は書き換えないので、null に戻せばいつもの顔に戻る。上書きしたパーツは左右反転しない
   */
  override: Partial<PartSelection> | null = null;
  /**
   * 視線：見たい向き（見る人から見て右 +・上 +。目の半幅・半高に対する比。null で正面）。
   * 今の視線はそこへなめらかに寄る（GAZE_FOLLOW）。開いた目の瞳だけを動かす
   */
  gazeTarget: [number, number] | null = null;
  private gaze: [number, number] = [0, 0];

  constructor() {
    const w = FACE_RECT.xMax - FACE_RECT.xMin;
    const h = FACE_RECT.yMax - FACE_RECT.yMin;
    this.canvas.width = TEX_WIDTH;
    this.canvas.height = Math.round((TEX_WIDTH * h) / w);
    this.ctx = this.canvas.getContext('2d')!;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    // 縁の透明部分が黒くにじまないよう、乗算済みアルファで扱う
    this.texture.premultiplyAlpha = true;
    this.texture.anisotropy = 4;
    this.render();
  }

  /** 表情セットに切り替える（AI などから呼ぶ）。id は expressions.ts の id。左右反転は解除する */
  setExpression(id: string): void {
    Object.assign(this.settings.parts, findExpression(id).parts);
    Object.assign(this.settings.flip, NO_FLIP);
    this.save();
  }

  /** パーツを1つ選ぶ。option は parts.ts の選択肢の id */
  setPart(part: FacePart, option: string): void {
    this.settings.parts[part] = option;
    this.save();
  }

  setFlip(part: FacePart, flip: boolean): void {
    this.settings.flip[part] = flip;
    this.save();
  }

  /** 今の選択を保存する（次回起動時に引き継ぐ） */
  save(): void {
    saveJSON(STORAGE_KEY, this.settings);
  }

  /** 止める（まばたきも視線も動かさない。死んだときなど） */
  frozen = false;

  /** 固定時間刻みで呼ぶ：まばたきを進める */
  update(dt: number): void {
    if (this.frozen) {
      this.blinkT = -1;
      return;
    }
    const [tx, ty] = this.gazeTarget ?? [0, 0];
    const k = Math.min(1, dt * GAZE_FOLLOW);
    this.gaze[0] += (tx - this.gaze[0]) * k;
    this.gaze[1] += (ty - this.gaze[1]) * k;
    if (this.blinkT >= 0) {
      this.blinkT += dt;
      if (this.blinkT > BLINK_TIME) this.blinkT = -1;
      return;
    }
    this.blinkWait -= dt;
    if (this.blinkWait <= 0) {
      this.blinkWait = randomBlinkWait();
      this.blinkT = 0;
    }
  }

  /** 描画直前に呼ぶ：変化があれば描き直す */
  render(): void {
    const s = this.settings;
    const parts = this.override ? { ...s.parts, ...this.override } : s.parts;
    // 上書きしたパーツだけ左右反転を外す（ほかは選んでいる向きのまま）
    const flip = this.override
      ? { ...s.flip, ...Object.fromEntries(Object.keys(this.override).map((k) => [k, false])) } as PartFlip
      : s.flip;
    const ex = composeExpression(parts, flip);
    const style = findStyle(s.style);
    // まばたき：閉じて開く（0→1→0）。描き直しを減らすため4段階に丸める
    let blink = 0;
    if (s.blink && ex.blink && this.blinkT >= 0) {
      blink = Math.round(Math.sin((this.blinkT / BLINK_TIME) * Math.PI) * 4) / 4;
    }
    // 視線は描き直しを減らすため 0.04 刻みに丸める
    const gaze: [number, number] = [Math.round(this.gaze[0] * 25) / 25, Math.round(this.gaze[1] * 25) / 25];
    const key = `${JSON.stringify(parts)}|${JSON.stringify(flip)}|${style.id}|${s.iris}|${blink}|${gaze}`;
    if (key === this.drawnKey) return;
    this.drawnKey = key;

    const { ctx, canvas } = this;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    // 顔座標（単位：頭の半径、y が上）に合わせる
    const k = canvas.width / (FACE_RECT.xMax - FACE_RECT.xMin);
    ctx.setTransform(k, 0, 0, -k, -FACE_RECT.xMin * k, FACE_RECT.yMax * k);
    style.draw(ctx, { expression: ex, look: s, blink, gaze });
    this.texture.needsUpdate = true;
  }

  /** 描き直しを強制する（絵柄の調整中など） */
  invalidate(): void {
    this.drawnKey = '';
  }
}

/** 保存した設定を読む。知らないパーツ・選択肢は初期値に戻す */
function loadSettings(): FaceSettings {
  const saved = loadJSON<Partial<FaceSettings>>(STORAGE_KEY) ?? {};
  const s: FaceSettings = {
    ...DEFAULT_FACE,
    ...saved,
    parts: { ...DEFAULT_FACE.parts, ...saved.parts },
    flip: { ...NO_FLIP, ...saved.flip },
  };
  for (const def of PARTS) {
    const v = s.parts[def.part];
    if (def.multi) {
      // 場所ごとのオン・オフ：知らない id を除く（以前の量の指定は「なし」になる）
      s.parts[def.part] = selectedIds(v ?? '').filter((id) => def.options.some((o) => o.id === id)).join(',');
    } else if (!def.options.some((o) => o.id === v)) {
      s.parts[def.part] = DEFAULT_FACE.parts[def.part];
    }
  }
  return s;
}

function randomBlinkWait(): number {
  return BLINK_MIN + Math.random() * (BLINK_MAX - BLINK_MIN);
}
