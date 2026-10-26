import * as THREE from 'three';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { createAccessoryMaterial } from '../render/accessoryMaterial';
import { createAccessoryOutlineMaterial } from '../render/outlineMaterial';
import type { PartSelection } from '../face/parts';
import { loadJSON, saveJSON } from '../platform/storage';
import { bodyFacing, pick, showFace, type Word } from './fx';
import type { LooseDirt } from './dropping';
import type { Yukkuri } from './Yukkuri';

/**
 * 吐餡：中身の餡子を口から吐き出す。高い所から落ちたとき（今後、強い衝撃・ストレスでも）に起きる。
 *   1. 待つ   … 落ちた勢いが収まって、立って止まるか寝転がり終えるまで待つ。仰向けなら腹ばいへ寝返る
 *              （上を向いたまま吐くと顔に降りかかる）
 *   2. 驚く   … 青ざめて固まり、小刻みに震える
 *   3. 吐く   … 何回かに分けて「ゴポォ」とこみ上げる。こみ上げる前に少しふくらみ、こみ上げると前へのめって縮み、
 *              口からつぶつぶの餡子の塊が続けて飛び出す。塊は体の前を伝って落ち、床に山と水たまりになる
 *   4. ぐったり … 泣き顔で震えながら、しばらくその場にいる
 * 顔は「白目をむく」と「目をぎゅっとつぶって泣く」を、始めるときにランダムに選ぶ（調整パネルで固定もできる）。
 * 吐いたものは「片付ける」まで床に残る。体の大きさは今のところ変えない
 */
type Phase = 'none' | 'wait' | 'shock' | 'gag' | 'after';

/** 顔の選び方：ランダム・白目・泣く */
export type VomitFace = 'random' | 'shock' | 'cry';

export interface VomitParams {
  /** この高さ（m。重心が落ちた距離）より高い所から落ちて着地したら吐く */
  fallHeight: number;
  face: VomitFace;
}

export const DEFAULT_VOMIT: VomitParams = { fallHeight: 0.8, face: 'random' };
const STORAGE_KEY = 'vomit';

/** 落ち着くのを待つ上限・驚いている時間・ぐったりしている時間（秒） */
const WAIT_MAX = 5;
const SHOCK_TIME = 0.7;
const AFTER_TIME = 3.5;
/** こみ上げる回数（この範囲でランダム）と、1 回の流れ（秒）：ためる → 吐く → 間 */
const SURGES_MIN = 3;
const SURGES_MAX = 5;
const PREP_TIME = 0.45;
const SURGE_MIN = 0.5;
const SURGE_MAX = 0.85;
const PAUSE_TIME = 0.35;
/** ためるとき・吐くときの体の前への傾き（rad。前後に長い体型は小さめ）と縦の伸縮 */
const PREP_PITCH = -0.08;
const SURGE_PITCH = 0.32;
const SURGE_PITCH_LONG = 0.12;
const PREP_SQUASH = 1.06;
const SURGE_SQUASH = 0.9;
/** 震えの振れ幅（胴の半径に対する比）：驚く・吐く・ぐったり */
const TREMBLE_SHOCK = 0.012;
const TREMBLE_SURGE = 0.02;
const TREMBLE_AFTER = 0.007;

/** 口の位置（顔座標の高さ。口の絵の真ん中） */
const MOUTH_FY = -0.15;
/** 塊を出す数（個/秒）と、大きさ（胴の半径に対する比の範囲）、飛び出す速さ（m/s。胴の半径 0.5 のとき） */
const RATE = 26;
const LUMP_MIN = 0.06;
const LUMP_MAX = 0.13;
const SPEED_MIN = 0.7;
const SPEED_MAX = 1.2;
/** 飛び出す向き：口の向き・体の前・下 の混ぜ方 */
const DIR_MOUTH = 1;
const DIR_FRONT = 0.5;
const DIR_DOWN = 0.35;
/** 出てからこの時間（秒）は体に当たらない（口の所で体の表面に押し戻されないように） */
const FREE_TIME = 0.08;
/** 体の表面からこの比（塊の半径に対する）だけ外にいるよう押し出し、表面に沿ってすべる。すべるときの減り方（1/秒） */
const BODY_GAP = 0.6;
const BODY_FRICTION = 2;
/** 床で落ち着いた塊のつぶれ方（横・縦の倍率）と、つぶれるまでの時間（秒） */
const FLAT_W = 1.12;
const FLAT_H = 0.8;
const FLAT_TIME = 0.25;
/** 床に着いた塊の中心の高さ（塊の半径に対する比。底は地面で平らに切れる） */
const REST_Y = 0.45;
/** 積み上がる高さの上限（胴の半径に対する比）。それより上に落ちた塊は脇へずり落ちる */
const HEAP_MAX = 0.34;
/** 積もった塊の上に落ちた塊は、下の塊から外へこの比（塊の半径に対する）だけずれて落ち着く（山が裾へ広がる） */
const HEAP_SLIDE = 0.55;
/**
 * 水たまり：最初に床に着いた所に、平たく広がる餡子。床に着いた塊の数 POOL_COUNT で半径 POOL_R（胴の半径に対する比）になり、
 * その後も数の平方根に比例して広がる。高さは半径のこの比
 */
