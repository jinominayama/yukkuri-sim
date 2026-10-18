import * as THREE from 'three';
import type { PartSelection } from '../face/parts';
import { loadJSON, saveJSON } from '../platform/storage';
import { pick, showFace, type Word } from './fx';
import type { Yukkuri } from './Yukkuri';

/**
 * 眠る・気絶。どちらも体を柔らかくする（形に戻る強さに掛ける倍率 SoftBody.softness を下げ、
 * 皮の伸びやすさに掛ける倍率 SoftBody.skinLoose を上げる。形に戻る強さを下げるだけでは、皮の張りで丸いまま残る）。
 *   眠る … 立った姿勢で眠る（寝転がっていれば起き上がってから）。目を閉じ、ゆっくり大きく呼吸して「すーやすーや」。
 *          起こすまで眠り続ける。起こす：ボタン・つつく・叩く・ほかの動き（食べる・うんうんなど）・行き先の指示・体勢の指示
 *   気絶 … どの姿勢でもその場で気絶する（立っていても寝転がっていても、そのままの姿勢）。目を×かぐるぐるにし、よだれを垂れ流して動かなくなり、
 *          しばらくすると気がつく。数秒ごとに不定期にビクッと痙攣する。気絶している間はつつかれても顔は変わらず、ほかの動きも始めない
 */
export interface RestParams {
  /** 眠っているときの柔らかさ（形に戻る強さに掛ける倍率。小さいほど柔らかい） */
  sleepSoft: number;
  /** 気絶しているときの柔らかさ */
  faintSoft: number;
  /** 気絶している時間（秒） */
  faintTime: number;
  /** 眠っている・気絶しているときの皮のゆるさ（皮の伸びやすさに掛ける倍率。大きいほどへたる） */
  sleepSkin: number;
  faintSkin: number;
}
export const DEFAULT_REST: RestParams = { sleepSoft: 0.15, faintSoft: 0.05, faintTime: 36, sleepSkin: 8, faintSkin: 30 };
const STORAGE_KEY = 'rest';

/** 柔らかさを変える速さ（1/s）：眠りに落ちる・目を覚ます・気絶する・気がつく */
const SOFTEN_SLEEP = 0.8;
const SOFTEN_FAINT = 4;
const HARDEN = 2.5;
/** 眠り：うとうとする時間（秒）、寝言の間隔（秒）、呼吸の大きさ・速さの倍率 */
const DOZE_TIME = 2;
const SNORE_EVERY = 3.5;
const SLEEP_BREATH = 2.2;
const SLEEP_BREATH_RATE = 0.55;
/**
 * 気絶中の痙攣：次の痙攣までの間（秒。この範囲でばらつかせる）、1 回の痙攣でビクッとする回数と間隔（秒）、
 * ビクッとするときに体の一部へ足す速さ（m/s）と範囲（胴の半径に対する比）、そのときの震えの振れ幅（胴の半径に対する比）
 */
const TWITCH_GAP_MIN = 1.5;
const TWITCH_GAP_MAX = 5;
const TWITCH_JERKS_MIN = 1;
const TWITCH_JERKS_MAX = 3;
const TWITCH_JERK_GAP = 0.09;
const TWITCH_SPEED = 0.9;
const TWITCH_RADIUS = 0.9;
const TWITCH_TREMBLE = 0.03;
/** 起き上がるのを待つ上限（秒） */
const WAIT_MAX = 12;
/** 目を覚ました・気がついたときの顔を出しておく時間（秒） */
const AWAKE_FACE_TIME = 1.8;

