import * as THREE from 'three';
import { createAccessoryMaterial } from '../render/accessoryMaterial';
import { createAccessoryOutlineMaterial } from '../render/outlineMaterial';
import { lathe, withOutline } from '../character/shapes';
import { loadJSON, saveJSON } from '../platform/storage';
import type { Yukkuri } from './Yukkuri';

/**
 * ぺにぺに：顔の正面の、口より下に生える円錐。体の表面の点について行き、表面の外向きに生える。
 * 色は体と同じ（体の色を変えたら合わせる）
 */

export interface PeniParams {
  /** 出しているか */
  show: boolean;
  /** 生える位置（体の正面の、口の下の高さ 0 から地面 1 までの間のどこか。立って落ち着いているときの形で測る） */
  at: number;
  /** 長さ・根元の半径（胴の半径に対する比） */
  length: number;
  radius: number;
  /** 上向きへの反り（0 で体の表面にまっすぐ、1 で真上） */
  rise: number;
  /** 先の丸み：先にはめる玉の半径（根元の半径に対する比。0 で尖り、大きいほど丸い） */
  round: number;
}

export const DEFAULT_PENI: PeniParams = { show: false, at: 0.45, length: 0.28, radius: 0.075, rise: 0.3, round: 0.45 };

/** 保存先。体型 ID → その体型の設定（初期値のままの体型は持たない） */
const STORAGE_KEY = 'peni';

/** 口の下端の位置（顔座標。単位は頭の半径） */
const MOUTH_BOTTOM_FY = -0.25;
/** 地面からこの高さ（胴の半径に対する比）より下には生やさない（地面に接して下を向いている所） */
const MIN_HEIGHT = 0.08;
/**
 * 生やす高さの範囲の、根元の半径に対する余白：位置 0 は口の下端から根元の半径のこれ倍だけ下（根元が口にかからない）、
 * 一番下は地面から根元の半径のこれ倍だけ上（立って落ち着いているとき、根元の下側が地面に着かない）
 */
const RADIUS_MARGIN = 1.2;
/**
 * 生やす所に選んでよい、法線の下向きの限度（上下の成分）。口の低い体型（いもむし型など）では口のすぐ下から
 * 体が下へ回り込むので、かなり下を向いた所まで選べるようにする
 */
const MIN_NORMAL_Y = -0.85;
/**
 * 生やす所を探すとき、高さの差（ワールド）に足す正面からの角度の差（ラジアン）の重み。
 * 頂点の段の間隔（高さで 0.01 ほど）より、少しでも横へずれた方を重く見て、正面の中心線上の頂点を選ぶ
 */
const AZ_WEIGHT = 1;
/** 生やす所を探す、正面からの左右の角度の範囲（ラジアン） */
const AZ_RANGE = 0.25;
/**
 * 体を倒している間（倒れ込み・横になっている・起き上がりの途中）に、生えている所の法線がこれより下を向いたら
 * （腹ばいで顔が地面を向いているとき）、体の下に敷かれているとみなして隠す。
 * 跳ねる・這うときのつぶれでは隠さない（低い所に生やしていると、つぶれるたびに消えたり出たりする）
 */
const HIDE_NORMAL_Y = -0.92;
/**
 * 円錐の一番低い所を、地面からこれ（胴の半径に対する比）より上に保つ。体がつぶれたときなど、
 * 下へはみ出しそうなら円錐ごと持ち上げる（体の中へずれるので、持ち上げた分の根元は体に隠れる）
 */
const GROUND_CLEAR = 0.02;
/** 向きは体の表面からこの角度（ラジアン）以上起こす（上向きを大きくしても体の丸みに潜らないように） */
const MIN_SURFACE_ANGLE = Math.PI / 6;

/**
 * 出し入れの動き：出し始めから出しきるまでの時間（秒）と、引っ込めるときの時間（秒）。
 * 出るときは先の細い所から押し出されるように伸び（EMERGE_SLIDE までの割合で、少し行き過ぎた長さ 1 + EMERGE_OVER まで）、
 * 残りの時間で揺れながら元の長さに落ち着く。引っ込むときは同じ動きを逆にたどる
 */