const POOL_R = 0.42;
const POOL_COUNT = 40;
const POOL_H = 0.22;
/** 速く落ちた大きめの塊は、床で小さな粒を飛び散らせる：その速さ（m/s）・粒の数・大きさの比・飛ぶ速さ */
const SPLASH_SPEED = 1.6;
const SPLASH_COUNT = 2;
const SPLASH_SIZE = 0.35;
const SPLASH_OUT = 0.6;
const SPLASH_UP = 0.9;
/** 飛んでいる塊の、速さによる伸び（m/s あたり）と上限 */
const STRETCH_PER_SPEED = 0.25;
const STRETCH_MAX = 1.6;
/** 1 回分の塊の数の上限と、置いておく回数の上限（古いものから消す） */
const MAX_LUMPS = 160;
const MAX_HEAPS = 20;
/** といれへ口で運ぶとき、1 回分を分ける数（指示）と、といれに置くとき寄せ集める倍率（水平の広がり） */
export const ANKO_PIECES = 2;
const PIECE_GATHER = 0.75;
/** 塊の形のばらつき（形の型の数と、でこぼこの大きさ） */
const SHAPES = 5;
const BUMPS = 0.18;

/** 吐いた餡子の色（うんうんより暗い、小豆色） */
const ANKO = { lit: '#62343a', shade: '#431f25', deep: '#261012', rim: '#946460' };

/** 表情 */
/** 吐く直前（驚く）：込み上げるのをこらえて歯を食いしばる */
const FACE_SHOCK_EYES: Partial<PartSelection> = { eyes: 'shock', brows: 'worried', mouth: 'grit' };
const FACE_CRY_EYES: Partial<PartSelection> = { eyes: 'squeeze', brows: 'worried', mouth: 'grit' };
const AT_LEAST_SHOCK: Partial<PartSelection> = { pale: 'lots' };
const GAG_SHOCK: Partial<PartSelection> = { eyes: 'shock', brows: 'worried', mouth: 'vomit', pale: 'lots' };
const AT_LEAST_GAG_SHOCK: Partial<PartSelection> = { tears: 'more' };
const GAG_CRY: Partial<PartSelection> = { eyes: 'squeeze', brows: 'worried', mouth: 'vomit', pale: 'some' };
const AT_LEAST_GAG_CRY: Partial<PartSelection> = { tears: 'lots', stream: 'lots' };
const FACE_AFTER: Partial<PartSelection> = { eyes: 'cry', brows: 'worried', mouth: 'sob', pale: 'some' };
const AT_LEAST_AFTER: Partial<PartSelection> = { tears: 'lots', stream: 'few' };
const SWEAT = 'forehead,templeL,templeR,cheekL,cheekR,mouthL,mouthR,bodyL,bodyC,bodyR';

/** 文字 */
const SURGE_WORDS = ['ゆげぇえええ', 'ゴポォ', 'ゆごぼっ', 'ゴボッ', 'げぼぉっ'];

interface Lump {
  p: THREE.Vector3;
  v: THREE.Vector3;
  r: number;
  /** 出てからの時間と、床で落ち着いてからの時間（-1 は飛んでいる途中） */
  age: number;
  rest: number;
  /** 形の型と向き */
  shape: number;
  rot: THREE.Quaternion;
  /** 水たまり（ほかの塊より平たくつぶす。積もる土台にはしない） */
  pool?: boolean;
}

interface Heap {
  lumps: Lump[];
  geometry: THREE.BufferGeometry;
  group: THREE.Group;
  /** 形が変わった（作り直しが要る） */
  dirty: boolean;
  /** 水たまりと、床に着いた塊の数 */
  pool: Lump | null;
  landed: number;
  /** といれの中にある（汚れとして数えない）。といれへ運んで減った数と、分け方（ANKO_PIECES 組。初めて運ぶときに決める） */
  toilet: boolean;
  cut: number;
  parts: Lump[][] | null;
  /** 分けた一組（といれへ運んで置いたもの）。もう分けない（運ぶ途中でやめて外に置いたものは、次はまるごと 1 回で運ぶ） */
  piece?: boolean;
}

