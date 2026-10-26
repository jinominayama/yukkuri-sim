import * as THREE from 'three';
import type { LyingPose } from './locomotion';
import type { Yukkuri } from './Yukkuri';

/**
 * といれでうんうんする：といれのあるマップ（飼育ケース）では、うんうんは基本といれでする（指示）。
 *   （寝転がっていれば起き上がる）→ 寄る（出した塊の真ん中がといれの真ん中に来る立ち位置へ）→ 向きを合わせる →
 *   （寝転がっていたなら、同じ体勢にもう一度寝転ぶ）→ 位置を合わせる（出す前に塊の行き先を見積もり、ずれた分だけ体ごと少し滑る）→
 *   うんうん（Dropping）
 * 体勢は 3 通り（立ったまま・腹ばい・仰向け）で、塊の出る向きが違う（立ったまま・腹ばいは体の後ろ、仰向けは元の向きの前）。
 * どの体勢でも塊がといれの中に納まるように向きと位置を合わせる（指示）。
 * といれのないマップ（平地）と、うんうんたいそうは、その場でする（指示）
 */
type Phase = 'idle' | 'getUp' | 'approach' | 'turn' | 'lie' | 'scoot' | 'poo';
type Pose = 'stand' | LyingPose;

/**
 * 寝転んでから出したときの塊の真ん中：寝転ぶ前に立っていた所からみた [前（+）への距離, 右（+）への距離]（m）。体型ごとに測った値
 * （腹ばいは前へ倒れ、塊は元の位置の後ろ。仰向けは後ろへ倒れ、塊は前の方へ。扁平型・いもむし型の仰向けは横に転がるので、横へずれる）。
 * 立ったままのときは、その場で出したときの行き先を見積もって使う（Dropping.predict）。
 * 表にない体型（ユーザー設定）はボール型の値を胴の半径に合わせて使い、一度寝転んで見積もった値を覚えて次から使う
 */
const LYING_MID: Record<string, Record<LyingPose, [number, number]>> = {
  ball: { prone: [-0.71, 0], supine: [0.12, 0] },
  egg: { prone: [-0.67, 0], supine: [0.15, -0.03] },
  chick: { prone: [-0.95, -0.04], supine: [-0.04, -0.02] },
  flat: { prone: [-0.9, 0], supine: [-0.51, -1.18] },
  eggplant: { prone: [-0.81, 0.03], supine: [0.23, -0.03] },
  caterpillar: { prone: [-1.24, 0], supine: [-1.33, 0.67] },
};
/** 寄る：この距離（胴の半径に対する比）まで来たら着いたことにする。あきらめるまでの時間（秒。道のり 1 m ごとに足す） */
const ARRIVE = 0.6;
const GIVE_UP = 12;
const GIVE_UP_PER_M = 9;
/** 向きを合わせる許し（rad）と最長時間（秒）。寝転ぶ・起き上がるのを待つ上限（秒） */
const TURN_OK = 0.12;
const TURN_MAX = 2.5;
const POSE_MAX = 8;
/**
 * 位置を合わせる：滑る時間（秒。基本の時間に、1 m あたりの時間を足す。大きく滑るときほどゆっくり）と、
 * 滑る一番長い距離（m。それより大きくずれていれば、そこまでで出す）
 */
const SCOOT_TIME = 0.4;
const SCOOT_PER_M = 2;
/** 向きを合わせる間に立ち位置へ寄る速さ（ずれの 1 秒あたりの割合） */
const STEP_IN_RATE = 3;
const SCOOT_MAX = 0.6;

export class ToiletTrip {
  private phase: Phase = 'idle';
  private t = 0;
  private pose: Pose = 'stand';
  private giveUp = GIVE_UP;
  private heading = 0;
  private readonly stand = new THREE.Vector3();
  /** 寝転ぶ前に立っていた所と向き（寝転んだ後の塊の行き先を覚えるのに使う） */
  private readonly before = new THREE.Vector3();
  private beforeYaw = 0;
  /** 寝転んで見積もった塊の真ん中（体型・体勢ごと。[前, 右]） */
  private readonly learned = new Map<string, [number, number]>();
  /** 位置を合わせる：まだ滑る残り（m）と、滑る時間（秒） */
  private readonly scoot = new THREE.Vector3();
  private scootTime = SCOOT_TIME;
  private readonly orient = new THREE.Quaternion();

