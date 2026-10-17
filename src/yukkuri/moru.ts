import * as THREE from 'three';
import type { PartSelection } from '../face/parts';
import { loadJSON, remove, saveJSON } from '../platform/storage';
import { bodyFacing, showFace, type Word } from './fx';
import type { Yukkuri } from './Yukkuri';

/**
 * もるんもるん：顔を床に付けるほど前へ倒れてお尻を突き上げ、左右に「もるん、もるん」と振る。
 *   ・調整パネルのボタンで、その場で振り始める・やめる。振っている間に行き先を決めると、もるんもるんのまま這って行き、
 *     着いたらまたその場で振る
 *   ・移動方法を「もるんもるん」にすると、移動している間だけもるんもるんで這う（着いたら立つ）
 * 体の動きは Locomotion（moru・mode = 'moru'）が受け持ち、ここでは顔と文字を出す。
 * 顔はご機嫌・必死・泣きから選ぶ（ランダムも）。振り切るたびに、振った側に「もるんっ」と出す。
 * 顔の選び方は全体で 1 つ、左右の揺れ幅と尻を上げる角度は体型ごとに保存する
 */

/** 顔の選び方 */
export type MoruFace = 'random' | 'happy' | 'desperate' | 'cry';
type Mood = Exclude<MoruFace, 'random'>;

export interface MoruParams {
  face: MoruFace;
  /** 左右の揺れ幅（片側。体の前後の長さに対する比。Locomotion.moruWag に渡す。体型ごとに保存する） */
  wag: number;
  /** 尻を上げる角度（度。前へ倒す角度。Locomotion.moruLift に渡す。体型ごとに保存する） */
  lift: number;
}

export const DEFAULT_MORU: MoruParams = { face: 'happy', wag: 0.35, lift: 60 };

/** 左右の揺れ幅の上限（調整パネルの欄の右端。大きくするとお尻がとがって伸びる） */
export const MORU_WAG_MAX = 0.4;

/** 体型ごとに保存する項目 */
type Fit = Pick<MoruParams, 'wag' | 'lift'>;
const FIT_KEYS = ['wag', 'lift'] as const;

/** 体型ごとの揺れ幅・角度の初期値（体型 ID → 値。ない体型は DEFAULT_MORU）。調整パネルで体型ごとに合わせた値 */
const PRESET_MORU: Record<string, Fit> = {
  user: { wag: 0.07, lift: 24 },
  ball: { wag: 0.09, lift: 17 },
  egg: { wag: 0.13, lift: 28 },
  chick: { wag: 0.09, lift: 15 },
  flat: { wag: 0.07, lift: 15 },
  eggplant: { wag: 0.14, lift: 35 },
  caterpillar: { wag: 0.07, lift: 20 },
};

/** 体型 id の揺れ幅・角度の初期値 */
function fitDefaults(id: string): Fit {
  return { ...pickFit(DEFAULT_MORU), ...PRESET_MORU[id] };
}

/** 保存先：顔の選び方（全体）と、体型ごとの揺れ幅・角度（体型 ID → 値。初期値のままの体型は持たない） */
const STORAGE_KEY = 'moru';
const FIT_KEY = 'moruFit';
/** 前の版の保存先（揺れ幅だけを体型ごとに保存していた） */
const LEGACY_WAG_KEY = 'moruWag';

/** 顔ごとの表情（目・眉・口は差し替え、涙などは足りないときだけ足す）・汗の場所・ときどき言うこと */
const MOODS: Record<Mood, { face: Partial<PartSelection>; atLeast: Partial<PartSelection>; sweat: string; say: string }> = {
  happy: {
    face: { eyes: 'smile', brows: 'neutral', mouth: 'smile' }, atLeast: { blush: 'mild' }, sweat: '',
    say: 'おちりふーりふーり♪',
  },
  desperate: {
    face: { eyes: 'tearyNarrow', brows: 'worried', mouth: 'grit' }, atLeast: { tears: 'few' },
    sweat: 'forehead,templeL,templeR,cheekL,cheekR', say: 'にげりゅよっ！',
  },
  cry: {
    face: { eyes: 'squeeze', brows: 'worried', mouth: 'wail' }, atLeast: { tears: 'lots', stream: 'few' },
    sweat: 'forehead,templeL,templeR', say: 'ゆえぇぇぇん！',
  },
};
const MOOD_LIST: Mood[] = ['happy', 'desperate', 'cry'];

