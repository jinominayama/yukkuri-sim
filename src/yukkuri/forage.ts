import * as THREE from 'three';
import { createAccessoryMaterial } from '../render/accessoryMaterial';
import { createAccessoryOutlineMaterial } from '../render/outlineMaterial';
import { ellipsoid, withOutline } from '../character/shapes';
import type { ToonColors } from '../render/toonMaterial';
import { bodyExtent, bodyFacing, type Word } from './fx';
import { BraidPick, braidSide, smooth } from './braidPick';
import { HatStash } from './hatStash';
import { findFood, type FoodKind } from './foods';
import type { Yukkuri } from './Yukkuri';

/**
 * 餌集め：小さな餌（木の実・草・虫）をボタンで 1 個ずつ地面に出し、「拾う」で一番近いものを三つ編みで拾って（枝と同じ動き）、
 * 帽子のつばの前へ「ぽいっ」と放ってひと固まりに積み上げる。
 *   落ちる：叩かれた・倒れた・寝転がった・帽子を隠したら、つばの上の餌は全部転がり落ちて地面に散らばる（また拾える）
 *   満杯（CAPACITY 個）なら拾わない。枝を持っている間は三つ編みがふさがっているので拾わない
 * 帽子にしまう（ボタン）：帽子を三つ編みで脱いで地面に逆さに置き（ひっくり返すときつばの餌は転がり落ちる）、
 *   落ちた餌を 1 個ずつ拾って中へ放り込み、かぶり直す（hatStash.ts）。中の餌は見えず、数（STASH_MAX 個まで）だけ覚える。
 *   つばの餌と同じきっかけで、中の餌もこぼれる
 */
type ItemState = 'ground' | 'picking' | 'lift' | 'toss' | 'hat' | 'falling' | 'tossIn' | 'inHat';

interface Item {
  kind: FoodKind;
  object: THREE.Group;
  state: ItemState;
  /** つばの上の置き場の番号（帽子に乗っている・放っている間） */
  slot: number;
  /** 地面・つばの上での向き（上向きまわりの回転） */
  yaw: number;
  t: number;
  readonly from: THREE.Vector3;
  readonly vel: THREE.Vector3;
  readonly spin: THREE.Vector3;
  /** 帽子にしまう途中（つばから落とした餌。拾って中へ入れる） */
  stash: boolean;
}

/** 餌の大きさ（胴の半径に対する比。形は単位の大きさで作る） */
const SIZE = 0.24;
/**
 * つばの前にひと固まりに積む（指示）：山の中心はつばの前（円錐の根元からつばの縁までの PILE_R の所）。
 * 置き場は [横, 前後, 高さ]（餌の大きさが単位。横は帽子の左が +、前後は外が +）。下の段から順に埋める：下 4・中 3・上 1
 */
const PILE_R = 0.5;
const PILE: [number, number, number][] = [
  [-0.45, -0.3, 0], [0.45, -0.3, 0], [-0.45, 0.42, 0], [0.45, 0.42, 0],
  [-0.25, -0.05, 0.78], [0.25, -0.05, 0.78], [0, 0.4, 0.75],
  [0, 0.12, 1.5],
];
const CAPACITY = PILE.length;
/** 帽子の中にしまえる数 */
export const STASH_MAX = 16;
/** 出す所：体の前へ（胴の半径に対する比。この間でばらつかせる）と、横へのばらつき */
const SPAWN_AHEAD = [2.2, 3.2];
const SPAWN_SIDE = 1.2;
/** 地面に出しておける数 */
const MAX_GROUND = 24;
/** 放る時間（秒）と、放物線の高さ（胴の半径に対する比） */
const TOSS_TIME = 0.45;
const TOSS_ARC = 0.9;
/** 落ちる：重力（m/s²）と、帽子から外へ・上へ飛ばす速さ（m/s） */
const GRAVITY = 10;
const SPILL_OUT = 0.9;
const SPILL_UP = 1.4;
/** 帽子にしまう：つばの餌を落とす弧（体の前から三つ編みの側への角度 rad。体の中心からの距離は胴の半径に対する比）と、落ちるまでの時間（秒） */
const DROP_FROM = -0.15;
const DROP_TO = 0.8;
const DROP_R = 1.45;
const DROP_CLEAR = 0.4;
const DROP_TIME = 0.55;
/** 体がこれ（rad）より傾いたら落とす */
const SPILL_TILT = 0.9;

