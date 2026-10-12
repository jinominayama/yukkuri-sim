import * as THREE from 'three';

/**
 * 静止形状の描画頂点を、顔座標で引くための索引。
 * 顔座標の計算は toonMaterial.ts の顔の貼り方、hair.ts の髪の貼り方と同じ式を使う：
 *   d = 静止位置 - 顔の基準点、az = 正面からの左右の角度、el = 上下の角度
 *   fy = el * |d| / 頭の半径
 *   fx = az * (正面ほど rxz / 頭の半径、背中側ほど 1)  … 前は顔と一致し、後ろは角度のまま一周する
 */
export class FaceIndex {
  fx = new Float32Array(0);
  fy = new Float32Array(0);
  az = new Float32Array(0);
  /** 静止位置（体の重心が原点） */
  rest: Float32Array = new Float32Array(0);
  headR = 1;
  /** 静止形状の高さの範囲（重心が原点） */
  minY = 0;
  maxY = 0;

  build(rest: Float32Array, headC: THREE.Vector3, headR: number): void {
    const n = rest.length / 3;
    this.rest = rest;
    this.headR = headR;
    this.fx = new Float32Array(n);
    this.fy = new Float32Array(n);
    this.az = new Float32Array(n);
    this.minY = Infinity;
    this.maxY = -Infinity;
    for (let i = 0; i < n; i++) {
      const dx = rest[3 * i] - headC.x, dy = rest[3 * i + 1] - headC.y, dz = rest[3 * i + 2] - headC.z;
      const rxz = Math.hypot(dx, dz);
      const az = Math.atan2(dx, dz);
      const el = Math.atan2(dy, rxz);
      const s = rxz / headR;
      const t = smoothstep(0.9, 1.8, Math.abs(az));
      this.az[i] = az;
      this.fx[i] = az * (s + (1 - s) * t);
      this.fy[i] = (el * Math.hypot(dx, dy, dz)) / headR;
      this.minY = Math.min(this.minY, rest[3 * i + 1]);
      this.maxY = Math.max(this.maxY, rest[3 * i + 1]);
    }
  }

  /** 頭のてっぺんの顔座標の y */
  get topFy(): number {
    let m = -Infinity;
    for (let i = 0; i < this.fy.length; i++) m = Math.max(m, this.fy[i]);
    return m;
  }

  /** 顔座標 (fx, fy) に最も近い頂点 */
  nearest(fx: number, fy: number): number {
    let best = 0, bd = Infinity;
    for (let i = 0; i < this.fx.length; i++) {
      const d = (this.fx[i] - fx) ** 2 + (this.fy[i] - fy) ** 2;
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }

  /** 左右の角度 az（正面 0）と顔座標の高さ fy で最も近い頂点 */
  nearestAz(az: number, fy: number): number {
    let best = 0, bd = Infinity;
    for (let i = 0; i < this.az.length; i++) {
      let da = Math.abs(this.az[i] - az);
      if (da > Math.PI) da = 2 * Math.PI - da;
      const d = da * da * 4 + (this.fy[i] - fy) ** 2;
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }

  /** 横の位置 fx の縦の列で、静止形状の床から上へ margin（高さに対する比）の位置の fy */
  lowestFy(fx: number, margin: number): number {
    const floor = this.minY + (this.maxY - this.minY) * margin;
    let low = Infinity;
    for (let i = 0; i < this.fx.length; i++) {
      if (Math.abs(this.fx[i] - fx) > 0.06 || this.rest[3 * i + 1] < floor) continue;
      low = Math.min(low, this.fy[i]);
    }
    return Number.isFinite(low) ? low : -1;
  }

  restPoint(i: number, out = new THREE.Vector3()): THREE.Vector3 {
    return out.set(this.rest[3 * i], this.rest[3 * i + 1], this.rest[3 * i + 2]);
  }
}

export function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** 頂点 i の今の位置・法線（ワールド座標） */
export function readVertex(pos: Float32Array, nrm: Float32Array, i: number, p: THREE.Vector3, n?: THREE.Vector3): void {
  p.set(pos[3 * i], pos[3 * i + 1], pos[3 * i + 2]);
  n?.set(nrm[3 * i], nrm[3 * i + 1], nrm[3 * i + 2]).normalize();
}
