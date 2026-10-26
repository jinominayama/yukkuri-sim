import * as THREE from 'three';
import { createAccessoryMaterial } from '../render/accessoryMaterial';
import { HairShell } from '../character/HairShell';
import { Braid } from '../character/Braid';
import type { PartSelection } from '../face/parts';
import { showFace } from './fx';
import { smooth } from './braidPick';
import { HatStash } from './hatStash';
import type { Yukkuri } from './Yukkuri';

/**
 * おたべなさい（「おたべなさい！」の後）：にっこりしたまま帽子を三つ編みで脱いで、かぶる向きのまま横の地面に置き、
 * 体の真ん中（顔の真ん中を通る縦の面）から左右に二つに割れて、底を支点に少し傾いて閉じた本のように開く（断面の餡子が斜め上を向く）。
 * 割れるときに目を閉じる。割れた後はそのまま（戻すのはページの読み直し）。
 *
 * 割り方：割れる瞬間の体の描く形を固め、左右それぞれの半分を作る。反対側の頂点を割る面へ押しつぶすと、その半分は閉じた形になり、
 * 押しつぶされた三角形（頂点が全部反対側）がそのまま断面になる（餡子の色で描く）。顔・髪は同じ材質をそのまま使うので半分ずつ写る。
 * 三つ編みはその側の半分に付けて一緒に傾く。割れた後は体の物理と装飾の更新を止める（Yukkuri.step / sync）
 */
type Phase = 'idle' | 'wait' | 'hat' | 'pause' | 'crack' | 'open' | 'done';

/** 言ってから帽子を脱ぎ始めるまで・帽子を置いてから割れるまで（秒） */
const WAIT = 1.2;
const PAUSE = 0.6;
/** ひびが入って少しずれる時間（秒）とずれ（胴の半径に対する比）。開く時間（秒）と角度（rad） */
const CRACK_TIME = 0.6;
const CRACK_GAP = 0.04;
const OPEN_TIME = 1.4;
const OPEN_ANGLE = (7 * Math.PI) / 180;
/** 傾く支点：半分の底の、真ん中から外へこの距離（胴の半径に対する比）の所 */
const HINGE = 0.5;
/**
 * 割れた後につつく・叩く：押す強さ（m/s）に掛ける速さの倍率と、傾きの倍率。揺れのばね（1/s²）と減衰（1/s）。
 * 固いまま揺れて戻る（形はへこまない）
 */
const HIT_SPEED = 0.15;
const HIT_TILT = 1.2;
const WOBBLE_K = 45;
const WOBBLE_C = 4;

const ANKO = { lit: '#7d3b2d', shade: '#5e2b21', deep: '#3f1b14', rim: '#a8604c' };
const FACE_SMILE: Partial<PartSelection> = { eyes: 'smile', mouth: 'smile', brows: 'neutral', tears: 'none', stream: 'none' };
const FACE_SPLIT: Partial<PartSelection> = { eyes: 'closed', mouth: 'smileSmall', brows: 'neutral', tears: 'none', stream: 'none' };

interface Half {
  side: number;
  pivot: THREE.Group;
  /** 傾けたとき地面より下へ出ないか調べる頂点（半分の座標。間引き） */
  samples: Float32Array;
  /** つつかれて揺れる分（ばねで戻る）：外へのずれと前後のずれ（m）、外への傾き（rad）と、それぞれの速さ */
  out: number;
  fwd: number;
  tilt: number;
  /** 前後への傾き（rad。+ で上が前へ） */
  rock: number;
  outV: number;
  fwdV: number;
  tiltV: number;
  rockV: number;
}

export class Otabe {
  private phase: Phase = 'idle';
  private t = 0;
  private readonly stash: HatStash;
  private readonly group = new THREE.Group();
  private halves: Half[] = [];
  private anko: THREE.Material | null = null;

  constructor(private readonly y: Yukkuri) {
    this.stash = new HatStash(y);
  }