const ACORN = { lit: '#b9824a', shade: '#8d5a2c', deep: '#5c3616', rim: '#f0d3b0' };
const ACORN_CAP = { lit: '#8a6a44', shade: '#634a2c', deep: '#3e2c18', rim: '#d8c3a6' };
const GRASS = { lit: '#9bd06a', shade: '#6aa043', deep: '#41712a', rim: '#eaf8d0' };
const BUG = { lit: '#5a8a5a', shade: '#2f5a3c', deep: '#173024', rim: '#c9f0d8' };
const BUG_LEG = { lit: '#3a3a30', shade: '#24241e', deep: '#121210', rim: '#88887a' };

export class Forage {
  /** 餌（体と一緒に震えないよう、シーンに直接置く） */
  readonly object = new THREE.Group();
  /** 次に出す餌の種類（'random' でランダム） */
  kindId: 'random' | 'acorn' | 'grass' | 'bug' = 'random';
  private readonly items: Item[] = [];
  private readonly picker: BraidPick;
  private readonly stash: HatStash;
  /** 帽子を外すだけ（デバッグ用）：置いたまま、もう一度押されるまで待つ */
  private hatOffOnly = false;
  private word: Word | null = null;
  private readonly mats: Record<string, THREE.Material> = {};
  private readonly outline: THREE.Material;
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly _p = new THREE.Vector3();
  private readonly _u = new THREE.Vector3();
  private readonly _s = new THREE.Vector3();
  private readonly _f = new THREE.Vector3();

  constructor(private readonly y: Yukkuri) {
    this.picker = new BraidPick(y);
    this.stash = new HatStash(y);
    const mat = (name: string, c: ToonColors, doubleSide = false) => {
      this.mats[name] = createAccessoryMaterial(y.bodyMaterial, c, { rim: 0.25, doubleSide });
    };
    mat('acorn', ACORN);
    mat('cap', ACORN_CAP);
    mat('grass', GRASS, true);
    mat('bug', BUG);
    mat('leg', BUG_LEG);
    this.outline = createAccessoryOutlineMaterial(y.outlineMaterial);
  }

  /** つばの上に乗っている数 */
  get onHat(): number {
    return this.items.filter((i) => i.state === 'hat' || i.state === 'toss').length;
  }

  /** 帽子の中にしまってある数 */
  get inHat(): number {
    return this.items.filter((i) => i.state === 'inHat' || i.state === 'tossIn').length;
  }

  /** 地面にある数 */
  get onGround(): number {
    return this.items.filter((i) => i.state === 'ground').length;
  }

  /** 拾っている途中か（三つ編みと身ぶりを使っている） */
  get busy(): boolean {
    return this.picker.active || this.stash.active;
  }

  /** 餌を 1 個出す（ゆっくりの前の地面に。種類は kindId） */
  spawn(): void {
    if (this.onGround >= MAX_GROUND) return;
    const y = this.y;
    const R = y.shape.radius;
    const ids = ['acorn', 'grass', 'bug'] as const;
    const kind = findFood(this.kindId === 'random' ? ids[Math.floor(Math.random() * ids.length)] : this.kindId);
    const f = bodyFacing(y);
    const side = new THREE.Vector3(f.z, 0, -f.x);
    const ahead = SPAWN_AHEAD[0] + Math.random() * (SPAWN_AHEAD[1] - SPAWN_AHEAD[0]);
    const p = y.center.clone().addScaledVector(f, R * ahead).addScaledVector(side, R * SPAWN_SIDE * (Math.random() * 2 - 1));
    const object = this.makeItem(kind.id);
    object.scale.setScalar(R * SIZE);
    this.object.add(object);
    const item: Item = {
      kind, object, state: 'ground', slot: -1, yaw: Math.random() * Math.PI * 2, t: 0,
      from: new THREE.Vector3(), vel: new THREE.Vector3(), spin: new THREE.Vector3(), stash: false,
    };
    this.items.push(item);
    this.placeOnGround(item, p.x, p.z);
  }

