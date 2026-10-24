import * as THREE from 'three';
import { loadJSON, saveJSON } from '../platform/storage';
import type { LineKey } from './lines';
import type { Word } from './fx';
import type { Yukkuri } from './Yukkuri';

/**
 * あいさつ：
 *   動作の前の宣言 … ボタンで動作を始めるとき、先に「うんうんするよ！」などと言い、言い終えてから（DECLARE_TIME 秒）動作を始める。
 *                     宣言する／しないは切り替えられる（declareFirst。保存する）。宣言の間はその場で止まって待つ
 *   挨拶 … 「ゆっくりしていってね！」などをボタンで言う（セリフだけ）。「ここを{種族名}のゆっくりぷれいすにするよ！」の種族名は
 *          キャラクターの呼び名（CharacterDef.kana。なければ「ゆっくり」）
 */
const STORAGE_KEY = 'greet';
/** 宣言してから動作を始めるまで（秒） */
const DECLARE_TIME = 1.3;
/** セリフの大きさ（胴の半径に対する比）と、出している時間（秒） */
const SIZE = 0.22;
const LIFE = 1.8;

export class Greet {
  /** 動作の前に宣言する */
  declareFirst = true;
  private pending: { then: () => void; t: number } | null = null;
  private word: Word | null = null;

  constructor(private readonly y: Yukkuri) {
    const saved = loadJSON<{ declareFirst?: boolean }>(STORAGE_KEY);
    if (saved?.declareFirst === false) this.declareFirst = false;
  }

  /** 宣言して、言い終えるのを待っている途中か */
  get busy(): boolean {
    return this.pending !== null;
  }

  save(): void {
    saveJSON(STORAGE_KEY, { declareFirst: this.declareFirst });
  }

  /**
   * 宣言してから then を呼ぶ（宣言しない設定なら、すぐ呼ぶ）。始められないとき（can が false・宣言の途中・気絶中）は何もしない
   */
  declare(key: LineKey, can: () => boolean, then: () => void): boolean {
    const y = this.y;
    if (this.pending || y.rest.fainting || !can()) return false;
    if (!this.declareFirst) {
      then();
      return true;
    }
    y.rest.wake(true);
    y.locomotion.stop();
    y.locomotion.hold();
    this.say(key);
    this.pending = { then, t: 0 };
    return true;
  }

  /** 挨拶を言う */
  say(key: LineKey): void {
    const y = this.y;
    const R = y.shape.radius;
    const text = y.line(key).replace('{species}', y.outfit.character.kana ?? 'ゆっくり');
    const pos = new THREE.Vector3(y.center.x, y.center.y + y.height * 0.5 + R * 0.45, y.center.z);
    if (this.word) y.texts.fade(this.word);
    this.word = y.texts.say(text, pos, R * SIZE, LIFE, new THREE.Vector3(0, R * 0.15, 0));
  }

  /** 固定時間刻みで呼ぶ */
  update(dt: number): void {
    const p = this.pending;
    if (!p) return;
    const y = this.y;
    // 宣言の途中で気絶したら、やめる
    if (y.rest.fainting) {
      this.pending = null;
      y.locomotion.release();
      return;
    }
    p.t += dt;
    if (p.t < DECLARE_TIME) return;
    this.pending = null;
    y.locomotion.release();
    p.then();
  }
}
