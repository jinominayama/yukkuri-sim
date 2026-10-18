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
import { Feeding } from './feeding';
import { Dropping } from './dropping';
import { Peni } from './peni';
import { Exercise } from './exercise';
import { Poke } from './poke';
import { Vomit } from './vomit';
import { Moru } from './moru';
import { Stress } from './stress';
import { Flee } from './flee';
import { TextFx } from './fx';
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
/** 震え（tremble）の速さ（回/秒） */
const TREMBLE_RATE = 13;
/** 起き上がるとき、体の中心からこの距離（胴の半径に対する比）以内にうんうんがあれば、先に寝返りで離れる */
const GETUP_CLEAR = 1.1;
const MAX_ROLLS_ASIDE = 2;
/** 起き上がるときに体がお尻の側へずれる量の見込み（胴の半径に対する比） */
const GETUP_SHIFT = 1.6;
/** 起動・置き直しからこの時間（秒）は、落ちても吐かない（最初に置くときの落下を数えない） */
const FALL_GRACE = 1;
/** 立ち止まってからこの時間（秒）たったら「落ち着いている」とみなす（跳ねた後の帽子の浮きなどが収まるまで） */
const STILL_TIME = 1;

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
  /** 物を食べる動き（食べ物・食べかす・文字は feeding.object をシーンに置いて表示する） */
  readonly feeding: Feeding;
  /** うんうん（出したものは dropping.object をシーンに置いて表示する） */
  readonly dropping: Dropping;
  /** つつかれた・叩かれたときの反応（へこんで弾む・痛がる顔・倒れる・転がる） */
  readonly poking: Poke;
  /** うんうんたいそう（歌に合わせて体を動かし、最後にうんうんを出す） */
  readonly exercise: Exercise;
  /** 吐餡（高い所から落ちたときなどに口から餡子を吐く。吐いたものは vomit.object をシーンに置いて表示する） */
  readonly vomit: Vomit;
  /** もるんもるん（お尻を突き上げて左右に振る。顔と文字を受け持つ。体の動きは locomotion.moru） */
  readonly moru: Moru;
  /** ぺにぺに（顔の正面の下に生える円錐） */
  readonly peni: Peni;
  /** ストレス（つつかれる・叩かれる・汚れの近くにいるとたまり、上限で吐餡する） */
  readonly stress: Stress;
  /** 汚れ（うんうん・吐いた餡子）の近くにいると、嫌がって離れる */
  readonly flee: Flee;
  /** まわりに出す文字（texts.object をシーンに置いて表示する） */
  readonly texts = new TextFx();
  /** 起き上がる前に寝返りで横へずれている最中か、と、あと何回寝返ってよいか */
  private rollingAside = false;
  private rollsLeft = 0;
  /** 体の見た目だけを小刻みに震わせる振れ幅（胴の半径に対する比。0 で止まる。物理には触らない） */
  tremble = 0;
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
  /** 宙にいる間の重心の一番高い所（地面に着いていれば null）と、落下を数え始める時刻 */
  private airTop: number | null = null;
  private fallFrom = FALL_GRACE;

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
    this.feeding = new Feeding(this);
    this.dropping = new Dropping(this);
    this.dropping.usePreset(this.presetId);
    this.exercise = new Exercise(this);
    this.poking = new Poke(this);
    this.vomit = new Vomit(this);
    this.moru = new Moru(this);
    this.moru.usePreset(this.presetId);
    this.stress = new Stress(this);
    this.flee = new Flee(this);
    this.peni = new Peni(this);
    this.peni.usePreset(this.presetId);
    this.root.add(this.peni.object);
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
    this.peni.usePreset(p.id); // ぺにぺにの設定も体型ごと
    this.dropping.usePreset(p.id); // うんうんの出る位置も体型ごと
    this.moru.usePreset(p.id); // もるんもるんの揺れ幅も体型ごと
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
    this.airTop = null;
    this.locomotion?.reset();
    this.skin.update(this.body);
  }

  /**
   * 起き上がる。寝転んだ体のそばにうんうんがあって、そのまま起き上がると体が貫通しそうなら、
   * 先に寝返りで横へ転がって離れてから起き上がる（寝返りは 2 回まで）
   */
  getUp(): void {
    const loco = this.locomotion;
    if (!loco.isLying) return;
    // 起き上がると、体はお尻の側（体の下向きが寝転んで傾いた向き）へずれる。今の位置と、ずれた先の両方で見る
    const R = this.shape.radius;
    const c = this.body.center;
    const bottom = new THREE.Vector3(0, -1, 0).applyQuaternion(this.body.rotation).setY(0);
    const after = bottom.lengthSq() > 1e-4 ? c.clone().addScaledVector(bottom.normalize(), R * GETUP_SHIFT) : c;
    if (this.dropping.near(c, R * GETUP_CLEAR) || this.dropping.near(after, R * GETUP_CLEAR)) {
      if (!this.rollingAside) {
        this.rollingAside = true;
        this.rollsLeft = MAX_ROLLS_ASIDE;
      }
      if (this.rollsLeft > 0) {
        this.rollsLeft--;
        loco.lieDown(loco.lyingPose === 'prone' ? 'supine' : 'prone');
        return;
      }
    }
    this.rollingAside = false;
    loco.getUp();
  }

  /**
   * 落下を見張る：宙にいる間の重心の一番高い所を覚えておき、地面に着いたら落ちた距離を吐餡に知らせる
   */
  private watchFall(): void {
    const b = this.body;
    if (b.groundContacts === 0) {
      this.airTop = Math.max(this.airTop ?? -Infinity, b.center.y);
      return;
    }
    if (this.airTop === null) return;
    const fall = this.airTop - b.center.y;
    this.airTop = null;
    if (this.time > this.fallFrom) this.vomit.landed(fall);
  }

  /** 点 point を方向 dir につつく（へこんで弾み、驚いた顔をする） */
  poke(point: THREE.Vector3, dir: THREE.Vector3, strength: number): void {
    this.poking.start(point, dir, strength);
  }

  /** 点 point を方向 dir に叩く（つつくより強くへこんで押し飛ばされ、痛がって泣く） */
  slap(point: THREE.Vector3, dir: THREE.Vector3, strength: number): void {
    this.poking.slap(point, dir, strength);
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
    // 寝返りで横へずれてから起き上がる：寝返りが終わったら、まだ塊に近ければもう一度、離れていれば起き上がる
    if (this.rollingAside && this.locomotion.resting) this.getUp();
    this.watchFall();
    this.stress.update(dt); // 上限に届いたら吐き始めるので、吐餡より先に
    this.flee.update(dt); // 汚れが近いかはストレスが調べる
    this.vomit.update(dt); // 吐くときの身ぶりも移動の処理より先に指示する
    this.exercise.update(dt); // 体操の身ぶりを移動の処理より先に指示する
    this.locomotion.update(dt, this.physics.gravity);
    this.moru.update(dt); // 振り切った回数は移動の処理が数えるので、その後で
    this.feeding.update(dt);
    this.dropping.update(dt);
    this.peni.step(dt);
    this.poking.update(dt);
    this.texts.update(dt);
    this.body.step(dt, this.physics);
  }

  /** 描画直前に呼ぶ */
  sync(): void {
    this.skin.update(this.body);
    // 震え：左右・前後に、少しずらした速さで小刻みに揺らす（見た目だけ）
    if (this.tremble > 0) {
      const a = this.tremble * this.shape.radius;
      const w = this.time * Math.PI * 2;
      this.root.position.set(a * Math.sin(w * TREMBLE_RATE), 0, a * 0.6 * Math.sin(w * TREMBLE_RATE * 0.83 + 1));
    } else {
      this.root.position.set(0, 0, 0);
    }
    // 立ち止まって落ち着いたかを渡す（三つ編みの編み目の数・ぺにぺにの生やす所は、動いている間は選び直さない）
    const still = this.locomotion.idleTime > STILL_TIME;
    this.outfit.update(still);
    this.peni.update(still);
    this.dropping.sync();
    this.vomit.sync();
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
