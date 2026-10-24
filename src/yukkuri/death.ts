import * as THREE from 'three';
import type { PartSelection } from '../face/parts';
import { showFace, type Word } from './fx';
import { smooth } from './braidPick';
import type { Yukkuri } from './Yukkuri';

/**
 * 死ぬ（「もっとゆっくりしたかったよ…」の後）：小刻みに震えながら体が柔らかくなっていき、震えが弱まるにつれて体の色が黒ずむ。
 * 「ゆ゛っ…」と言う間隔が延び、声も小さくなって、DURATION 秒で止まる。顔は涙目、止まったら脱力した半目の白目と半開きの口。
 * 止まった後は戻さない（元に戻すのはページの読み直し）：呼吸・まばたき・移動・ほかの動き・つついたときの顔や声も止まり、
 * 体がへこむ・押される・倒れるなど物の反応だけが残る（Yukkuri.step が death.active の間は、ほかの動きを動かさない）
 */
const DURATION = 20;
/** 震え（Yukkuri.tremble。胴の半径に対する比）の一番強い所と、強まるまでの時間（秒）。進み TREMBLE_END で 0 になる */
const TREMBLE = 0.0175;
const TREMBLE_RISE = 0.6;
const TREMBLE_END = 0.92;
/** 柔らかさ：形に戻る強さの倍率と、皮のゆるさの倍率（止まったとき）。頭の形を保つ割合 */
const SOFT_END = 0.05;
const SKIN_END = 25;
const HEAD_KEEP = 0.5;
/** 黒ずみ：止まったときの色へ寄せる割合と、寄せる色 */
const DARKEN = 0.43;
const DARK = new THREE.Color('#1c1612');
/** 「ゆ゛っ…」：最初の間・間の始めと終わり（秒）・文字の大きさの始めと終わり（胴の半径に対する比）。進み GASP_END より後は言わない */
const GASP_FIRST = 1.6;
const GASP_GAP = [1.4, 4.2];
const GASP_SIZE = [0.2, 0.1];
const GASP_END = 0.82;

const FACE_DYING: Partial<PartSelection> = { eyes: 'cry', brows: 'worried', mouth: 'sobWeak', tears: 'more', stream: 'few', pale: 'some' };
const FACE_DEAD: Partial<PartSelection> = { eyes: 'limp', brows: 'none', mouth: 'slack', tears: 'few', stream: 'none', pale: 'some', sweat: '', strain: 'none' };

export class Death {
  private t = -1;
  private gaspIn = 0;
  private word: Word | null = null;
  /** 始めたときの体の色（黒ずみの元） */
  private readonly from = { lit: new THREE.Color(), shade: new THREE.Color(), deep: new THREE.Color() };

  constructor(private readonly y: Yukkuri) {}

  /** 死んでいく途中か、死んでいるか */
  get active(): boolean {
    return this.t >= 0;
  }

  /** 止まった（死んだ）か */
  get dead(): boolean {
    return this.t >= DURATION;
  }

  /** 死に始める（もう始まっていれば何もしない） */
  start(): boolean {
    const y = this.y;
    if (this.active) return false;
    // ほかの動きはやめる（止められるもの）
    y.feeding.cancel();
    y.exercise.cancel();
    y.moru.stop();
    y.puku.stop();
    y.rest.wake(true);
    y.lookAt(null);
    const loco = y.locomotion;
    loco.stop();
    loco.gesture = null;
    loco.hold();
    const u = y.bodyMaterial.uniforms;
    this.from.lit.copy(u.uLit.value as THREE.Color);
    this.from.shade.copy(u.uShade.value as THREE.Color);
    this.from.deep.copy(u.uDeep.value as THREE.Color);
    this.t = 0;
    this.gaspIn = GASP_FIRST;
    showFace(y, FACE_DYING);
    y.face.frozen = false;
    return true;
  }

  /** 固定時間刻みで呼ぶ（死んでいく途中・死んだ後） */
  update(dt: number): void {
    if (!this.active) return;
    const y = this.y;
    const was = this.dead;
    this.t = Math.min(DURATION, this.t + dt);
    const k = this.t / DURATION;
    // 動かない（地面をクリックされても行かない）
    const loco = y.locomotion;
    loco.stop();
    loco.hold();
    // 震え：はじめに強まり、だんだん弱まって止まる
    const rise = Math.min(1, this.t / TREMBLE_RISE);
    y.tremble = TREMBLE * rise * Math.pow(Math.max(0, 1 - k / TREMBLE_END), 1.4);
    // 柔らかくなる（形に戻る強さを下げ、皮をゆるめる）
    const s = smooth(Math.min(1, k * 1.25));
    y.body.softness = 1 + (SOFT_END - 1) * s;
    y.body.skinLoose = Math.exp(Math.log(SKIN_END) * s);
    y.body.headKeep = HEAD_KEEP;
    // 呼吸が弱まって止まる
    y.breathGain = Math.max(0, 1 - k * 1.2);
    // 黒ずむ（震えが弱まるにつれて）
    const d = DARKEN * smooth(Math.min(1, k * 1.1));
    const u = y.bodyMaterial.uniforms;
    (u.uLit.value as THREE.Color).copy(this.from.lit).lerp(DARK, d);
    (u.uShade.value as THREE.Color).copy(this.from.shade).lerp(DARK, d);
    (u.uDeep.value as THREE.Color).copy(this.from.deep).lerp(DARK, d);
    // 「ゆ゛っ…」：間が延び、声が小さくなる
    if (k < GASP_END) {
      this.gaspIn -= dt;
      if (this.gaspIn <= 0) {
        const g = k / GASP_END;
        this.say(y.line('dyingGasp'), GASP_SIZE[0] + (GASP_SIZE[1] - GASP_SIZE[0]) * g, 1.2 + 0.6 * g);
        this.gaspIn = GASP_GAP[0] + (GASP_GAP[1] - GASP_GAP[0]) * g;
      }
    }
    // 止まった：白目・半開きの口。まばたき・視線も止める
    if (this.dead && !was) {
      y.tremble = 0;
      showFace(y, FACE_DEAD);
      y.face.frozen = true;
    }
  }

  private say(text: string, size: number, life: number): void {
    const y = this.y;
    const R = y.shape.radius;
    const pos = new THREE.Vector3(y.center.x, y.center.y + y.height * 0.5 + R * 0.35, y.center.z);
    if (this.word) y.texts.fade(this.word);
    this.word = y.texts.say(text, pos, R * size, life, new THREE.Vector3(0, R * 0.06, 0));
  }
}
