import * as THREE from 'three';
import { bodyExtent, faceFrame, showFace, type Word } from './fx';
import { smooth } from './braidPick';
import type { LooseDirt } from './dropping';
import type { PartSelection } from '../face/parts';
import type { Yukkuri } from './Yukkuri';

/**
 * といれへ運ぶ：といれの外にあるうんうん・吐いた餡子を口でくわえて、といれへ運んで吐き出す（指示）。
 *   ボタンで、外にあるものを近い順に全部運ぶ（指示。宣言してから）。うんうんは 3 回・吐いた餡子は 2 回に分けて運ぶ（指示）。
 *   1 回分：寄る（一切れの手前、そちらを向いて）→ 向きを合わせる → 前かがみで口を地面へ（ぱくっ。元の塊からその一切れが消える）→ 起きる →
 *   といれへ寄る → 前かがみ（ぺっ。といれにその一切れの形が現れる）→ 起きる
 * 嫌そうに運ぶ（指示）：拾う・吐き出すときはぎゅっと目をつぶり、運ぶ間は涙目で口を閉じて頬をふくらませる（口「ぷくー」）。
 * 拾うたびにストレスが少したまる。運んでいる間の一切れは見せない（指示）
 */
type Phase = 'idle' | 'approach' | 'turn' | 'lean' | 'rise' | 'done';
type Goal = 'pick' | 'spit';

/**
 * 寄る：着いたことにする距離（胴の半径に対する比）・あきらめるまでの時間（秒。道のり 1 m ごとに足す）。
 * 立ち位置がこの距離（胴の半径に対する比）より近ければ歩かず、向きを合わせながら寄る（すぐそばへ跳ねると行き過ぎては戻り、
 * 周りを回り続けて時間切れになった。うんうんを出した直後など）。歩いていても、この距離に入って NEAR_AFTER 秒たったら着いたことにする
 */
const ARRIVE = 0.6;
const NEAR = 1.6;
const NEAR_AFTER = 3;
const GIVE_UP = 12;
const GIVE_UP_PER_M = 9;
/** 向きを合わせる許し（rad）と最長時間（秒）。向きを合わせる間に立ち位置へ寄る速さ（ずれの 1 秒あたりの割合） */
const TURN_OK = 0.12;
const TURN_MAX = 2.5;
const STEP_IN_RATE = 3;
/** 立つ所：口を向ける所から、体の広がり × この比だけ手前 */
const STAND_GAP = 0.8;
/** 前かがみ：前へ傾ける角度（rad）・前後に伸ばす倍率。かがむ・止まる・起きる時間（秒） */
const PITCH = 0.32;
const STRETCH = 1.12;
const LEAN_TIME = 0.5;
const HOLD_TIME = 0.35;
const RISE_TIME = 0.45;
/** 拾うたびにたまるストレス */
const STRESS_PICK = 3;
/** 終わった後の顔を出しておく時間（秒） */
const DONE_TIME = 2.2;
/** といれの中に置く所を選ぶ：縁から内側へ（m）・試す格子の数（横 × 奥行き） */
const DROP_MARGIN = 0.28;
const DROP_GRID = 4;

/**
 * 顔：拾う・吐き出すときはぎゅっと目をつぶる。
 * 運ぶ間と、吐き出して次へ向かう間は、苦痛にゆがむ顔（指示）：運ぶ間はぎゅっとつぶった目・力み眉・しわ・青ざめ・汗・涙で、
 * 口は閉じて頬をふくらませる（「ぷくー」）。吐き出した後は泣き目で歯を食いしばる。終わったらほっとした涙目
 */
const FACE_PICK: Partial<PartSelection> = { eyes: 'squeeze', brows: 'worried', mouth: 'grit' };
const FACE_CARRY: Partial<PartSelection> = { eyes: 'squeeze', brows: 'strain', mouth: 'pout', strain: 'mid', pale: 'some', sweat: 'forehead,templeL,templeR' };
const AT_LEAST_CARRY: Partial<PartSelection> = { tears: 'more', stream: 'few' };
const FACE_SPIT: Partial<PartSelection> = { eyes: 'squeeze', brows: 'strain', mouth: 'openSmall', strain: 'light', pale: 'some' };
const FACE_AFTER: Partial<PartSelection> = { eyes: 'cry', brows: 'worried', mouth: 'grit', strain: 'light', pale: 'some', sweat: 'forehead,templeL,templeR' };
const AT_LEAST_AFTER: Partial<PartSelection> = { tears: 'lots', stream: 'few' };
const FACE_DONE: Partial<PartSelection> = { eyes: 'troubled', brows: 'worried', mouth: 'smileSmall' };
const AT_LEAST_DONE: Partial<PartSelection> = { tears: 'few' };