const FACE_DOZE: Partial<PartSelection> = { eyes: 'half', brows: 'neutral', mouth: 'smileSmall' };
const FACE_SLEEP: Partial<PartSelection> = { eyes: 'closed', brows: 'neutral', mouth: 'smileSmall' };
const FACE_WAKE: Partial<PartSelection> = { eyes: 'normal', brows: 'neutral', mouth: 'smile' };
/** 気絶：目は×・ぐるぐる・白目のどれか（気絶するたびにランダム）、口はぽかんと開けてよだれを垂れ流す（指示） */
const FACE_FAINT: Partial<PartSelection> = { eyes: 'cross', brows: 'worried', mouth: 'openSmall', drool: 'flood' };
const FAINT_EYES = ['cross', 'swirl', 'shock'];
const FACE_COME_TO: Partial<PartSelection> = { eyes: 'troubled', brows: 'worried', mouth: 'openSmall' };

const DOZE_WORDS = ['ゆぅ…ねむいよ…', 'ゆっくり…おやすみ…', 'ゆふぁ～…'];
const SNORE_WORDS = ['すーやすーや', 'ゆぅ…ゆぅ…', 'むにゃむにゃ…', 'すーや…すーや…', 'もう…たべられないよ…', 'ゆっくり…してるよ…'];
const WAKE_WORDS = ['ゆっくりおきたよ！', 'ゆっ！？', 'ゆふぁ～…よくねたよ！', 'ゆっくりしていってね！'];
const FAINT_WORDS = ['ゆ゛っ…', 'ゆ…ぐ…', 'ゆきゅ～…'];
const COME_TO_WORDS = ['ゆ…ゆっくり…？', 'ゆぅ…ここは…？', 'ゆっ…！？なにがあったの…？'];

type SleepPhase = 'none' | 'wait' | 'doze' | 'sleep';

/** 言葉を頭の上に出す（前の言葉は早めに消す） */
function sayAbove(y: Yukkuri, prev: Word | null, text: string, life: number, size = 0.24): Word {
  const R = y.shape.radius;
  const pos = new THREE.Vector3(y.center.x, y.center.y + y.height * 0.5 + R * 0.35, y.center.z);
  if (prev) y.texts.fade(prev);
  return y.texts.say(text, pos, R * size, life, new THREE.Vector3(R * 0.08, R * 0.12, 0));
}

/** 目を覚ました・気がついた顔をしばらく出してから、いつもの顔に戻す */
class AfterFace {
  private left = 0;
  private face: Partial<PartSelection> | null = null;
  constructor(private readonly y: Yukkuri) {}
  show(face: Partial<PartSelection>): void {
    showFace(this.y, face);
    this.face = this.y.face.override;
    this.left = AWAKE_FACE_TIME;
  }
  update(dt: number): void {
    if (this.left <= 0) return;
    this.left -= dt;
    // ほかの動きが顔を変えていたら触らない
    if (this.left <= 0 && this.y.face.override === this.face) this.y.face.override = null;
  }
}

export class Rest {
  readonly params: RestParams = { ...DEFAULT_REST, ...loadJSON<Partial<RestParams>>(STORAGE_KEY) };
  private sleepPhase: SleepPhase = 'none';
  private fainted = false;
  private t = 0;
  private snoreIn = 0;
  /** 次の痙攣までの時間（秒）、今の痙攣で残っているビクッの回数と、次のビクッまでの時間 */
  private twitchIn = 0;
  private jerksLeft = 0;
  private jerkIn = 0;
  private word: Word | null = null;
  private readonly after: AfterFace;

  constructor(private readonly y: Yukkuri) {
    this.after = new AfterFace(y);
  }

  save(): void {
    saveJSON(STORAGE_KEY, this.params);
  }

  /** 眠っている（眠りに落ちる途中を含む）か */
  get sleeping(): boolean {
    return this.sleepPhase !== 'none';
  }

  /** 気絶しているか */
  get fainting(): boolean {
    return this.fainted;
  }

  /** 眠るか気絶している（ほかの動きをしない）か */
  get active(): boolean {
    return this.sleeping || this.fainted;
  }

