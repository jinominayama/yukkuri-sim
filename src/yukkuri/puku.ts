import * as THREE from 'three';
import type { PartSelection } from '../face/parts';
import { loadJSON, saveJSON } from '../platform/storage';
import { pick, showFace, type Word } from './fx';
import type { Yukkuri } from './Yukkuri';

/**
 * ぷくー：怒って・威嚇して、体を空気でふくらませてみせる（本人は全力の威嚇のつもり）。
 *   ふくらむ（INFLATE_TIME 秒）→ ふくらんだまま小刻みに震える（params.time 秒。「ぷるぷる」）→ 息を抜いてしぼむ（「ぷしゅ～」）。
 *   体：下ぶくれにふくらむ（SoftBody.actuation.inflate・inflateWide。大きさと下ぶくれ具合は体型ごとに保存）。
 *   向き：設定でカメラ（遊んでいる人）の方を向く（立って止まっている間の身ぶり Locomotion.gesture）。
 *   顔：目をぎゅっとつぶる・にらむ・すまして閉じる から選ぶ（ランダムあり）。口は横に結んだへの字と、両脇の頬の輪郭「)—(」、頬は赤い。
 * 今はボタンでだけ始める。寝転がっていれば起き上がってから。食べる・うんうん・体操・吐餡・もるんもるん・眠る・気絶の最中はしない
 * （ふくらんでいる間にそれらが始まったら、すぐしぼむ）
 */
export type PukuFace = 'random' | 'squeeze' | 'glare' | 'calm';
type Mood = Exclude<PukuFace, 'random'>;

export interface PukuParams {
  face: PukuFace;
  /** カメラの方を向く */
  faceCamera: boolean;
  /** ふくらんだままでいる時間（秒） */
  time: number;
  /** ふくらむ大きさ（体型ごとに保存） */
  size: number;
  /** 下ぶくれ具合（下半分を余分に張り出させる割合。体型ごとに保存） */
  wide: number;
}

export const DEFAULT_PUKU: PukuParams = { face: 'squeeze', faceCamera: true, time: 10, size: 0.2, wide: 0.6 };

type Fit = Pick<PukuParams, 'size' | 'wide'>;
const FIT_KEYS = ['size', 'wide'] as const;
/** 体型ごとの初期値（体型 ID → 値。ない体型は DEFAULT_PUKU） */
const PRESET_PUKU: Record<string, Partial<Fit>> = {};
function fitDefaults(id: string): Fit {
  return { size: DEFAULT_PUKU.size, wide: DEFAULT_PUKU.wide, ...PRESET_PUKU[id] };
}

const STORAGE_KEY = 'puku';
const FIT_KEY = 'pukuFit';

/** ふくらむ・しぼむ時間（秒）と、起き上がるのを待つ上限（秒） */
const INFLATE_TIME = 0.7;
const DEFLATE_TIME = 0.6;
const WAIT_MAX = 12;
/** ふくらんでいる間の震え（胴の半径に対する比）と、「ぷるぷる」を出す間隔（秒） */
const TREMBLE = 0.012;
const PURU_EVERY = 1.3;
/** 向きを変えるとき、ふくらみながら少し後ろへ反って胸を張る角度（rad） */
const PUFF_LEAN = -0.08;

const MOODS: Record<Mood, Partial<PartSelection>> = {
  squeeze: { eyes: 'squeeze', brows: 'strain', mouth: 'pout' },
  glare: { eyes: 'half', brows: 'angry', mouth: 'pout' },
  calm: { eyes: 'closed', brows: 'angry', mouth: 'pout' },
};
const MOOD_LIST: Mood[] = ['squeeze', 'glare', 'calm'];
const AT_LEAST: Partial<PartSelection> = { blush: 'red' };
const SWEAT = 'forehead,templeL,templeR';

const START_WORDS = ['ぷくー！', 'ぷっくぅぅぅ！', 'ぷくぷくー！', 'ぷっくー！！'];
const PURU_WORDS = ['ぷる', 'ぷるぷる', 'ぷる…'];
const END_WORDS = ['ぷしゅ～', 'ぷひゅ～…', 'ぷすー'];

type Phase = 'none' | 'wait' | 'inflate' | 'hold' | 'deflate';