export class Cleanup {
  private phase: Phase = 'idle';
  private t = 0;
  private goal: Goal = 'pick';
  private giveUp = GIVE_UP;
  private heading = 0;
  /** 口を向ける所（拾う一切れの真ん中・といれに置く所）と、立つ所 */
  private readonly aim = new THREE.Vector3();
  private readonly stand = new THREE.Vector3();
  /** 今運んでいる一切れ（といれに置く関数）と、今の塊 */
  private carrying: ((x: number, z: number, yaw: number) => void) | null = null;
  private dirt: LooseDirt | null = null;
  private moved = 0;
  private readonly pose = new THREE.Quaternion();
  private readonly euler = new THREE.Euler(0, 0, 0, 'YXZ');
  private face: Partial<PartSelection> | null = null;
  private word: Word | null = null;

  constructor(private readonly y: Yukkuri) {}

  /** 運んでいる途中か（最初の塊へ向かってから、全部運び終えた顔を出し終えるまで） */
  get active(): boolean {
    return this.phase !== 'idle';
  }

  /** 今始められないわけ（始められるなら null）：といれがない・といれの外に何もない */
  reason(): string | null {
    const y = this.y;
    if (!y.stage?.toilet) return y.line('cleanNoToilet');
    if (y.dropping.loose().length === 0 && y.vomit.loose().length === 0) return y.line('cleanNone');
    return null;
  }

  /** 運び始める。始められないとき（といれがない・何もない・ほかの動きの途中）は、わけを言って false */
  start(): boolean {
    const y = this.y;
    if (this.active || y.dropping.active || y.vomit.active || y.feeding.active || y.rest.fainting) return false;
    const why = this.reason();
    if (why) {
      this.say(why, 1.8);
      return false;
    }
    y.rest.wake(true);
    if (y.locomotion.isLying) y.getUp();
    this.moved = 0;
    this.carrying = null;
    this.nextPick();
    return true;
  }

  /** やめる（運んでいる一切れは、その場で口の前に吐き出す。次に「といれへ運ぶ」を押すと、それもまた運ぶ。顔・身ぶりを戻す） */
  cancel(): void {
    if (!this.active) return;
    if (this.carrying) {
      const y = this.y;
      const f = faceFrame(y, 0, -0.1);
      const p = f.pos.clone().addScaledVector(f.facing, y.shape.radius * 0.35);
      this.carrying(p.x, p.z, y.body.yaw + Math.PI / 2);
      this.carrying = null;
      this.mouthWord('ぺっ');
    }
    this.end();
  }

  /** 固定時間刻みで呼ぶ */
  update(dt: number): void {
    if (this.phase === 'idle') return;
    const y = this.y;
    const loco = y.locomotion;
    const R = y.shape.radius;
    this.t += dt;
    if (y.rest.fainting || y.vomit.active) {
      this.cancel();
      return;
    }
    switch (this.phase) {
      case 'approach': {
        if ((loco.hasTarget && loco.target.distanceTo(this.stand) > 1e-3) || this.t > this.giveUp) {
          this.cancel();
          break;
        }
        if (loco.isLying || loco.tilted) break;
        const far = Math.hypot(this.stand.x - y.center.x, this.stand.z - y.center.z);
        if (loco.hasTarget && (far < R * ARRIVE || (far < R * NEAR && this.t > NEAR_AFTER))) loco.stop();
        if (!loco.hasTarget && loco.idle) {
          loco.hold();
          this.go('turn');
        }
        break;
      }
      case 'turn': {
        this.setPose(0);
        const k = Math.min(1, STEP_IN_RATE * dt);
        y.body.translate((this.stand.x - y.center.x) * k, (this.stand.z - y.center.z) * k);
        const err = Math.abs(Math.atan2(Math.sin(this.heading - y.body.yaw), Math.cos(this.heading - y.body.yaw)));
        if ((err < TURN_OK && this.t > 0.3) || this.t > TURN_MAX) {
          if (this.goal === 'pick') this.showFace(FACE_PICK);
          y.lookAt(this.aim);
          this.go('lean');
        }
        break;
      }
      case 'lean': {
        this.setPose(smooth(this.t / LEAN_TIME));
        if (this.t >= LEAN_TIME + HOLD_TIME) {
          if (this.goal === 'pick') this.pick();
          else this.spit();
          this.go('rise');
        }
        break;
      }
      case 'rise': {
        this.setPose(1 - smooth(this.t / RISE_TIME));
        if (this.t >= RISE_TIME) {
          loco.gesture = null;
          y.lookAt(null);
          loco.release();
          if (this.goal === 'pick') this.toToilet();
          else {
            // 吐き出した後、次へ向かう間も苦痛にゆがんだ顔のまま
            this.showFace(FACE_AFTER, AT_LEAST_AFTER);
            this.nextPick();
          }
        }
        break;
      }
      case 'done':
        if (this.t >= DONE_TIME) this.end();
        break;
    }
  }