/** 塊の位置の真ん中（地面の上） */
function centroid(lumps: Lump[]): THREE.Vector3 {
  const c = new THREE.Vector3();
  for (const l of lumps) c.x += l.p.x, c.z += l.p.z;
  return lumps.length ? c.divideScalar(lumps.length).setY(0) : c;
}

/** 0〜1 をなめらかに */
function smooth(t: number): number {
  t = THREE.MathUtils.clamp(t, 0, 1);
  return t * t * (3 - 2 * t);
}

function rand(a: number, b: number): number {
  return a + Math.random() * (b - a);
}

export class Vomit {
  /** 吐いたもの（体と一緒に震えないよう、シーンに直接置く） */
  readonly object = new THREE.Group();
  readonly params: VomitParams = { ...DEFAULT_VOMIT, ...loadJSON<Partial<VomitParams>>(STORAGE_KEY) };
  private readonly material: THREE.ShaderMaterial;
  private readonly outline: THREE.ShaderMaterial;
  /** 塊の形の型（でこぼこした丸）。位置と法線 */
  private readonly shapes: { pos: Float32Array; nrm: Float32Array }[] = [];
  private readonly index: Uint32Array;
  private readonly heaps: Heap[] = [];
  private current: Heap | null = null;
  private phase: Phase = 'none';
  private t = 0;
  /** こみ上げの予定（各回の吐く時間）と、今何回目か */
  private surges: number[] = [];
  private surge = 0;
  /** 塊を出す端数（個） */
  private carry = 0;
  /** 白目の顔にするか（始めるときに決める） */
  private shockFace = true;
  private yaw = 0;
  private readonly orientation = new THREE.Quaternion();
  private readonly euler = new THREE.Euler(0, 0, 0, 'YXZ');
  private word: Word | null = null;
  private turned = false;

  constructor(private readonly y: Yukkuri) {
    this.material = createAccessoryMaterial(y.bodyMaterial, ANKO, { rim: 0.3 });
    this.outline = createAccessoryOutlineMaterial(y.outlineMaterial);
    this.outline.uniforms.uWidthScale.value = 0.7;
    const base = mergeVertices(new THREE.IcosahedronGeometry(1, 2).deleteAttribute('normal').deleteAttribute('uv'));
    this.index = new Uint32Array(base.index!.array);
    const src = base.getAttribute('position').array as Float32Array;
    for (let k = 0; k < SHAPES; k++) {
      // でこぼこ：向きの違う波をいくつか重ねて、半径を少しずつ変える
      const waves = Array.from({ length: 4 }, () => ({
        d: new THREE.Vector3(rand(-1, 1), rand(-1, 1), rand(-1, 1)).normalize(),
        f: rand(2, 4.5),
        ph: rand(0, Math.PI * 2),
      }));
      const g = new THREE.BufferGeometry();
      const pos = new Float32Array(src.length);
      const v = new THREE.Vector3();
      for (let i = 0; i < src.length; i += 3) {
        v.set(src[i], src[i + 1], src[i + 2]).normalize();
        let bump = 0;
        for (const w of waves) bump += Math.sin(v.dot(w.d) * w.f + w.ph);
        v.multiplyScalar(1 + (BUMPS * bump) / waves.length);
        pos[i] = v.x; pos[i + 1] = v.y; pos[i + 2] = v.z;
      }
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setIndex(new THREE.BufferAttribute(this.index, 1));
      g.computeVertexNormals();
      this.shapes.push({ pos, nrm: g.getAttribute('normal').array as Float32Array });
      g.dispose();
    }
    base.dispose();
  }

  /** 吐いている最中か（ぐったりし終えるまで） */
  get active(): boolean {
    return this.phase !== 'none';
  }

  /** 調整値を保存する */
  save(): void {
    saveJSON(STORAGE_KEY, this.params);
  }

  /**
   * 吐く。うんうんの最中は何もしない。体操・食べている最中なら、それをやめて吐く。
   * 勢いが収まるまで待ってから吐き始める
   */
  start(): boolean {
    const y = this.y;
    if (this.active || y.dropping.active || y.rest.fainting) return false;
    y.rest.wake(true);
    if (y.exercise.active) y.exercise.cancel();
    if (y.feeding.active) y.feeding.cancel();
    y.locomotion.hold();
    this.phase = 'wait';
    this.t = 0;
    this.turned = false;
    const f = this.params.face;
    this.shockFace = f === 'random' ? Math.random() < 0.5 : f === 'shock';
    y.stress.vomited(); // 吐くとストレスが半分に減る（落ちた・ためすぎた・ボタン、どれでも）
    return true;
  }