export class Puku {
  private readonly saved = loadJSON<Partial<PukuParams>>(STORAGE_KEY);
  readonly params: PukuParams = {
    ...DEFAULT_PUKU,
    face: this.saved?.face ?? DEFAULT_PUKU.face,
    faceCamera: this.saved?.faceCamera ?? DEFAULT_PUKU.faceCamera,
    time: this.saved?.time ?? DEFAULT_PUKU.time,
  };
  private readonly fits: Record<string, Partial<Fit>> = { ...loadJSON<Record<string, Partial<Fit>>>(FIT_KEY) };
  private presetId = '';
  private phase: Phase = 'none';
  private t = 0;
  /** 今のふくらみ（0〜1） */
  private amount = 0;
  private puruIn = 0;
  private side = 1;
  private mood: Mood = 'squeeze';
  private face: Partial<PartSelection> | null = null;
  private word: Word | null = null;
  private readonly orientation = new THREE.Quaternion();
  private readonly euler = new THREE.Euler(0, 0, 0, 'YXZ');

  constructor(private readonly y: Yukkuri) {}

  /** ふくらませている最中か（ふくらむ〜しぼみ終わるまで。起き上がるのを待っている間も） */
  get active(): boolean {
    return this.phase !== 'none';
  }

  save(): void {
    const { face, faceCamera, time } = this.params;
    saveJSON(STORAGE_KEY, { face, faceCamera, time });
  }

  /** 体型を切り替える：大きさ・下ぶくれ具合を、その体型で保存したもの（なければ初期値）にする */
  usePreset(id: string): void {
    this.presetId = id;
    Object.assign(this.params, fitDefaults(id), this.fits[id]);
  }

  /** 大きさ・下ぶくれ具合を今の体型のものとして保存する（調整パネルで変えたとき） */
  setFit(): void {
    if (!this.presetId) return;
    this.storeFit(this.presetId);
    saveJSON(FIT_KEY, this.fits);
  }

  /** 今の体型の大きさ・下ぶくれ具合を初期値に戻す */
  resetFit(): void {
    Object.assign(this.params, fitDefaults(this.presetId));
    this.setFit();
  }

  /** 今の大きさ・下ぶくれ具合を、別の体型（ユーザー設定など）にも写す */
  copyFitTo(id: string): void {
    this.storeFit(id);
    saveJSON(FIT_KEY, this.fits);
  }

  private storeFit(id: string): void {
    const changed: Partial<Fit> = {};
    const d = fitDefaults(id);
    for (const k of FIT_KEYS) if (this.params[k] !== d[k]) changed[k] = this.params[k];
    if (Object.keys(changed).length === 0) delete this.fits[id];
    else this.fits[id] = changed;
  }

  /** ぷくーする／やめる */
  toggle(): void {
    if (this.phase === 'none' || this.phase === 'deflate') this.start();
    else this.stop();
  }

  /** ぷくーし始める。ほかの動きの最中・気絶中は何もしない。寝転がっていれば起き上がってから */
  start(): boolean {
    const y = this.y;
    if ((this.phase !== 'none' && this.phase !== 'deflate') || this.othersBusy() || y.rest.fainting) return false;
    if (y.locomotion.isLying && y.stuck()) return false; // 足焼きで移動できず寝転がっていれば、起き上がれない
    y.rest.wake(true);
    const loco = y.locomotion;
    loco.stop();
    loco.hold();
    const f = this.params.face;
    this.mood = f === 'random' ? pick(MOOD_LIST) : f;
    this.t = 0;
    if (loco.isLying || !loco.idle) {
      if (loco.isLying) y.getUp();
      this.phase = 'wait';
    } else this.begin();
    return true;
  }

  /** 途中でやめる（しぼむ） */
  stop(): void {
    if (this.phase === 'none' || this.phase === 'deflate') return;
    if (this.phase === 'wait') {
      this.finish(true);
      return;
    }
    this.deflate();
  }

  /** 顔の選び方を変えたとき：ふくらんでいれば、すぐその顔にする */
  refreshFace(): void {
    if (this.phase !== 'inflate' && this.phase !== 'hold') return;
    const f = this.params.face;
    this.mood = f === 'random' ? pick(MOOD_LIST) : f;
    this.applyFace();
  }

