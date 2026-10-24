import * as THREE from 'three';
import { loadJSON, saveJSON } from '../platform/storage';
import type { LineKey } from './lines';
import { bodyFacing, faceFrame, showFace, type Word } from './fx';
import { smooth } from './braidPick';
import type { PartSelection } from '../face/parts';
import type { Yukkuri } from './Yukkuri';

/**
 * あいさつ：
 *   動作の前の宣言 … ボタンで動作を始めるとき、先に「うんうんするよ！」などと言い、言い終えてから（DECLARE_TIME 秒）動作を始める。
 *                     宣言する／しないは切り替えられる（declareFirst。保存する）。宣言の間はその場で止まって待つ
 *   挨拶 … 「ゆっくりしていってね！」などをボタンで言う（セリフだけ）。「ここを{種族名}のゆっくりぷれいすにするよ！」の種族名は
 *          キャラクターの呼び名（CharacterDef.kana。なければ「ゆっくり」）
 *   おうちせんげん（proud）… 言いながらその場で軽く一度跳ね、着地したら少し体を反らして胸を張り、正面の上を見上げる（にっこり）。
 *                             せんげんした場所をおうち（Yukkuri.home）にする
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
/**
 * おうちせんげん：跳ねる上向きの速さ（m/s）。胸を張る（後ろへ反らす角度 rad・縦の伸び）間の長さ（秒。寄せる・戻す時間を含む）。
 * 見上げる所（顔から、前へ・上へ 胴の半径の何倍か。正面の上）
 */
const PROUD_HOP = 1.6;
const PROUD_LEAN = 0.16;
const PROUD_STRETCH = 1.05;
const PROUD_TIME = 2.6;
const PROUD_IN = 0.35;
const PROUD_OUT = 0.45;
const PROUD_LOOK = [2.0, 2.4];
const FACE_PROUD: Partial<PartSelection> = { eyes: 'normal', brows: 'neutral', mouth: 'smile' };

export class Greet {
  /** 動作の前に宣言する */
  declareFirst = true;
  /** 挨拶・宣言の文字の大きさ（倍。保存する） */
  textSize = 1;
  /** 「ゆっくりしていってね！」の文字の大きさ（ふつうの文字に対する倍。保存する） */
  bigSize = 3;
  private pending: { then: () => void; t: number } | null = null;
  /** おうちせんげんの途中（跳ねて着地を待つ・胸を張る） */
  private proud: {
    phase: 'hop' | 'pose'; t: number; heading: number; face: Partial<PartSelection> | null;
    /** 跳ねる前の重心の高さと、跳ねている間の一番高い所 */
    y0: number; top: number;
  } | null = null;
  private readonly pose = new THREE.Quaternion();
  private readonly euler = new THREE.Euler(0, 0, 0, 'YXZ');
  private word: Word | null = null;

  constructor(private readonly y: Yukkuri) {
    const saved = loadJSON<{ declareFirst?: boolean; textSize?: number; bigSize?: number }>(STORAGE_KEY);
    if (saved?.declareFirst === false) this.declareFirst = false;
    if (typeof saved?.textSize === 'number') this.textSize = saved.textSize;
    if (typeof saved?.bigSize === 'number') this.bigSize = saved.bigSize;
  }

  /** 宣言して言い終えるのを待っている途中か、おうちせんげんの途中か */
  get busy(): boolean {
    return this.pending !== null || this.proud !== null;
  }

  /**
   * おうちせんげん：「ここを○○のゆっくりぷれいすにするよ！」と言い、その場で軽く跳ねて、着地したら胸を張って斜め上を見上げる。
   * 始められないとき（can が false・ほかのあいさつの途中・気絶中・寝転がっている）は何もしない
   */
  declareHome(can: () => boolean): boolean {
    const y = this.y;
    if (this.busy || y.rest.fainting || y.death.active || y.otabe.active || y.locomotion.isLying || !can()) return false;
    y.rest.wake(true);
    y.locomotion.stop();
    y.locomotion.hold();
    this.say('greetPlace');
    // せんげんした場所をおうちにする（巣作りなどの起点。前のおうちは置き換わる）
    y.home.set(y.center.x, y.center.z, y.body.yaw);
    y.impulse(0, PROUD_HOP, 0);
    this.proud = { phase: 'hop', t: 0, heading: y.body.yaw, face: null, y0: y.center.y, top: y.center.y };
    return true;
  }

  save(): void {
    saveJSON(STORAGE_KEY, { declareFirst: this.declareFirst, textSize: this.textSize, bigSize: this.bigSize });
  }

  /**
   * 宣言してから then を呼ぶ（宣言しない設定なら、すぐ呼ぶ）。始められないとき（can が false・宣言の途中・気絶中）は何もしない
   */
  declare(key: LineKey, can: () => boolean, then: () => void): boolean {
    const y = this.y;
    if (this.busy || y.rest.fainting || y.death.active || y.otabe.active || !can()) return false;
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
    if (this.proud) this.updateProud(dt);
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

  private updateProud(dt: number): void {
    const y = this.y;
    const pr = this.proud!;
    const loco = y.locomotion;
    pr.t += dt;
    if (y.rest.fainting || loco.isLying) {
      this.endProud();
      return;
    }
    if (pr.phase === 'hop') {
      // 跳ね上がって、跳ねる前の高さまで下りてきたら（着地したら）胸を張る
      pr.top = Math.max(pr.top, y.center.y);
      const landed = pr.top > pr.y0 + y.shape.radius * 0.05 && y.center.y <= pr.y0 + y.shape.radius * 0.02 && y.body.groundContacts > 0;
      if ((landed && loco.idle) || pr.t > 2) {
        pr.phase = 'pose';
        pr.t = 0;
        showFace(y, FACE_PROUD);
        pr.face = y.face.override;
      }
      return;
    }
    // 胸を張る：少し後ろへ反らして縦に伸び、斜め上を見上げる。始めと終わりはなめらかに
    const k = Math.min(smooth(pr.t / PROUD_IN), 1 - smooth((pr.t - (PROUD_TIME - PROUD_OUT)) / PROUD_OUT));
    this.euler.set(-PROUD_LEAN * k, pr.heading, 0);
    this.pose.setFromEuler(this.euler);
    loco.gesture = { orientation: this.pose, squash: 1 + (PROUD_STRETCH - 1) * k };
    const R = y.shape.radius;
    const f = bodyFacing(y);
    const head = faceFrame(y, 0, 0).pos;
    if (k > 0.05) y.lookAt(head.addScaledVector(f, R * PROUD_LOOK[0]).add(new THREE.Vector3(0, R * PROUD_LOOK[1], 0)));
    else y.lookAt(null);
    if (pr.t >= PROUD_TIME) this.endProud();
  }

  private endProud(): void {
    const y = this.y;
    const pr = this.proud!;
    if (y.locomotion.gesture?.orientation === this.pose) y.locomotion.gesture = null;
    if (pr.face && y.face.override === pr.face) y.face.override = null;
    y.lookAt(null);
    y.locomotion.release();
    this.proud = null;
  }
}
