import * as THREE from 'three';
import { createAccessoryMaterial } from '../render/accessoryMaterial';
import { createAccessoryOutlineMaterial } from '../render/outlineMaterial';
import { ellipsoid, withOutline } from '../character/shapes';
import { bodyFacing, type Word } from './fx';
import type { Yukkuri } from './Yukkuri';

/**
 * 枝：道具や環境に関わる動きの最初。ボタンで地面に出し、三つ編み（簡易的な手）で持つ。今は持つだけ。
 *   出す   … ゆっくりの前の少し横（三つ編みの側）の地面に置く（もう出ていれば置き直す）
 *   持つ   … 枝が三つ編みの側の真横に来るよう横付けに寄り（寝転がっていれば起き上がってから）、
 *            三つ編みの側へかがんで毛先を枝の端寄りへ下ろし、沿わせてつかみ、体を起こしながら持ち上げて構える
 *   離す   … その場に落とす（地面に転がる）
 *   片付ける … 消す
 * 持っている間は、三つ編みの毛先（Braid.grip）について行き、体の前へ少し上向きに構える。
 * 気絶したら落とす。三つ編みを表示していないときは持てない（持っていれば落とす）
 */
type State = 'none' | 'ground' | 'approach' | 'turn' | 'lower' | 'touch' | 'lift' | 'held' | 'falling';

/** 枝の長さ・太さ（胴の半径に対する比） */
const LENGTH = 1.5;
const THICK = 0.045;
/** 出す所：体の前へ・三つ編みの側へ（胴の半径に対する比） */
const SPAWN_AHEAD = 3.0;
const SPAWN_SIDE = 0.8;
/** 横付け：枝が体の真横（三つ編みの側）、中心からこの距離（胴の半径に対する比）・少し前に来る所で止まる */
const SIDE_GAP = 1.25;
const SIDE_AHEAD = 0.15;
/** 止まる所がこれより近ければ（胴の半径に対する比）歩かずにその場で向きだけ変える（すぐ後ろへは回り込めず、近くを回り続ける） */
const NEAR_ENOUGH = 1.0;
/** 向きを合わせる：差がこれ（rad）より小さくなるか、この時間（秒）たったら、かがむ */
const TURN_OK = 0.15;
const TURN_MAX = 2.5;
/** あきらめるまでの時間（秒） */
const GIVE_UP = 15;
/** かがむ（三つ編みを下ろす）時間・沿わせて止まる時間・持ち上げる時間（秒） */
const LOWER_TIME = 0.5;
const TOUCH_TIME = 0.25;
const LIFT_TIME = 0.6;
/** かがむとき、三つ編みの側へ傾ける角度（rad）と沈み込み（縦の倍率） */
const LEAN = 0.26;
const CROUCH = 0.92;
/** 持ってから枝を見ている時間（秒） */
const LOOK_AFTER = 1.2;
/** つかむ所：枝の中心から端寄りへ（長さに対する比。どちらの端かは三つ編みに近い方） */
const GRAB_AT = 0.3;
/** 持ち方：前へ構える上向きの角度（rad）・外への開き（rad）。つかんだ所（GRAB_AT）を毛先で握ったまま構える */
const HOLD_PITCH = 0.35;
const HOLD_OUT = 0.35;
/** 落とすときの重力（m/s²） */
const GRAVITY = 10;

const BARK = { lit: '#a8784a', shade: '#7e5532', deep: '#5a3a20', rim: '#e8cfae' };
const LEAF = { lit: '#8fc45a', shade: '#62963a', deep: '#3f6a22', rim: '#e6f7c8' };