  /** 次の一切れを拾いに行く（今の塊に残りがあればそれ、なければ一番近い塊）。何もなければ終わり */
  private nextPick(): void {
    const y = this.y;
    let at = this.dirt?.next() ?? null;
    if (!at) {
      this.dirt = null;
      let best = Infinity;
      for (const d of [...y.dropping.loose(), ...y.vomit.loose()]) {
        const p = d.next();
        if (!p) continue;
        const dist = Math.hypot(p.x - y.center.x, p.z - y.center.z);
        if (dist < best) {
          best = dist;
          this.dirt = d;
          at = p;
        }
      }
    }
    if (!at) {
      this.finishAll();
      return;
    }
    this.goal = 'pick';
    this.goTo(at);
  }

  /** 口を向ける所 p へ寄る（p の手前、今いる側に立ち、p の方を向く） */
  private goTo(p: THREE.Vector3): void {
    const y = this.y;
    const R = y.shape.radius;
    this.aim.copy(p);
    const away = new THREE.Vector3(y.center.x - p.x, 0, y.center.z - p.z);
    if (away.lengthSq() < 1e-6) away.set(-Math.sin(y.body.yaw), 0, -Math.cos(y.body.yaw));
    away.normalize();
    this.stand.copy(p).addScaledVector(away, bodyExtent(y, away) * STAND_GAP);
    this.heading = Math.atan2(-away.x, -away.z);
    const loco = y.locomotion;
    if (Math.hypot(this.stand.x - y.center.x, this.stand.z - y.center.z) < R * NEAR) {
      loco.stop();
      loco.hold();
      this.go('turn');
      return;
    }
    loco.moveTo(this.stand.x, this.stand.z);
    this.stand.copy(loco.target);
    this.giveUp = GIVE_UP + GIVE_UP_PER_M * Math.hypot(this.stand.x - y.center.x, this.stand.z - y.center.z);
    this.go('approach');
  }

  /** ぱくっ：一切れを口に入れる（元の塊から消す）。嫌そうな一言、ストレスが少したまる */
  private pick(): void {
    const y = this.y;
    this.carrying = this.dirt?.take() ?? null;
    if (!this.carrying) return;
    this.mouthWord('ぱくっ');
    y.stress.add(STRESS_PICK);
    this.showFace(FACE_CARRY, AT_LEAST_CARRY);
    this.say(y.line('cleanPick'), 1.6);
  }

  /** といれへ向かう（くわえていなければ、次を拾いに） */
  private toToilet(): void {
    if (!this.carrying) {
      this.nextPick();
      return;
    }
    this.goal = 'spit';
    this.goTo(this.dropSpot());
  }

  /** ぺっ：といれに一切れを吐き出す（その形が現れる） */
  private spit(): void {
    this.showFace(FACE_SPIT);
    this.mouthWord('ぺっ');
    this.dropInToilet();
    this.moved++;
  }

  /** 持っている一切れを、口を向けた所（といれの中に選んだ所）に置く */
  private dropInToilet(): void {
    const place = this.carrying;
    this.carrying = null;
    if (place) place(this.aim.x, this.aim.z, this.heading + Math.PI / 2 + (Math.random() - 0.5) * 0.8);
  }

