import * as THREE from 'three';
import { createAccessoryMaterial } from '../render/accessoryMaterial';
import type { ToonColors } from '../render/toonMaterial';
import { readVertex } from './FaceIndex';
import { bowGeometries, ellipsoid, lathe, withOutline } from './shapes';
import type { Accessory, AttachContext, OutfitParams } from './types';

export interface BraidStyle {
  /** 横の位置（顔座標の x。+ で見る人から見て右） */
  fx: number;
  /** 編み始めの高さ（顔座標の y） */
  top: number;
  /** 毛先の位置：体の下端から上へ、体の高さに対するこの比の所で終わる */
  bottomMargin: number;
  /** 編み目の幅・1つの長さ（頭の半径に対する比） */
  width: number;
  segment: number;
  /** 体の表面から浮かせる量（頭の半径に対する比） */
  lift: number;
  /** リボンの位置（編み始めから毛先までの割合）と大きさ（頭の半径に対する比） */
  bowAt: number;
  bowSize: number;
  hair: ToonColors;
  bow: ToonColors;
}

/** 体の表面の道筋をたどる点の数 */
const PATH = 14;
/** 編み目の数の上限（体型を変えても作り直さずに済むよう、多めに作って使う分だけ表示する） */
const MAX_LOBES = 24;

/**
 * 三つ編み：体の表面に沿って垂れる編み目の列。編み目は左右に交互に傾いたふくらみで、
 * 下の方にリボン、その下に毛先の房。
 * 道筋は体の表面の点（静止形状で選んだ頂点）なので、体の変形についていく
 */
export class Braid implements Accessory {
  readonly object = new THREE.Group();
  private path: number[] = [];
  private readonly lobes: THREE.Group[] = [];
  private readonly bow = new THREE.Group();
  private readonly tuft: THREE.Group;
  private readonly materials: THREE.Material[] = [];
  private readonly geometries: THREE.BufferGeometry[] = [];
  private headR = 1;

  constructor(ctx: AttachContext, private readonly style: BraidStyle, _params: OutfitParams) {
    const hair = createAccessoryMaterial(ctx.bodyMaterial, style.hair, { rim: 0.2 });
    const bow = createAccessoryMaterial(ctx.bodyMaterial, style.bow, { doubleSide: true });
    this.materials.push(hair, bow);
    const ol = ctx.outlineMaterial;
    // 編み目：単位の大きさの楕円体（置くときに大きさを合わせる）
    // 編み目：横長の楕円体を斜めに傾けて交互に重ねる（菱形が組み合わさった見た目）
    const lobe = ellipsoid(0.5, 0.5, 0.28, 14);
    this.geometries.push(lobe);
    for (let i = 0; i < MAX_LOBES; i++) {
      const g = withOutline(lobe, hair, ol);
      this.lobes.push(g);
      this.object.add(g);
    }
    for (const g of bowGeometries(0.55, { tail: 0, lift: 0.15 })) {
      this.geometries.push(g);
      this.bow.add(withOutline(g, bow, ol));
    }
    this.object.add(this.bow);
    // 毛先の房：上がふくらみ、下へとがる（少し広がった筆の形）
    // 断面は下から上へ並べる（逆だと面が裏返り、輪郭線だけが黒く見える）
    const tuft = lathe([[0.001, -1.05], [0.2, -0.95], [0.42, -0.7], [0.5, -0.3], [0.32, 0], [0.001, 0.05]], 24);
    tuft.scale(1, 1, 0.55);
    this.geometries.push(tuft);
    this.tuft = withOutline(tuft, hair, ol);
    this.object.add(this.tuft);
  }

  rebuild(ctx: AttachContext): void {
    const ix = ctx.index;
    this.headR = ix.headR;
    const st = this.style;
    const bottom = Math.min(st.top - 0.5, ix.lowestFy(st.fx, st.bottomMargin));
    this.path = [];
    for (let i = 0; i < PATH; i++) {
      const fy = st.top + ((bottom - st.top) * i) / (PATH - 1);
      // 下へ行くほど少し外側（体の丸みに沿って広がる）
      this.path.push(ix.nearest(st.fx * (1 + 0.08 * (i / (PATH - 1))), fy));
    }
    this.update(ctx);
  }

