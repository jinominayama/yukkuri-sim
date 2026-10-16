import * as THREE from 'three';
import { createUnitSphere, faceOrigin, mapToRest, type BodyShapeParams } from './bodyShape';
import { loadStartPreset, type BodyPreset } from './presets';
import { Skin } from './skin';
import { Locomotion, type LocomotionParams } from './locomotion';
import { SoftBody, type SoftBodyParams } from '../physics/SoftBody';
import { createToonMaterial, DEFAULT_SKIN, type ToonColors } from '../render/toonMaterial';
import { createOutlineMaterial } from '../render/outlineMaterial';
import { createBlobShadow } from '../render/blobShadow';
import { Face } from '../face/Face';
import { Outfit } from '../character/Outfit';
import { FACE_RECT } from '../face/types';

/** 物理メッシュと描画メッシュの細かさ */
const PHYS_DETAIL = 7;    // 約640頂点
const RENDER_DETAIL = 32; // 約1万頂点

export interface LifeParams {
  /** 呼吸の大きさ（体積の変化率） */
  breath: number;
  /** 呼吸の速さ（回/秒） */
  breathRate: number;
}

export const DEFAULT_LIFE: LifeParams = { breath: 0.03, breathRate: 0.3 };

/**
 * ゆっくり1体（物理＋描画）。
 * 今後、状態（欲求・行動）はシミュレーション層から受け取る。
 */
/** 初めて開いたときのキャラクター */
const FIRST_CHARACTER = 'marisa';

export class Yukkuri {
  readonly root = new THREE.Group();
  // 起動時は最後に選んだ体型（保存済みの上書きを反映）で始める
  private readonly startPreset = loadStartPreset();
  readonly shape: BodyShapeParams = { ...this.startPreset.shape };
  readonly physics: SoftBodyParams = { ...this.startPreset.physics };
  readonly life: LifeParams = { ...DEFAULT_LIFE };
  readonly colors: ToonColors = { ...DEFAULT_SKIN };
  readonly move: LocomotionParams = { ...this.startPreset.move };
  /** 顔（表情・絵柄） */
  readonly face = new Face();
  /** 装飾（キャラクターの髪・帽子など） */
  readonly outfit: Outfit;
  /** 最後に適用した体型プリセット */
  presetId = this.startPreset.id;
  readonly locomotion: Locomotion;
  readonly bodyMaterial: THREE.ShaderMaterial;
  readonly outlineMaterial: THREE.ShaderMaterial;
  readonly body: SoftBody;
  /** レイキャスト（つつく等）の対象 */
  readonly bodyMesh: THREE.Mesh;

  private readonly physUnit: Float32Array;
  private readonly renderUnit: Float32Array;
  private readonly skin: Skin;
  private readonly shadow = createBlobShadow();
  private readonly outline: THREE.Mesh;
  private restHeight = 1;
  private time = 0;

  constructor() {
    const phys = createUnitSphere(PHYS_DETAIL);
    const render = createUnitSphere(RENDER_DETAIL);
    this.physUnit = phys.positions;
    this.renderUnit = render.positions;

    this.body = new SoftBody(mapToRest(this.physUnit, this.shape), phys.index);
    this.skin = new Skin(render.geometry, this.renderUnit, this.physUnit, phys.index);

    this.bodyMaterial = createToonMaterial(this.colors);
    const u = this.bodyMaterial.uniforms;
    u.uFaceTex.value = this.face.texture;
    (u.uFaceRect.value as THREE.Vector4).set(FACE_RECT.xMin, FACE_RECT.yMin, FACE_RECT.xMax, FACE_RECT.yMax);
    this.outlineMaterial = createOutlineMaterial();
    this.bodyMesh = new THREE.Mesh(render.geometry, this.bodyMaterial);
    this.outline = new THREE.Mesh(render.geometry, this.outlineMaterial);
    // 頂点は毎フレームワールド座標で書き換えるので、視錐台カリングは使わない
    this.bodyMesh.frustumCulled = false;
    this.outline.frustumCulled = false;
    this.root.add(this.shadow, this.outline, this.bodyMesh);

    this.outfit = new Outfit(render.geometry, this.bodyMaterial, this.outlineMaterial);
    this.root.add(this.outfit.object);
    this.outfit.usePreset(this.presetId);

    this.locomotion = new Locomotion(this.body, this.move);
    this.applyShape();
    // 初めて開いたときは魔理沙で始める（テスト版）
    if (this.outfit.fresh) {
      this.outfit.setCharacter(FIRST_CHARACTER);
      const iris = this.outfit.character.iris;
      if (iris) {
        this.face.settings.iris = iris;
        this.face.save();
      }
    } else this.outfit.create();
    this.drop(0);
  }

