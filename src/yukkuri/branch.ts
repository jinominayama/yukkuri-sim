import * as THREE from 'three';
import { createAccessoryMaterial } from '../render/accessoryMaterial';
import { createAccessoryOutlineMaterial } from '../render/outlineMaterial';
import { ellipsoid, withOutline } from '../character/shapes';
import { bodyFacing, type Word } from './fx';
import { BraidPick, braidSide, LIFT_TIME, smooth } from './braidPick';
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
type State = 'none' | 'ground' | 'picking' | 'held' | 'falling';

/** 枝の長さ・太さ（胴の半径に対する比） */
const LENGTH = 1.5;
const THICK = 0.045;
/** 出す所：体の前へ・三つ編みの側へ（胴の半径に対する比） */
const SPAWN_AHEAD = 3.0;
const SPAWN_SIDE = 0.8;
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
  /** 三つ編みで拾う動き（餌と共通） */
  private readonly picker: BraidPick;

  constructor(private readonly y: Yukkuri) {
    this.picker = new BraidPick(y);
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
    return (this.state === 'picking' && this.picker.lifting) || this.state === 'held';
  }

  /** 拾っている途中か（三つ編みと身ぶりを使っている） */
  get busy(): boolean {
    return this.state === 'picking';
  }

  /** 枝を出す（ゆっくりの前の、三つ編みの側の地面に置く）。持っていれば離してから置き直す */
  spawn(): void {
    const y = this.y;
    const R = y.shape.radius;
    const facing = bodyFacing(y);
    const side = braidSide(y);
    const p = y.center.clone().addScaledVector(facing, R * SPAWN_AHEAD).addScaledVector(side, R * SPAWN_SIDE);
    this.picker.cancel();
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

  /** 拾いに行く。枝が地面にないとき・三つ編みがないとき・気絶中・餌を拾っている途中は何もしない */
  pickUp(): boolean {
    const y = this.y;
    if ((this.state !== 'ground' && this.state !== 'falling') || y.forage.busy) return false;
    if (this.state === 'falling') this.land();
    const ok = this.picker.start({
      grabPoint: () => this.stickPoint(this.grabSign * GRAB_AT),
      onLower: () => {
        // つかむ所は、枝の両端寄りのうち三つ編みの毛先に近い方
        const g = y.outfit.braid!.grip.pos;
        const near = (sgn: number) => this.stickPoint(sgn * GRAB_AT).distanceTo(g);
        this.grabSign = near(-1) <= near(1) ? -1 : 1;
        this.say(y.line('branchLower'), 0.18, 1.0);
      },
      onLift: () => {
        this.t = 0;
        this.fromQuat.copy(this.object.quaternion);
        this.lookFor = LOOK_AFTER;
      },
      onDone: () => {
        this.state = 'held';
        this.say(y.line('branchPick'), 0.24, 2.0);
      },
      onCancel: () => {
        if (this.state === 'picking') this.state = 'ground';
      },
    });
    if (!ok) return false;
    this.state = 'picking';
    this.say(y.line('branchGo'), 0.2, 1.4);
    return true;
  }

  /** 離す（その場に落とす） */
  drop(): void {
    if (!this.holding) return;
    if (this.state === 'picking') this.picker.cancel();
    this.state = 'falling';
    this.vel.set(0, 0, 0);
    this.say(this.y.line('branchDrop'), 0.2, 1.2);
  }

  /** 片付ける */
  clear(): void {
    this.picker.cancel();
    this.state = 'none';
    this.object.visible = false;
  }

  /** 固定時間刻みで呼ぶ（持っているときの位置は sync で合わせる） */
  update(dt: number): void {
    const y = this.y;
    this.t += dt;
    this.picker.update(dt);
    // 気絶した・三つ編みを隠したら落とす（拾う途中は picker がやめる）
    if (this.state === 'held' && (y.rest.fainting || !y.outfit.braid)) this.drop();
    this.look(dt);
    if (this.state === 'falling') {
      this.vel.y -= GRAVITY * dt;
      this.object.position.addScaledVector(this.vel, dt);
      // 落ちながら水平へ寝かせる
      this.object.quaternion.slerp(this.flatQuat(), Math.min(1, dt * 6));
      if (this.object.position.y <= this.restY()) this.land();
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
    const q = this.state === 'picking' ? this.fromQuat.clone().slerp(hold, smooth(this.t / LIFT_TIME)) : hold;
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
   * 視線：持ち上げている間と、持ってからしばらく（LOOK_AFTER 秒）は枝の先を見る。こちらで向けた視線だけ正面へ戻す
   */
  private lookFor = 0;
  private looking = false;
  private look(dt: number): void {
    const y = this.y;
    // 持ち上げている間と、持ってからしばらくは枝の先を見る（拾う途中のほかの間は picker がつかむ所を見せる）
    if (this.holding && this.lookFor > 0) {
      if (this.state === 'held') this.lookFor -= dt;
      y.lookAt(this.stickPoint(-this.grabSign * 0.25));
      this.looking = true;
    } else if (this.looking && !this.picker.active) {
      y.lookAt(null);
      this.looking = false;
    }
  }

  /** 構える向き：体の前へ、少し上向き・三つ編みの側へ少し開く。つかんだ端（grabSign）を手元に、反対の端を前へ */
  private holdQuat(): THREE.Quaternion {
    const y = this.y;
    const facing = bodyFacing(y);
    const out = braidSide(this.y);
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

