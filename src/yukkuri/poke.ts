import * as THREE from 'three';
import { SWEAT_SPOTS, selectedIds, type PartSelection } from '../face/parts';
import { bodyFacing, showFace, type Word } from './fx';
import type { Yukkuri } from './Yukkuri';

/**
 * つつかれたときの反応：
 *   ・体：つついた所を短い間押し続けてへこませ、離すと弾んで戻る。体全体も押された向きへ少し揺れる
 *     （一瞬だけ速さを足すと、形に戻る力ですぐ打ち消されて、へこみがほとんど見えない）
 *   ・顔：驚いた顔と文字をしばらく出す。続けてつつかれるほど（連打）、泣き顔 → 泣き目で食いしばり → 叫びと変わり、
 *     汗・涙が増える。食べている・うんうん・体操の最中は、その動きの顔を優先して体の動きだけにする
 */

/** 押し続ける時間（秒）と、強さ 1 あたり・1 秒あたりに足す速さ（m/s）、押す範囲（胴の半径に対する比） */
const PUSH_TIME = 0.15;
const PUSH_GAIN = 60;
const PUSH_RADIUS = 1.0;
/** 体全体を押された向きへ揺らす速さ（強さ 1 あたり、m/s。水平の向きだけ） */
const SHOVE = 0.06;
/** 連打の数え方：つつくたびに 1 足し、1 秒あたりこれだけ減らす（間を空けると落ち着いていく） */
const HIT_DECAY = 0.7;

/** 連打の段階ごとの反応（hits がこの値以上で、この段階） */
interface Level {
  hits: number;
  face: Partial<PartSelection>;
  /** 選んでいるものがこれより少ないときだけ足す（涙など） */
  atLeast: Partial<PartSelection>;
  /** 汗を出す場所（選んでいる場所に足す） */
  sweat: string[];
  text: string;
  /** 顔を出しておく時間（秒） */
  time: number;
}

const LEVELS: Level[] = [
  {
    hits: 0, face: { eyes: 'squeeze', brows: 'worried', mouth: 'openSmall' }, atLeast: {}, sweat: [],
    text: 'ゆっ！？', time: 1.1,
  },
  {
    hits: 1.6, face: { eyes: 'tearyNarrow', brows: 'worried', mouth: 'sob' }, atLeast: { tears: 'few' },
    sweat: ['forehead', 'templeL', 'templeR'], text: 'ゆっ…！', time: 1.6,
  },
  {
    hits: 3.4, face: { eyes: 'cry', brows: 'worried', mouth: 'grit' }, atLeast: { tears: 'more', stream: 'few' },
    sweat: ['forehead', 'templeL', 'templeR', 'cheekL', 'cheekR'], text: 'ゆぐっ…！', time: 2.2,
  },
  {
    hits: 5.2, face: { eyes: 'cry', brows: 'worried', mouth: 'wail' }, atLeast: { tears: 'lots', stream: 'lots' },
    sweat: ['forehead', 'templeL', 'templeR', 'cheekL', 'cheekR', 'mouthL', 'mouthR'], text: 'やべでぇぇ！', time: 3.0,
  },
];

export class Poke {
  private pushLeft = 0;
  private readonly point = new THREE.Vector3();
  private readonly velocity = new THREE.Vector3();
  /** 顔を出している残り時間（0 なら出していない） */
  private faceLeft = 0;
  /** 連打の数（つつくたびに 1 足し、時間とともに減る） */
  private hits = 0;
  /** 文字を出す向き（見る人から見て左右交互。重ならないように） */
  private side = 1;
  /** 前に出した文字（続けてつつかれたら、新しい文字と重ならないよう早めに消す） */
  private word: Word | null = null;

  constructor(private readonly y: Yukkuri) {}

  /** 点 point（ワールド）を向き dir に強さ strength（m/s）でつつく */
  start(point: THREE.Vector3, dir: THREE.Vector3, strength: number): void {
    const y = this.y;
    this.point.copy(point);
    this.velocity.copy(dir).normalize().multiplyScalar(strength);
    this.pushLeft = PUSH_TIME;
    // 体全体も押された向きへ少し（地面へ押し込まないよう水平だけ）
    const shove = this.velocity.clone().setY(0).multiplyScalar(SHOVE);
    y.body.addVelocity(shove.x, 0, shove.z);
    this.hits += 1;
    // 顔（ほかの動きが顔を使っていなければ）
    if (this.busy()) return;
    let level = LEVELS[0];
    for (const l of LEVELS) if (this.hits >= l.hits) level = l;
    showFace(y, level.face, level.atLeast);
    if (level.sweat.length > 0 && y.face.override) {
      const on = new Set([...selectedIds(y.face.settings.parts.sweat), ...level.sweat]);
      y.face.override.sweat = SWEAT_SPOTS.filter((s) => on.has(s.id)).map((s) => s.id).join(',');
    }
    this.faceLeft = level.time;
    // 文字：頭の上の少し横（続けて出すときは左右交互にずらして、前の文字と重ならないように）
    const R = y.shape.radius;
    const facing = bodyFacing(y);
    const sideDir = new THREE.Vector3(-facing.z, 0, facing.x);
    this.side = -this.side;
    const pos = new THREE.Vector3(y.center.x, y.center.y + y.height * 0.5 + R * 0.15, y.center.z)
      .addScaledVector(facing, R * 0.6).addScaledVector(sideDir, this.side * R * 0.5);
    if (this.word) y.texts.fade(this.word);
    this.word = y.texts.say(level.text, pos, R * 0.3, level.time, new THREE.Vector3(0, R * 0.25, 0).addScaledVector(sideDir, this.side * R * 0.15));
  }

  /** 固定時間刻みで呼ぶ */
  update(dt: number): void {
    const y = this.y;
    this.hits = Math.max(0, this.hits - HIT_DECAY * dt);
    if (this.pushLeft > 0) {
      const k = Math.min(dt, this.pushLeft) * PUSH_GAIN;
      this.pushLeft -= dt;
      y.body.addLocalVelocity(this.point.x, this.point.y, this.point.z, y.shape.radius * PUSH_RADIUS,
        this.velocity.x * k, this.velocity.y * k, this.velocity.z * k);
    }
    if (this.faceLeft > 0) {
      this.faceLeft -= dt;
      // ほかの動きが始まって顔を使い出したら、そちらに任せる
      if (this.busy()) this.faceLeft = 0;
      else if (this.faceLeft <= 0) y.face.override = null;
    }
  }

  /** 食べている・うんうん・体操・吐いている最中か（その動きの顔を優先する） */
  private busy(): boolean {
    const y = this.y;
    return y.feeding.active || y.dropping.active || y.exercise.active || y.vomit.active;
  }
}
