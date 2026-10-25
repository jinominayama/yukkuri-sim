import * as THREE from 'three';
import { bodyExtent, faceFrame, showFace, type Word } from './fx';
import { smooth } from './braidPick';
import type { FoodKind } from './foods';
import type { PartSelection } from '../face/parts';
import type { BoxCollider } from '../physics/SoftBody';
import type { Yukkuri } from './Yukkuri';

/**
 * 皿から直接食べる・飲む（飼育ケース）：
 *   寄る（皿の縁の外、皿の方を向いて立てる所へ）→ 向きを合わせる → 皿に顔を突っ込む（底は地面に付けたまま前かがみ）→
 *   食べる：いつもの食べ方（見つめる → むーしゃむーしゃ → しあわせー。Feeding に皿の餌を渡す）→ しあわせーで体を起こす
 *   飲む：水面に口を付けて小さく頭を上下させ「ごーくごーく」（口が付いた所から水面に波の輪）→ しあわせー（Feeding.celebrate）で体を起こす
 * 食べるのは 1 回で 1 個（指示）。皿の中の餌（餌集めの木の実・草・虫と、おまんじゅう）のうち、寄った所から一番近いもの。
 * 水は減らない（指示。今後減らすかもしれない）。飲んでもストレスなどは変わらない（のどの渇きの仕組みがまだない）。
 * 皿は体が乗れないので、縁から身を乗り出して顔だけ皿の上に出す
 */
type Mode = 'eat' | 'drink';
type Phase = 'idle' | 'approach' | 'turn' | 'lean' | 'eat' | 'drink' | 'rise';

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
 * 前かがみ：前へ傾ける角度（rad）と、前後に伸ばす倍率（Locomotion.gesture の stretch）。底は地面に留める。
 * ゆっくりの体は下の方が一番張り出しているので、底が皿の縁で止まると顔は縁より手前に残る。体の下の方を縁に少し乗り上げさせ
 * （皿の当たりを RIM_H の高さまで下げ、立つ所を CLOSER だけ皿へ寄せる）、浅く傾けて顔を皿の上へ出す。
 * 口は飲むとき水面の上（水皿の中心から 0.48 m。水面の半径は 0.52 m）、食べるとき餌の 18 cm ほど手前まで届く。
 * これまでの形：①上部を前へずらす（bend）と頭の形がずれ、帽子が持ち上げては戻すのをくり返して揺れ、髪が突き抜けた
 * ②深く傾けて伸ばす（0.55 rad・1.4 倍）と、体の後ろが高く盛り上がり、顔の下半分が縁に押し付けられてつぶれた
 */
const PITCH = 0.3;
const STRETCH = 1.12;
/**
 * 顔を突っ込んでいる間は、突っ込み終えた所に体を留める：ずれた分を 1 秒あたりこの割合ずつ戻す。
 * 飲むときに頭を上下させるたび、体の下の方が皿の縁に当たって後ろへ押され、戻らずに積み重なっていた（扁平型で 4 口に 7 cm）
 */
const ANCHOR_RATE = 15;
/** 皿に乗り上げる：顔を突っ込む間だけ下げる皿の当たりの高さ（m）と、立つ所を皿へ寄せる距離（m） */
const RIM_H = 0.03;
const CLOSER = 0.32;
const LEAN_TIME = 0.6;
const RISE_TIME = 0.5;
/** 立つ向きの候補を回す刻み（rad）：皿の外側が壁ぎわ・ほかの皿なら回して探す */
const TRY_STEP = Math.PI / 6;
/**
 * 飲む：ひと口の長さ（秒）と回数、ひと口ごとに頭を上下させる大きさ（前かがみの割合に足す）。
 * 口の位置（顔座標。単位は頭の半径）
 */
const GULP_TIME = 0.9;
const GULPS = 4;
const BOB = 0.12;
const MOUTH_FY = -0.06;
/** 飲む顔：目を閉じ、口を開く（飲み込む）・閉じるをひと口ごとに */
const FACE_GULP_OPEN: Partial<PartSelection> = { eyes: 'closed', brows: 'neutral', mouth: 'openSmall' };
const FACE_GULP_SHUT: Partial<PartSelection> = { eyes: 'closed', brows: 'neutral', mouth: 'smirk' };
/** 波の輪：広がる時間（秒）・広がりきった半径（m）・太さの比 */
const RIPPLE_TIME = 1.1;
const RIPPLE_R = 0.26;
const RIPPLE_WIDTH = 0.12;

interface Ripple { mesh: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>; t: number }