const EMERGE_TIME = 1.6;
const RETRACT_TIME = 0.9;
const EMERGE_SLIDE = 0.7;
const EMERGE_OVER = 0.08;
/** 出始めの太さ（設定の太さに対する比）。伸びながら設定の太さになる */
const EMERGE_THIN = 0.55;
/**
 * 引っ込みきる間際の消し方：長さ（設定の長さに対する比）がこれより短くなったら、
 *   ・輪郭線を細くしていく（線は画面上で一定の太さなので、ほんの少ししか出ていないときに線だけが残って見える）
 *   ・根元ごと体の中へ沈めていく（長さが 0 に近づくと、体に埋めた根元がつぶれて表面に貼り付いて見える）
 * 沈める深さは根元の半径の SINK_DEPTH 倍まで
 */
const OUTLINE_FADE = 0.5;
const SINK_DEPTH = 1.5;
/** 伸びている間に先を左右へくねらせる振れ幅（ラジアン）と回数 */
const WIGGLE = 0.12;
const WIGGLE_TURNS = 1.5;

/** 根元を体に埋める深さ（根元の半径に対する比） */
const BASE_SINK = 1.2;
/** 長さ・太さがこの割合より変わったら形を作り直す */
const REBUILD_EPS = 0.01;
/** 先の丸みの区切りの数 */
const TIP_STEPS = 8;

/**
 * 根元の半径 r・長さ L の円錐の、先を半径 round × r の玉で丸めた断面（下から上へ。lathe に渡す）。
 * 引き伸ばして使うと丸みが長さの向きに伸びて尖るので、実際の大きさで作る
 */
function profile(r: number, L: number, round: number): [number, number][] {
  const side = Math.hypot(r, L);
  const sinA = r / side; // 円錐の開きの半分の角の sin
  // 玉は円錐の両側に接する。円錐に収まらないほど短いときは小さくする
  const rt = Math.max(1e-4 * r, Math.min(round * r, L * sinA * 0.9));
  const yc = L - rt / sinA; // 玉の中心
  // 接する所：先から側面に沿って rt / tan(角) の所
  const d = rt * (L / r);
  const px = (r / side) * d, py = L - (L / side) * d;
  const pts: [number, number][] = [[0.001 * r, -BASE_SINK * r], [r, -BASE_SINK * r], [r, 0], [px, py]];
  const from = Math.atan2(px, py - yc);
  for (let i = 1; i < TIP_STEPS; i++) {
    const a = from * (1 - i / TIP_STEPS);
    pts.push([rt * Math.sin(a), yc + rt * Math.cos(a)]);
  }
  pts.push([0.001 * r, yc + rt]);
  return pts;
}

/** 0〜1 をなめらかに（始めと終わりの速さが 0、加速度も 0） */
function smoother(t: number): number {
  t = THREE.MathUtils.clamp(t, 0, 1);
  return t * t * t * (t * (t * 6 - 15) + 10);
}

export class Peni {
  readonly object = new THREE.Group();
  readonly params: PeniParams = { ...DEFAULT_PENI };
  /** 体型 ID → 設定（初期値から変えた体型だけ） */
  private readonly saved: Record<string, PeniParams>;
  /** 今の体型（設定をどの体型のものとして読み書きするか） */
  private presetId = '';
  private readonly mesh: THREE.Group;
  /** 今の形の大きさ（根元の半径・長さ。変わったら作り直す） */
  private builtR = 0;
  private builtL = 0;
  private builtRound = -1;
  private readonly material: THREE.ShaderMaterial;
  private readonly outline: THREE.ShaderMaterial;
  private readonly pos = new THREE.Vector3();
  private readonly nrm = new THREE.Vector3();
  private readonly dir = new THREE.Vector3();
  private static readonly UP = new THREE.Vector3(0, 1, 0);
  /** 生やしている体の頂点（-1 は未定）と、それを選んだときの設定 */
  private vertex = -1;
  private chosenFor = '';
  /** 出し入れの進み具合（0 で引っ込んでいる、1 で出しきった） */
  private progress = 0;
  private readonly axis = new THREE.Vector3();
  private readonly wiggle = new THREE.Quaternion();