  /** 静止形状のパラメータ変更を反映する（今の位置・動きは保つ） */
  applyShape(): void {
    const physRest = mapToRest(this.physUnit, this.shape);
    this.body.setRestShape(physRest);
    this.skin.setRest(mapToRest(this.renderUnit, this.shape), this.body.restCentroid);
    let minY = Infinity, maxY = -Infinity;
    for (let i = 1; i < physRest.length; i += 3) {
      minY = Math.min(minY, physRest[i]);
      maxY = Math.max(maxY, physRest[i]);
    }
    this.restHeight = maxY - minY;
    this.bodyMaterial.uniforms.uBodyHeight.value = this.restHeight;
    this.placeFace();
    this.outfit?.rebuild();
  }

  /** 体型プリセットを適用する（形・柔らかさ・運動能力）。その場で置き直す */
  applyPreset(p: BodyPreset): void {
    Object.assign(this.shape, p.shape);
    Object.assign(this.physics, p.physics);
    Object.assign(this.move, p.move);
    this.presetId = p.id;
    this.outfit.usePreset(p.id); // 帽子・髪の厚み・三つ編みの長さは体型ごと
    this.locomotion.reset();
    this.applyShape();
    this.drop(0.02);
  }

  /**
   * 顔を貼る位置を決める。頭の中心から見た方向に、頭の大きさに比例した実寸で貼る。
   * 体型を伸縮しても顔そのものは歪まない
   */
  private placeFace(): void {
    const u = this.bodyMaterial.uniforms;
    const headR = this.shape.radius * this.shape.headSize;
    u.uHeadR.value = headR * this.shape.faceSize;
    const c = faceOrigin(this.shape, u.uHeadC.value as THREE.Vector3).sub(this.body.restCentroid);
    c.y += headR * this.shape.faceHeight;
  }

  /** 底が地面から height の高さになるよう置き直して落とす */
  drop(height: number, x = this.body.center.x, z = this.body.center.z): void {
    let minY = Infinity;
    for (let i = 1; i < this.body.rest.length; i += 3) minY = Math.min(minY, this.body.rest[i]);
    this.body.reset(x, height - minY, z);
    this.locomotion?.reset();
    this.skin.update(this.body);
  }

  /** 点 point を方向 dir につつく */
  poke(point: THREE.Vector3, dir: THREE.Vector3, strength: number): void {
    const v = dir.clone().normalize().multiplyScalar(strength);
    this.body.addLocalVelocity(point.x, point.y, point.z, this.shape.radius * 0.9, v.x, v.y, v.z);
  }

  /** 外から全体に速度を加える（投げる・弾き飛ばす等） */
  impulse(vx: number, vy: number, vz: number): void {
    this.body.addVelocity(vx, vy, vz);
  }

  set outlineVisible(v: boolean) {
    this.outline.visible = v;
  }
  get outlineVisible(): boolean {
    return this.outline.visible;
  }

  applyColors(): void {
    const u = this.bodyMaterial.uniforms;
    (u.uLit.value as THREE.Color).set(this.colors.lit);
    (u.uShade.value as THREE.Color).set(this.colors.shade);
    (u.uDeep.value as THREE.Color).set(this.colors.deep);
    (u.uRimColor.value as THREE.Color).set(this.colors.rim);
  }

  /** 固定時間刻みで呼ぶ物理更新 */
  step(dt: number): void {
    this.time += dt;
    this.face.update(dt);
    this.body.volumeScale = 1 + this.life.breath * Math.sin(this.time * Math.PI * 2 * this.life.breathRate);
    this.locomotion.update(dt, this.physics.gravity);
    this.body.step(dt, this.physics);
  }

  /** 描画直前に呼ぶ */
  sync(): void {
    this.skin.update(this.body);
    this.outfit.update();
    this.face.render();

    // 影：重心の真下。高く跳ぶほど小さく薄く
    const c = this.body.center;
    const lift = Math.max(0, c.y - this.restHeight * 0.5);
    const s = this.shape.radius * 2.6 / (1 + lift * 1.5);
    this.shadow.position.set(c.x, 0.002, c.z);
    this.shadow.scale.set(s, 1, s);
    this.shadow.material.uniforms.uOpacity.value = 0.55 / (1 + lift * 2);
  }

  get center(): THREE.Vector3 {
    return this.body.center;
  }
  get height(): number {
    return this.restHeight;
  }
}