export class DishEat {
  /** 水面の波の輪（シーンに置く） */
  readonly object = new THREE.Group();
  private phase: Phase = 'idle';
  private mode: Mode = 'eat';
  private t = 0;
  private giveUp = GIVE_UP;
  private readonly stand = new THREE.Vector3();
  private heading = 0;
  private food: { pos: THREE.Vector3; kind: FoodKind; eaten: () => void; gone: () => boolean } | null = null;
  private gulps = 0;
  /** 顔を突っ込み終えた所（体の中心。地面の上） */
  private readonly anchor = new THREE.Vector3();
  /** 下げている皿の当たりと、元の高さ */
  private rim: { collider: BoxCollider; h: number } | null = null;
  private readonly ripples: Ripple[] = [];
  private readonly rippleGeometry = new THREE.RingGeometry(1 - RIPPLE_WIDTH, 1, 40).rotateX(-Math.PI / 2);
  private readonly pose = new THREE.Quaternion();
  private readonly euler = new THREE.Euler(0, 0, 0, 'YXZ');
  private word: Word | null = null;

  constructor(private readonly y: Yukkuri) {}

  /** 皿へ向かっている途中から、食べて（飲んで）体を起こすまで */
  get active(): boolean {
    return this.phase !== 'idle';
  }

  /** 今始められないわけ（始められるなら null）：餌皿・水皿がない・餌皿に餌がない */
  reason(mode: Mode = 'eat'): string | null {
    const y = this.y;
    if (mode === 'drink') return y.stage?.waterDish ? null : y.line('waterNone');
    if (!y.stage?.foodDish) return y.line('dishNone');
    if (!y.forage.dishItem(y.center)) return y.line('dishEmpty');
    return null;
  }

  /** 餌皿から 1 個食べに行く（mode 'drink' なら水皿の水を飲みに行く）。始められないとき（皿がない・餌がない・ほかの動きの途中）は、わけを言って false */
  start(mode: Mode = 'eat'): boolean {
    const y = this.y;
    if (this.active || y.feeding.active || y.rest.fainting || y.death.active || y.otabe.active) return false;
    const why = this.reason(mode);
    if (why) {
      this.say(why);
      return false;
    }
    this.mode = mode;
    const dish = mode === 'drink' ? y.stage!.waterDish! : y.stage!.foodDish!;
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
      const dist = dish.r * 0.92 + bodyExtent(y, out) * BOTTOM_SPREAD + STAND_GAP - CLOSER;
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
    this.updateRipples(dt);
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
          if (this.mode === 'drink') {
            this.go('lean');
            break;
          }
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
        if (this.food?.gone()) {
          this.go('rise');
          break;
        }
        if (this.t >= LEAN_TIME) {
          this.anchor.set(y.center.x, 0, y.center.z);
          if (this.mode === 'drink') {
            this.gulps = 0;
            this.go('drink');
            break;
          }
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
        this.stay(dt);
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
      case 'drink': {
        // ひと口ごとに、頭を少し下げて水面に口を付け（口を開く）、上げながら飲み込む（口を閉じる）
        const n = Math.floor(this.t / GULP_TIME);
        const u = (this.t % GULP_TIME) / GULP_TIME;
        this.setPose(1 + BOB * Math.sin(u * Math.PI));
        this.stay(dt);
        showFace(y, u < 0.5 ? FACE_GULP_OPEN : FACE_GULP_SHUT);
        if (n >= this.gulps && n < GULPS && u >= 0.4) {
          this.gulps++;
          this.gulp();
        }
        if (this.t >= GULP_TIME * GULPS) {
          y.face.override = null;
          // しあわせー（指示。食べたときと同じ顔と文字・震え。ストレスは変えない）
          y.feeding.celebrate();
          this.go('rise');
        }
        break;
      }
      case 'rise': {
        this.setPose(1 - smooth(this.t / RISE_TIME));
        // 皿の当たりは起き上がりに合わせて少しずつ戻す（一度に戻すと、縁に乗った体が急にはじき出される）
        if (this.rim) this.rim.collider.h = RIM_H + (this.rim.h - RIM_H) * smooth(this.t / RISE_TIME);
        if (this.t >= RISE_TIME) this.end();
        break;
      }
    }
  }