  constructor(private readonly y: Yukkuri) {
    // 根元（y = 0）から先端（y = 1）へ細くなる円錐。根元は体に少し埋めて、継ぎ目を見せない。先端は少し丸める
    // 断面は下から上へ並べる（逆だと面が裏返る）
    const geometry = lathe(profile(1, 3, DEFAULT_PENI.round), 24);
    this.material = createAccessoryMaterial(y.bodyMaterial, y.colors, { rim: 0.25 });
    this.outline = createAccessoryOutlineMaterial(y.outlineMaterial);
    this.mesh = withOutline(geometry, this.material, this.outline);
    this.object.add(this.mesh);
    this.object.visible = false;
    this.saved = { ...loadJSON<Record<string, PeniParams>>(STORAGE_KEY) };
  }

  /** 体型を切り替える：設定を、その体型で保存したもの（なければ初期値）にする */
  usePreset(id: string): void {
    this.presetId = id;
    Object.assign(this.params, DEFAULT_PENI, this.saved[id]);
    // 開いたとき・体型を切り替えたときは動きを付けず、その体型の状態から始める
    this.progress = this.params.show ? 1 : 0;
  }

  /** 固定時間刻みで呼ぶ：出し入れを進める（「出す」を切り替えると、その向きへ動く） */
  step(dt: number): void {
    if (this.params.show) this.progress = Math.min(1, this.progress + dt / EMERGE_TIME);
    else this.progress = Math.max(0, this.progress - dt / RETRACT_TIME);
  }

  /** 進み具合 t のときの長さ（設定の長さに対する比） */
  private static lengthAt(t: number): number {
    if (t < EMERGE_SLIDE) return (1 + EMERGE_OVER) * smoother(t / EMERGE_SLIDE);
    // 行き過ぎた所から、揺れながら元の長さへ（つなぎ目で長さが跳ばないよう cos で始める）
    const q = (t - EMERGE_SLIDE) / (1 - EMERGE_SLIDE);
    return 1 + EMERGE_OVER * Math.cos(Math.PI * 1.5 * q) * Math.exp(-3 * q) * (1 - smoother(q));
  }

  /** 今の体型の設定を初期値に戻す */
  reset(): void {
    Object.assign(this.params, DEFAULT_PENI);
    this.save();
  }

  /** 今の設定を、別の体型（ユーザー設定など）にも写す */
  copyTo(id: string): void {
    this.store(id);
    saveJSON(STORAGE_KEY, this.saved);
  }

  /** 今の設定を、今の体型のものとして保存する */
  save(): void {
    if (!this.presetId) return;
    this.store(this.presetId);
    saveJSON(STORAGE_KEY, this.saved);
  }

  private store(id: string): void {
    const p = this.params;
    const same = (Object.keys(DEFAULT_PENI) as (keyof PeniParams)[]).every((k) => p[k] === DEFAULT_PENI[k]);
    if (same) delete this.saved[id];
    else this.saved[id] = { ...p };
  }