  /** 床に着いた塊の位置（水平）を順に渡す。吐いている最中のもの・といれの中のものは数えない */
  forEachPoint(f: (x: number, z: number) => void): void {
    for (const h of this.heaps) {
      if ((h === this.current && this.active) || h.toilet) continue;
      for (const l of h.lumps) if (l.rest >= 0) f(l.p.x, l.p.z);
    }
  }

  /** といれの中にある塊の位置（水平）を順に渡す（といれへ運んだ一組を置く所を選ぶのに使う） */
  forEachToiletPoint(f: (x: number, z: number) => void): void {
    for (const h of this.heaps) if (h.toilet) for (const l of h.lumps) f(l.p.x, l.p.z);
  }

  /** 吐いたもの（床に着いた塊）のどれかが、水平に見て点 c から radius 以内にあるか。吐いている最中のものは数えない */
  near(c: THREE.Vector3, radius: number): boolean {
    for (const h of this.heaps) {
      if ((h === this.current && this.active) || h.toilet) continue;
      for (const l of h.lumps) {
        if (l.rest < 0) continue;
        if (Math.hypot(l.p.x - c.x, l.p.z - c.z) < radius + l.r) return true;
      }
    }
    return false;
  }

  /**
   * といれの外にある吐いたもの（床に落ち着いた 1 回分）。広がりの長い向きで半分ずつ（ANKO_PIECES 組）に分けて、1 組ずつ持っていける
   */
  loose(): LooseDirt[] {
    const out: LooseDirt[] = [];
    for (const h of this.heaps) {
      if (h.toilet || (h === this.current && this.active) || h.lumps.length === 0 || h.lumps.some((l) => l.rest < 0)) continue;
      out.push({
        next: () => {
          const parts = this.partsOf(h);
          return h.cut < parts.length && this.heaps.includes(h) ? centroid(parts[h.cut]) : null;
        },
        take: () => {
          const parts = this.partsOf(h);
          if (h.cut >= parts.length || !this.heaps.includes(h)) return null;
          const part = parts[h.cut];
          h.cut++;
          h.lumps.splice(0, h.lumps.length, ...h.lumps.filter((l) => !part.includes(l)));
          if (h.pool && part.includes(h.pool)) h.pool = null;
          if (h.cut >= parts.length || h.lumps.length === 0) {
            this.heaps.splice(this.heaps.indexOf(h), 1);
            this.dispose(h);
          } else h.dirty = true;
          return (x, z, yaw) => this.placePiece(part, x, z, yaw);
        },
      });
    }
    return out;
  }

  /** 1 回分の塊を半分ずつに分ける：広がりの長い向きに並べて真ん中で切る。水たまりは後の組（最後に持っていく） */
  private partsOf(h: Heap): Lump[][] {
    if (h.parts) return h.parts;
    if (h.piece) return (h.parts = [[...h.lumps]]);
    const lumps = h.lumps.filter((l) => !l.pool);
    const c = centroid(lumps);
    let xx = 0, xz = 0, zz = 0;
    for (const l of lumps) {
      const dx = l.p.x - c.x, dz = l.p.z - c.z;
      xx += dx * dx; xz += dx * dz; zz += dz * dz;
    }
    const a = 0.5 * Math.atan2(2 * xz, xx - zz);
    const ax = Math.cos(a), az = Math.sin(a);
    const sorted = [...lumps].sort((p, q) => (p.p.x - c.x) * ax + (p.p.z - c.z) * az - ((q.p.x - c.x) * ax + (q.p.z - c.z) * az));
    const parts: Lump[][] = [];
    for (let k = 0; k < ANKO_PIECES; k++) parts.push(sorted.slice(Math.floor((sorted.length * k) / ANKO_PIECES), Math.floor((sorted.length * (k + 1)) / ANKO_PIECES)));
    if (h.pool) parts[parts.length - 1].push(h.pool);
    h.parts = parts;
    return parts;
  }