/** 「もるんっ」の文字の高さ・出しておく時間（秒）と、ときどき言うことの間隔（秒） */
const BEAT_SIZE = 0.3;
const BEAT_LIFE = 0.8;
const SAY_EVERY = 4.5;

export class Moru {
  private readonly saved = loadJSON<Partial<MoruParams>>(STORAGE_KEY);
  readonly params: MoruParams = { ...DEFAULT_MORU, face: this.saved?.face ?? DEFAULT_MORU.face };
  private readonly fits: Record<string, Partial<Fit>> = loadFits();
  /** ごく前の版で全体に 1 つだけ保存していた揺れ幅。体型ごとの保存がまだなければ、開いたときの体型の値として引き継ぐ */
  private legacyWag = loadJSON(FIT_KEY) || loadJSON(LEGACY_WAG_KEY) ? undefined : this.saved?.wag;
  private presetId = '';
  /** 今の顔（もるんもるんの姿勢になるたびに選ぶ）と、顔を出しているか */
  private mood: Mood = 'happy';
  private showing = false;
  private lastBeat = 0;
  private sayT = 0;
  private word: Word | null = null;

  constructor(private readonly y: Yukkuri) {
    this.applyFit();
  }

  /** 体型を切り替える：揺れ幅・角度を、その体型で保存したもの（なければ初期値）にする */
  usePreset(id: string): void {
    this.presetId = id;
    Object.assign(this.params, fitDefaults(id), this.fits[id]);
    this.params.wag = Math.min(this.params.wag, MORU_WAG_MAX); // 上限を下げる前に保存した値
    if (this.legacyWag !== undefined) {
      this.params.wag = this.legacyWag;
      this.legacyWag = undefined;
      this.setFit();
      this.save(); // 全体の保存から揺れ幅を外す
    }
    this.applyFit();
  }

  /** 揺れ幅・角度を体の動きに渡し、今の体型のものとして保存する（調整パネルで変えたとき） */
  setFit(): void {
    this.applyFit();
    if (!this.presetId) return;
    this.storeFit(this.presetId);
    saveJSON(FIT_KEY, this.fits);
  }

  /** 今の体型の揺れ幅・角度を初期値（その体型の初期値）に戻す */
  resetFit(): void {
    Object.assign(this.params, fitDefaults(this.presetId));
    this.setFit();
  }

  /** 今の揺れ幅・角度を、別の体型（ユーザー設定など）にも写す */
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

  private applyFit(): void {
    this.y.locomotion.moruWag = this.params.wag;
    this.y.locomotion.moruLift = this.params.lift;
  }

  /** その場で振っている（ボタンで始めた）か */
  get active(): boolean {
    return this.y.locomotion.moru;
  }

  /** 顔の選び方を保存する（全体で 1 つ） */
  save(): void {
    saveJSON(STORAGE_KEY, { face: this.params.face });
  }

  /** その場で振り始める。食べている・うんうん・体操・吐いている最中なら何もしない。寝転がっていれば起き上がってから */
  start(): boolean {
    const y = this.y;
    if (this.busy()) return false;
    y.locomotion.moru = true;
    if (y.locomotion.isLying) y.getUp();
    return true;
  }

  /** 振るのをやめる（立ち姿に戻る） */
  stop(): void {
    this.y.locomotion.moru = false;
  }

  /** 振っていればやめ、振っていなければ始める */
  toggle(): void {
    if (this.active) this.stop();
    else this.start();
  }