  /** 固定時間刻みで呼ぶ（移動の処理より先に。身ぶりの向きを指示する） */
  update(dt: number): void {
    const y = this.y;
    const act = y.body.actuation;
    if (this.phase === 'none') {
      act.inflate = 0;
      return;
    }
    this.t += dt;
    // ほかの動きが始まったら、すぐしぼむ（その動きの身ぶり・移動の保留はそちらに任せる。
    // 保留を使わない動き（もるんもるん）なら、こちらの保留は解く）
    if (this.othersBusy() || y.rest.fainting) {
      this.finish(!(y.feeding.active || y.dropping.active || y.exercise.active || y.vomit.active || y.rest.active));
      return;
    }
    const loco = y.locomotion;
    switch (this.phase) {
      case 'wait':
        if ((loco.idle && !loco.tilted) || this.t > WAIT_MAX) this.begin();
        else if (loco.resting) y.getUp();
        break;
      case 'inflate':
        this.amount = smooth(this.t / INFLATE_TIME);
        if (this.t >= INFLATE_TIME) {
          this.phase = 'hold';
          this.t = 0;
          this.puruIn = PURU_EVERY * 0.5;
        }
        break;
      case 'hold':
        this.amount = 1;
        this.puruIn -= dt;
        if (this.puruIn <= 0) {
          this.puruIn = PURU_EVERY;
          this.puru();
        }
        // つつかれた顔などが終わったら、こちらの顔に戻す
        if (y.face.override === null) this.applyFace();
        if (this.t >= this.params.time) this.deflate();
        break;
      case 'deflate':
        this.amount = 1 - smooth(this.t / DEFLATE_TIME);
        if (this.t >= DEFLATE_TIME) this.finish(true);
        break;
    }
    if ((this.phase as Phase) === 'none') return; // 上でしぼみ終えた
    act.inflate = this.params.size * this.amount;
    act.inflateWide = this.params.wide;
    // 震える：ふくらんでいる間だけ（見た目だけ）
    y.tremble = this.phase === 'hold' ? TREMBLE : this.phase === 'inflate' ? TREMBLE * this.amount : 0;
    // 向き：カメラの方へ（設定）。ふくらむにつれて少し反って胸を張る。立って止まっている間だけ効く
    if (this.phase !== 'wait' && loco.idle) {
      const yaw = this.params.faceCamera && y.viewer
        ? Math.atan2(y.viewer.x - y.center.x, y.viewer.z - y.center.z)
        : y.body.yaw;
      this.euler.set(PUFF_LEAN * this.amount, yaw, 0);
      this.orientation.setFromEuler(this.euler);
      loco.gesture = { orientation: this.orientation, squash: 1 };
    }
  }

  private begin(): void {
    this.phase = 'inflate';
    this.t = 0;
    this.amount = 0;
    this.applyFace();
    this.say(pick(START_WORDS), 0.4, 1.8, 0);
  }

  private deflate(): void {
    this.phase = 'deflate';
    this.t = 0;
    this.say(pick(END_WORDS), 0.28, 1.4, 0);
  }

  /** 終える。release：移動の保留を解く（ほかの動きが始まってやめたときは、その動きの保留を解かないよう false） */
  private finish(release: boolean): void {
    const y = this.y;
    this.phase = 'none';
    this.amount = 0;
    y.body.actuation.inflate = 0;
    y.tremble = 0;
    if (y.locomotion.gesture?.orientation === this.orientation) y.locomotion.gesture = null;
    if (this.face && y.face.override === this.face) y.face.override = null;
    this.face = null;
    if (release) y.locomotion.release();
  }

  private applyFace(): void {
    const y = this.y;
    showFace(y, MOODS[this.mood], AT_LEAST);
    if (y.face.override) y.face.override.sweat = SWEAT;
    this.face = y.face.override;
  }

  /** 「ぷるぷる」：体の下の左右に交互に小さく */
  private puru(): void {
    const y = this.y;
    const R = y.shape.radius;
    this.side = -this.side;
    const yaw = y.body.yaw;
    const sideDir = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
    const pos = new THREE.Vector3(y.center.x, R * 0.35, y.center.z).addScaledVector(sideDir, this.side * R * 1.45);
    y.texts.say(pick(PURU_WORDS), pos, R * 0.2, 1.0, new THREE.Vector3(0, R * 0.15, 0).addScaledVector(sideDir, this.side * R * 0.1));
  }

  /** 頭の上に文字 */
  private say(text: string, size: number, life: number, side: number): void {
    const y = this.y;
    const R = y.shape.radius;
    const pos = new THREE.Vector3(y.center.x, y.center.y + y.height * 0.5 + R * (0.5 + this.params.size), y.center.z);
    pos.x += side * R * 0.5;
    if (this.word) y.texts.fade(this.word);
    this.word = y.texts.say(text, pos, R * size, life, new THREE.Vector3(0, R * 0.2, 0));
  }

  /** 食べる・うんうん・体操・吐餡・もるんもるん・眠るの最中か */
  private othersBusy(): boolean {
    const y = this.y;
    return y.feeding.active || y.dropping.active || y.exercise.active || y.vomit.active || y.moru.active || y.rest.sleeping;
  }
}

/** 0〜1 をなめらかに */
function smooth(t: number): number {
  t = Math.min(1, Math.max(0, t));
  return t * t * (3 - 2 * t);
}
