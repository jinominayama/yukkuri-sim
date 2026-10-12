import * as THREE from 'three';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * 体の静止形状（力がかかっていないときの形）。
 *
 * 3つの部位をなめらかにつないで作る：
 *   胴（球。前後に伸ばすとソーセージ形）＋ 頭（上・前後に移動可）＋ 後部の膨らみ（餡の偏り）
 * そのうえで全体を幅・高さ・奥行きの倍率で伸縮し、下半分を縦に縮めて低い丸みにする。
 * 前方はローカル +Z。自重による潰れは、ソフトボディの物理計算で別途生じる。
 */
export interface BodyShapeParams {
  /** 胴の太さ（半径, m） */
  radius: number;
  /** 胴の長さ（前後に伸ばす量、胴の半径に対する比。0 で球、>0 で両端の丸いソーセージ形） */
  bodyLength: number;
  /** 頭の球の大きさ（胴に対する比） */
  headSize: number;
  /** 頭の高さ（胴の中心から頭の中心まで、胴の半径に対する比） */
  headHeight: number;
  /** 頭の前後位置（+ で前、胴の半径に対する比） */
  headForward: number;
  /** 後部の膨らみの大きさ（胴に対する比、0 で無し） */
  rearSize: number;
  /** 後部の膨らみの後ろへの位置（胴の半径に対する比） */
  rearBack: number;
  /** 後部の膨らみの高さ（胴の中心から、胴の半径に対する比。- で下） */
  rearHeight: number;
  /** 各部のつながりのなめらかさ（大きいほどくびれがなく、なだらか） */
  blend: number;
  /** 全体の左右の倍率 */
  width: number;
  /** 全体の高さの倍率 */
  heightScale: number;
  /** 全体の前後の倍率 */
  length: number;
  /**
   * 下半分のつぶれ（0〜0.6）。体の下半分を縦に縮めて、底を丸みのある低い形にする。
   * 平面で切らないので底は丸いまま。接地面の広がりは自重の潰れで生まれる
   */
  bottomFlat: number;
  /** 傾き（上ほどずれる、生まれつきのクセ） */
  lean: number;
  /** 傾く方向（度、Y軸まわり） */
  leanAngle: number;
  /** 顔の大きさ（1 = 頭の大きさに合わせた標準） */
  faceSize: number;
  /** 顔の高さのずれ（頭の半径に対する比。+ で上） */
  faceHeight: number;
}

/** ユーザー設定の出荷時の値（プリセット「ユーザー設定」の初期値） */
export const DEFAULT_SHAPE: BodyShapeParams = {
  radius: 0.55,
  bodyLength: 0,
  headSize: 0.65,
  headHeight: 0.95,
  headForward: 0,
  rearSize: 0.85,
  rearBack: 0.35,
  rearHeight: -0.1,
  blend: 0.3,
  width: 1,
  heightScale: 1,
  length: 1,
  bottomFlat: 0.1,
  lean: 0,
  leanAngle: 0,
  faceSize: 1.12,
  faceHeight: -0.28,
};

/** なめらかな和集合（多項式 smooth min） */
function smin(a: number, b: number, k: number): number {
  const h = clamp01(0.5 + (0.5 * (b - a)) / k);
  return b + (a - b) * h - k * h * (1 - h);
}

/** 伸縮前の座標での符号付き距離関数（内側が負） */
function bodySdf(x: number, y: number, z: number, p: BodyShapeParams): number {
  const rb = p.radius;
  // 下半分を縦に縮める（底を平らに切らず、丸みを残したまま低くする）
  if (y < 0) y /= 1 - Math.min(p.bottomFlat, 0.6);
  const k = rb * p.blend;
  // 胴：前後方向の線分から一定距離の形（bodyLength = 0 なら球）
  const a = rb * p.bodyLength;
  const zc = Math.max(-a, Math.min(a, z));
  let d = Math.hypot(x, y, z - zc) - rb;
  d = smin(d, Math.hypot(x, y - rb * p.headHeight, z - rb * p.headForward) - rb * p.headSize, k);
  if (p.rearSize > 0) {
    d = smin(d, Math.hypot(x, y - rb * p.rearHeight, z + rb * p.rearBack) - rb * p.rearSize, k);
  }
  return d;
}