  /** 始めてから（割れた後も） */
  get active(): boolean {
    return this.phase !== 'idle';
  }

  /** 割れた（割れている途中を含む）。体の物理と装飾の更新を止める */
  get split(): boolean {
    return this.phase === 'crack' || this.phase === 'open' || this.phase === 'done';
  }

  /** 始める（「おたべなさい！」と言った後に呼ぶ） */
  start(): boolean {
    const y = this.y;
    if (this.active || y.death.active || y.rest.fainting) return false;
    if (y.locomotion.isLying && y.stuck()) return false; // 足焼きで移動できず寝転がっていれば、起き上がれない
    y.feeding.cancel();
    y.exercise.cancel();
    y.moru.stop();
    y.puku.stop();
    y.rest.wake(true);
    y.lookAt(null);
    if (y.locomotion.isLying) y.getUp();
    y.locomotion.stop();
    y.locomotion.hold();
    showFace(y, FACE_SMILE);
    this.go('wait');
    return true;
  }

  /** 固定時間刻みで呼ぶ */
  update(dt: number): void {
    if (!this.active) return;
    const y = this.y;
    this.t += dt;
    switch (this.phase) {
      case 'wait':
        y.locomotion.stop();
        y.locomotion.hold();
        if (this.t >= WAIT && !y.locomotion.tilted) {
          // 帽子を三つ編みで脱いで、かぶる向きのまま横に置く（帽子・三つ編みがなければそのまま割れる）
          const ok = this.stash.start({ onDown: () => this.go('pause'), onCancel: () => this.go('pause') }, true);
          this.go(ok ? 'hat' : 'pause');
        }
        break;
      case 'hat':
        this.stash.update(dt);
        break;
      case 'pause':
        this.stash.update(dt);
        y.locomotion.stop();
        y.locomotion.hold();
        if (this.t >= PAUSE && y.locomotion.idle) this.splitBody();
        break;
      case 'crack':
        if (this.t >= CRACK_TIME) this.go('open');
        break;
      case 'open':
        if (this.t >= OPEN_TIME) this.go('done');
        break;
    }
    if (this.split) this.wobble(dt);
  }

  /** つつく・叩くの当たり判定に使う物体（割れた半分） */
  get pickTarget(): THREE.Object3D {
    return this.group;
  }

  /**
   * 割れた半分をつつく・叩く（点 point を向き dir に強さ strength m/s）：当たった半分が固いまま押されて揺れ、ばねで元へ戻る。
   * 外へ押すと外へ傾き・ずれる。内へ押しても、もう一方の半分に当たる所（閉じきった所）より内へは入らない
   */
  hit(point: THREE.Vector3, dir: THREE.Vector3, strength: number): void {
    if (!this.split || this.halves.length === 0) return;
    const y = this.y;
    const H = y.height;
    // 体の座標（割った時の向き）へ
    const cs = Math.cos(this.group.rotation.y), sn = Math.sin(this.group.rotation.y);
    const px = point.x - this.group.position.x, pz = point.z - this.group.position.z;
    const lx = px * cs - pz * sn;
    const d = dir.clone().setY(0);
    if (d.lengthSq() < 1e-8) return;
    d.normalize();
    const dx = d.x * cs - d.z * sn, dz = d.x * sn + d.z * cs;
    const h = this.halves.find((q) => q.side === (lx >= 0 ? 1 : -1))!;
    const v = strength * HIT_SPEED;
    const out = dx * h.side;
    h.outV += out * v;
    h.fwdV += dz * v;
    // 高い所を押すほど傾く（外へ押せば外へ、前後へ押せば前後へ）
    const lever = (v * HIT_TILT * Math.max(0.2, point.y / H)) / y.shape.radius;
    h.tiltV += out * lever;
    h.rockV += dz * lever;
  }

