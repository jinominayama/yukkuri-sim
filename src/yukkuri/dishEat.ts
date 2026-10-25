import * as THREE from 'three';
import { bodyExtent, type Word } from './fx';
import { smooth } from './braidPick';
import type { FoodKind } from './foods';
import type { Yukkuri } from './Yukkuri';

/**
 * 餌皿から直接食べる（飼育ケース）：
 *   寄る（餌皿の縁の外、皿の方を向いて立てる所へ）→ 向きを合わせる → 皿に顔を突っ込む（底は地面に付けたまま前かがみ）→
 *   いつもの食べ方（見つめる → むーしゃむーしゃ → しあわせー。Feeding に皿の餌を渡す）→ しあわせーで体を起こす
 * 1 回で 1 個（指示）。皿の中の餌（餌集めの木の実・草・虫と、おまんじゅう）のうち、寄った所から一番近いものを食べる。
 * 皿は体が乗れないので、縁から身を乗り出して顔だけ皿の上に出す
 */
type Phase = 'idle' | 'approach' | 'turn' | 'lean' | 'eat' | 'rise';

/** 立つ所：皿の当たり（半径 × 0.92）の外に、体の底の広がり（体の広がりに対する比）＋この隙間（m） */
const BOTTOM_SPREAD = 0.8;
const STAND_GAP = 0.03;
/**
 * 寄る：この距離（胴の半径に対する比）まで来たら着いたことにする。あきらめるまでの時間（秒。道のり 1 m ごとに足す。
 * なすび型は 1 回の跳ねで 10 cm ほどしか進まず、1 m に 7 秒ほどかかる）
 */
const ARRIVE = 0.6;
const GIVE_UP = 12;
const GIVE_UP_PER_M = 9;
/** 向きを合わせる許し（rad）と最長時間（秒） */
const TURN_OK = 0.12;
const TURN_MAX = 2.5;
/**
 * 前かがみ：上部を前へずらす量（Locomotion.gesture の bend）・前へ傾ける角度（rad）・縦に縮める割合と、かがむ・起きる時間（秒）。
 * 顔を皿の上へ出して下げる（0.42 だけ前へずらしても、顔は皿の縁に届くだけだった）
 */
const BEND = 0.55;
const PITCH = 0.12;
const SQUASH = 0.94;
const LEAN_TIME = 0.6;
const RISE_TIME = 0.5;
/** 立つ向きの候補を回す刻み（rad）：皿の外側が壁ぎわ・ほかの皿なら回して探す */
const TRY_STEP = Math.PI / 6;

export class DishEat {
  private phase: Phase = 'idle';
  private t = 0;
  private giveUp = GIVE_UP;
  private readonly stand = new THREE.Vector3();
  private heading = 0;
  private food: { pos: THREE.Vector3; kind: FoodKind; eaten: () => void; gone: () => boolean } | null = null;
  private readonly pose = new THREE.Quaternion();
  private readonly euler = new THREE.Euler(0, 0, 0, 'YXZ');
  private word: Word | null = null;

  constructor(private readonly y: Yukkuri) {}

  /** 皿へ向かっている途中から、食べて体を起こすまで */
  get active(): boolean {
    return this.phase !== 'idle';
  }

  /** 今始められないわけ（始められるなら null）：餌皿がない・皿に餌がない */
  reason(): string | null {
    const y = this.y;
    if (!y.stage?.foodDish) return y.line('dishNone');
    if (!y.forage.dishItem(y.center)) return y.line('dishEmpty');
    return null;
  }

  /** 餌皿から 1 個食べに行く。始められないとき（皿がない・餌がない・ほかの動きの途中）は、わけを言って false */
  start(): boolean {
    const y = this.y;
    if (this.active || y.feeding.active || y.rest.fainting || y.death.active || y.otabe.active) return false;
    const why = this.reason();
    if (why) {
      this.say(why);
      return false;
    }
    const dish = y.stage!.foodDish!;
    y.rest.wake(true);
    if (y.locomotion.isLying) y.getUp();
    // 立つ所：皿の中心から、今いる側へ（壁ぎわ・ほかの皿にかかるなら向きを回して探す）
    const R = y.shape.radius;
    const away = Math.atan2(y.center.x - dish.x, y.center.z - dish.z);
    const out = new THREE.Vector3();
    const stage = y.stage!;
    for (const k of [0, 1, -1, 2, -2, 3, -3, 4, -4, 5, -5, 6]) {
      const a = away + k * TRY_STEP;
      out.set(Math.sin(a), 0, Math.cos(a));
      const dist = dish.r * 0.92 + bodyExtent(y, out) * BOTTOM_SPREAD + STAND_GAP;
      this.stand.set(dish.x, 0, dish.z).addScaledVector(out, dist);
      const free = stage.props.every((q) => Math.hypot(q.x - dish.x, q.z - dish.z) < 1e-6
        || Math.hypot(this.stand.x - q.x, this.stand.z - q.z) > q.r + R * 0.8);
      if (stage.inside(this.stand.x, this.stand.z, y.stageMargin) && free) break;
    }
    // 皿の方を向く
    this.heading = Math.atan2(dish.x - this.stand.x, dish.z - this.stand.z);
    this.food = null;
    this.go('approach');
    if (Math.hypot(this.stand.x - y.center.x, this.stand.z - y.center.z) < R * ARRIVE) {
      y.locomotion.stop();
      y.locomotion.hold();
      this.go('turn');
    } else {
      y.locomotion.moveTo(this.stand.x, this.stand.z);
      this.stand.copy(y.locomotion.target);
    }
    this.giveUp = GIVE_UP + GIVE_UP_PER_M * Math.hypot(this.stand.x - y.center.x, this.stand.z - y.center.z);
    return true;
  }