  update(ctx: AttachContext): void {
    const st = this.style;
    const R = this.headR;
    const lift = st.lift * R;
    // 道筋：表面の点を法線方向へ浮かせたもの
    const pts: THREE.Vector3[] = [];
    const nrms: THREE.Vector3[] = [];
    const p = new THREE.Vector3(), n = new THREE.Vector3();
    for (const i of this.path) {
      readVertex(ctx.pos, ctx.nrm, i, p, n);
      pts.push(p.clone().addScaledVector(n, lift));
      nrms.push(n.clone());
    }
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + pts[i].distanceTo(pts[i - 1]));
    const total = cum[cum.length - 1];
    /** 道筋に沿った距離 d の位置・接線・法線 */
    const at = (d: number) => {
      let k = 1;
      while (k < cum.length - 1 && cum[k] < d) k++;
      const t = THREE.MathUtils.clamp((d - cum[k - 1]) / Math.max(1e-6, cum[k] - cum[k - 1]), 0, 1);
      const pos = pts[k - 1].clone().lerp(pts[k], t);
      const nrm = nrms[k - 1].clone().lerp(nrms[k], t).normalize();
      const tan = pts[k].clone().sub(pts[k - 1]).normalize();
      return { pos, nrm, tan };
    };
    /** 置く：up を接線の逆（下向きに垂れる）、前を法線にした向き */
    const place = (obj: THREE.Object3D, d: number, side: number, scale: THREE.Vector3, roll: number) => {
      const { pos, nrm, tan } = at(d);
      const down = tan;
      const lat = new THREE.Vector3().crossVectors(nrm, down).normalize();
      const front = new THREE.Vector3().crossVectors(down, lat).normalize();
      const m = new THREE.Matrix4().makeBasis(lat, down.clone().negate(), front);
      obj.position.copy(pos).addScaledVector(lat, side);
      obj.quaternion.setFromRotationMatrix(m);
      obj.rotateZ(roll);
      obj.scale.copy(scale);
    };

    const w = st.width * R;
    const seg = st.segment * R;
    const braidEnd = total * st.bowAt;
    const count = Math.min(MAX_LOBES, Math.max(2, Math.round(braidEnd / (seg * 0.5))));
    this.lobes.forEach((g, i) => {
      g.visible = i < count;
      if (!g.visible) return;
      const d = ((i + 0.5) / count) * braidEnd;
      // 下ほど少し細く。左右交互に傾ける
      const taper = 1 - 0.25 * (i / count);
      const s = i % 2 === 0 ? 1 : -1;
      place(g, d, s * w * 0.18 * taper, new THREE.Vector3(w * 0.72 * taper, seg * taper, w * taper), s * 0.75);
    });
    // リボンは三つ編みの流れる向き（数個前の編み目からの向き）に立てる。
    // 結び目のあたりは体の下へ回り込み始めるので、その場の向きだと下を向いてしまう
    const b = st.bowSize * R;
    {
      const here = at(braidEnd);
      const before = at(Math.max(0, braidEnd - seg * 2.5));
      const down = here.pos.clone().sub(before.pos).normalize();
      const lat = new THREE.Vector3().crossVectors(here.nrm, down).normalize();
      const front = new THREE.Vector3().crossVectors(down, lat).normalize();
      this.bow.position.copy(here.pos).addScaledVector(front, w * 0.25);
      this.bow.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(lat, down.negate(), front));
      this.bow.scale.setScalar(b);
    }
    // 房は結び目から下へ（長すぎると地面に届くので、編み目2つ分ほどまで）
    const tuftLen = THREE.MathUtils.clamp(total - braidEnd, seg, seg * 1.8) * 1.05;
    place(this.tuft, braidEnd + w * 0.05, 0, new THREE.Vector3(w * 0.9, tuftLen, w * 0.9), 0);
  }

  dispose(): void {
    this.materials.forEach((m) => m.dispose());
    this.geometries.forEach((g) => g.dispose());
  }
}