  /**
   * 描画の直前に呼ぶ（体の描画メッシュを更新した後）。still：立ち止まって落ち着いているか。
   * 生やす所は落ち着いているときに選び直す（跳ねてつぶれた形で選ぶと、付く所がずれる）
   */
  update(still: boolean): void {
    const p = this.params;
    const t = this.progress;
    this.object.visible = t > 0;
    if (t <= 0) return;
    const y = this.y;
    const R = y.shape.radius;
    const key = `${p.at}|${p.radius}|${y.outfit.builds}`;
    if (this.vertex < 0 || (key !== this.chosenFor && still)) {
      // 口の下端（から根元の太さの分だけ下）の今の高さと、地面（から根元の太さの分だけ上）の間を
      // at で割り振った高さにある、正面の表面の点
      const mouthRest = y.outfit.restHeightAt(0, MOUTH_BOTTOM_FY);
      if (mouthRest < 0 || !y.outfit.facePoint(0, MOUTH_BOTTOM_FY, this.pos, this.nrm)) {
        this.object.visible = false;
        return;
      }
      const margin = RADIUS_MARGIN * p.radius * R;
      const low = Math.max(MIN_HEIGHT * R, margin);
      const high = Math.max(low, this.pos.y - margin);
      const target = high + (low - high) * p.at;
      this.vertex = y.outfit.surfaceIndexAt(0, AZ_RANGE, mouthRest, target, MIN_NORMAL_Y, AZ_WEIGHT);
      // 動いている間に選んだのは仮の所。落ち着いたら選び直す
      this.chosenFor = still ? key : '';
      if (this.vertex < 0) {
        this.object.visible = false;
        return;
      }
    }
    y.outfit.vertexPoint(this.vertex, this.pos, this.nrm);
    if (y.locomotion.tilted && this.nrm.y < HIDE_NORMAL_Y) {
      this.object.visible = false;
      return;
    }
    // 向き：表面の外向き（下向きの成分は除き、地面へ向けない）を、反りの分だけ真上へ寄せる
    this.dir.copy(this.nrm);
    this.dir.y = Math.max(0, this.dir.y);
    if (this.dir.lengthSq() < 1e-6) this.dir.set(0, 0, 1);
    this.dir.normalize().lerp(Peni.UP, p.rise).normalize();
    // 体の表面から MIN_SURFACE_ANGLE 以上起こす（表面に沿う成分を縮める）
    const minUp = Math.sin(MIN_SURFACE_ANGLE);
    const up = this.dir.dot(this.nrm);
    if (up < minUp) {
      this.axis.copy(this.dir).addScaledVector(this.nrm, -up);
      if (this.axis.lengthSq() > 1e-8) this.dir.copy(this.nrm).multiplyScalar(minUp).addScaledVector(this.axis.normalize(), Math.cos(MIN_SURFACE_ANGLE));
      else this.dir.copy(this.nrm);
    }
    const length = Peni.lengthAt(t);
    const fade = smoother(length / OUTLINE_FADE);
    this.mesh.position.copy(this.pos).addScaledVector(this.dir, -(1 - fade) * SINK_DEPTH * p.radius * R);
    this.mesh.quaternion.setFromUnitVectors(Peni.UP, this.dir);
    // 伸びている間は先を左右へくねらせる（向きに垂直で、なるべく縦の軸のまわりに回す）
    const sway = WIGGLE * Math.sin(Math.PI * 2 * WIGGLE_TURNS * t) * (1 - smoother(t));
    if (sway !== 0) {
      this.axis.copy(Peni.UP).addScaledVector(this.dir, -this.dir.y);
      if (this.axis.lengthSq() < 1e-6) this.axis.set(this.nrm.x, 0, this.nrm.z);
      if (this.axis.lengthSq() > 1e-6) this.mesh.quaternion.premultiply(this.wiggle.setFromAxisAngle(this.axis.normalize(), sway));
    }
    // 先の細い所から押し出されるように：短いうちは細く、伸びながら設定の太さに
    const thick = EMERGE_THIN + (1 - EMERGE_THIN) * smoother(t / EMERGE_SLIDE);
    const radius = p.radius * R * thick;
    this.reshape(radius, p.length * R * length, p.round);
    // 円錐の一番低い所（根元の円の一番低い所か、下を向いていれば先）が地面より下なら持ち上げる
    const axisY = this.axis.set(0, 1, 0).applyQuaternion(this.mesh.quaternion).y;
    const lowest = this.mesh.position.y + Math.min(
      -radius * Math.sqrt(Math.max(0, 1 - axisY * axisY)), axisY * this.builtL);
    if (lowest < GROUND_CLEAR * R) this.mesh.position.y += GROUND_CLEAR * R - lowest;
    this.outline.uniforms.uWidthScale.value = fade;
    // 体の色を変えたら合わせる
    const u = this.material.uniforms;
    (u.uLit.value as THREE.Color).set(y.colors.lit);
    (u.uShade.value as THREE.Color).set(y.colors.shade);
    (u.uDeep.value as THREE.Color).set(y.colors.deep);
    (u.uRimColor.value as THREE.Color).set(y.colors.rim);
  }

  /** 根元の半径 r・長さ L・先の丸み round の形にする（前と少ししか変わらなければそのまま） */
  private reshape(r: number, L: number, round: number): void {
    if (round === this.builtRound && Math.abs(r - this.builtR) <= this.builtR * REBUILD_EPS &&
      Math.abs(L - this.builtL) <= Math.max(this.builtL, r) * REBUILD_EPS) return;
    this.builtR = r;
    this.builtL = L;
    this.builtRound = round;
    const geometry = lathe(profile(r, Math.max(L, 1e-4), round), 24);
    const old = (this.mesh.children[0] as THREE.Mesh).geometry;
    for (const m of this.mesh.children) (m as THREE.Mesh).geometry = geometry;
    old.dispose();
  }
}
