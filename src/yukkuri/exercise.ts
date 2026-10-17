import * as THREE from 'three';
import type { PartSelection } from '../face/parts';
import { bodyFacing, faceFrame, showFace } from './fx';
import type { Yukkuri } from './Yukkuri';

/**
 * うんうんたいそう：歌に合わせて体を動かし、最後にうんうんを出す。
 *   1. みぎにひだりに ゆ～らゆ～ら … 体を左右に傾けて揺らす
 *   2. おてんとさままで の～びの～び … 上へ伸びる（2 回）
 *   3. ぽんぽんぽかぽか ゆわわ～い … 少し後ろへ反って、左右にひねる
 *   4. うんうんさんも おでかけするよっ … 「でりゅっ！」でうんうん（Dropping）を出す。出し方は始めるときにどちらかを選ぶ。
 *      どちらもその姿勢のまま出し、出し終わったら（すっきりーの前に）起き上がる：
 *        ・仰向け：後ろへ反ってお尻を見せ、体の前の下から前へ出す
 *        ・腹ばい：前へ大きく倒れてお尻を突き上げ、いつもの背中側から出す
 * 体は Locomotion.gesture で動かす（立って止まっている間だけ効く）。寝転がっていれば起き上がってから始める
 */

/** pose：4. の姿勢のまま、うんうんを出し終わるのを待つ（体操としては終わっている） */
type Phase = 'none' | 'wait' | 'sway' | 'stretch' | 'twist' | 'lean' | 'pose';

/** 各段の長さ（秒） */
const SWAY_TIME = 4.4;
const STRETCH_TIME = 4.4;
const TWIST_TIME = 4.4;
const LEAN_TIME = 2.6;
/** 起き上がる・止まるのを待つ上限（秒） */
const WAIT_MAX = 12;

/** 1. 左右に傾ける角度（rad）と、1 往復の時間（秒） */
const SWAY_ANGLE = 0.32;
const SWAY_PERIOD = 2.2;
/** 2. 伸びる量（縦の倍率）と、1 回の伸びの時間（秒。伸びて戻るまで） */
const STRETCH_SQUASH = 1.22;
const STRETCH_PERIOD = 2.2;
/** 3. 後ろへ反る角度・左右にひねる角度（rad）と、1 往復の時間（秒） */
const TWIST_BACK = 0.22;
const TWIST_ANGLE = 0.7;
const TWIST_PERIOD = 2.2;
/** 4. 後ろへ傾く角度（rad） */
const LEAN_BACK = 0.55;
/** 4. 腹ばいでお尻を突き上げるときに前へ倒れる角度（rad）と、倒れきるまでの時間（秒） */
const PRONE_TILT = 1.15;
const PRONE_TIME = 1.2;
/**
 * 4. 前後に長い体型（いもむし型など）の腹ばい：体ごと大きく傾けると長い体が棒のように斜めに立って不自然なので、
 * 傾きは小さめにして、背骨を縦に曲げて後ろを持ち上げる（頭は地面に付けたまま、胴を丸めてお尻を突き上げる）
 */
const PRONE_TILT_LONG = 0.55;
const PRONE_ARCH_LONG = 1.5;
/**
 * 4. 前後に長い体型の後ろへの反り：体ごと傾けても長い体はほとんど傾かない（指令 31° に対して 14°）ので、
 * 背骨を縦に逆向きに曲げて頭の側を起こし、お尻の側を地面に付けたまま反り返る（顔が上を向く）
 */
const LEAN_BACK_LONG = 0.55;
const LEAN_ARCH_LONG = -1.5;
/** 4. の出し方を腹ばい・お尻突き上げにする割合 */
const PRONE_CHANCE = 0.5;

/** 段ごとの顔（目・眉・口の上書き）と、足りないときだけ足すもの */
const FACE_SWAY: Partial<PartSelection> = { eyes: 'smile', brows: 'neutral', mouth: 'smile' };
const FACE_STRETCH: Partial<PartSelection> = { eyes: 'squeeze', brows: 'neutral', mouth: 'smile' };
const FACE_TWIST: Partial<PartSelection> = { eyes: 'smile', brows: 'neutral', mouth: 'smile' };
const FACE_LEAN: Partial<PartSelection> = { eyes: 'smile', brows: 'neutral', mouth: 'smile' };
const AT_LEAST: Partial<PartSelection> = { blush: 'mild' };