  /** 一番近い地面の餌を拾いに行く */
  pickNearest(): boolean {
    const y = this.y;
    if (this.picker.active || this.stash.active) return false;
    if (y.branch.holding || y.branch.busy) {
      this.say(y.line('forageBusy'), 0.2, 1.6);
      return false;
    }
    if (this.onHat >= CAPACITY) {
      this.say(y.line('forageFull'), 0.2, 1.6);
      return false;
    }
    if (!y.outfit.hat) return false;
    let best: Item | null = null;
    let bd = Infinity;
    for (const it of this.items) {
      if (it.state !== 'ground') continue;
      const d = it.object.position.distanceTo(y.center);
      if (d < bd) {
        bd = d;
        best = it;
      }
    }
    if (!best) return false;
    const item = best;
    const ok = this.picker.start({
      grabPoint: () => item.object.position.clone(),
      onLower: () => this.say(y.line('forageLower'), 0.18, 1.0),
      onLift: () => {
        item.state = 'lift';
      },
      onDone: () => this.toss(item),
      onCancel: () => {
        if (item.state === 'picking' || item.state === 'lift') this.dropToGround(item);
      },
    });
    if (!ok) return false;
    item.state = 'picking';
    this.say(y.line('forageGo'), 0.2, 1.4);
    return true;
  }

  /**
   * つばの上の餌と帽子の中の餌を全部落とす（地面に散らばる）。帽子にしまう途中なら、やめて帽子を頭へ戻す
   * （地面に置いた帽子の中身はそのまま）
   */
  spill(say = true): void {
    if (this.stash.active) {
      this.stash.cancel();
      return;
    }
    let n = 0;
    const y = this.y;
    const hat = y.outfit.hat;
    const up = hat ? hat.upVector(this._u).clone() : new THREE.Vector3(0, 1, 0);
    // 中の餌は帽子の口（つばの根元）のあたりから出す
    const mouth = hat ? new THREE.Vector3().setFromMatrixPosition(hat.object.matrix)
      : new THREE.Vector3(y.center.x, y.center.y + y.height * 0.4, y.center.z);
    for (const it of this.items) {
      if (it.state === 'inHat') {
        it.object.visible = true;
        it.object.position.copy(mouth)
          .add(new THREE.Vector3(Math.random() - 0.5, 0, Math.random() - 0.5).multiplyScalar(y.shape.radius * 0.6));
      } else if (it.state !== 'hat' && it.state !== 'toss') continue;
      n++;
      // 帽子の中心から外へ・上へ飛ばす
      const out = it.object.position.clone().sub(y.center).setY(0);
      if (out.lengthSq() < 1e-6) out.set(Math.random() - 0.5, 0, Math.random() - 0.5);
      out.normalize();
      it.state = 'falling';
      it.slot = -1;
      it.vel.copy(out).multiplyScalar(SPILL_OUT * (0.6 + Math.random() * 0.8)).addScaledVector(up, SPILL_UP * (0.5 + Math.random() * 0.6));
      it.spin.set(Math.random() * 10 - 5, Math.random() * 10 - 5, Math.random() * 10 - 5);
    }
    if (n > 0 && say) this.say(y.line('forageSpill'), 0.22, 1.8);
  }

  /** 片付ける（拾う途中ならやめる） */
  clear(): void {
    this.picker.cancel();
    this.stash.cancel();
    for (const it of this.items) this.object.remove(it.object);
    this.items.length = 0;
  }

