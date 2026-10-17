import * as THREE from 'three';
import { createAccessoryMaterial } from '../render/accessoryMaterial';
import { createAccessoryOutlineMaterial } from '../render/outlineMaterial';
import { lathe, withOutline } from '../character/shapes';
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
}

export const DEFAULT_PENI: PeniParams = { show: false, at: 0.45, length: 0.28, radius: 0.075, rise: 0.3 };

/** 口の下端の位置（顔座標。単位は頭の半径） */
const MOUTH_BOTTOM_FY = -0.25;
/** 地面からこの高さ（胴の半径に対する比）より下には生やさない（地面に接して下を向いている所） */
const MIN_HEIGHT = 0.08;
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
 * 体の下に敷かれているとみなして隠す：根元が地面からこれ（胴の半径に対する比）より低いとき、
 * または生えている所の法線がこれより下を向いているとき（腹ばいで顔が地面を向いているとき）
 */
const GROUND_CLEAR = 0.02;
const HIDE_NORMAL_Y = -0.92;

export class Peni {
  readonly object = new THREE.Group();
  readonly params: PeniParams = { ...DEFAULT_PENI };
  private readonly mesh: THREE.Group;
  private readonly material: THREE.ShaderMaterial;
  private readonly pos = new THREE.Vector3();
  private readonly nrm = new THREE.Vector3();
  private readonly dir = new THREE.Vector3();
  private static readonly UP = new THREE.Vector3(0, 1, 0);
  /** 生やしている体の頂点（-1 は未定）と、それを選んだときの設定 */
  private vertex = -1;
  private chosenFor = '';

  constructor(private readonly y: Yukkuri) {
    // 根元（y = 0）から先端（y = 1）へ細くなる円錐。根元は体に少し埋めて、継ぎ目を見せない。先端は少し丸める
    // 断面は下から上へ並べる（逆だと面が裏返る）
    const geometry = lathe([
      [0.001, -0.8], [1, -0.8], [1, 0], [0.55, 0.5], [0.16, 0.92], [0.07, 0.98], [0.001, 1],
    ], 24);
    this.material = createAccessoryMaterial(y.bodyMaterial, y.colors, { rim: 0.25 });
    this.mesh = withOutline(geometry, this.material, createAccessoryOutlineMaterial(y.outlineMaterial));
    this.object.add(this.mesh);
    this.object.visible = false;
  }

  /**
   * 描画の直前に呼ぶ（体の描画メッシュを更新した後）。still：立ち止まって落ち着いているか。
   * 生やす所は落ち着いているときに選び直す（跳ねてつぶれた形で選ぶと、付く所がずれる）
   */
  update(still: boolean): void {
    const p = this.params;
    this.object.visible = p.show;
    if (!p.show) return;
    const y = this.y;
    const R = y.shape.radius;
    const key = `${p.at}|${y.outfit.builds}`;
    if (this.vertex < 0 || (key !== this.chosenFor && still)) {
      // 口の下端の今の高さと地面の間を at で割り振った高さにある、正面の表面の点
      const mouthRest = y.outfit.restHeightAt(0, MOUTH_BOTTOM_FY);
      if (mouthRest < 0 || !y.outfit.facePoint(0, MOUTH_BOTTOM_FY, this.pos, this.nrm)) {
        this.object.visible = false;
        return;
      }
      const target = Math.max(MIN_HEIGHT * R, this.pos.y * (1 - p.at));
      this.vertex = y.outfit.surfaceIndexAt(0, AZ_RANGE, mouthRest, target, MIN_NORMAL_Y, AZ_WEIGHT);
      // 動いている間に選んだのは仮の所。落ち着いたら選び直す
      this.chosenFor = still ? key : '';
      if (this.vertex < 0) {
        this.object.visible = false;
        return;
      }
    }
    y.outfit.vertexPoint(this.vertex, this.pos, this.nrm);
    if (this.pos.y < GROUND_CLEAR * R || this.nrm.y < HIDE_NORMAL_Y) {
      this.object.visible = false;
      return;
    }
    // 向き：表面の外向き（下向きの成分は除き、地面へ向けない）を、反りの分だけ真上へ寄せる
    this.dir.copy(this.nrm);
    this.dir.y = Math.max(0, this.dir.y);
    if (this.dir.lengthSq() < 1e-6) this.dir.set(0, 0, 1);
    this.dir.normalize().lerp(Peni.UP, p.rise).normalize();
    this.mesh.position.copy(this.pos);
    this.mesh.quaternion.setFromUnitVectors(Peni.UP, this.dir);
    this.mesh.scale.set(p.radius * R, p.length * R, p.radius * R);
    // 体の色を変えたら合わせる
    const u = this.material.uniforms;
    (u.uLit.value as THREE.Color).set(y.colors.lit);
    (u.uShade.value as THREE.Color).set(y.colors.shade);
    (u.uDeep.value as THREE.Color).set(y.colors.deep);
    (u.uRimColor.value as THREE.Color).set(y.colors.rim);
  }
}