/** 歌詞（段ごと） */
const LYRICS: Record<Exclude<Phase, 'none' | 'wait' | 'pose'>, string> = {
  sway: '♪みぎにひだりに ゆ～らゆ～ら',
  stretch: '♪おてんとさままで の～びの～び',
  twist: '♪ぽんぽんぽかぽか ゆわわ～い',
  lean: '♪うんうんさんも おでかけするよっ',
};

/** 0〜1 をなめらかに */
function smooth(t: number): number {
  t = THREE.MathUtils.clamp(t, 0, 1);
  return t * t * (3 - 2 * t);
}

export class Exercise {
  private phase: Phase = 'none';
  private t = 0;
  /** 始めたときの体の向き（Y 軸まわり）。体操の間はこの向きを基準にする */
  private yaw = 0;
  private readonly orientation = new THREE.Quaternion();
  private readonly euler = new THREE.Euler(0, 0, 0, 'YXZ');
  /** この段で、掛け声を何回出したか */
  private calls = 0;
  /** 4. を腹ばい・お尻突き上げで出すか（始めるときに決める） */
  private prone = false;

  constructor(private readonly y: Yukkuri) {}

  /** 体操をしている最中か（うんうんを出し始めるまで。腹ばいの姿勢を保っている間は含まない） */
  get active(): boolean {
    return this.phase !== 'none' && this.phase !== 'pose';
  }

  /**
   * 始める。食べている・出している・体操している最中なら何もしない。
   * prone：4. を腹ばい・お尻突き上げで出すか（省くと PRONE_CHANCE の割合でランダム）
   */
  start(prone?: boolean): boolean {
    const y = this.y;
    if (this.active || y.feeding.active || y.dropping.active) return false;
    const loco = y.locomotion;
    loco.hold();
    this.phase = 'wait';
    this.t = 0;
    this.prone = prone ?? Math.random() < PRONE_CHANCE;
    if (loco.isLying) y.getUp();
    return true;
  }

  /** 途中でやめる（いつもの立ち姿と顔に戻る） */
  cancel(): void {
    if (this.phase === 'pose') {
      // 4. の姿勢を保っているだけ（移動の保留はうんうんが持っている）
      this.finish();
      return;
    }
    if (!this.active) return;
    this.finish();
    this.y.locomotion.release();
  }

  /** 固定時間刻みで呼ぶ */
  update(dt: number): void {
    if (this.phase === 'none') return;
    const y = this.y;
    const loco = y.locomotion;
    this.t += dt;
    if (this.phase === 'wait') {
      if (loco.idle) this.next('sway');
      else if (this.t > WAIT_MAX) this.cancel();
      return;
    }
    if (this.phase === 'pose') {
      // 4. の姿勢のまま、出し終わる（すっきりー）か立ち姿でなくなるまで待つ
      if (!y.dropping.pushing || !loco.idle) this.finish();
      return;
    }
    // 立ち姿でなくなったら（落とされた・転んだなど）やめる
    if (!loco.idle) {
      this.cancel();
      return;
    }
    let pitch = 0, roll = 0, twist = 0, squash = 1, arch = 0;
    const t = this.t;
    switch (this.phase) {
      case 'sway': {
        // 左右に傾ける（出だしと終わりはなめらかに）
        const env = smooth(t / 0.5) * smooth((SWAY_TIME - t) / 0.5);
        roll = SWAY_ANGLE * env * Math.sin((2 * Math.PI * t) / SWAY_PERIOD);
        this.callEvery(SWAY_PERIOD / 2, SWAY_PERIOD / 4, 'ゆっ♪');
        if (t > SWAY_TIME) this.next('stretch');
        break;
      }
      case 'stretch': {
        // 上へ伸びて戻るのを 2 回（伸びている間は少しためる）
        const k = (t % STRETCH_PERIOD) / STRETCH_PERIOD;
        squash = 1 + (STRETCH_SQUASH - 1) * Math.sin(Math.PI * Math.min(1, k * 1.25)) ** 2;
        this.callEvery(STRETCH_PERIOD, STRETCH_PERIOD * 0.4, 'ゆっ！');
        if (t > STRETCH_TIME) this.next('twist');
        break;
      }
      case 'twist': {
        // 少し後ろへ反って、左右にひねる
        const env = smooth(t / 0.5) * smooth((TWIST_TIME - t) / 0.5);
        pitch = -TWIST_BACK * env;
        twist = TWIST_ANGLE * env * Math.sin((2 * Math.PI * t) / TWIST_PERIOD);
        if (this.calls === 0 && t > TWIST_TIME * 0.55) {
          this.calls++;
          this.shout('ゆわわ～い！', true);
        }
        if (t > TWIST_TIME) this.next('lean');
        break;
      }
      case 'lean': {
        // 後ろへ傾いてお尻を見せる。または前へ大きく倒れて腹ばいになり、お尻を突き上げる
        if (this.prone) {
          const k = smooth(t / PRONE_TIME);
          if (loco.isLongBody()) {
            pitch = PRONE_TILT_LONG * k;
            arch = PRONE_ARCH_LONG * k;
          } else {
            pitch = PRONE_TILT * k;
          }
        } else {
          const k = smooth(t / 0.8);
          if (loco.isLongBody()) {
            pitch = -LEAN_BACK_LONG * k;
            arch = LEAN_ARCH_LONG * k;
          } else {
            pitch = -LEAN_BACK * k;
          }
        }
        if (this.calls === 0 && t > 0.9) {
          this.calls++;
          this.shout('でりゅっ！', true);
        }
        if (t > LEAN_TIME) {
          // 姿勢を保ったまま出し、出し終わったら（すっきりーの前に）起き上がる（移動の保留はそのまま Dropping が持つ）。
          // 仰向け（後ろへ反った）なら体の前から前へ出す
          this.phase = 'pose';
          this.y.face.override = null;
          if (!y.dropping.start({ front: !this.prone })) {
            this.finish();
            loco.release();
          }
          return;
        }
        break;
      }
    }
    this.euler.set(pitch, this.yaw + twist, roll);
    this.orientation.setFromEuler(this.euler);
    loco.gesture = { orientation: this.orientation, squash, arch };
  }