export class Branch {
  /** 枝（体と一緒に震えないよう、シーンに直接置く） */
  readonly object = new THREE.Group();
  private readonly stick: THREE.Group;
  private state: State = 'none';
  private t = 0;
  /** つかむ所が枝のどちらの端寄りか（-1：根元側、+1：先の側）。三つ編みに近い方 */
  private grabSign = -1;
  /** 持ち上げ始めた時の向き（地面に寝かせた向き） */
  private readonly fromQuat = new THREE.Quaternion();
  /** 落ちている速さ */
  private readonly vel = new THREE.Vector3();
  private word: Word | null = null;
  private readonly materials: THREE.Material[] = [];
  private readonly geometries: THREE.BufferGeometry[] = [];
  /** 拾いに行く行き先と、着いたら向く向き（rad）・三つ編みの側（体の右 +1・左 -1） */
  private readonly approachTarget = new THREE.Vector3();
  private heading = 0;
  private side = 1;
  /** 身ぶり（向きを合わせる・かがむ）の姿勢 */
  private readonly pose = new THREE.Quaternion();
  private readonly euler = new THREE.Euler(0, 0, 0, 'YXZ');

  constructor(private readonly y: Yukkuri) {
    const bark = createAccessoryMaterial(y.bodyMaterial, BARK, { rim: 0.2 });
    const leaf = createAccessoryMaterial(y.bodyMaterial, LEAF, { rim: 0.25, doubleSide: true });
    const outline = createAccessoryOutlineMaterial(y.outlineMaterial);
    this.materials.push(bark, leaf, outline);
    // 単位の長さ 1（x 方向、-0.5〜0.5。+ が先）。置くときに大きさを合わせる
    this.stick = new THREE.Group();
    const main = new THREE.CylinderGeometry(THICK * 0.6, THICK, 1, 10, 1);
    main.rotateZ(-Math.PI / 2); // y 方向 → x 方向（細い先が +x）
    this.geometries.push(main);
    this.stick.add(withOutline(main, bark, outline));
    // 小枝 2 本（先の側へ斜めに）と、先に葉 1 枚
    const twig = (at: number, len: number, ang: number) => {
      const g = new THREE.CylinderGeometry(THICK * 0.3, THICK * 0.5, len, 8, 1);
      g.translate(0, len / 2, 0);
      g.rotateZ(-ang);
      g.translate(at, 0, 0);
      this.geometries.push(g);
      this.stick.add(withOutline(g, bark, outline));
    };
    twig(0.05, 0.22, 0.9);
    twig(0.25, 0.16, Math.PI - 0.8);
    const lf = ellipsoid(0.07, 0.012, 0.035, 12);
    lf.rotateY(0.4);
    lf.translate(0.53, 0.01, 0.02);
    this.geometries.push(lf);
    this.stick.add(withOutline(lf, leaf, outline));
    this.object.add(this.stick);
    this.object.visible = false;
  }

  /** 枝が出ているか */
  get exists(): boolean {
    return this.state !== 'none';
  }

  /** 持っている（持ち上げている途中を含む）か */
  get holding(): boolean {
    return this.state === 'lift' || this.state === 'held';
  }

  /** 拾おうとしている途中（寄る・向きを合わせる・かがむ・沿わせる）か */
  private get picking(): boolean {
    return this.state === 'approach' || this.state === 'turn' || this.state === 'lower' || this.state === 'touch';
  }