/** 伸縮後の座標での陰関数（内側が負。符号と勾配の向きだけを使う） */
function shapeField(x: number, y: number, z: number, p: BodyShapeParams): number {
  return bodySdf(x / p.width, y / p.heightScale, z / p.length, p);
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** 頭の中心（伸縮後の座標）。顔の位置の基準に使う */
export function headCenter(p: BodyShapeParams, out: THREE.Vector3): THREE.Vector3 {
  const rb = p.radius;
  return out.set(0, rb * p.headHeight * p.heightScale, rb * p.headForward * p.length);
}

/** 顔を貼る基準点：頭の中心に、体のクセ（傾き）によるずれを加えたもの */
export function faceOrigin(p: BodyShapeParams, out: THREE.Vector3): THREE.Vector3 {
  headCenter(p, out);
  return out.add(leanOffset(out.y, p, new THREE.Vector3()));
}

/** 体の内部の点 (ox,oy,oz) から方向 (ux,uy,uz) へ進んで表面を探し、その距離を返す */
function rayToSurface(ox: number, oy: number, oz: number, ux: number, uy: number, uz: number, p: BodyShapeParams): number {
  let lo = 0;
  let hi = p.radius * (6 + 2 * p.bodyLength) * Math.max(p.width, p.heightScale, p.length);
  for (let i = 0; i < 40; i++) {
    const t = (lo + hi) * 0.5;
    if (shapeField(ox + ux * t, oy + uy * t, oz + uz * t, p) < 0) lo = t;
    else hi = t;
  }
  return (lo + hi) * 0.5;
}

/** 上ほどずれるクセの量（底は動かない） */
function leanOffset(y: number, p: BodyShapeParams, out: THREE.Vector3): THREE.Vector3 {
  const rb = p.radius;
  const bottom = -rb * (1 - p.bottomFlat) * p.heightScale;
  const top = rb * (p.headHeight + p.headSize) * p.heightScale;
  const s = clamp01((y - bottom) / (top - bottom));
  const shift = p.lean * rb * s * s;
  const ang = THREE.MathUtils.degToRad(p.leanAngle);
  return out.set(Math.cos(ang) * shift, 0, Math.sin(ang) * shift);
}

const _lean = new THREE.Vector3();

/** 単位方向ベクトル → 静止形状上の点（体の内部の点から放射状に表面を探す） */
export function restPoint(ux: number, uy: number, uz: number, p: BodyShapeParams, out: THREE.Vector3): THREE.Vector3 {
  const rb = p.radius;
  // 各部の中心の間にある点を基準にする（形が放射状に一意に決まる）
  let oy = rb * p.headHeight * 0.4;
  let oz = rb * p.headForward * 0.4;
  if (p.rearSize > 0) {
    oy += rb * p.rearHeight * 0.2;
    oz -= rb * p.rearBack * 0.2;
  }
  oy *= p.heightScale;
  oz *= p.length;
  const t = rayToSurface(0, oy, oz, ux, uy, uz, p);
  const y = oy + uy * t;
  leanOffset(y, p, _lean);
  return out.set(ux * t + _lean.x, y, oz + uz * t + _lean.z);
}

/** 顔のパーツ（目など）を体の表面に置くための位置と向き（静止形状の座標） */
export interface SurfaceFrame {
  /** 表面上の位置 */
  center: THREE.Vector3;
  /** 外向きの法線 */
  normal: THREE.Vector3;
  /** 表面に沿った横方向（顔の外側へ向く） */
  side: THREE.Vector3;
  /** 表面に沿った縦方向（上向き） */
  up: THREE.Vector3;
}

/**
 * 頭の中心から、左右の角度 az・上下の角度 el の方向にある表面の点と、その点での向きを求める。
 * 目は「角度」ではなくこの点まわりの実寸で描くので、体型を伸縮しても形が歪まない
 */
export function surfaceFrame(p: BodyShapeParams, az: number, el: number): SurfaceFrame {
  const hc = headCenter(p, new THREE.Vector3());
  const dir = new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el));
  const t = rayToSurface(hc.x, hc.y, hc.z, dir.x, dir.y, dir.z, p);
  const c = hc.clone().addScaledVector(dir, t);
  // 法線：陰関数の勾配（中心差分）
  const e = p.radius * 0.01;
  const normal = new THREE.Vector3(
    shapeField(c.x + e, c.y, c.z, p) - shapeField(c.x - e, c.y, c.z, p),
    shapeField(c.x, c.y + e, c.z, p) - shapeField(c.x, c.y - e, c.z, p),
    shapeField(c.x, c.y, c.z + e, p) - shapeField(c.x, c.y, c.z - e, p),
  ).normalize();
  const side = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), normal);
  if (side.lengthSq() < 1e-8) side.set(1, 0, 0);
  side.normalize();
  if (side.x * Math.sign(az || 1) < 0) side.negate();
  const up = new THREE.Vector3().crossVectors(normal, side).normalize();
  if (up.y < 0) up.negate();
  c.add(leanOffset(c.y, p, _lean));
  return { center: c, normal, side, up };
}

/** 継ぎ目のない単位球（頂点を共有させ、輪郭線の割れと物理メッシュの穴を防ぐ） */
export function createUnitSphere(detail: number): { positions: Float32Array; index: Uint32Array; geometry: THREE.BufferGeometry } {
  let g: THREE.BufferGeometry = new THREE.IcosahedronGeometry(1, detail);
  g.deleteAttribute('normal');
  g.deleteAttribute('uv');
  g = mergeVertices(g);
  const positions = (g.getAttribute('position').array as Float32Array).slice();
  const index = new Uint32Array(g.getIndex()!.array);
  return { positions, index, geometry: g };
}

/** 単位球の各頂点を静止形状に写す */
export function mapToRest(unit: Float32Array, p: BodyShapeParams, out = new Float32Array(unit.length)): Float32Array {
  const v = new THREE.Vector3();
  for (let i = 0; i < unit.length; i += 3) {
    restPoint(unit[i], unit[i + 1], unit[i + 2], p, v);
    out[i] = v.x; out[i + 1] = v.y; out[i + 2] = v.z;
  }
  return out;
}