  /** 揺れ：ばねで元へ戻る（閉じきった所より内へは入らない） */
  private wobble(dt: number): void {
    const R = this.y.shape.radius;
    const step = (x: number, v: number) => {
      const a = -WOBBLE_K * x - WOBBLE_C * v;
      v += a * dt;
      return [x + v * dt, v];
    };
    for (const h of this.halves) {
      [h.out, h.outV] = step(h.out, h.outV);
      [h.fwd, h.fwdV] = step(h.fwd, h.fwdV);
      [h.tilt, h.tiltV] = step(h.tilt, h.tiltV);
      [h.rock, h.rockV] = step(h.rock, h.rockV);
      // 閉じきった所（ずれ 0・傾き 0 から CRACK_GAP 分・開いた角度分）より内へは入らず、跳ね返る
      const minOut = -R * CRACK_GAP;
      if (h.out < minOut) {
        h.out = minOut;
        h.outV = Math.abs(h.outV) * 0.3;
      }
      const minTilt = -OPEN_ANGLE;
      if (h.tilt < minTilt) {
        h.tilt = minTilt;
        h.tiltV = Math.abs(h.tiltV) * 0.3;
      }
    }
  }

  /** 描画の直前に呼ぶ（割れている間の半分の置き場） */
  sync(): void {
    if (!this.split) return;
    const R = this.y.shape.radius;
    const crack = this.phase === 'crack' ? smooth(this.t / CRACK_TIME) : 1;
    const open = this.phase === 'open' ? smooth(this.t / OPEN_TIME) : this.phase === 'done' ? 1 : 0;
    // ひびが入る間は小刻みに震える
    const jitter = this.phase === 'crack' ? Math.sin(this.t * 90) * R * 0.004 * (1 - crack) : 0;
    for (const h of this.halves) {
      const a = OPEN_ANGLE * open + h.tilt;
      h.pivot.rotation.set(h.rock, 0, -h.side * a);
      // 傾けて地面より下へ出た分だけ持ち上げる
      const lift = Math.max(0, -this.minY(h, -h.side * a));
      h.pivot.position.x = h.side * (R * HINGE + R * CRACK_GAP * crack + h.out) + jitter * h.side;
      h.pivot.position.y = lift;
      h.pivot.position.z = h.fwd;
    }
  }