  /** 枝を出す（ゆっくりの前の、三つ編みの側の地面に置く）。持っていれば離してから置き直す */
  spawn(): void {
    const y = this.y;
    const R = y.shape.radius;
    const facing = bodyFacing(y);
    const side = this.braidSide();
    const p = y.center.clone().addScaledVector(facing, R * SPAWN_AHEAD).addScaledVector(side, R * SPAWN_SIDE);
    this.cancel();
    this.setScale();
    this.object.position.set(p.x, this.restY(), p.z);
    this.object.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.random() * Math.PI * 2);
    this.object.visible = true;
    this.state = 'ground';
  }

  /** 持つ／離す */
  toggleHold(): void {
    if (this.holding) this.drop();
    else this.pickUp();
  }

  /** 拾いに行く。枝が地面にないとき・三つ編みがないとき・気絶中は何もしない */
  pickUp(): boolean {
    const y = this.y;
    if ((this.state !== 'ground' && this.state !== 'falling') || !y.outfit.braid || y.rest.fainting) return false;
    if (this.state === 'falling') this.land();
    y.rest.wake(true);
    if (y.locomotion.isLying) y.getUp();
    this.state = 'approach';
    this.t = 0;
    this.goNear();
    // 止まる所がすぐそばなら歩かない（すぐ後ろへは回り込めない）。その場で向きを合わせる
    if (Math.hypot(this.approachTarget.x - y.center.x, this.approachTarget.z - y.center.z) < y.shape.radius * NEAR_ENOUGH && !y.locomotion.isLying) {
      y.locomotion.stop();
      this.startTurn();
    }
    this.say(this.y.line('branchGo'), 0.2, 1.4);
    return true;
  }

  /** 離す（その場に落とす） */
  drop(): void {
    if (!this.holding) return;
    if (this.state === 'lift') this.endPick();
    this.state = 'falling';
    this.vel.set(0, 0, 0);
    this.say(this.y.line('branchDrop'), 0.2, 1.2);
  }

  /** 片付ける */
  clear(): void {
    this.cancel();
    if (this.state === 'lift') this.endPick();
    this.state = 'none';
    this.object.visible = false;
  }

  /** 固定時間刻みで呼ぶ（持っているときの位置は sync で合わせる） */
  update(dt: number): void {
    const y = this.y;
    this.t += dt;
    this.look(dt);
    // 気絶した・三つ編みを隠したら、拾うのをやめる・落とす
    if ((y.rest.fainting || !y.outfit.braid) && this.state !== 'none' && this.state !== 'ground' && this.state !== 'falling') {
      if (this.holding) this.drop();
      else this.cancel();
      return;
    }
    const loco = y.locomotion;
    switch (this.state) {
      case 'approach':
        // ほかの行き先を指示されたらやめる
        if (loco.hasTarget && loco.target.distanceTo(this.approachTarget) > 1e-3) {
          this.state = 'ground';
          break;
        }
        if (this.t > GIVE_UP) {
          this.cancel();
          break;
        }
        // 着いた（立って止まった）：向きを合わせる。行き先の指示などは終わるまで待たせる
        if (!loco.hasTarget && loco.idle && !loco.tilted) this.startTurn();
        break;
      case 'turn': {
        const err = Math.abs(Math.atan2(Math.sin(this.heading - y.body.yaw), Math.cos(this.heading - y.body.yaw)));
        this.setPose(0, 1);
        if ((err < TURN_OK && this.t > 0.3) || this.t > TURN_MAX) {
          // かがむ：つかむ所は、枝の両端寄りのうち三つ編みの毛先に近い方
          const g = y.outfit.braid!.grip.pos;
          const near = (sgn: number) => this.stickPoint(sgn * GRAB_AT).distanceTo(g);
          this.grabSign = near(-1) <= near(1) ? -1 : 1;
          this.state = 'lower';
          this.t = 0;
          this.say(this.y.line('branchLower'), 0.18, 1.0);
        }
        break;
      }
      case 'lower': {
        const k = smooth(this.t / LOWER_TIME);
        this.setPose(k, k);
        const braid = y.outfit.braid!;
        braid.reachTarget.copy(this.stickPoint(this.grabSign * GRAB_AT));
        braid.reachAmount = k;
        if (this.t >= LOWER_TIME) {
          this.state = 'touch';
          this.t = 0;
        }
        break;
      }
      case 'touch':
        this.setPose(1, 1);
        y.outfit.braid!.reachTarget.copy(this.stickPoint(this.grabSign * GRAB_AT));
        if (this.t >= TOUCH_TIME) {
          // 沿わせてつかんだ：体を起こしながら持ち上げる
          this.state = 'lift';
          this.t = 0;
          this.fromQuat.copy(this.object.quaternion);
        }
        break;
      case 'lift': {
        const k = smooth(this.t / LIFT_TIME);
        this.setPose(1 - k, 1 - k);
        y.outfit.braid!.reachAmount = 1 - k;
        if (this.t >= LIFT_TIME) {
          this.endPick();
          this.state = 'held';
          this.say(this.y.line('branchPick'), 0.24, 2.0);
        }
        break;
      }
      case 'falling': {
        this.vel.y -= GRAVITY * dt;
        this.object.position.addScaledVector(this.vel, dt);
        // 落ちながら水平へ寝かせる
        this.object.quaternion.slerp(this.flatQuat(), Math.min(1, dt * 6));
        if (this.object.position.y <= this.restY()) this.land();
        break;
      }
    }
  }

  /** 描画の直前に呼ぶ（三つ編みの毛先が決まった後）：持っていれば毛先につける */
  sync(): void {
    if (!this.holding) return;
    const braid = this.y.outfit.braid;
    if (!braid?.grip.ready) return;
    const grip = braid.grip.pos;
    const hold = this.holdQuat();
    // 持ち上げる途中：寝かせた向きから構える向きへ少しずつ回す（つかんだ所は毛先に付けたまま）
    const q = this.state === 'lift' ? this.fromQuat.clone().slerp(hold, smooth(this.t / LIFT_TIME)) : hold;
    const L = this.y.shape.radius * LENGTH;
    const x = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
    const pos = grip.clone().addScaledVector(x, -this.grabSign * GRAB_AT * L);
    // 両端が地面に潜らないよう持ち上げる
    const low = pos.y - Math.abs(x.y) * L * 0.5;
    if (low < this.restY()) pos.y += this.restY() - low;
    this.object.position.copy(pos);
    this.object.quaternion.copy(q);
  }

  /**
   * 視線：拾おうとしている間は枝のつかむ所を見る。持ち上げている間と、持ってからしばらく（LOOK_AFTER 秒）は枝の先を見る。
   * それ以外は、こちらで向けた視線だけ正面へ戻す
   */
  private lookFor = 0;
  private looking = false;
  private look(dt: number): void {
    const y = this.y;
    let target: THREE.Vector3 | null = null;
    if (this.picking) target = this.stickPoint(this.grabSign * GRAB_AT);
    else if (this.state === 'lift') {
      target = this.stickPoint(-this.grabSign * 0.25);
      this.lookFor = LOOK_AFTER;
    } else if (this.state === 'held' && this.lookFor > 0) {
      this.lookFor -= dt;
      target = this.stickPoint(-this.grabSign * 0.25);
    }
    if (target) {
      y.lookAt(target);
      this.looking = true;
    } else if (this.looking) {
      y.lookAt(null);
      this.looking = false;
    }
  }

  /** 構える向き：体の前へ、少し上向き・三つ編みの側へ少し開く。つかんだ端（grabSign）を手元に、反対の端を前へ */
  private holdQuat(): THREE.Quaternion {
    const y = this.y;
    const facing = bodyFacing(y);
    const out = this.braidSide();
    const axis = facing.clone().multiplyScalar(Math.cos(HOLD_OUT)).addScaledVector(out, Math.sin(HOLD_OUT)).normalize();
    axis.multiplyScalar(Math.cos(HOLD_PITCH)).add(new THREE.Vector3(0, Math.sin(HOLD_PITCH), 0)).normalize();
    // 枝の x 軸：つかんだのが根元側（-1）なら前へ、先の側（+1）なら後ろへ（つかんだ端が手元に来るように）
    const x = axis.multiplyScalar(-this.grabSign);
    const up0 = new THREE.Vector3(0, 1, 0);
    const z = new THREE.Vector3().crossVectors(x, up0).normalize();
    const yy = new THREE.Vector3().crossVectors(z, x).normalize();
    return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, yy, z));
  }

  /** 枝の上の点（中心から x 方向へ、長さに対する比 u の所。ワールド） */
  private stickPoint(u: number): THREE.Vector3 {
    const L = this.y.shape.radius * LENGTH;
    const x = new THREE.Vector3(1, 0, 0).applyQuaternion(this.object.quaternion);
    return this.object.position.clone().addScaledVector(x, u * L);
  }

  /** 身ぶり：拾う向き（heading）を向き、三つ編みの側へ lean の割合だけ傾けて、crouch の割合だけ沈む */
  private setPose(lean: number, crouch: number): void {
    // 体の右（ローカル +x）が三つ編みの側なら、右を下げる＝z 軸まわりに負へ回す
    this.euler.set(0, this.heading, -this.side * LEAN * lean);
    this.pose.setFromEuler(this.euler);
    this.y.locomotion.gesture = { orientation: this.pose, squash: 1 + (CROUCH - 1) * crouch };
  }

  /** 三つ編みのある側（水平の単位ベクトル。体の中心から毛先へ。毛先がまだなければ体の左） */
  private braidSide(): THREE.Vector3 {
    const y = this.y;
    const facing = bodyFacing(y);
    const g = y.outfit.braid?.grip;
    const v = g?.ready ? g.pos.clone().sub(y.center).setY(0) : new THREE.Vector3(facing.z, 0, -facing.x);
    v.addScaledVector(facing, -v.dot(facing)); // 前後の成分は除く
    if (v.lengthSq() < 1e-6) v.set(facing.z, 0, -facing.x);
    return v.normalize();
  }

  /**
   * 拾いに行く行き先：枝が三つ編みの側の真横（少し前）に来る所。向く向きは今いる所から枝へ向かう向き
   * （そこへ向かって歩けば、着いたときおおむねその向きを向いている）
   */
  private goNear(): void {
    const y = this.y;
    const R = y.shape.radius;
    const p = this.object.position;
    const f = bodyFacing(y);
    // 三つ編みが体の右（ローカル +x：前 f に対して (f.z, 0, -f.x)）にあるか
    const right = new THREE.Vector3(f.z, 0, -f.x);
    this.side = this.braidSide().dot(right) >= 0 ? 1 : -1;
    const toward = new THREE.Vector3(p.x - y.center.x, 0, p.z - y.center.z);
    if (toward.lengthSq() < 1e-6) toward.copy(f);
    toward.normalize();
    this.heading = Math.atan2(toward.x, toward.z);
    const sideThen = new THREE.Vector3(toward.z, 0, -toward.x).multiplyScalar(this.side);
    const t = p.clone().addScaledVector(sideThen, -R * SIDE_GAP).addScaledVector(toward, -R * SIDE_AHEAD);
    this.approachTarget.set(t.x, 0, t.z);
    y.locomotion.moveTo(t.x, t.z);
    this.approachTarget.copy(y.locomotion.target);
  }

  /** 向きを合わせ始める（移動はこちらが終わるまで待たせる） */
  private startTurn(): void {
    this.y.locomotion.hold();
    this.state = 'turn';
    this.t = 0;
  }

  /** 拾う途中でやめる（身ぶり・三つ編みを戻し、移動の保留を解く）。枝は地面のまま */
  private cancel(): void {
    if (!this.picking) return;
    const loco = this.y.locomotion;
    if (this.state === 'approach') {
      if (loco.hasTarget && loco.target.distanceTo(this.approachTarget) < 1e-3) loco.stop();
    } else this.endPick();
    this.state = 'ground';
  }

  /** 身ぶりと三つ編みを戻し、移動の保留を解く */
  private endPick(): void {
    const y = this.y;
    const braid = y.outfit.braid;
    if (braid) braid.reachAmount = 0;
    if (y.locomotion.gesture?.orientation === this.pose) y.locomotion.gesture = null;
    y.locomotion.release();
  }

  private land(): void {
    this.object.position.y = this.restY();
    this.object.quaternion.copy(this.flatQuat());
    this.vel.set(0, 0, 0);
    this.state = 'ground';
  }

  /** 今の向き（水平の向き）のまま、地面に寝かせた向き */
  private flatQuat(): THREE.Quaternion {
    const x = new THREE.Vector3(1, 0, 0).applyQuaternion(this.object.quaternion).setY(0);
    if (x.lengthSq() < 1e-6) x.set(1, 0, 0);
    const yaw = Math.atan2(-x.z, x.x);
    return new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
  }

  /** 地面に置いたときの中心の高さ */
  private restY(): number {
    return this.y.shape.radius * LENGTH * THICK;
  }

  private setScale(): void {
    this.stick.scale.setScalar(this.y.shape.radius * LENGTH);
  }

  private say(text: string, size: number, life: number): void {
    const y = this.y;
    const R = y.shape.radius;
    const pos = new THREE.Vector3(y.center.x, y.center.y + y.height * 0.5 + R * 0.4, y.center.z);
    if (this.word) y.texts.fade(this.word);
    this.word = y.texts.say(text, pos, R * size, life, new THREE.Vector3(0, R * 0.15, 0));
  }
}

function smooth(t: number): number {
  t = Math.min(1, Math.max(0, t));
  return t * t * (3 - 2 * t);
}