  /** 固定時間刻みで呼ぶ */
  update(dt: number): void {
    const y = this.y;
    const loco = y.locomotion;
    // ほかの動きが始まったらやめる（体操・うんうんの身ぶり、吐くときの身ぶりを優先する）
    if (loco.moru && this.busy()) this.stop();
    if (!loco.inMoruPose) {
      if (this.showing) {
        this.showing = false;
        if (!this.busy()) y.face.override = null;
      }
      return;
    }
    if (!this.showing) {
      // 姿勢に入った：顔を決める（ランダムならここで選ぶ）
      this.showing = true;
      const f = this.params.face;
      this.mood = f === 'random' ? MOOD_LIST[Math.floor(Math.random() * MOOD_LIST.length)] : f;
      this.lastBeat = loco.wagBeats;
      this.sayT = SAY_EVERY * 0.5;
    }
    // つつかれた顔などが終わったら、こちらの顔に戻す
    if (y.face.override === null) this.applyFace();
    // 振り切るたびに、振った側に「もるんっ」
    if (loco.wagBeats !== this.lastBeat) {
      this.lastBeat = loco.wagBeats;
      this.beat(loco.wagSide);
    }
    this.sayT -= dt;
    if (this.sayT <= 0) {
      this.sayT = SAY_EVERY;
      this.chatter();
    }
  }

  /** 顔の選び方を変えたとき：今振っていれば、すぐその顔にする */
  refreshFace(): void {
    if (!this.showing) return;
    const f = this.params.face;
    this.mood = f === 'random' ? MOOD_LIST[Math.floor(Math.random() * MOOD_LIST.length)] : f;
    this.applyFace();
  }

  private applyFace(): void {
    const y = this.y;
    const m = MOODS[this.mood];
    showFace(y, m.face, m.atLeast);
    if (m.sweat && y.face.override) y.face.override.sweat = m.sweat;
  }

  /** 振り切った：お尻の振った側の上に「もるんっ」 */
  private beat(side: number): void {
    const y = this.y;
    const R = y.shape.radius;
    const facing = bodyFacing(y);
    const sideDir = new THREE.Vector3(-facing.z, 0, facing.x);
    const pos = new THREE.Vector3(y.center.x, y.center.y + R * 0.9, y.center.z)
      .addScaledVector(facing, -R * 0.6).addScaledVector(sideDir, -side * R * 0.9);
    y.texts.say(side > 0 ? 'もるんっ' : 'もるん', pos, R * BEAT_SIZE, BEAT_LIFE,
      new THREE.Vector3(0, R * 0.3, 0).addScaledVector(sideDir, -side * R * 0.25));
  }

  /** ときどき言うこと（顔の前の高い所。お尻の「もるんっ」と重ならないように） */
  private chatter(): void {
    const y = this.y;
    const R = y.shape.radius;
    const facing = bodyFacing(y);
    const pos = new THREE.Vector3(y.center.x, y.center.y + R * 1.6, y.center.z).addScaledVector(facing, R * 0.9);
    if (this.word) y.texts.fade(this.word);
    this.word = y.texts.say(MOODS[this.mood].say, pos, R * 0.24, 2.2, new THREE.Vector3(0, R * 0.12, 0));
  }

  /** 食べている・うんうん・体操・吐いている最中か */
  private busy(): boolean {
    const y = this.y;
    return y.feeding.active || y.dropping.active || y.exercise.active || y.vomit.active;
  }
}

function pickFit(p: MoruParams): Fit {
  return { wag: p.wag, lift: p.lift };
}

/** 体型ごとの揺れ幅・角度を読む。前の版（揺れ幅だけ。体型 ID → 数）の保存があれば引き継ぐ */
function loadFits(): Record<string, Partial<Fit>> {
  const fits = loadJSON<Record<string, Partial<Fit>>>(FIT_KEY);
  if (fits) return { ...fits };
  const wags = loadJSON<Record<string, number>>(LEGACY_WAG_KEY);
  if (!wags) return {};
  const out: Record<string, Partial<Fit>> = {};
  for (const [id, wag] of Object.entries(wags)) out[id] = { wag };
  saveJSON(FIT_KEY, out);
  remove(LEGACY_WAG_KEY);
  return out;
}