  /** 分けた 1 組を（x, z）に寄せ集めて置く（向き yaw に回す。水平の広がりは PIECE_GATHER 倍）。といれの中か外かは置いた所で決まる */
  private placePiece(part: Lump[], x: number, z: number, yaw: number): void {
    const c = centroid(part.filter((l) => !l.pool).length ? part.filter((l) => !l.pool) : part);
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    const geometry = new THREE.BufferGeometry();
    const group = new THREE.Group();
    group.add(new THREE.Mesh(geometry, this.outline), new THREE.Mesh(geometry, this.material));
    group.children.forEach((m) => (m.frustumCulled = false));
    const lumps = part.map((l) => {
      const off = new THREE.Vector3(l.p.x - c.x, 0, l.p.z - c.z).multiplyScalar(PIECE_GATHER).applyQuaternion(q);
      return { ...l, p: new THREE.Vector3(x + off.x, l.p.y, z + off.z), v: new THREE.Vector3(), rest: FLAT_TIME, r: l.pool ? l.r * PIECE_GATHER : l.r, rot: l.rot.clone().premultiply(q) };
    });
    const pool = lumps.find((l) => l.pool) ?? null;
    const toilet = !!this.y.stage?.inToilet(x, z);
    const heap: Heap = { lumps, geometry, group, dirty: true, pool, landed: part.length, toilet, cut: 0, parts: null, piece: true };
    this.heaps.push(heap);
    this.object.add(group);
    while (this.heaps.length > MAX_HEAPS) this.dispose(this.heaps.shift()!);
  }

  /** 吐いたものを全部片付ける（吐いている最中ならそこでやめる） */
  clear(): void {
    if (this.active) this.finish();
    this.current = null;
    for (const h of this.heaps) this.dispose(h);
    this.heaps.length = 0;
  }

  /** 着地の知らせ：重心が fall（m）落ちて地面に着いた */
  landed(fall: number): void {
    if (fall > this.params.fallHeight) this.start();
  }

  /** 固定時間刻みで呼ぶ */
  update(dt: number): void {
    this.t += dt;
    if (this.phase !== 'none') this.act(dt);
    for (const h of this.heaps) this.simulate(h, dt);
  }

  /** 描画の直前に呼ぶ：動いた塊の形を作り直す */
  sync(): void {
    for (const h of this.heaps) if (h.dirty) this.build(h);
  }

  private act(dt: number): void {
    const y = this.y;
    const loco = y.locomotion;
    switch (this.phase) {
      case 'wait': {
        // 仰向けなら腹ばいへ寝返る（上を向いて吐くと顔に降りかかる）
        if (loco.resting && loco.lyingPose === 'supine' && !this.turned) {
          this.turned = true;
          loco.lieDown('prone');
          return;
        }
        const settled = loco.idle || (loco.resting && loco.lyingPose !== 'supine');
        if (settled || this.t > WAIT_MAX) this.begin();
        return;
      }
      case 'shock': {
        y.tremble = TREMBLE_SHOCK;
        if (this.t > SHOCK_TIME) this.startGag();
        return;
      }
      case 'gag': {
        this.gag(dt);
        return;
      }
      case 'after': {
        y.tremble = TREMBLE_AFTER * (1 - smooth(this.t / AFTER_TIME));
        if (this.t > AFTER_TIME) this.finish();
        return;
      }
    }
  }

  /** 驚く：青ざめて固まる */
  private begin(): void {
    const y = this.y;
    this.phase = 'shock';
    this.t = 0;
    this.yaw = y.body.yaw;
    showFace(y, this.shockFace ? FACE_SHOCK_EYES : FACE_CRY_EYES, AT_LEAST_SHOCK);
    this.addSweat();
    this.say(this.y.line('vomitShock'), 1.0, 0.28);
  }

  /** 吐き始める：こみ上げる回数と長さを決め、吐いたものを置く場所を用意する */
  private startGag(): void {
    const y = this.y;
    this.phase = 'gag';
    this.t = 0;
    this.surge = 0;
    this.carry = 0;
    const n = SURGES_MIN + Math.floor(Math.random() * (SURGES_MAX - SURGES_MIN + 1));
    // 1 回目が一番長い
    this.surges = Array.from({ length: n }, (_, i) => (i === 0 ? SURGE_MAX : rand(SURGE_MIN, SURGE_MAX)));
    showFace(y, this.shockFace ? GAG_SHOCK : GAG_CRY, this.shockFace ? AT_LEAST_GAG_SHOCK : AT_LEAST_GAG_CRY);
    this.addSweat();
    const geometry = new THREE.BufferGeometry();
    const group = new THREE.Group();
    group.add(new THREE.Mesh(geometry, this.outline), new THREE.Mesh(geometry, this.material));
    group.children.forEach((m) => (m.frustumCulled = false));
    const heap: Heap = { lumps: [], geometry, group, dirty: false, pool: null, landed: 0, toilet: false, cut: 0, parts: null };
    this.heaps.push(heap);
    this.object.add(group);
    while (this.heaps.length > MAX_HEAPS) this.dispose(this.heaps.shift()!);
    this.current = heap;
  }