  /** 固定時間刻みで呼ぶ */
  update(dt: number): void {
    const y = this.y;
    this.stash.update(dt);
    this.picker.update(dt);
    if (this.stash.down && !this.picker.active && !this.hatOffOnly) this.fillNext();
    // 倒れた・寝転がった・大きく傾いた・帽子を隠したら、つばの上と帽子の中の餌は落ちる（しまう途中は傾けるので見ない）
    if ((this.onHat > 0 || this.inHat > 0) && !this.stash.active) {
      const tilt = new THREE.Vector3(0, 1, 0).applyQuaternion(y.body.rotation).angleTo(new THREE.Vector3(0, 1, 0));
      if (!y.outfit.hat || y.locomotion.isLying || y.locomotion.tilted || tilt > SPILL_TILT) this.spill();
    }
    for (const it of this.items) {
      it.t += dt;
      if (it.state === 'toss' && it.t >= TOSS_TIME) {
        it.state = 'hat';
        this.say(y.line('forageOnHat'), 0.2, 1.4);
      }
      if (it.state === 'tossIn' && it.t >= TOSS_TIME) {
        it.state = 'inHat';
        it.object.visible = false;
      }
      if (it.state === 'falling') {
        it.vel.y -= GRAVITY * dt;
        it.object.position.addScaledVector(it.vel, dt);
        it.object.rotation.x += it.spin.x * dt;
        it.object.rotation.y += it.spin.y * dt;
        it.object.rotation.z += it.spin.z * dt;
        if (it.object.position.y <= this.groundY(it) && it.vel.y < 0) this.placeOnGround(it, it.object.position.x, it.object.position.z);
      }
    }
  }

  /** 描画の直前に呼ぶ（帽子と三つ編みの位置が決まった後）：拾っている餌は毛先に、つばの上の餌は置き場に付ける */
  sync(): void {
    const y = this.y;
    const hat = y.outfit.hat;
    for (const it of this.items) {
      if (it.state === 'tossIn') {
        // 放物線：毛先から地面に置いた帽子の口へ
        const to = this.stash.mouth(this._p);
        const k = smooth(it.t / TOSS_TIME);
        const p = it.from.clone().lerp(to, k);
        p.y += Math.sin(Math.PI * Math.min(1, it.t / TOSS_TIME)) * y.shape.radius * TOSS_ARC;
        it.object.position.copy(p);
      } else if (it.state === 'lift') {
        const g = y.outfit.braid?.grip;
        if (g?.ready) it.object.position.copy(g.pos).addScaledVector(g.down, y.shape.radius * SIZE * 0.4);
      } else if ((it.state === 'hat' || it.state === 'toss') && hat) {
        hat.brimSpot(0, PILE_R, this._p, this._u);
        hat.axes(this._s, this._u, this._f);
        const s = y.shape.radius * SIZE;
        const [dx, dz, dh] = PILE[it.slot % PILE.length];
        const to = this._p.clone().addScaledVector(this._s, dx * s).addScaledVector(this._f, dz * s)
          .addScaledVector(this._u, (this.restLift(it.kind.id) + dh) * s);
        const q = this.uprightQuat(it, this._u);
        if (it.state === 'toss') {
          // 放物線：毛先から置き場へ、上へふくらませて
          const k = smooth(it.t / TOSS_TIME);
          const p = it.from.clone().lerp(to, k);
          p.y += Math.sin(Math.PI * Math.min(1, it.t / TOSS_TIME)) * y.shape.radius * TOSS_ARC;
          it.object.position.copy(p);
          it.object.quaternion.slerp(q, Math.min(1, k * 1.5));
        } else {
          it.object.position.copy(to);
          it.object.quaternion.copy(q);
        }
      }
    }
  }

  /**
   * デバッグ用：帽子を脱いで地面に逆さに置くだけ（餌は入れない。つばの餌は転がり落ちて普通の地面の餌になる）。
   * 置いてあるときに呼ぶと、かぶり直す
   */
  toggleHatOff(): boolean {
    if (this.hatOffOnly && this.stash.down) {
      this.stash.putBack();
      return true;
    }
    const y = this.y;
    if (this.picker.active || this.stash.active || y.branch.holding || y.branch.busy) return false;
    const ok = this.stash.start({
      onTip: () => {
        this.dropPile();
        for (const it of this.items) it.stash = false;
      },
      onDone: () => {
        this.hatOffOnly = false;
      },
      onCancel: () => {
        this.hatOffOnly = false;
      },
    });
    this.hatOffOnly = ok;
    return ok;
  }