  /** 眠る。ほかの動きの最中・気絶中は何もしない。寝転がっていれば起き上がってから */
  sleep(): boolean {
    const y = this.y;
    if (this.active || this.othersBusy()) return false;
    const loco = y.locomotion;
    loco.stop();
    loco.hold();
    this.t = 0;
    if (loco.tilted || !loco.idle) {
      if (loco.isLying) y.getUp();
      this.sleepPhase = 'wait';
    } else this.doze();
    return true;
  }

  /** 起こす（眠っていなければ何もしない）。quiet：言葉と顔を出さない（つつかれて起きたときは、つつかれた反応に任せる） */
  wake(quiet = false): void {
    if (!this.sleeping) return;
    const y = this.y;
    const wasAsleep = this.sleepPhase === 'sleep' || this.sleepPhase === 'doze';
    this.sleepPhase = 'none';
    y.breathGain = 1;
    y.breathSlow = 1;
    y.face.override = null;
    y.locomotion.release();
    if (!quiet && wasAsleep) {
      this.word = sayAbove(y, this.word, pick(WAKE_WORDS), 1.8);
      this.after.show(FACE_WAKE);
    }
  }

  /** 眠る／起こす */
  toggleSleep(): void {
    if (this.sleeping) this.wake();
    else this.sleep();
  }

  /** 気絶する（その場の姿勢のまま）。眠っていれば眠りから気絶へ。ほかの動きはやめる */
  faint(): boolean {
    const y = this.y;
    if (this.fainted) return false;
    if (this.sleeping) this.wake(true);
    if (y.feeding.active) y.feeding.cancel();
    if (y.exercise.active) y.exercise.cancel();
    if (y.moru.active) y.moru.toggle();
    if (y.dropping.active || y.vomit.active) return false; // 出している最中は、出し終えるまで待たない（気絶しない）
    const loco = y.locomotion;
    loco.stop();
    loco.hold();
    this.fainted = true;
    this.t = 0;
    this.twitchIn = 1 + Math.random() * 1.5;
    this.jerksLeft = 0;
    showFace(y, { ...FACE_FAINT, eyes: pick(FAINT_EYES) });
    if (y.face.override) y.face.override.sweat = 'forehead,templeL,templeR';
    this.word = sayAbove(y, this.word, pick(FAINT_WORDS), 1.6, 0.26);
    return true;
  }

  /** 気がつく */
  private comeTo(): void {
    const y = this.y;
    this.fainted = false;
    this.jerksLeft = 0;
    y.tremble = 0;
    y.face.override = null;
    y.locomotion.release();
    this.word = sayAbove(y, this.word, pick(COME_TO_WORDS), 2.2);
    this.after.show(FACE_COME_TO);
  }

  /** 固定時間刻みで呼ぶ */
  update(dt: number): void {
    const y = this.y;
    this.t += dt;
    this.after.update(dt);
    const loco = y.locomotion;
    if (this.sleeping) {
      // ほかの動きを始めた・行き先や体勢を指示された → 起こす
      if (this.othersBusy() || loco.deferred || (this.sleepPhase !== 'wait' && loco.tilted)) this.wake(true);
    }
    switch (this.sleepPhase) {
      case 'wait':
        if ((loco.idle && !loco.tilted) || this.t > WAIT_MAX) this.doze();
        else if (loco.resting) y.getUp();
        break;
      case 'doze':
        if (this.t > DOZE_TIME) {
          this.sleepPhase = 'sleep';
          this.t = 0;
          this.snoreIn = 1;
          showFace(y, FACE_SLEEP);
        }
        break;
      case 'sleep':
        this.snoreIn -= dt;
        if (this.snoreIn <= 0) {
          this.snoreIn = SNORE_EVERY;
          this.word = sayAbove(y, this.word, pick(SNORE_WORDS), 2.6, 0.2);
        }
        break;
    }
    if (this.fainted) this.twitch(dt);
    if (this.fainted && this.t > this.params.faintTime) this.comeTo();

    // 柔らかさ：眠っている・気絶している間は下げ、それ以外は 1 へ戻す（どれもなめらかに）
    const goal = this.fainted ? this.params.faintSoft : this.sleepPhase === 'sleep' || this.sleepPhase === 'doze'
      ? this.params.sleepSoft : 1;
    const rate = this.fainted ? SOFTEN_FAINT : goal < y.body.softness ? SOFTEN_SLEEP : HARDEN;
    const k = Math.min(1, dt * rate);
    y.body.softness += (goal - y.body.softness) * k;
    // 皮のゆるさは倍率が大きいので、対数で寄せる（戻るときに急に張らないように）
    const skinGoal = this.fainted ? this.params.faintSkin : goal < 1 ? this.params.sleepSkin : 1;
    y.body.skinLoose = Math.exp(Math.log(y.body.skinLoose) + (Math.log(skinGoal) - Math.log(y.body.skinLoose)) * k);
    // 眠っている間は、ゆっくり大きく呼吸する
    if (this.sleepPhase === 'sleep') {
      const b = Math.min(1, dt * 0.8);
      y.breathGain += (SLEEP_BREATH - y.breathGain) * b;
      y.breathSlow += (SLEEP_BREATH_RATE - y.breathSlow) * b;
    }
  }