  /** こみ上げて吐く：ためる → 吐く → 間 を回数分 */
  private gag(dt: number): void {
    const y = this.y;
    const loco = y.locomotion;
    const dur = this.surges[this.surge];
    const t = this.t;
    let pitch = 0, squash = 1;
    if (t < PREP_TIME) {
      // ためる：少しふくらんで、わずかに後ろへ
      const k = smooth(t / PREP_TIME);
      pitch = PREP_PITCH * k;
      squash = 1 + (PREP_SQUASH - 1) * k;
      y.tremble = TREMBLE_SHOCK;
    } else if (t < PREP_TIME + dur) {
      // 吐く：前へのめって縮み、口から塊を続けて出す
      const u = (t - PREP_TIME) / dur;
      const k = smooth(u / 0.25) * (1 - smooth((u - 0.8) / 0.2));
      pitch = (loco.isLongBody() ? SURGE_PITCH_LONG : SURGE_PITCH) * k;
      squash = 1 + (SURGE_SQUASH - 1) * k;
      y.tremble = TREMBLE_SURGE;
      if (t - dt < PREP_TIME) this.say(pick(SURGE_WORDS), 1.1, 0.3);
      // 吐く勢いは出だしが強く、終わりに向けて弱まる
      this.carry += RATE * dt * (1.15 - 0.5 * u);
      while (this.carry >= 1) {
        this.carry -= 1;
        this.emit(1.1 - 0.4 * u);
      }
    } else {
      y.tremble = TREMBLE_SHOCK;
      if (t > PREP_TIME + dur + PAUSE_TIME) {
        this.surge++;
        this.t = 0;
        if (this.surge >= this.surges.length) {
          this.afterGag();
          return;
        }
      }
    }
    // 身ぶりは立って止まっている間だけ効く（寝転がっていれば、震えるだけ）
    if (loco.idle) {
      this.euler.set(pitch, this.yaw, 0);
      this.orientation.setFromEuler(this.euler);
      loco.gesture = { orientation: this.orientation, squash };
    }
  }

  /** 吐き終えた：ぐったりした泣き顔 */
  private afterGag(): void {
    const y = this.y;
    this.phase = 'after';
    this.t = 0;
    y.locomotion.gesture = null;
    this.current = null;
    showFace(y, FACE_AFTER, AT_LEAST_AFTER);
    this.addSweat();
    this.say(this.y.line('vomitAfter'), AFTER_TIME * 0.8, 0.26);
  }

  private finish(): void {
    const y = this.y;
    this.phase = 'none';
    this.current = null;
    y.tremble = 0;
    y.locomotion.gesture = null;
    y.face.override = null;
    y.locomotion.release();
  }

  /** 汗を体じゅうに足す（選んでいる汗に重ねる） */
  private addSweat(): void {
    const o = this.y.face.override;
    if (o) o.sweat = SWEAT;
  }

  /** 口から塊を 1 つ出す（power：勢いの倍率） */
  private emit(power: number): void {
    const heap = this.current;
    if (!heap || heap.lumps.length >= MAX_LUMPS) return;
    const y = this.y;
    const R = y.shape.radius;
    const pos = new THREE.Vector3(), nrm = new THREE.Vector3();
    if (!y.outfit.facePoint(0, MOUTH_FY, pos, nrm)) return;
    const facing = bodyFacing(y);
    const dir = nrm.clone().normalize().multiplyScalar(DIR_MOUTH)
      .addScaledVector(facing, DIR_FRONT)
      .add(new THREE.Vector3(rand(-0.15, 0.15), -DIR_DOWN + rand(-0.1, 0.1), rand(-0.15, 0.15)))
      .normalize();
    const r = R * rand(LUMP_MIN, LUMP_MAX);
    const speed = rand(SPEED_MIN, SPEED_MAX) * power * Math.sqrt(R / 0.5);
    heap.lumps.push({
      p: pos.addScaledVector(nrm, r * 0.3),
      v: dir.multiplyScalar(speed),
      r,
      age: 0,
      rest: -1,
      shape: Math.floor(Math.random() * SHAPES),
      rot: new THREE.Quaternion().setFromEuler(new THREE.Euler(rand(0, 6.3), rand(0, 6.3), rand(0, 6.3))),
    });
    heap.dirty = true;
  }