  /** 帽子にしまう：帽子を脱いで地面に逆さに置き、つばの餌を中へ入れて、かぶり直す */
  stashHat(): boolean {
    const y = this.y;
    if (this.picker.active || this.stash.active || !y.outfit.hat) return false;
    if (y.branch.holding || y.branch.busy) {
      this.say(y.line('forageBusy'), 0.2, 1.6);
      return false;
    }
    if (this.onHat === 0) {
      this.say(y.line('stashNone'), 0.2, 1.6);
      return false;
    }
    if (this.inHat >= STASH_MAX) {
      this.say(y.line('stashFull'), 0.2, 1.6);
      return false;
    }
    const ok = this.stash.start({
      onTip: () => this.dropPile(),
      onDone: () => this.say(y.line('stashDone'), 0.2, 1.8),
      onCancel: () => {
        this.picker.cancel();
        for (const it of this.items) it.stash = false;
      },
    });
    if (ok) this.say(y.line('stashStart'), 0.2, 1.4);
    return ok;
  }

  /**
   * 帽子をひっくり返し始めた：つばの餌を前の地面へ転がり落とす（あとでその場で拾って中へ入れる）。
   * 落ちる所は体の前から三つ編みの側（帽子を置く側）へ寄せた弧の上に並べる（歩かずに届き、置いた帽子にかからない所）
   */
  private dropPile(): void {
    const y = this.y;
    const R = y.shape.radius;
    const f = bodyFacing(y);
    const right = new THREE.Vector3(f.z, 0, -f.x);
    const side = right.multiplyScalar(braidSide(y).dot(right) >= 0 ? 1 : -1);
    const pile = this.items.filter((it) => it.state === 'hat' || it.state === 'toss');
    pile.forEach((it, i) => {
      it.state = 'falling';
      it.slot = -1;
      it.stash = true;
      const a = DROP_FROM + (DROP_TO - DROP_FROM) * (pile.length > 1 ? i / (pile.length - 1) : 0.5);
      const dir = f.clone().multiplyScalar(Math.cos(a)).addScaledVector(side, Math.sin(a));
      // 横に広い体型では体の表面から DROP_CLEAR だけ外（体の下に入ると拾えない）
      const r = Math.max(R * DROP_R, bodyExtent(y, dir) + R * DROP_CLEAR) + R * (Math.random() - 0.5) * 0.15;
      const to = y.center.clone().addScaledVector(dir, r);
      // その所へ DROP_TIME 秒で落ちる速さ
      const p = it.object.position;
      it.vel.set((to.x - p.x) / DROP_TIME, 0, (to.z - p.z) / DROP_TIME);
      it.vel.y = (this.groundY(it) - p.y + 0.5 * GRAVITY * DROP_TIME * DROP_TIME) / DROP_TIME;
      it.spin.set(Math.random() * 8 - 4, Math.random() * 8 - 4, Math.random() * 8 - 4);
    });
  }

  /** 地面に置いた帽子へ、落とした餌を 1 個ずつ入れる（なくなるか、いっぱいになったら、かぶり直しに行く） */
  private fillNext(): void {
    const y = this.y;
    if (this.items.some((i) => i.stash && i.state === 'falling')) return; // 落ちきるまで待つ
    if (this.items.some((i) => i.state === 'tossIn')) return; // 入れ終わるまで待つ
    const rest = this.items.filter((i) => i.stash && i.state === 'ground');
    if (rest.length === 0 || this.inHat >= STASH_MAX) {
      if (rest.length > 0) this.say(y.line('stashFull'), 0.2, 1.6);
      for (const it of this.items) it.stash = false;
      this.stash.putBack();
      return;
    }
    let best = rest[0];
    for (const it of rest) if (it.object.position.distanceTo(y.center) < best.object.position.distanceTo(y.center)) best = it;
    const item = best;
    const ok = this.picker.start({
      grabPoint: () => item.object.position.clone(),
      onLift: () => {
        item.state = 'lift';
      },
      onDone: () => {
        item.state = 'tossIn';
        item.stash = false;
        item.t = 0;
        item.from.copy(item.object.position);
        this.say(y.line('stashIn'), 0.18, 1.0);
      },
      onCancel: () => {
        if (item.state === 'picking' || item.state === 'lift') this.dropToGround(item);
        this.stash.cancel();
      },
    }, true);
    if (ok) item.state = 'picking';
    else this.stash.cancel();
  }

  /** 毛先から帽子のつばの空いている置き場へ放る */
  private toss(item: Item): void {
    const used = new Set(this.items.filter((i) => i !== item && (i.state === 'hat' || i.state === 'toss')).map((i) => i.slot));
    let slot = 0;
    while (used.has(slot) && slot < CAPACITY) slot++;
    item.slot = slot;
    item.state = 'toss';
    item.t = 0;
    item.from.copy(item.object.position);
  }