  /** 体を二つに割る：形を固めて左右の半分を作り、元の体・髪は隠す */
  private splitBody(): void {
    const y = this.y;
    const R = y.shape.radius;
    const g = y.bodyMesh.geometry;
    const pos = g.getAttribute('position').array as Float32Array;
    const nrm = g.getAttribute('normal').array as Float32Array;
    const rest = g.getAttribute('aRest').array as Float32Array;
    const index = g.getIndex()!.array;
    const n = pos.length / 3;
    // 体の座標：底の真ん中が原点、顔の正面が +z、横が x
    const yaw = y.body.yaw;
    const cs = Math.cos(yaw), sn = Math.sin(yaw);
    const ox = y.center.x, oz = y.center.z;
    const lp = new Float32Array(n * 3), ln = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const dx = pos[3 * i] - ox, dz = pos[3 * i + 2] - oz;
      lp[3 * i] = dx * cs - dz * sn;
      lp[3 * i + 1] = pos[3 * i + 1];
      lp[3 * i + 2] = dx * sn + dz * cs;
      ln[3 * i] = nrm[3 * i] * cs - nrm[3 * i + 2] * sn;
      ln[3 * i + 1] = nrm[3 * i + 1];
      ln[3 * i + 2] = nrm[3 * i] * sn + nrm[3 * i + 2] * cs;
    }
    this.group.position.set(ox, 0, oz);
    this.group.rotation.set(0, yaw, 0);
    this.group.clear();
    y.root.add(this.group);
    if (!this.anko) this.anko = createAccessoryMaterial(y.bodyMaterial, ANKO, { rim: 0.15, doubleSide: true });
    const hair = y.outfit.accessories.find((a): a is HairShell => a instanceof HairShell);
    const hairMats = hair ? hair.object.children.map((c) => (c as THREE.Mesh).material as THREE.Material) : [];
    this.halves = [];
    for (const side of [-1, 1]) {
      // 反対側の頂点は割る面（x = 0）へ押しつぶす
      const hp = Float32Array.from(lp);
      for (let i = 0; i < n; i++) if (hp[3 * i] * side < 0) hp[3 * i] = 0;
      const skinIdx: number[] = [], capPos: number[] = [];
      for (let t = 0; t < index.length; t += 3) {
        const a = index[t], b = index[t + 1], c = index[t + 2];
        if (lp[3 * a] * side > 0 || lp[3 * b] * side > 0 || lp[3 * c] * side > 0) skinIdx.push(a, b, c);
        else for (const v of [a, b, c]) capPos.push(0, hp[3 * v + 1], hp[3 * v + 2]);
      }
      const skin = new THREE.BufferGeometry();
      skin.setAttribute('position', new THREE.BufferAttribute(hp, 3));
      skin.setAttribute('normal', new THREE.BufferAttribute(Float32Array.from(ln), 3));
      skin.setAttribute('aRest', new THREE.BufferAttribute(Float32Array.from(rest), 3));
      skin.setIndex(skinIdx);
      skin.computeBoundingSphere();
      const cap = new THREE.BufferGeometry();
      cap.setAttribute('position', new THREE.Float32BufferAttribute(capPos, 3));
      const capN = new Float32Array(capPos.length);
      for (let i = 0; i < capN.length; i += 3) capN[i] = -side; // 断面は反対の半分の側を向く
      cap.setAttribute('normal', new THREE.BufferAttribute(capN, 3));
      const pivot = new THREE.Group();
      const inner = new THREE.Group();
      const hinge = side * R * HINGE;
      pivot.position.x = hinge;
      inner.position.x = -hinge;
      pivot.add(inner);
      this.group.add(pivot);
      const add = (geo: THREE.BufferGeometry, mat: THREE.Material) => {
        const m = new THREE.Mesh(geo, mat);
        m.frustumCulled = false;
        inner.add(m);
      };
      add(skin, y.outlineMaterial);
      add(skin, y.bodyMaterial);
      add(cap, this.anko);
      for (const m of hairMats) add(skin, m);
      // 傾けたときに調べる頂点（半分の側の頂点を間引いて。支点からの位置）
      const samples: number[] = [];
      for (let i = 0; i < n; i += 7) if (lp[3 * i] * side >= 0) samples.push(hp[3 * i] - hinge, hp[3 * i + 1]);
      this.halves.push({ side, pivot, samples: Float32Array.from(samples), out: 0, fwd: 0, tilt: 0, rock: 0, outV: 0, fwdV: 0, tiltV: 0, rockV: 0 });
      // 三つ編みはその側の半分に付けて一緒に傾ける
      const braid = y.outfit.accessories.find((a): a is Braid => a instanceof Braid);
      if (braid?.grip.ready) {
        const gx = (braid.grip.pos.x - ox) * cs - (braid.grip.pos.z - oz) * sn;
        if (gx * side > 0) inner.attach(braid.object);
      }
    }
    y.hideBody();
    if (hair) hair.object.visible = false;
    showFace(y, FACE_SPLIT);
    this.go('crack');
  }

  /** 半分 h を角度 a（z 軸まわり）だけ傾けたときの、一番低い所の高さ（支点の高さが 0） */
  private minY(h: Half, a: number): number {
    const c = Math.cos(a), s = Math.sin(a);
    let m = Infinity;
    const p = h.samples;
    for (let i = 0; i < p.length; i += 2) m = Math.min(m, p[i] * s + p[i + 1] * c);
    return m;
  }

  private go(phase: Phase): void {
    this.phase = phase;
    this.t = 0;
  }
}