  /** 塊を動かす：飛んでいる塊は落ち、体に当たれば表面をすべり、床（や積もった塊）に着いたら落ち着く */
  private simulate(h: Heap, dt: number): void {
    const y = this.y;
    const g = y.physics.gravity;
    const R = y.shape.radius;
    const body = y.body;
    const bp = body.pos;
    const c = body.center;
    const splashes: Lump[] = [];
    for (const l of h.lumps) {
      if (l.rest >= 0) {
        if (l.rest < FLAT_TIME) {
          l.rest += dt;
          h.dirty = true;
        }
        continue;
      }
      h.dirty = true;
      l.age += dt;
      l.v.y -= g * dt;
      l.p.addScaledVector(l.v, dt);
      // 体に当たる：一番近い頂点の、体の中心から外への向きに押し出し、表面に沿ってすべらせる
      if (l.age > FREE_TIME) {
        let best = -1, bd = Infinity;
        for (let i = 0; i < bp.length; i += 3) {
          const dx = bp[i] - l.p.x, dy = bp[i + 1] - l.p.y, dz = bp[i + 2] - l.p.z;
          const d = dx * dx + dy * dy + dz * dz;
          if (d < bd) { bd = d; best = i; }
        }
        const vx = bp[best], vy = bp[best + 1], vz = bp[best + 2];
        const o = new THREE.Vector3(vx - c.x, vy - c.y, vz - c.z).normalize();
        const d = (l.p.x - vx) * o.x + (l.p.y - vy) * o.y + (l.p.z - vz) * o.z;
        const gap = l.r * BODY_GAP;
        if (d < gap) {
          l.p.addScaledVector(o, gap - d);
          const vn = l.v.dot(o);
          if (vn < 0) l.v.addScaledVector(o, -vn);
          l.v.multiplyScalar(Math.max(0, 1 - BODY_FRICTION * dt));
        }
      }
      // 床・積もった塊に着く
      let support = 0;
      let top: Lump | null = null;
      for (const o of h.lumps) {
        // 下にある塊だけ（自分より上にある塊には乗らない）
        if (o.rest < 0 || o === l || o.pool || o.p.y > l.p.y) continue;
        const dx = o.p.x - l.p.x, dz = o.p.z - l.p.z;
        const reach = (o.r * FLAT_W + l.r) * 0.6;
        if (dx * dx + dz * dz > reach * reach) continue;
        const s = o.p.y + o.r * FLAT_H * 0.8;
        if (s > support) { support = s; top = o; }
      }
      if (l.p.y - l.r * 0.5 > support) continue;
      if (support > HEAP_MAX * R && top) {
        // 山が高すぎる：脇へずり落ちる
        const away = new THREE.Vector3(l.p.x - top.p.x, 0, l.p.z - top.p.z);
        if (away.lengthSq() < 1e-8) away.set(rand(-1, 1), 0, rand(-1, 1));
        away.normalize();
        l.p.addScaledVector(away, l.r * 0.5);
        // 山の脇に沿って下りる（山の中へ沈まない）
        l.p.y = Math.max(l.p.y, support - l.r);
        l.v.set(away.x * 0.4, 0, away.z * 0.4);
        continue;
      }
      const speed = l.v.length();
      if (speed > SPLASH_SPEED && l.r > R * LUMP_MIN && h.lumps.length + splashes.length < MAX_LUMPS) {
        for (let k = 0; k < SPLASH_COUNT; k++) {
          const a = rand(0, Math.PI * 2);
          splashes.push({
            p: l.p.clone(),
            v: new THREE.Vector3(Math.cos(a) * SPLASH_OUT, SPLASH_UP * rand(0.6, 1), Math.sin(a) * SPLASH_OUT).add(l.v.clone().setY(0).multiplyScalar(0.3)),
            r: l.r * SPLASH_SIZE,
            age: FREE_TIME,
            rest: -1,
            shape: Math.floor(Math.random() * SHAPES),
            rot: l.rot.clone(),
          });
        }
      }
      if (top) {
        // 積もった塊の上：下の塊から外へずれて、斜面を少し下りた所で落ち着く
        const away = new THREE.Vector3(l.p.x - top.p.x, 0, l.p.z - top.p.z);
        if (away.lengthSq() < 1e-8) away.set(rand(-1, 1), 0, rand(-1, 1));
        l.p.addScaledVector(away.normalize(), l.r * HEAP_SLIDE);
        support -= l.r * 0.3;
      }
      l.p.y = Math.max(support + l.r * REST_Y * 0.5, l.r * REST_Y);
      l.v.set(0, 0, 0);
      l.rest = 0;
      // 水たまり：最初に床に着いた所にでき、床に着いた数に応じて広がる
      if (l.r > R * LUMP_MIN * 0.9) h.landed++;
      if (!h.pool) {
        h.pool = { p: new THREE.Vector3(l.p.x, 0, l.p.z), v: new THREE.Vector3(), r: 0, age: 0, rest: FLAT_TIME, shape: 0, rot: new THREE.Quaternion(), pool: true };
        splashes.push(h.pool);
      }
      const n = Math.max(1, h.landed);
      h.pool.r = POOL_R * R * Math.sqrt(n / POOL_COUNT);
      // 水たまりの真ん中は塊の重なりの真ん中へ寄せていく
      h.pool.p.x += (l.p.x - h.pool.p.x) / n;
      h.pool.p.z += (l.p.z - h.pool.p.z) / n;
    }
    h.lumps.push(...splashes);
  }