  /** 拾うのをやめた餌を、その場の地面に戻す */
  private dropToGround(item: Item): void {
    if (item.state === 'lift') {
      item.state = 'falling';
      item.vel.set(0, 0, 0);
      item.spin.set(0, 0, 0);
    } else item.state = 'ground';
  }

  private placeOnGround(it: Item, x: number, z: number): void {
    it.state = 'ground';
    it.vel.set(0, 0, 0);
    it.object.quaternion.copy(this.groundQuat(it));
    it.object.position.set(x, this.groundY(it), z);
  }

  /** 地面に置いたときの向き：木の実は横倒し、草は寝かせる、虫は立つ（どれも上向きまわりに yaw） */
  private groundQuat(it: Item): THREE.Quaternion {
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), it.yaw);
    if (it.kind.id === 'acorn') q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2));
    return q;
  }

  /** つばの上での向き：帽子の上向きに立てて（木の実は立てる）、yaw だけ回す */
  private uprightQuat(it: Item, up: THREE.Vector3): THREE.Quaternion {
    const align = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), up);
    return align.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), it.yaw));
  }

  /** 地面に置いたときの中心の高さ */
  private groundY(it: Item): number {
    const s = this.y.shape.radius * SIZE;
    return (it.kind.id === 'acorn' ? 0.42 : this.restLift(it.kind.id)) * s;
  }

  /** 立てて置いたとき、中心から底までの高さ（単位の大きさ） */
  private restLift(id: string): number {
    return id === 'acorn' ? 0.05 : id === 'grass' ? 0.05 : 0.2;
  }

  /** 餌の形（単位の大きさ。中心が原点、上が +y、前が +z） */
  private makeItem(id: string): THREE.Group {
    const g = new THREE.Group();
    const add = (geo: THREE.BufferGeometry, m: string) => {
      this.geometries.push(geo);
      g.add(withOutline(geo, this.mats[m], this.outline));
    };
    if (id === 'acorn') {
      // どんぐり：下が丸くとがった実と、上にかぶさる帽子・軸
      const body = ellipsoid(0.42, 0.5, 0.42, 16);
      body.translate(0, 0.05, 0);
      add(body, 'acorn');
      const cap = new THREE.SphereGeometry(0.46, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2);
      cap.scale(1, 0.55, 1);
      cap.translate(0, 0.32, 0);
      add(cap, 'cap');
      const stem = new THREE.CylinderGeometry(0.05, 0.07, 0.18, 6);
      stem.translate(0, 0.62, 0);
      add(stem, 'cap');
    } else if (id === 'grass') {
      // 草：細長い葉 3 枚を扇に広げて寝かせた束
      for (const a of [-0.45, 0, 0.45]) {
        const blade = ellipsoid(0.12, 0.03, 0.75, 10);
        blade.translate(0, 0, 0.55);
        blade.rotateY(a);
        blade.rotateX(-0.08);
        add(blade, 'grass');
      }
    } else {
      // 虫：つやのある甲羅の胴、小さな頭、細い脚 6 本
      const body = ellipsoid(0.36, 0.24, 0.5, 14);
      body.translate(0, 0.2, -0.05);
      add(body, 'bug');
      const head = ellipsoid(0.2, 0.16, 0.18, 10);
      head.translate(0, 0.16, 0.5);
      add(head, 'leg');
      for (const side of [-1, 1]) {
        for (const z of [-0.25, 0.05, 0.3]) {
          const leg = new THREE.CylinderGeometry(0.025, 0.025, 0.4, 5);
          leg.rotateZ(side * 1.1);
          leg.translate(side * 0.42, 0.06, z);
          add(leg, 'leg');
        }
      }
    }
    return g;
  }

  private say(text: string, size: number, life: number): void {
    const y = this.y;
    const R = y.shape.radius;
    const pos = new THREE.Vector3(y.center.x, y.center.y + y.height * 0.5 + R * 0.45, y.center.z);
    if (this.word) y.texts.fade(this.word);
    this.word = y.texts.say(text, pos, R * size, life, new THREE.Vector3(0, R * 0.15, 0));
  }
}