  /** 次の段へ：顔を変え、歌詞を出す */
  private next(phase: Exclude<Phase, 'none' | 'wait' | 'pose'>): void {
    const y = this.y;
    if (this.phase === 'wait') this.yaw = y.body.yaw;
    this.phase = phase;
    this.t = 0;
    this.calls = 0;
    const face = { sway: FACE_SWAY, stretch: FACE_STRETCH, twist: FACE_TWIST, lean: FACE_LEAN }[phase];
    showFace(y, face, AT_LEAST);
    this.lyric(LYRICS[phase], { sway: SWAY_TIME, stretch: STRETCH_TIME, twist: TWIST_TIME, lean: LEAN_TIME }[phase]);
  }

  /** 段の始め offset 秒から every 秒ごとに、顔の左右に交互に掛け声を出す */
  private callEvery(every: number, offset: number, text: string): void {
    const due = Math.floor((this.t - offset) / every) + 1;
    if (this.t >= offset && due > this.calls) {
      this.calls = due;
      this.shout(text, false, due % 2 === 0 ? 1 : -1);
    }
  }

  /** 掛け声：big なら頭の上に大きく、そうでなければ顔の横（side：見る人から見て左 -1・右 1） */
  private shout(text: string, big: boolean, side = 0): void {
    const y = this.y;
    const R = y.shape.radius;
    const { pos: mouth } = faceFrame(y, 0, -0.06);
    // 前の向きは体の向きから（4. で大きく傾けていると顔は真下・真上を向き、顔からは前後が決まらない）
    const facing = bodyFacing(y);
    const sideDir = new THREE.Vector3(-facing.z, 0, facing.x);
    const pos = new THREE.Vector3();
    if (big) {
      pos.set(y.center.x, y.center.y + y.height * 0.5 + R * 0.1, y.center.z).addScaledVector(facing, R * 0.7);
    } else {
      pos.copy(mouth).addScaledVector(sideDir, side * R * 1.15).addScaledVector(facing, R * 0.2);
      pos.y += R * 0.2;
    }
    const life = big ? 1.8 : 1.0;
    y.texts.say(text, pos, R * (big ? 0.36 : 0.26), life, new THREE.Vector3(0, R * 0.3, 0).addScaledVector(sideDir, side * R * 0.15));
  }

  /** 歌詞：頭の上の少し後ろに、その段の間出しておく */
  private lyric(text: string, life: number): void {
    const y = this.y;
    const R = y.shape.radius;
    const facing = bodyFacing(y);
    // 段の始めの頭の高さから測るので、反り返って頭が高くなっても頭の上の掛け声と重ならない高さにする
    const pos = new THREE.Vector3(y.center.x, y.center.y + y.height * 0.5 + R * 1.15, y.center.z).addScaledVector(facing, R * 0.2);
    y.texts.say(text, pos, R * 0.22, life, new THREE.Vector3(0, R * 0.02, 0));
  }

  /** 体操を終える（いつもの立ち姿と顔に戻す。移動の保留は呼び出し側で） */
  private finish(): void {
    this.phase = 'none';
    this.y.locomotion.gesture = null;
    this.y.face.override = null;
  }
}