  /** 塊をまとめて 1 つの形にする（飛んでいる塊は速さの向きに伸び、床の塊は平たくつぶれる） */
  private build(h: Heap): void {
    h.dirty = false;
    const nv = this.shapes[0].pos.length / 3;
    const ni = this.index.length;
    const pos = new Float32Array(h.lumps.length * nv * 3);
    const nrm = new Float32Array(h.lumps.length * nv * 3);
    const idx = new Uint32Array(h.lumps.length * ni);
    const v = new THREE.Vector3(), n = new THREE.Vector3(), d = new THREE.Vector3();
    h.lumps.forEach((l, li) => {
      const sh = this.shapes[l.shape];
      const flat = l.rest < 0 ? 0 : smooth(l.rest / FLAT_TIME);
      const a = l.pool ? 1 : 1 + (FLAT_W - 1) * flat, b = l.pool ? POOL_H : 1 + (FLAT_H - 1) * flat;
      // 飛んでいる間：速さの向き d に s 倍、それと直交する向きに k 倍（体積は保つ）
      const speed = l.rest < 0 ? l.v.length() : 0;
      const s = Math.min(STRETCH_MAX, 1 + speed * STRETCH_PER_SPEED);
      const k = 1 / Math.sqrt(s);
      if (speed > 1e-4) d.copy(l.v).divideScalar(speed);
      const o = li * nv * 3;
      for (let i = 0; i < nv * 3; i += 3) {
        v.set(sh.pos[i], sh.pos[i + 1], sh.pos[i + 2]).applyQuaternion(l.rot).multiplyScalar(l.r);
        n.set(sh.nrm[i], sh.nrm[i + 1], sh.nrm[i + 2]).applyQuaternion(l.rot);
        if (speed > 1e-4) {
          v.multiplyScalar(k).addScaledVector(d, (s - k) * v.dot(d) / k);
          n.multiplyScalar(1 / k).addScaledVector(d, (1 / s - 1 / k) * n.dot(d) * k);
        }
        v.set(v.x * a, v.y * b, v.z * a).add(l.p);
        n.set(n.x / a, n.y / b, n.z / a).normalize();
        pos[o + i] = v.x; pos[o + i + 1] = v.y; pos[o + i + 2] = v.z;
        nrm[o + i] = n.x; nrm[o + i + 1] = n.y; nrm[o + i + 2] = n.z;
      }
      const base = li * nv;
      for (let j = 0; j < ni; j++) idx[li * ni + j] = this.index[j] + base;
    });
    const g = h.geometry;
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.computeBoundingSphere();
  }

  /** 顔の上に文字を出す（前の文字は早めに消す） */
  private say(text: string, life: number, size: number): void {
    const y = this.y;
    const R = y.shape.radius;
    const facing = bodyFacing(y);
    const sideDir = new THREE.Vector3(-facing.z, 0, facing.x);
    const side = Math.random() < 0.5 ? 1 : -1;
    const pos = new THREE.Vector3(y.center.x, y.center.y + y.height * 0.5 + R * 0.2, y.center.z)
      .addScaledVector(facing, R * 0.7).addScaledVector(sideDir, side * R * 0.4);
    if (this.word) y.texts.fade(this.word);
    this.word = y.texts.say(text, pos, R * size, life, new THREE.Vector3(0, R * 0.2, 0).addScaledVector(sideDir, side * R * 0.1));
  }

  private dispose(h: Heap): void {
    this.object.remove(h.group);
    h.geometry.dispose();
  }
}