  /** ひと口飲んだ：「ごーくごーく」（左右交互）と、口の下の水面に波の輪 */
  private gulp(): void {
    const y = this.y;
    const R = y.shape.radius;
    const f = faceFrame(y, 0, MOUTH_FY);
    const side = new THREE.Vector3(-f.facing.z, 0, f.facing.x);
    const s = this.gulps % 2 ? -1 : 1;
    const pos = f.pos.clone().addScaledVector(side, s * R * 1.2).addScaledVector(f.facing, R * 0.2);
    pos.y += R * 0.25;
    const life = GULP_TIME * 2.2;
    y.texts.say('ごーくごーく', pos, R * 0.26, life, new THREE.Vector3(0, R * 0.38 / life, 0).addScaledVector(side, (s * R * 0.16) / life));
    // 波の輪：口の真下の水面（水面の縁より内側に寄せる）
    const w = y.stage?.waterDish;
    if (!w) return;
    const p = new THREE.Vector3(f.pos.x - w.x, 0, f.pos.z - w.z).addScaledVector(f.facing, R * 0.1);
    const max = w.surfaceR - RIPPLE_R * 0.5;
    if (p.length() > max) p.setLength(max);
    // 2 重の輪（少し遅れてもう 1 つ）
    this.ripple(w.x + p.x, w.surfaceY, w.z + p.z, 0);
    this.ripple(w.x + p.x, w.surfaceY, w.z + p.z, -0.25);
  }

  /** 水面に波の輪を 1 つ（t0 から数え始める。負なら、その秒数だけ遅れて広がり始める） */
  private ripple(x: number, surfaceY: number, z: number, t0: number): void {
    const mesh = new THREE.Mesh(this.rippleGeometry, new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.95, depthWrite: false }));
    mesh.position.set(x, surfaceY + 0.002, z);
    mesh.scale.setScalar(0.01);
    mesh.visible = t0 >= 0;
    this.object.add(mesh);
    this.ripples.push({ mesh, t: t0 });
  }

  /** 波の輪を広げて薄くし、消す */
  private updateRipples(dt: number): void {
    for (let i = this.ripples.length - 1; i >= 0; i--) {
      const r = this.ripples[i];
      r.t += dt;
      r.mesh.visible = r.t >= 0;
      const k = Math.max(0, r.t) / RIPPLE_TIME;
      r.mesh.scale.setScalar(RIPPLE_R * Math.max(0.01, 1 - (1 - k) * (1 - k)));
      r.mesh.material.opacity = 0.95 * (1 - k);
      if (k >= 1) {
        this.object.remove(r.mesh);
        r.mesh.material.dispose();
        this.ripples.splice(i, 1);
      }
    }
  }

  /** 顔を突っ込み終えた所に体を留める（皿の縁に押されてずれた分を少しずつ戻す） */
  private stay(dt: number): void {
    const y = this.y;
    const k = Math.min(1, ANCHOR_RATE * dt);
    const dx = (this.anchor.x - y.center.x) * k, dz = (this.anchor.z - y.center.z) * k;
    if (dx * dx + dz * dz > 1e-10) y.body.translate(dx, dz);
  }

  /** 身ぶり：皿の方を向き、k の割合だけ前へ傾けて伸ばす（底は地面に留める） */
  private setPose(k: number): void {
    // 向きを合わせ始めたら、皿の当たりを下げて縁に乗り上げられるようにする（終わったら戻す）
    if (this.phase !== 'approach') this.lowerRim(true);
    // 顔を突っ込んでいる間は、帽子を下げずに保つ（起き上がるときに戻す）
    const hat = this.y.outfit.hat;
    if (hat) hat.holdLift = this.phase === 'lean' || this.phase === 'eat' || this.phase === 'drink';
    this.euler.set(PITCH * k, this.heading, 0);
    this.pose.setFromEuler(this.euler);
    this.y.locomotion.gesture = { orientation: this.pose, squash: 1, stretch: 1 + (STRETCH - 1) * k, pin: k > 0 };
  }

  /** 向かっている皿の当たりの高さを下げる・戻す（皿の上にも餌の当たりにも体が乗れないのは変わらない。縁に体を預けられるだけ） */
  private lowerRim(on: boolean): void {
    const y = this.y;
    if (on && !this.rim) {
      const d = this.mode === 'drink' ? y.stage?.waterDish : y.stage?.foodDish;
      const c = d && y.body.boxes.find((b) => Math.abs(b.x - d.x) < 1e-6 && Math.abs(b.z - d.z) < 1e-6);
      if (!c) return;
      this.rim = { collider: c, h: c.h };
      c.h = Math.min(c.h, RIM_H);
    } else if (!on && this.rim) {
      this.rim.collider.h = this.rim.h;
      this.rim = null;
    }
  }

  private end(): void {
    const y = this.y;
    this.lowerRim(false);
    if (y.outfit.hat) y.outfit.hat.holdLift = false;
    if (y.locomotion.gesture?.orientation === this.pose) y.locomotion.gesture = null;
    y.lookAt(null);
    if (this.phase === 'drink') y.face.override = null;
    // 食べている途中（しあわせーを含む）なら Feeding が移動の保留を解く。それ以外はここで解く
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
