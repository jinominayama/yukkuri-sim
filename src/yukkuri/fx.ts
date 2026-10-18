import * as THREE from 'three';
import { findPart, type FacePart, type PartSelection } from '../face/parts';
import type { Yukkuri } from './Yukkuri';

/**
 * 演出の共通部品：
 *   ・TextFx  … まわりに出す文字（「むーしゃ」「しあわせー」「すっきりー」など）。ぽんと出て浮かび、薄くなって消える
 *   ・showFace … 表情の一時的な上書き（目・眉・口など）。よだれ・涙など段階に要るものは足りないときだけ足す
 */

/** 出している文字（say が返す。fade に渡すと早めに消せる） */
export interface Word { sprite: THREE.Sprite; vel: THREE.Vector3; life: number; total: number; size: number }

export class TextFx {
  /** 文字（体と一緒に震えないよう、シーンに直接置く） */
  readonly object = new THREE.Group();
  private readonly words: Word[] = [];
  private readonly textures = new Map<string, THREE.CanvasTexture>();

  /**
   * 文字を出す。pos：真ん中の位置（ワールド）、height：文字の高さ（ワールド）、
   * life：出している時間（秒）、vel：浮かぶ速さ（ワールド / 秒）
   */
  say(text: string, pos: THREE.Vector3, height: number, life: number, vel: THREE.Vector3): Word {
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.texture(text), transparent: true, depthTest: false }));
    sprite.renderOrder = 10;
    const img = sprite.material.map!.image as HTMLCanvasElement;
    sprite.scale.set((height * img.width) / img.height, height, 1);
    sprite.position.copy(pos);
    this.object.add(sprite);
    const word = { sprite, vel: vel.clone(), life, total: life, size: height };
    this.words.push(word);
    return word;
  }

  /** 出している文字 word を、time 秒で薄くして消す（まだ残っていて、それより長く残る予定なら） */
  fade(word: Word, time = 0.2): void {
    if (this.words.includes(word)) word.life = Math.min(word.life, time);
  }

  /** 固定時間刻みで呼ぶ：浮かせて、時間が来たら消す */
  update(dt: number): void {
    for (let i = this.words.length - 1; i >= 0; i--) {
      const w = this.words[i];
      w.life -= dt;
      w.sprite.position.addScaledVector(w.vel, dt);
      const age = w.total - w.life;
      // ぽんと出て（少し大きく→元の大きさ）、最後に薄くなって消える
      const pop = age < 0.12 ? 0.6 + (age / 0.12) * 0.55 : age < 0.24 ? 1.15 - ((age - 0.12) / 0.12) * 0.15 : 1;
      const aspect = w.sprite.scale.x / w.sprite.scale.y;
      w.sprite.scale.set(w.size * pop * aspect, w.size * pop, 1);
      w.sprite.material.opacity = Math.min(1, w.life / 0.35);
      if (w.life <= 0) {
        this.object.remove(w.sprite);
        w.sprite.material.dispose();
        this.words.splice(i, 1);
      }
    }
  }

  /** 文字の絵（白いふちどりの太字）。同じ文字は使い回す */
  private texture(text: string): THREE.CanvasTexture {
    const hit = this.textures.get(text);
    if (hit) return hit;
    const px = 96;
    const font = `bold ${px}px "Hiragino Maru Gothic ProN", "BIZ UDPGothic", "Meiryo", sans-serif`;
    const c = document.createElement('canvas');
    const ctx = c.getContext('2d')!;
    ctx.font = font;
    const w = Math.ceil(ctx.measureText(text).width) + px * 0.5;
    c.width = w;
    c.height = Math.ceil(px * 1.5);
    ctx.font = font;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.lineWidth = px * 0.22;
    ctx.strokeStyle = '#ffffff';
    ctx.strokeText(text, w / 2, c.height / 2);
    ctx.fillStyle = '#4a2a14';
    ctx.fillText(text, w / 2, c.height / 2);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    this.textures.set(text, tex);
    return tex;
  }
}

/**
 * 表情を一時的に上書きする。face：そのまま差し替えるパーツ、atLeast：選んでいるものが
 * これより少ない（選択肢の並びで前にある）ときだけ差し替えるパーツ。汗・頬などそれ以外は選んでいるまま
 */
export function showFace(y: Yukkuri, face: Partial<PartSelection>, atLeast: Partial<PartSelection> = {}): void {
  const mine = y.face.settings.parts;
  const out = { ...face };
  for (const [part, id] of Object.entries(atLeast) as [FacePart, string][]) {
    const opts = findPart(part).options;
    const rank = (v: string) => opts.findIndex((o) => o.id === v);
    if (rank(mine[part]) < rank(id)) out[part] = id;
  }
  y.face.override = out;
}

/** 一覧からどれか 1 つ（発言のパターンを選ぶ） */
export function pick<T>(list: readonly T[]): T {
  return list[Math.floor(Math.random() * list.length)];
}

/**
 * 体の前の向き（水平）。体の向き（Y 軸まわり）から求める。
 * 体を大きく傾けているとき（腹ばいでお尻を突き上げるなど）は顔がほぼ真下・真上を向き、
 * 顔の向きの水平成分はわずかな揺れで前にも後ろにもなるので、跳ねる向きなどにはこちらを使う
 */
export function bodyFacing(y: Yukkuri): THREE.Vector3 {
  const yaw = y.body.yaw;
  return new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
}

/** 顔の正面の向き（水平）と、顔座標 (fx, fy) の位置 */
export function faceFrame(y: Yukkuri, fx = 0, fy = 0): { pos: THREE.Vector3; facing: THREE.Vector3 } {
  const pos = new THREE.Vector3(), n = new THREE.Vector3();
  if (!y.outfit.facePoint(fx, fy, pos, n)) {
    pos.copy(y.center);
    n.set(0, 0, 1);
  }
  n.y = 0;
  if (n.lengthSq() < 1e-6) n.set(0, 0, 1);
  return { pos, facing: n.normalize() };
}
