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
/** セリフの大きさの基準（胴の半径に対する比。調整値 textSize を掛ける）と、出している時間（秒） */
const SIZE = 0.22;
const LIFE = 1.8;
/** 「ゆっくりしていってね！」の出している時間の倍率（大きさは調整値 bigSize） */
const BIG_LIFE = 2;
/**
 * セリフを出す高さ：体の中心の高さ＋体の高さの半分から、胴の半径の RAISE 倍。文字が大きいほど上に出す
 * （大きさの基準を超えた分 × RAISE_PER。大きくすると帽子に重なった）
 */
const RAISE = 0.45;
const RAISE_PER = 1.93;

export class Greet {
  /** 動作の前に宣言する */
  declareFirst = true;
  /** 挨拶・宣言の文字の大きさ（倍。保存する） */
  textSize = 1;
  /** 「ゆっくりしていってね！」の文字の大きさ（ふつうの文字に対する倍。保存する） */
  bigSize = 3;
  private pending: { then: () => void; t: number } | null = null;
  private word: Word | null = null;

  constructor(private readonly y: Yukkuri) {
    const saved = loadJSON<{ declareFirst?: boolean; textSize?: number; bigSize?: number }>(STORAGE_KEY);
    if (saved?.declareFirst === false) this.declareFirst = false;
    if (typeof saved?.textSize === 'number') this.textSize = saved.textSize;
    if (typeof saved?.bigSize === 'number') this.bigSize = saved.bigSize;
  }

  /** 宣言して、言い終えるのを待っている途中か */
  get busy(): boolean {
    return this.pending !== null;
  }

  save(): void {
    saveJSON(STORAGE_KEY, { declareFirst: this.declareFirst, textSize: this.textSize, bigSize: this.bigSize });
  }

  /**
   * 宣言してから then を呼ぶ（宣言しない設定なら、すぐ呼ぶ）。始められないとき（can が false・宣言の途中・気絶中）は何もしない
   */
  declare(key: LineKey, can: () => boolean, then: () => void): boolean {
    const y = this.y;
    if (this.pending || y.rest.fainting || y.death.active || y.otabe.active || !can()) return false;
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
    if (y.death.active || y.otabe.active) return; // 死んでいく途中・死んだ後・おたべなさいの途中は言わない
    const R = y.shape.radius;
    const text = y.line(key).replace('{species}', y.outfit.character.kana ?? 'ゆっくり');
    // 「ゆっくりしていってね！」だけは大きく長く（指示）。大きい分だけ上に出す（帽子に重なった）
    const big = key === 'greetYukkuri';
    const size = SIZE * this.textSize * (big ? this.bigSize : 1);
    const raise = RAISE + Math.max(0, size - SIZE) * RAISE_PER;
    const pos = new THREE.Vector3(y.center.x, y.center.y + y.height * 0.5 + R * raise, y.center.z);
    if (this.word) y.texts.fade(this.word);
    this.word = y.texts.say(text, pos, R * size, LIFE * (big ? BIG_LIFE : 1), new THREE.Vector3(0, R * 0.15, 0));
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
