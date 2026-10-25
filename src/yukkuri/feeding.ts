import * as THREE from 'three';
import { createAccessoryMaterial } from '../render/accessoryMaterial';
import { createAccessoryOutlineMaterial } from '../render/outlineMaterial';
import { withOutline } from '../character/shapes';
import type { PartSelection } from '../face/parts';
import { faceFrame, showFace } from './fx';
import { DEFAULT_FOOD, type FoodKind } from './foods';
import type { Yukkuri } from './Yukkuri';

/**
 * 物を食べる動き。リアルな咀嚼ではなく、段階ごとに表情と演出を切り替える：
 *   1. 見つめる … 食べ物の前で目を見開いて口を開け、よだれを少し垂らす
 *   2. 食べる   … 口を閉じる・開くを繰り返し、口のまわりに食べかす、まわりに「むーしゃ」の文字
 *   3. しあわせ … 食べ物を消し、涙を流して震えながら「しあわせー」の文字。食べ物の品質に応じてストレスが減る
 * 表情は顔の設定を書き換えずに一時的に上書きする（終わればいつもの顔に戻る）。
 * 食べている間は、うろつき・移動をしない
 */
type Phase = 'none' | 'wait' | 'gaze' | 'chew' | 'happy';

/** 各段階の長さ（秒）と、口を閉じる・開く1回の長さ */
const GAZE_TIME = 3.2;
const CHEW_COUNT = 5;
const CHEW_HALF = 0.8;
const HAPPY_TIME = 5.6;
/** 起き上がるのを待つ上限（秒） */
const WAIT_MAX = 12;

/**
 * 表情（顔パーツの選択。parts.ts の id）。上書きするのは目・眉・口だけ。
 * 汗・涙・頬などは選んでいるものをそのまま出す。段階に要るもの（よだれ・涙）は、
 * 選んでいるものがそれより少ないときだけ足す（AT_LEAST）
 */
const FACE_GAZE: Partial<PartSelection> = { eyes: 'round', brows: 'neutral', mouth: 'smile' };
const FACE_CHEW_OPEN: Partial<PartSelection> = { eyes: 'smile', brows: 'neutral', mouth: 'smile' };
const FACE_CHEW_SHUT: Partial<PartSelection> = { ...FACE_CHEW_OPEN, mouth: 'smirk' };
const FACE_HAPPY: Partial<PartSelection> = { eyes: 'smile', brows: 'worried', mouth: 'smile' };
const AT_LEAST_GAZE: Partial<PartSelection> = { drool: 'few' };
const AT_LEAST_HAPPY: Partial<PartSelection> = { tears: 'lots', stream: 'lots' };

/** 口の位置（顔座標。単位は頭の半径） */
const MOUTH_FY = -0.06;
/** 食べ物の大きさ（胴の半径に対する比）と、口の前からの距離（胴の半径に対する比） */
const FOOD_SIZE = 0.22;
const FOOD_GAP = 0.08;
/** しあわせーのときの震えの振れ幅（胴の半径に対する比） */
const TREMBLE_AMP = 0.025;

const FOOD_COLORS = { lit: '#f3d2a2', shade: '#d9a96e', deep: '#a8723f', rim: '#fff3dc' };
const CRUMB_COLORS = { lit: '#e9bd84', shade: '#c98f52', deep: '#8f5a2c', rim: '#fff3dc' };

interface Crumb { mesh: THREE.Mesh; vel: THREE.Vector3; life: number; size: number }

export class Feeding {
  /** 食べ物・食べかす（体と一緒に震えないよう、シーンに直接置く。文字は yukkuri.texts） */
  readonly object = new THREE.Group();
  private phase: Phase = 'none';
  private t = 0;
  private chews = 0;
  /** 今食べている食べ物の種類 */
  private kind: FoodKind = DEFAULT_FOOD;
  private food: THREE.Group | null = null;
  /** よそに置いてある食べ物を食べる（餌皿の餌など）：食べ終えたら eaten で消してもらう。目の前に食べ物は置かない */
  private external: { eaten: () => void } | null = null;
  private readonly foodGeometry: THREE.BufferGeometry;
  private readonly crumbGeometry: THREE.BufferGeometry;
  private readonly foodMaterial: THREE.ShaderMaterial;
  private readonly crumbMaterial: THREE.ShaderMaterial;
  private readonly outlineMaterial: THREE.ShaderMaterial;
  private readonly crumbs: Crumb[] = [];
  private readonly mouth = new THREE.Vector3();
  private readonly facing = new THREE.Vector3(0, 0, 1);