  /** といれの中に置く所：格子の点のうち、といれの中にすでにあるもの（うんうん・餡子）から一番離れた所 */
  private dropSpot(): THREE.Vector3 {
    const y = this.y;
    const t = y.stage!.toilet!;
    const taken: THREE.Vector3[] = [];
    const add = (x: number, z: number) => taken.push(new THREE.Vector3(x, 0, z));
    y.dropping.forEachToiletPoint(add);
    y.vomit.forEachToiletPoint(add);
    let best = new THREE.Vector3(t.x, 0, t.z), bestD = -1;
    for (let i = 0; i < DROP_GRID; i++) {
      for (let j = 0; j < DROP_GRID; j++) {
        const x = t.x - t.w / 2 + DROP_MARGIN + ((t.w - DROP_MARGIN * 2) * i) / (DROP_GRID - 1);
        const z = t.z - t.d / 2 + DROP_MARGIN + ((t.d - DROP_MARGIN * 2) * j) / (DROP_GRID - 1);
        let near = Infinity;
        for (const p of taken) near = Math.min(near, Math.hypot(p.x - x, p.z - z));
        // 近づきやすいよう、今いる所に近い点を少しだけ選びやすく
        const score = Math.min(near, 3) - 0.05 * Math.hypot(x - y.center.x, z - y.center.z);
        if (score > bestD) {
          bestD = score;
          best = new THREE.Vector3(x, 0, z);
        }
      }
    }
    return best;
  }

  /** 全部運び終えた：ほっとした涙目で一言 */
  private finishAll(): void {
    const y = this.y;
    y.locomotion.gesture = null;
    if (this.moved > 0) {
      this.showFace(FACE_DONE, AT_LEAST_DONE);
      this.say(y.line('cleanDone'), DONE_TIME);
    }
    y.locomotion.hold();
    this.go('done');
  }

  private end(): void {
    const y = this.y;
    const loco = y.locomotion;
    if (loco.gesture?.orientation === this.pose) loco.gesture = null;
    y.lookAt(null);
    if (y.outfit.hat) y.outfit.hat.holdLift = false;
    if (this.face && y.face.override === this.face) y.face.override = null;
    this.face = null;
    if (this.phase !== 'approach') loco.release();
    this.dirt = null;
    this.phase = 'idle';
  }

  /** 身ぶり：口を向ける方を向き、k の割合だけ前へ傾けて伸ばす（底は地面に留める）。かがんでいる間は帽子を下げない */
  private setPose(k: number): void {
    this.euler.set(PITCH * k, this.heading, 0);
    this.pose.setFromEuler(this.euler);
    this.y.locomotion.gesture = { orientation: this.pose, squash: 1, stretch: 1 + (STRETCH - 1) * k, pin: k > 0 };
    const hat = this.y.outfit.hat;
    if (hat) hat.holdLift = k > 0;
  }

  private showFace(f: Partial<PartSelection>, atLeast: Partial<PartSelection> = {}): void {
    showFace(this.y, f, atLeast);
    this.face = this.y.face.override;
  }

  private go(phase: Phase): void {
    this.phase = phase;
    this.t = 0;
  }

  /** 口の横に小さく「ぱくっ」「ぺっ」 */
  private mouthWord(text: string): void {
    const y = this.y;
    const R = y.shape.radius;
    const f = faceFrame(y, 0, -0.1);
    const side = new THREE.Vector3(-f.facing.z, 0, f.facing.x);
    const pos = f.pos.clone().addScaledVector(side, R * 0.9).addScaledVector(f.facing, R * 0.2);
    pos.y += R * 0.2;
    y.texts.say(text, pos, R * 0.26, 1.1, new THREE.Vector3(0, R * 0.3, 0));
  }

  private say(text: string, life: number): void {
    const y = this.y;
    const R = y.shape.radius;
    const pos = new THREE.Vector3(y.center.x, y.center.y + y.height * 0.5 + R * 0.45, y.center.z);
    if (this.word) y.texts.fade(this.word);
    this.word = y.texts.say(text, pos, R * 0.2, life, new THREE.Vector3(0, R * 0.15, 0));
  }
}