  constructor(private readonly y: Yukkuri) {}

  /** といれへ向かっているところから、うんうんを出し終えるまで */
  get active(): boolean {
    return this.phase !== 'idle';
  }

  /**
   * うんうんする：といれがあれば、といれへ行ってする。なければその場で（Dropping.start）。
   * 始められないとき（ほかの動きの途中・気絶中）は false
   */
  start(): boolean {
    const y = this.y;
    const toilet = y.stage?.toilet;
    if (!toilet) return y.dropping.start();
    if (this.active || y.dropping.active || y.feeding.active || y.exercise.active || y.vomit.active || y.rest.fainting) return false;
    y.rest.wake(true);
    const loco = y.locomotion;
    this.pose = loco.isLying ? (loco.lyingPose ?? 'prone') : 'stand';
    if (loco.isLying || loco.tilted) {
      y.getUp();
      this.go('getUp');
    } else this.plan();
    return true;
  }

  /** やめる（滑る・寝転ぶ途中ならそのまま。うんうんを出し始めていれば、それは Dropping に任せる） */
  cancel(): void {
    if (!this.active) return;
    this.end();
  }

  /** 固定時間刻みで呼ぶ */
  update(dt: number): void {
    if (this.phase === 'idle') return;
    const y = this.y;
    const loco = y.locomotion;
    const R = y.shape.radius;
    this.t += dt;
    if (y.rest.fainting && this.phase !== 'poo') {
      this.cancel();
      return;
    }
    switch (this.phase) {
      case 'getUp':
        if ((loco.idle && !loco.tilted) || this.t > POSE_MAX) this.plan();
        break;
      case 'approach': {
        // ほかの行き先を指示された・あきらめた（その場でもしない）
        if ((loco.hasTarget && loco.target.distanceTo(this.stand) > 1e-3) || this.t > this.giveUp) {
          this.end();
          break;
        }
        if (loco.hasTarget && Math.hypot(this.stand.x - y.center.x, this.stand.z - y.center.z) < R * ARRIVE) loco.stop();
        if (!loco.hasTarget && loco.idle && !loco.tilted) {
          loco.hold();
          this.go('turn');
        }
        break;
      }
      case 'turn': {
        this.orient.setFromAxisAngle(new THREE.Vector3(0, 1, 0), this.heading);
        loco.gesture = { orientation: this.orient, squash: 1 };
        // 向きを合わせながら、立ち位置へ少しずつ寄る（跳ねて寄ると、立ち位置から胴の半径の 0.6 倍までずれて着く）
        {
          const k = Math.min(1, STEP_IN_RATE * dt);
          y.body.translate((this.stand.x - y.center.x) * k, (this.stand.z - y.center.z) * k);
        }
        const err = Math.abs(Math.atan2(Math.sin(this.heading - y.body.yaw), Math.cos(this.heading - y.body.yaw)));
        if ((err < TURN_OK && this.t > 0.3) || this.t > TURN_MAX) {
          if (loco.gesture?.orientation === this.orient) loco.gesture = null;
          if (this.pose === 'stand') this.aim();
          else {
            this.before.set(y.center.x, 0, y.center.z);
            this.beforeYaw = y.body.yaw;
            loco.lieDown(this.pose);
            this.go('lie');
          }
        }
        break;
      }
      case 'lie':
        if ((loco.resting && this.t > 0.5) || this.t > POSE_MAX) this.aim();
        break;
      case 'scoot': {
        // 残りを、時間に合わせてなめらかに滑る（体ごと動かす）
        const k = Math.min(1, dt / Math.max(dt, this.scootTime - this.t + dt));
        const dx = this.scoot.x * k, dz = this.scoot.z * k;
        y.body.translate(dx, dz);
        this.scoot.x -= dx;
        this.scoot.z -= dz;
        if (this.t >= this.scootTime) {
          // うんうんを出す（Dropping が出し終わるまで移動を保留する）
          loco.release();
          if (y.dropping.start()) this.go('poo');
          else this.end();
        }
        break;
      }
      case 'poo':
        if (!y.dropping.active) this.end();
        break;
    }
  }