  constructor(private readonly y: Yukkuri) {
    // 食べ物：まんじゅう形（下がやや平らな丸）
    this.foodGeometry = new THREE.SphereGeometry(1, 32, 20);
    const p = this.foodGeometry.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < p.count; i++) {
      const yv = p.getY(i);
      p.setY(i, yv < 0 ? yv * 0.35 : yv * 0.62);
    }
    this.foodGeometry.computeVertexNormals();
    this.crumbGeometry = new THREE.IcosahedronGeometry(1, 0);
    this.foodMaterial = createAccessoryMaterial(y.bodyMaterial, FOOD_COLORS, { rim: 0.3 });
    this.crumbMaterial = createAccessoryMaterial(y.bodyMaterial, CRUMB_COLORS, { rim: 0.2 });
    this.outlineMaterial = createAccessoryOutlineMaterial(y.outlineMaterial);
  }

  /** 食べている最中か（食べ物を置いてから、しあわせーが終わるまで） */
  get active(): boolean {
    return this.phase !== 'none';
  }

  /** 見つめる・むーしゃむーしゃの途中か（しあわせーの前まで） */
  get chewing(): boolean {
    return this.phase === 'wait' || this.phase === 'gaze' || this.phase === 'chew';
  }

  /**
   * 食べ物を目の前に置いて食べ始める。寝転がっていれば起き上がってから。食べている最中なら何もしない。
   * external を渡すと、食べ物は置かず（よそに置いてある物を食べる）、むーしゃむーしゃが終わったら external.eaten() を呼ぶ
   */
  start(kind: FoodKind = DEFAULT_FOOD, external: { eaten: () => void } | null = null): boolean {
    if (this.active || this.y.dropping.active || this.y.exercise.active || this.y.vomit.active || this.y.rest.fainting) return false;
    this.y.rest.wake(true);
    const loco = this.y.locomotion;
    loco.hold();
    this.kind = kind;
    this.external = external;
    this.t = 0;
    // 寝転がっていれば起き上がってから。跳ねている途中など体勢が変わっている途中なら、止まるまで待つ
    // （途中の向きで食べ物を置くと、顔の正面からずれる）
    if (loco.isLying) {
      this.y.getUp();
      this.phase = 'wait';
    } else if (!loco.idle) {
      this.phase = 'wait';
    } else {
      this.begin();
    }
    return true;
  }

  /** 途中でやめる（食べ物・演出を片付け、いつもの顔に戻す） */
  cancel(): void {
    this.removeFood();
    this.external = null;
    this.finish();
  }

  /** 固定時間刻みで呼ぶ */
  update(dt: number): void {
    this.updateEffects(dt);
    if (this.phase === 'none') return;
    this.t += dt;
    switch (this.phase) {
      case 'wait':
        if (this.y.locomotion.idle || this.t > WAIT_MAX) this.begin();
        break;
      case 'gaze':
        if (this.t > GAZE_TIME) {
          this.phase = 'chew';
          this.t = 0;
          this.chews = 0;
          this.show(FACE_CHEW_SHUT);
          this.chewed();
        }
        break;
      case 'chew': {
        // 半周ごとに閉じる・開くを切り替える。閉じたときに食べかすと文字
        const half = Math.floor(this.t / CHEW_HALF);
        const shut = half % 2 === 0;
        this.show(shut ? FACE_CHEW_SHUT : FACE_CHEW_OPEN);
        if (shut && half / 2 >= this.chews) this.chewed();
        if (half >= CHEW_COUNT * 2) {
          this.phase = 'happy';
          this.t = 0;
          this.removeFood();
          this.external?.eaten();
          this.external = null;
          this.show(FACE_HAPPY, AT_LEAST_HAPPY);
          this.say('しあわせー', true);
          this.y.stress.ate(this.kind.quality);
        }
        break;
      }
      case 'happy':
        // 震える：出だしと終わりはなめらかに
        this.y.tremble = TREMBLE_AMP * Math.min(1, this.t * 4) * Math.min(1, Math.max(0, HAPPY_TIME - this.t) * 3);
        if (this.t > HAPPY_TIME) this.finish();
        break;
    }
  }

  private begin(): void {
    this.measure();
    if (!this.external) this.placeFood();
    this.phase = 'gaze';
    this.t = 0;
    this.show(FACE_GAZE, AT_LEAST_GAZE);
  }

  private finish(): void {
    this.phase = 'none';
    this.y.face.override = null;
    this.y.locomotion.release();
    this.y.tremble = 0;
  }

  private show(face: Partial<PartSelection>, atLeast: Partial<PartSelection> = {}): void {
    showFace(this.y, face, atLeast);
  }

  /** 口の位置と、顔の向き（水平） */
  private measure(): void {
    const f = faceFrame(this.y, 0, MOUTH_FY);
    this.mouth.copy(f.pos);
    this.facing.copy(f.facing);
  }

  /** 食べ物を口の前の地面に置く */
  private placeFood(): void {
    this.removeFood();
    const R = this.y.shape.radius;
    const s = R * FOOD_SIZE;
    const g = withOutline(this.foodGeometry, this.foodMaterial, this.outlineMaterial);
    g.scale.setScalar(s);
    g.position.copy(this.mouth).addScaledVector(this.facing, s + R * FOOD_GAP);
    g.position.y = s * 0.35;
    g.rotation.y = Math.random() * Math.PI * 2;
    this.food = g;
    this.object.add(g);
  }

  private removeFood(): void {
    if (this.food) this.object.remove(this.food);
    this.food = null;
  }

  /** 1回噛んだ：食べかすを飛ばし、「むーしゃ」（左右交互） */
  private chewed(): void {
    this.measure();
    const R = this.y.shape.radius;
    const n = 6 + Math.floor(Math.random() * 5);
    for (let i = 0; i < n; i++) {
      const size = R * (0.018 + Math.random() * 0.02);
      const mesh = new THREE.Mesh(this.crumbGeometry, this.crumbMaterial);
      mesh.scale.setScalar(size);
      const side = new THREE.Vector3(-this.facing.z, 0, this.facing.x);
      const sx = (Math.random() - 0.5) * 2;
      mesh.position.copy(this.mouth)
        .addScaledVector(side, sx * R * 0.18)
        .addScaledVector(this.facing, R * 0.05)
        .add(new THREE.Vector3(0, (Math.random() - 0.5) * R * 0.08, 0));
      mesh.rotation.set(Math.random() * 3, Math.random() * 3, Math.random() * 3);
      const vel = this.facing.clone().multiplyScalar(0.25 + Math.random() * 0.35)
        .addScaledVector(side, sx * 0.35)
        .add(new THREE.Vector3(0, 0.4 + Math.random() * 0.6, 0));
      this.object.add(mesh);
      this.crumbs.push({ mesh, vel, life: 1.2 + Math.random() * 0.6, size });
    }
    this.say('むーしゃ', false, this.chews % 2 === 0 ? -1 : 1);
    this.chews++;
  }

  /** 頭のまわりに文字を出す（side：見る人から見て左 -1・右 1、big：頭の上に大きく） */
  private say(text: string, big: boolean, side = 0): void {
    const R = this.y.shape.radius;
    const h = R * (big ? 0.42 : 0.3);
    const pos = new THREE.Vector3();
    const sideDir = new THREE.Vector3(-this.facing.z, 0, this.facing.x);
    const top = this.y.center.y + this.y.height * 0.5;
    if (big) {
      // 頭のてっぺんの少し前（帽子に重なっても文字が前に出る）
      pos.set(this.y.center.x, top + R * 0.05, this.y.center.z).addScaledVector(this.facing, R * 0.7);
    } else {
      // 顔の横（少し前）の、頬の高さあたり
      pos.copy(this.mouth)
        .addScaledVector(sideDir, side * R * 1.2)
        .addScaledVector(this.facing, R * 0.2);
      pos.y += R * (0.1 + Math.random() * 0.15);
    }
    // 「むーしゃ」は次の「むーしゃ」が出た少し後まで残す（浮かぶ距離は時間によらず同じくらいに）
    const total = big ? HAPPY_TIME : CHEW_HALF * 2.5;
    const vel = new THREE.Vector3(0, R * (big ? 0.06 : 0.38 / total), 0).addScaledVector(sideDir, side * R * 0.16 / total);
    this.y.texts.say(text, pos, h, total, vel);
  }

  /** 食べかすを落として消す */
  private updateEffects(dt: number): void {
    const g = this.y.physics.gravity;
    for (let i = this.crumbs.length - 1; i >= 0; i--) {
      const c = this.crumbs[i];
      c.life -= dt;
      if (c.mesh.position.y > c.size) {
        c.vel.y -= g * dt;
        c.mesh.position.addScaledVector(c.vel, dt);
        if (c.mesh.position.y < c.size) {
          c.mesh.position.y = c.size;
          c.vel.set(0, 0, 0);
        }
      }
      // 消えるときは小さくなって消える
      c.mesh.scale.setScalar(c.size * Math.min(1, c.life / 0.3));
      if (c.life <= 0) {
        this.object.remove(c.mesh);
        this.crumbs.splice(i, 1);
      }
    }
  }
}
