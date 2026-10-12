import * as THREE from 'three';

/** 装飾の形を作る道具 */

/** 部品と、その輪郭線（同じ形を背面法で描く）を1組にする */
export function withOutline(geometry: THREE.BufferGeometry, material: THREE.Material, outline: THREE.Material | null): THREE.Group {
  const g = new THREE.Group();
  if (outline) g.add(new THREE.Mesh(geometry, outline));
  g.add(new THREE.Mesh(geometry, material));
  return g;
}

/**
 * 曲線に沿った管。radius(t) で太さを変えられる（先がとがった帽子の円錐など）。
 * 断面の向きは平行移動で引き継ぐので、曲がってもねじれない
 */
export function tubeAlong(
  curve: (t: number) => THREE.Vector3,
  radius: (t: number, angle: number) => number,
  segments = 48,
  radial = 48,
): THREE.BufferGeometry {
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i <= segments; i++) pts.push(curve(i / segments));
  const tangents = pts.map((_, i) => {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(segments, i + 1)];
    return b.clone().sub(a).normalize();
  });
  // 平行移動の枠
  let normal = new THREE.Vector3(0, 0, 1);
  if (Math.abs(tangents[0].dot(normal)) > 0.9) normal.set(1, 0, 0);
  normal = normal.sub(tangents[0].clone().multiplyScalar(normal.dot(tangents[0]))).normalize();
  const pos: number[] = [];
  for (let i = 0; i <= segments; i++) {
    const t = tangents[i];
    if (i > 0) {
      normal = normal.sub(t.clone().multiplyScalar(normal.dot(t))).normalize();
    }
    const bin = new THREE.Vector3().crossVectors(t, normal);
    for (let j = 0; j <= radial; j++) {
      const a = (j / radial) * Math.PI * 2;
      const r = radius(i / segments, a);
      const p = pts[i].clone()
        .addScaledVector(normal, Math.cos(a) * r)
        .addScaledVector(bin, Math.sin(a) * r);
      pos.push(p.x, p.y, p.z);
    }
  }
  const index: number[] = [];
  for (let i = 0; i < segments; i++) {
    for (let j = 0; j < radial; j++) {
      const a = i * (radial + 1) + j, b = a + radial + 1;
      index.push(a, a + 1, b, b, a + 1, b + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(index);
  g.computeVertexNormals();
  return g;
}

/** 断面（x：中心からの距離、y：高さ）を縦軸のまわりに回した形。closed なら断面を閉じる */
export function lathe(profile: [number, number][], segments = 96, closed = false): THREE.BufferGeometry {
  const pts = profile.map(([x, y]) => new THREE.Vector2(x, y));
  if (closed) pts.push(pts[0].clone());
  const g = new THREE.LatheGeometry(pts, segments);
  g.computeVertexNormals();
  return g;
}

/** 楕円体（大きさは半径） */
export function ellipsoid(rx: number, ry: number, rz: number, detail = 20): THREE.BufferGeometry {
  const g = new THREE.SphereGeometry(1, detail * 2, detail);
  g.scale(rx, ry, rz);
  return g;
}

/** リボンの布幅の半分（size に対する比）。羽の外端で布が広がりきった幅で、垂れの幅もこれに等しい */
const BOW_RIBBON_HALF = 0.47;
/** 結び目で絞られた所の布幅の半分（同上） */
const BOW_PINCH_HALF = 0.13;

export interface BowOptions {
  /** 垂れの長さ（size に対する比）。0 なら垂れなし */
  tail?: number;
  /** 付ける面の丸み（半径）。羽の先を面に沿って奥へ曲げる。なしなら平ら */
  wrap?: number;
  /** 羽の先の上がり具合（ラジアン） */
  lift?: number;
}

/**
 * リボン（蝶結び）。正面が +z（付ける面から外向き）、上が +y。大きさ size は結び目から羽の先までの長さ。
 *   羽 … 前と後ろの2枚が重なった平たい輪。帯の幅は上下（正面から幅の広い面が見える）で、外ほど広がる
 *   垂れ … 結び目から斜め下へ。帯の幅は正面を向く
 */
export function bowGeometries(size: number, opts: BowOptions = {}): THREE.BufferGeometry[] {
  const tailLen = opts.tail ?? 0.9;
  const lift = opts.lift ?? 0.12;
  const thick = size * 0.035; // 帯の厚みの半分
  const depth = size * 0.1;   // 羽の前後2枚の間の半分
  // 付ける面の丸みに沿って、中心から離れるほど奥へ下げる
  const sink = (x: number) => (opts.wrap ? (x * x) / (2 * opts.wrap) : 0);
  // 断面：tubeAlong の枠の bin 方向に広い楕円（平たい帯）
  const flat = (w: number) => (a: number) => {
    const c = Math.cos(a), sn = Math.sin(a);
    return 1 / Math.sqrt((c / thick) ** 2 + (sn / w) ** 2);
  };
  const out: THREE.BufferGeometry[] = [];
  for (const s of [1, -1]) {
    // 羽：xz 面の平たい輪（前の層 z>0、後ろの層 z<0）。枠の bin が y になるので、帯の幅は上下
    const wing = tubeAlong((t) => {
      const phi = t * Math.PI * 2;
      const u = (1 - Math.cos(phi)) / 2; // 0：結び目、1：羽の先
      const x = size * u;
      const p = new THREE.Vector3(x, 0, depth * Math.sin(phi) * (0.4 + 0.6 * u) - sink(x));
      return p.applyAxisAngle(new THREE.Vector3(0, 0, 1), lift).multiply(new THREE.Vector3(s, 1, 1));
    }, (t, a) => {
      const u = (1 - Math.cos(t * Math.PI * 2)) / 2;
      // 結び目で絞られ、外ほど広がる（羽の先の高さは長さの 8 割ほど）
      return flat(size * (BOW_PINCH_HALF + (BOW_RIBBON_HALF - BOW_PINCH_HALF) * Math.pow(u, 0.8)))(a);
    }, 64, 16);
    out.push(wing);
    // 垂れ：結び目から斜め下へ、少し外へ開く。xy 面の曲線なので枠の bin が xy 面内（帯の幅は正面向き）
    if (tailLen <= 0) continue;
    const L = size * tailLen;
    const tail = tubeAlong((t) => {
      const x = s * (size * 0.06 + L * 0.42 * t);
      return new THREE.Vector3(x, -size * 0.08 - L * t + L * 0.08 * Math.sin(t * Math.PI), -size * 0.04 - sink(x));
    }, (t, a) => flat(size * (0.13 + 0.05 * t))(a), 20, 16);
    out.push(tail);
  }
  // 結び目：帯を巻いた小さなふくらみ
  const knot = ellipsoid(0.15 * size, 0.21 * size, 0.07 * size, 12);
  knot.translate(0, 0, depth * 0.6);
  out.push(knot);
  return out;
}