  /** 立ち位置と向きを決めて歩き出す：塊の真ん中がといれの真ん中に来る所。向きは今いる所からといれへ向かう向き */
  private plan(): void {
    const y = this.y;
    const t = y.stage?.toilet;
    const mid = this.midOffset();
    if (!t || !mid) {
      this.end();
      return;
    }
    const R = y.shape.radius;
    const c = y.center;
    let a = Math.hypot(t.x - c.x, t.z - c.z) > 0.05 ? Math.atan2(t.x - c.x, t.z - c.z) : y.body.yaw;
    // 向き a で立つと塊の真ん中が来る所から、逆算した立ち位置（前 f・右 r）
    const at = (h: number) => {
      const f = new THREE.Vector3(Math.sin(h), 0, Math.cos(h)), r = new THREE.Vector3(f.z, 0, -f.x);
      return new THREE.Vector3(t.x, 0, t.z).addScaledVector(f, -mid[0]).addScaledVector(r, -mid[1]);
    };
    // 立ち位置がケースの壁ぎわで行けなければ、反対向きから
    if (!y.stage!.inside(at(a).x, at(a).z, y.stageMargin)) a += Math.PI;
    this.heading = a;
    this.stand.copy(at(a));
    const loco = y.locomotion;
    if (Math.hypot(this.stand.x - c.x, this.stand.z - c.z) < R * ARRIVE) {
      loco.stop();
      loco.hold();
      this.go('turn');
      return;
    }
    loco.moveTo(this.stand.x, this.stand.z);
    this.stand.copy(loco.target);
    this.giveUp = GIVE_UP + GIVE_UP_PER_M * Math.hypot(this.stand.x - c.x, this.stand.z - c.z);
    this.go('approach');
  }

  /** 立っている所からみた塊の真ん中 [前, 右]（m）。立ったままならその場で見積もり、寝転ぶなら覚えた値か体型ごとの値 */
  private midOffset(): [number, number] | null {
    const y = this.y;
    if (this.pose === 'stand') {
      const p = y.dropping.predict();
      if (!p) return null;
      return this.relative((p.start.x + p.end.x) / 2, (p.start.z + p.end.z) / 2, y.center, y.body.yaw);
    }
    const known = this.learned.get(`${y.presetId}/${this.pose}`) ?? LYING_MID[y.presetId]?.[this.pose];
    if (known) return known;
    const k = y.shape.radius / 0.5;
    const b = LYING_MID.ball[this.pose];
    return [b[0] * k, b[1] * k];
  }

  /** 点（x, z）を、c に向き yaw で立った体からみた [前, 右]（m）にする */
  private relative(x: number, z: number, c: THREE.Vector3, yaw: number): [number, number] {
    const fx = Math.sin(yaw), fz = Math.cos(yaw);
    const dx = x - c.x, dz = z - c.z;
    return [dx * fx + dz * fz, dx * fz - dz * fx];
  }

  /** 位置を合わせる：今の体勢で出したときの塊の真ん中が、といれの真ん中に来るように滑る量を決める */
  private aim(): void {
    const y = this.y;
    const t = y.stage?.toilet;
    const p = y.dropping.predict();
    this.scoot.set(0, 0, 0);
    if (t && p) {
      const mx = (p.start.x + p.end.x) / 2, mz = (p.start.z + p.end.z) / 2;
      // 寝転んだときの行き先を覚える（次からはこの値で立ち位置を決める）
      if (this.pose !== 'stand') this.learned.set(`${y.presetId}/${this.pose}`, this.relative(mx, mz, this.before, this.beforeYaw));
      this.scoot.set(t.x - mx, 0, t.z - mz);
      if (this.scoot.length() > SCOOT_MAX) this.scoot.setLength(SCOOT_MAX);
    }
    this.scootTime = SCOOT_TIME + SCOOT_PER_M * this.scoot.length();
    y.locomotion.hold();
    this.go('scoot');
  }

  private end(): void {
    const loco = this.y.locomotion;
    if (loco.gesture?.orientation === this.orient) loco.gesture = null;
    // 寄る・向きを合わせる・滑る途中でやめたら、移動の保留を解く（うんうんの途中なら Dropping が解く）
    if (this.phase === 'turn' || this.phase === 'lie' || this.phase === 'scoot') loco.release();
    this.phase = 'idle';
  }

  private go(phase: Phase): void {
    this.phase = phase;
    this.t = 0;
  }
}