  /** やめる（体を起こし、食べる途中ならやめる） */
  cancel(): void {
    if (!this.active) return;
    if (this.phase === 'eat') this.y.feeding.cancel();
    this.end();
  }

  /** 固定時間刻みで呼ぶ */
  update(dt: number): void {
    if (this.phase === 'idle') return;
    const y = this.y;
    const loco = y.locomotion;
    const R = y.shape.radius;
    this.t += dt;
    if (y.rest.fainting || (loco.isLying && this.phase !== 'approach')) {
      this.cancel();
      return;
    }
    switch (this.phase) {
      case 'approach': {
        // ほかの行き先を指示された・あきらめた
        if ((loco.hasTarget && loco.target.distanceTo(this.stand) > 1e-3) || this.t > this.giveUp) {
          this.end();
          break;
        }
        // そばまで来たら着いたことにする（ぴったりを狙うと、その周りを回り続けることがある）
        if (loco.hasTarget && Math.hypot(this.stand.x - y.center.x, this.stand.z - y.center.z) < R * ARRIVE) loco.stop();
        if (!loco.hasTarget && loco.idle && !loco.tilted) {
          loco.hold();
          this.go('turn');
        }
        break;
      }
      case 'turn': {
        this.setPose(0);
        const err = Math.abs(Math.atan2(Math.sin(this.heading - y.body.yaw), Math.cos(this.heading - y.body.yaw)));
        if ((err < TURN_OK && this.t > 0.3) || this.t > TURN_MAX) {
          // 食べる餌：顔の前（皿の中で一番近いもの）。寄っている間に拾われて、もうなければやめる
          const f = y.forage.dishItem(y.center);
          if (!f) {
            this.say(y.line('dishEmpty'));
            this.end();
            break;
          }
          this.food = f;
          y.lookAt(f.pos);
          this.go('lean');
        }
        break;
      }
      case 'lean': {
        this.setPose(smooth(this.t / LEAN_TIME));
        if (this.food!.gone()) {
          this.go('rise');
          break;
        }
        if (this.t >= LEAN_TIME) {
          const food = this.food!;
          // いつもの食べ方で食べる（食べ物は置かず、皿の餌を食べる。むーしゃむーしゃが終わったら皿から消す）
          if (!y.feeding.start(food.kind, { eaten: () => food.eaten() })) {
            this.go('rise');
            break;
          }
          this.go('eat');
        }
        break;
      }
      case 'eat': {
        this.setPose(1);
        if (this.food && !this.food.gone()) y.lookAt(this.food.pos);
        // しあわせーになったら（食べ終えたら）体を起こす。食べている途中で餌を拾われたら、やめて起きる
        if (!y.feeding.chewing) {
          y.lookAt(null);
          this.go('rise');
        } else if (this.food!.gone()) {
          y.feeding.cancel();
          this.go('rise');
        }
        break;
      }
      case 'rise': {
        this.setPose(1 - smooth(this.t / RISE_TIME));
        if (this.t >= RISE_TIME) this.end();
        break;
      }
    }
  }

  /** 身ぶり：皿の方を向き、k の割合だけ前かがみ（底は地面に留める） */
  private setPose(k: number): void {
    this.euler.set(PITCH * k, this.heading, 0);
    this.pose.setFromEuler(this.euler);
    this.y.locomotion.gesture = { orientation: this.pose, squash: 1 - (1 - SQUASH) * k, bend: BEND * k, pin: k > 0 };
  }

  private end(): void {
    const y = this.y;
    if (y.locomotion.gesture?.orientation === this.pose) y.locomotion.gesture = null;
    y.lookAt(null);
    // 食べている途中なら Feeding が移動の保留を解く（しあわせーの後）。それ以外はここで解く
    if (!y.feeding.active) y.locomotion.release();
    this.food = null;
    this.phase = 'idle';
  }

  private go(phase: Phase): void {
    this.phase = phase;
    this.t = 0;
  }

  private say(text: string): void {
    const y = this.y;
    const R = y.shape.radius;
    const pos = new THREE.Vector3(y.center.x, y.center.y + y.height * 0.5 + R * 0.45, y.center.z);
    if (this.word) y.texts.fade(this.word);
    this.word = y.texts.say(text, pos, R * 0.2, 1.8, new THREE.Vector3(0, R * 0.15, 0));
  }
}