  /**
   * 気絶中の痙攣：不定期に、短い間隔で何回かビクッとする。ビクッとするたびに体のどこか（上半分）を
   * 外向き・上向きに弾き（柔らかくなった体がぶるんと揺れる）、見た目も一瞬小刻みに震わせる
   */
  private twitch(dt: number): void {
    const y = this.y;
    if (this.jerksLeft > 0) {
      this.jerkIn -= dt;
      y.tremble = Math.max(0, y.tremble - dt * TWITCH_TREMBLE / TWITCH_JERK_GAP);
      if (this.jerkIn <= 0) {
        this.jerksLeft--;
        this.jerkIn = TWITCH_JERK_GAP * (0.7 + Math.random() * 0.6);
        this.jerk();
        if (this.jerksLeft === 0) y.tremble = 0;
      }
      return;
    }
    this.twitchIn -= dt;
    if (this.twitchIn > 0) return;
    this.twitchIn = TWITCH_GAP_MIN + Math.random() * (TWITCH_GAP_MAX - TWITCH_GAP_MIN);
    this.jerksLeft = TWITCH_JERKS_MIN + Math.floor(Math.random() * (TWITCH_JERKS_MAX - TWITCH_JERKS_MIN + 1));
    this.jerkIn = 0;
  }

  private jerk(): void {
    const y = this.y;
    const R = y.shape.radius;
    const c = y.center;
    // 体の表面のどこか（重心から見てランダムな向き。下半分は地面に押しつけるだけなので上へ寄せる）
    const dir = new THREE.Vector3(Math.random() * 2 - 1, Math.random() * 0.8 + 0.2, Math.random() * 2 - 1).normalize();
    const p = c.clone().addScaledVector(dir, R * 0.8);
    const s = TWITCH_SPEED * (0.6 + Math.random() * 0.6);
    // 横向きは半分（続けると少しずつ這うように動いてしまう）
    y.body.addLocalVelocity(p.x, p.y, p.z, R * TWITCH_RADIUS, dir.x * s * 0.5, Math.abs(dir.y) * s + s * 0.4, dir.z * s * 0.5);
    y.tremble = TWITCH_TREMBLE;
  }

  private doze(): void {
    this.sleepPhase = 'doze';
    this.t = 0;
    showFace(this.y, FACE_DOZE);
    this.word = sayAbove(this.y, this.word, pick(DOZE_WORDS), 2.0);
  }

  /** 食べる・うんうん・体操・吐餡・もるんもるんの最中か */
  private othersBusy(): boolean {
    const y = this.y;
    return y.feeding.active || y.dropping.active || y.exercise.active || y.vomit.active || y.moru.active;
  }
}
