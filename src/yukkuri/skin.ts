import * as THREE from 'three';
import type { SoftBody } from '../physics/SoftBody';

/**
 * 細かい描画メッシュを、粗い物理メッシュに追従させる。
 *
 * 位置 = 全体の回転・移動（シェイプマッチング）× 描画側の静止形状
 *      + 物理頂点の「剛体運動からのずれ」を近傍の重み付き平均で補間したもの
 *
 * 三角形ごとの直線補間だと物理三角形の境目で法線が折れ、トゥーン塗りにまだらが出るため、
 * なめらかな重み（Wendland C2）で近くの物理頂点を混ぜる。
 */
export class Skin {
  private readonly offsets: Uint32Array; // 描画頂点 v の近傍は [offsets[v], offsets[v+1])
  private readonly nbr: Uint32Array;     // 近傍の物理頂点番号
  private readonly weight: Float32Array; // 正規化済みの重み
  private readonly restLocal: Float32Array;
  private readonly residual: Float32Array;
  private readonly rot = new THREE.Matrix4();

  constructor(
    readonly geometry: THREE.BufferGeometry,
    renderUnit: Float32Array,
    physUnit: Float32Array,
    physTris: Uint32Array,
  ) {
    this.restLocal = new Float32Array(renderUnit.length);
    this.residual = new Float32Array(physUnit.length);

    // 影響半径：物理メッシュの平均辺長（単位球上）の約2倍
    const radius = 2.1 * meanEdge(physUnit, physTris);
    const r2 = radius * radius;
    const nRender = renderUnit.length / 3;
    const nPhys = physUnit.length / 3;
    const offsets = new Uint32Array(nRender + 1);
    const nbr: number[] = [];
    const weight: number[] = [];

    for (let v = 0; v < nRender; v++) {
      const vx = renderUnit[3 * v], vy = renderUnit[3 * v + 1], vz = renderUnit[3 * v + 2];
      const start = nbr.length;
      let sum = 0;
      for (let i = 0; i < nPhys; i++) {
        const dx = physUnit[3 * i] - vx, dy = physUnit[3 * i + 1] - vy, dz = physUnit[3 * i + 2] - vz;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 >= r2) continue;
        const q = Math.sqrt(d2) / radius;
        const w = (1 - q) ** 4 * (4 * q + 1);
        nbr.push(i);
        weight.push(w);
        sum += w;
      }
      for (let k = start; k < weight.length; k++) weight[k] /= sum;
      offsets[v + 1] = nbr.length;
    }
    this.offsets = offsets;
    this.nbr = new Uint32Array(nbr);
    this.weight = new Float32Array(weight);
  }

  /** 静止形状が変わったときに呼ぶ（renderRest は描画頂点の静止位置） */
  setRest(renderRest: Float32Array, restCentroid: THREE.Vector3): void {
    const r = this.restLocal;
    for (let i = 0; i < r.length; i += 3) {
      r[i] = renderRest[i] - restCentroid.x;
      r[i + 1] = renderRest[i + 1] - restCentroid.y;
      r[i + 2] = renderRest[i + 2] - restCentroid.z;
    }
    // 顔などの模様を体に貼り付けるための静止座標
    this.geometry.setAttribute('aRest', new THREE.BufferAttribute(r.slice(), 3));
  }

  update(body: SoftBody): void {
    const e = this.rot.makeRotationFromQuaternion(body.rotation).elements; // 列優先 4x4
    const c = body.center;
    const { pos, rest, n: pn } = body;
    const res = this.residual;

    // 物理頂点ごとの「剛体運動からのずれ」
    for (let i = 0; i < pn * 3; i += 3) {
      const qx = rest[i], qy = rest[i + 1], qz = rest[i + 2];
      res[i] = pos[i] - (c.x + e[0] * qx + e[4] * qy + e[8] * qz);
      res[i + 1] = pos[i + 1] - (c.y + e[1] * qx + e[5] * qy + e[9] * qz);
      res[i + 2] = pos[i + 2] - (c.z + e[2] * qx + e[6] * qy + e[10] * qz);
    }

    const attr = this.geometry.getAttribute('position') as THREE.BufferAttribute;
    const out = attr.array as Float32Array;
    const r = this.restLocal;
    const { offsets, nbr, weight } = this;
    for (let v = 0; v < offsets.length - 1; v++) {
      let dx = 0, dy = 0, dz = 0;
      for (let k = offsets[v]; k < offsets[v + 1]; k++) {
        const j = 3 * nbr[k];
        const w = weight[k];
        dx += res[j] * w; dy += res[j + 1] * w; dz += res[j + 2] * w;
      }
      const o = 3 * v;
      const qx = r[o], qy = r[o + 1], qz = r[o + 2];
      out[o] = c.x + e[0] * qx + e[4] * qy + e[8] * qz + dx;
      out[o + 1] = Math.max(0, c.y + e[1] * qx + e[5] * qy + e[9] * qz + dy);
      out[o + 2] = c.z + e[2] * qx + e[6] * qy + e[10] * qz + dz;
    }
    attr.needsUpdate = true;
    this.geometry.computeVertexNormals();
    this.geometry.computeBoundingSphere();
  }
}

function meanEdge(p: Float32Array, tris: Uint32Array): number {
  let sum = 0;
  for (let t = 0; t < tris.length; t += 3) {
    const a = 3 * tris[t], b = 3 * tris[t + 1];
    sum += Math.hypot(p[a] - p[b], p[a + 1] - p[b + 1], p[a + 2] - p[b + 2]);
  }
  return sum / (tris.length / 3);
}
