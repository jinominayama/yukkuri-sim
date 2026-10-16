import { Quaternion, Vector3 } from 'three';
import type { SoftBody } from '../physics/SoftBody';

export type MoveMode = 'hop' | 'crawl';

export interface LocomotionParams {
  mode: MoveMode;
  /** 跳ねて移動できるか（できない体型は mode に関わらず這う） */
  canHop: boolean;
  /** 跳躍の高さ (m) */
  hopHeight: number;
  /** 1回の跳躍で進む距離 (m) */
  hopDistance: number;
  /** 溜めで縮む深さ（縦の倍率） */
  crouchDepth: number;
  /** 溜めの時間 (s) */
  crouchTime: number;
  /** 着地してから次に跳ぶまでの間 (s) */
  restTime: number;
  /** 這うときに前後へ伸びる量（1 = 伸びない） */
  crawlStretch: number;
  /** 這うときに潰れる深さ（縦の倍率） */
  crawlSquash: number;
  /** 這うときに頭（上部）を前に突き出す量（体の高さに対する比） */
  crawlBend: number;
  /** 這うリズム（伸び縮みの回数/秒） */
  crawlRhythm: number;
  /** 向きを変える速さ (rad/s) */
  turnSpeed: number;
  /**
   * 1回の跳躍で顔を向ける最大の角度（度）。溜めの間に背骨を曲げて顔を先に向けるので、
   * 大きくしすぎると皮が足りずにしわが出る
   */
  hopTurnMax: number;
  /** 1回の伸び縮み（這う）で顔を向ける最大の角度（度） */
  crawlTurnMax: number;
  /** 目的地に着いたとみなす距離 (m) */
  arriveRadius: number;
  /** 目的地がないとき、自分で行き先を決めてうろつく */
  wander: boolean;
  /** うろつく範囲（原点からの半径 m） */
  wanderRadius: number;
}

export const DEFAULT_LOCOMOTION: LocomotionParams = {
  mode: 'crawl',
  canHop: true,
  hopHeight: 0.12,
  hopDistance: 0.15,
  crouchDepth: 0.72,
  crouchTime: 0.22,
  restTime: 0.25,
  crawlStretch: 1.1,
  crawlSquash: 0.82,
  crawlBend: 0.15,
  crawlRhythm: 0.35,
  turnSpeed: 2.2,
  hopTurnMax: 30,
  crawlTurnMax: 60,
  arriveRadius: 0.2,
  wander: false,
  wanderRadius: 3,
};

type State = 'idle' | 'crouch' | 'air' | 'land' | 'crawl' | 'recover' | 'lieDown' | 'lying' | 'getUp';

/**
 * 横になる体勢。体の部位は「前面の下部がお腹、底があんよ」。
 *   腹ばい … お腹を地面につける（前に倒れ、顔は前下を向く）
 *   仰向け … お腹を真上に向ける（後ろに倒れ、背中側＝後頭部が地面につく）
 */
export type LyingPose = 'prone' | 'supine';

/** お腹の向き：正面から下へこの角度 (rad) */
const BELLY_DOWN = (35 * Math.PI) / 180;

/** 横になったときの前傾の角度 (rad, + で前)。お腹を真下／真上に向ける */
function lyingLean(pose: LyingPose): number {
  return pose === 'prone' ? Math.PI / 2 - BELLY_DOWN : -(Math.PI / 2 + BELLY_DOWN);
}

const Y_AXIS = new Vector3(0, 1, 0);
const X_AXIS = new Vector3(1, 0, 0);

/**
 * 「Y軸まわりの向き × 体に固定した回転 local」で表される姿勢のうち、current に最も近いものを返す。
 * 横になる・転がる・起き上がるときに、余計に回らない向きを選ぶのに使う
 */
function nearestPose(local: Quaternion, current: Quaternion, out: Quaternion): Quaternion {
  const q = new Quaternion();
  let best = 0;
  let bestAngle = Infinity;
  const search = (from: number, to: number, step: number) => {
    for (let a = from; a <= to; a += step) {
      q.setFromAxisAngle(Y_AXIS, a).multiply(local);
      const ang = q.angleTo(current);
      if (ang < bestAngle) {
        bestAngle = ang;
        best = a;
      }
    }
  };
  search(-Math.PI, Math.PI, Math.PI / 18);
  search(best - Math.PI / 18, best + Math.PI / 18, Math.PI / 180);
  return out.setFromAxisAngle(Y_AXIS, best).multiply(local);
}

/** 腹ばい／仰向けの体に固定した回転 */
function lyingLocal(pose: LyingPose): Quaternion {
  return new Quaternion().setFromAxisAngle(X_AXIS, lyingLean(pose));
}

const STATE_LABEL: Record<State, string> = {
  idle: '待機',
  crouch: '溜め',
  air: '跳躍中',
  land: '着地',
  crawl: '這う',
  recover: '体勢を立て直す',
  lieDown: '横になる',
  lying: '横になっている',
  getUp: '起き上がる',
};

/** これ以上傾いたら転倒とみなして起き上がる (rad) */
const FALLEN = (50 * Math.PI) / 180;
/** 姿勢の段階を終えたとみなす、体と目標の姿勢の差 (rad) */
const POSE_TOLERANCE = (15 * Math.PI) / 180;
/** 指令が目標に届いてから、体が追いつかなくても次の段階へ進むまでの時間 (s) */
const POSE_WAIT = 0.8;
/** 横になる・寝返りで転がる・起き上がる角速度 (rad/s) */
const LIE_SPEED = 1.3;
/**
 * 横になる・転がる・起き上がる間の姿勢を保つ強さの下限。
 * 平たい体型（扁平型）は横倒しにすると元の向きへ戻ろうとする力が強いので、しっかり保つ
 */
const LIE_POSTURE = 0.5;
const ROLL_SPEED = 1.8;
const RISE_SPEED = 1.2;
/** 起き上がり完了とみなす傾き (rad) */
const RECOVERED = (10 * Math.PI) / 180;

/**
 * 移動しながら向きを変えるときの、1回に進む距離の倍率。
 * 目的地が正面なら 1、真横なら約 0.5、真後ろなら最小値。後ろの目的地へは小刻みに進みながら振り向く
 * （大回りしたり、目的地のまわりを回り続けたりしないように）
 */
/** 跳び出した直後に体をひねる速さ (rad/s) */
const HOP_TWIST_SPEED = 9;

function headingFactor(yawErr: number): number {
  return Math.max(0.15, (Math.cos(yawErr) + 1) / 2);
}
/**
 * 跳躍中（溜め・空中・着地）の姿勢を保つ強さの下限。
 * 後部が重い体型（ひよこ型・なすび型）は縮むと前に回転しやすいので、踏ん張って姿勢を保つ
 */
const HOP_POSTURE = 0.5;
/** 空中での姿勢を保つ強さの下限（跳び出した直後のひねりを空中で終えるため） */
const AIR_POSTURE = 0.85;
/** 跳ぶ高さの下限 (m)。これより低いと柔らかい底が地面から離れられない */
export const MIN_HOP_HEIGHT = 0.12;

/**
 * 移動の制御。ソフトボディの「筋肉」入力（伸縮・前傾・向き・底の滑り）を時間変化させて体を動かす。
 * 跳躍の踏み切りだけは地面を蹴る力として全体に速度を与える。
 */
export class Locomotion {
  readonly target = new Vector3();
  hasTarget = false;
  /**
   * ほかの動き（食べるなど）をしている。うろつかず、行き先を指示されても動かずに覚えておき、
   * release() で動き出す
   */
  private holding = false;
  /** 動けない間に指示された行き先がある（target に入っている） */
  deferred = false;
  private state: State = 'idle';
  private t = 0;
  private airborne = false;
  private squash = 1;
  private stretch = 1;
  private bend = 0;
  /** 這う動作の今回の伸び縮みの大きさ（目的地が近いと小さくする） */
  private crawlAmp = 1;
  private lean = 0;
  private idleFor = 0;
  private idleWait = 2;
  /** 横になる向き（+1 腹ばい / -1 仰向け） */
  private lieSign = 1;
  /**
   * 横になる・寝返り・起き上がるときの姿勢の指令。
   *   立ち姿 ⇔ 腹ばい／仰向け … phaseTarget へそのまま前後に倒れる・起き上がる
   *   腹ばい ⇔ 仰向け（寝返り） … 体を横たえた向きの水平な軸まわりに 180° 転がる
   */
  private readonly poseCmd = new Quaternion();
  private readonly phaseTarget = new Quaternion();
  /** 寝返り中か */
  private rolling = false;
  private readonly rollStart = new Quaternion();
  private readonly rollAxis = new Vector3();
  private rollAngle = 0;
  private rollSign = 1;
  private readonly _rq = new Quaternion();
  /** 姿勢の指令が目標に届いてからの時間 */
  private reachedFor = 0;
  /** 指令中の向き（目標の向きへ turnSpeed で近づける） */
  private cmdYaw: number | null = null;
  private readonly prevCenter = new Vector3();
  private readonly velocity = new Vector3();
  /** 今回の跳躍：踏み切り地点・進む距離・頂点の高さ・立ち姿勢の重心の高さ */
  private readonly hopFrom = new Vector3();
  private hopDist = 0;
  /**
   * 今回の跳躍の方向転換。溜めの間に背骨を曲げて顔を hopYaw0 + hopTurn へ向け、
   * そちらへ跳び、空中で体をひねって顔の向きに追いつかせる（曲げは戻す）
   */
  private hopYaw0 = 0;
  private hopTurn = 0;
  /** 今回の跳躍の方向（= hopYaw0 + hopTurn） */
  private hopYaw = 0;
  private hopDirX = 0;
  private hopDirZ = 1;
  /**
   * 這う動作の今回の伸び縮みでの方向転換。
   *   伸びる … 後ろの端を固定し、体を横に曲げて頭を新しい向きへ突き出す（体の向きは回さない）
   *   縮む   … 頭の端を固定し、横の曲げを戻しながら体の向きを crawlTurn だけ回す（後部が弧を描いてついてくる）
   */
  private crawlTurn = 0;
  private crawlYaw0 = 0;
  private sideBend = 0;
  private apexY = 0;
  private standY = 0;
  private readonly _v = new Vector3();
  /** 這う動作の今回の伸び縮みを始めた位置（1回で進んだ距離を測る） */
  private readonly cycleFrom = new Vector3();

  constructor(private readonly body: SoftBody, readonly params: LocomotionParams) {
    this.prevCenter.copy(body.center);
    this.standY = body.center.y;
  }

  get stateLabel(): string {
    if (this.state === 'lying' || this.state === 'lieDown') {
      const pose = this.lieSign > 0 ? '腹ばい' : '仰向け';
      return this.state === 'lying' ? pose : `${pose}になる`;
    }
    return STATE_LABEL[this.state];
  }

  /**
   * 横になる。立っていれば前（腹ばい）・後ろ（仰向け）へそのまま倒れ、
   * 反対の体勢で横になっていれば、起き上がらずに寝返りで切り替える。移動中なら移動をやめる
   */
  lieDown(pose: LyingPose): void {
    const b = this.body;
    const sign = pose === 'prone' ? 1 : -1;
    const lying = this.state === 'lieDown' || this.state === 'lying';
    this.hasTarget = false;
    if (lying && sign === this.lieSign) return; // すでにその体勢
    this.lieSign = sign;
    this.reachedFor = 0;
    if (lying) {
      // 寝返り：体を横たえた向き（頭の向きを水平にしたもの）を軸に、丸太のように 180° 転がる。
      // お腹は前面の下部にあるので、この転がりで腹ばい（お腹が真下）と仰向け（お腹が真上）が入れ替わる
      this.rolling = true;
      this.rollStart.copy(this.poseCmd);
      this.rollAxis.set(0, 1, 0).applyQuaternion(this.poseCmd);
      this.rollAxis.y = 0;
      if (this.rollAxis.lengthSq() < 1e-6) this.rollAxis.set(0, 0, 1).applyQuaternion(this.poseCmd).setY(0);
      this.rollAxis.normalize();
      this.rollAngle = 0;
      this.rollSign = Math.random() < 0.5 ? 1 : -1;
      this.phaseTarget.setFromAxisAngle(this.rollAxis, Math.PI).multiply(this.rollStart);
    } else {
      // 立ち姿から：今の向きのまま、前（腹ばい）・後ろ（仰向け）へ倒れる
      this.rolling = false;
      this.poseCmd.copy(b.rotation);
      this.phaseTarget.setFromAxisAngle(Y_AXIS, b.yaw).multiply(lyingLocal(pose));
    }
    this.go('lieDown');
  }

  /** 横になっていれば、そのまま体を起こして起き上がる */
  getUp(): void {
    if (this.state !== 'lieDown' && this.state !== 'lying') return;
    const b = this.body;
    this.rolling = false;
    this.reachedFor = 0;
    this.poseCmd.copy(b.rotation);
    nearestPose(new Quaternion(), b.rotation, this.phaseTarget);
    this.go('getUp');
  }

  /** 立って待機している（移動・体勢の切り替えをしていない）か */
  get idle(): boolean {
    return this.state === 'idle';
  }

  /** 横になり終えて止まっている（倒れ込み・寝返りの途中ではない）か */
  get resting(): boolean {
    return this.state === 'lying';
  }

  /** 横になっている体勢（倒れ込み中を含む）。立っていれば null */
  get lyingPose(): LyingPose | null {
    return this.isLying ? (this.lieSign > 0 ? 'prone' : 'supine') : null;
  }

  /** 横になっている（倒れ込み中を含む）か */
  get isLying(): boolean {
    return this.state === 'lieDown' || this.state === 'lying';
  }

  moveTo(x: number, z: number): void {
    this.target.set(x, 0, z);
    this.idleFor = 0;
    if (this.holding) this.deferred = true;
    else this.hasTarget = true;
  }

  stop(): void {
    this.hasTarget = false;
    this.deferred = false;
  }

  /** ほかの動きを始める：今の移動をやめ、終わるまで動かない */
  hold(): void {
    this.holding = true;
    if (this.hasTarget) this.deferred = true;
    this.hasTarget = false;
  }

  /** ほかの動きが終わった：その間に指示された行き先があれば動き出す */
  release(): void {
    this.holding = false;
    if (this.deferred) this.hasTarget = true;
    this.deferred = false;
  }

  /** 体を置き直したときなどに、移動・体勢を待機状態に戻す（横になっていても立った状態に戻る） */
  reset(): void {
    this.hasTarget = false;
    this.cmdYaw = null;
    this.squash = 1;
    this.stretch = 1;
    this.bend = 0;
    this.sideBend = 0;
    this.lean = 0;
    const act = this.body.actuation;
    act.squash = 1;
    act.stretch = 1;
    act.bend = 0;
    act.sideBend = 0;
    act.lean = 0;
    act.yaw = null;
    act.anchor = null;
    act.pivot = null;
    act.slideFriction = null;
    act.uprightMin = null;
    act.stiffnessMode = 'normal';
    act.orientation = null;
    this.rolling = false;
    this.go('idle');
  }

  update(dt: number, gravity: number): void {
    const b = this.body;
    const p = this.params;
    const act = b.actuation;
    this.t += dt;
    this.velocity.subVectors(b.center, this.prevCenter).divideScalar(dt);
    this.prevCenter.copy(b.center);

    // 目的地までの距離と向き
    const dx = this.target.x - b.center.x;
    const dz = this.target.z - b.center.z;
    const dist = Math.hypot(dx, dz);
    const wantYaw = Math.atan2(dx, dz);
    const yawErr = wrapAngle(wantYaw - b.yaw);
    const fx = Math.sin(b.yaw), fz = Math.cos(b.yaw);
    const needsMove = this.hasTarget && dist > p.arriveRadius;

    let squashGoal = 1;
    let leanGoal = 0;
    let rate = 8; // 伸縮の追従の速さ (1/s)
    let stretchGoal = 1;
    let bendGoal = 0;
    let sideGoal = 0;
    act.slideFriction = null;
    act.anchor = null;
    act.pivot = null;
    act.uprightMin = null;
    act.orientation = null;
    if (this.hasTarget) {
      // 向きを変えるのは決まった瞬間だけ（常に回し続けると機械的で、宙に浮いて見える）
      //   跳ねる … 跳び出した直後に、踏み切りで決めた方向へ素早く体をひねる
      //   這う   … 体を横に曲げて頭から向きを変える（'crawl' で指令する）。
      //            大きな方向転換も、伸び縮みを繰り返して弧を描きながら向きを変える
      if (this.cmdYaw === null) this.cmdYaw = b.yaw;
      if (this.state === 'air') {
        const err = wrapAngle(this.hopYaw - this.cmdYaw);
        const maxStep = HOP_TWIST_SPEED * dt;
        this.cmdYaw += Math.max(-maxStep, Math.min(maxStep, err));
      }
    } else {
      this.cmdYaw = null;
    }
    act.yaw = this.cmdYaw;

    // 転倒したら、何をしていても中断して起き上がる
    const tilt = tiltOf(b);
    // （自分から横になる・起き上がる途中は除く）
    const selfLying = this.state === 'lieDown' || this.state === 'lying' || this.state === 'getUp';
    if (this.state !== 'recover' && this.state !== 'air' && !selfLying && tilt > FALLEN) this.go('recover');
    let leanRate = 6; // 前傾の追従の速さ (1/s)

    // 立ち姿勢の重心の高さ（跳躍の基準）。止まっている間だけ更新する
    // （連続跳躍中は着地の反動で上下しているので使わない）
    if (this.state === 'idle') {
      this.standY += (b.center.y - this.standY) * Math.min(1, dt * 5);
    }

    switch (this.state) {
      case 'lieDown': {
        // 立ち姿から倒れる、または寝返りで転がる
        act.uprightMin = LIE_POSTURE;
        squashGoal = 0.95;
        const done = this.rolling ? this.followRoll(dt) : this.followPose(dt, LIE_SPEED);
        if (done) {
          this.rolling = false;
          this.go('lying');
        }
        act.orientation = this.poseCmd;
        break;
      }
      case 'lying': {
        act.uprightMin = LIE_POSTURE;
        act.orientation = this.poseCmd;
        // 行き先ができたら起き上がってから向かう
        if (this.hasTarget) this.getUp();
        break;
      }
      case 'getUp': {
        // 少し縮んで踏ん張り、そのまま体を起こす
        act.uprightMin = LIE_POSTURE;
        squashGoal = 0.92;
        if (this.followPose(dt, RISE_SPEED) && (tilt < RECOVERED || this.reachedFor > 2)) {
          // 起き上がりきれなくても、倒れていれば「体勢を立て直す」が引き継ぐ
          this.go('idle');
          break;
        }
        act.orientation = this.poseCmd;
        break;
      }
      case 'recover': {
        // 体をやや縮めて踏ん張り、全力で姿勢を戻す
        act.uprightMin = 1;
        squashGoal = 0.9;
        if (tilt < RECOVERED && this.t > 0.3) this.go('idle');
        break;
      }
      case 'idle': {
        this.idleFor += dt;
        if (!this.hasTarget && p.wander && !this.holding && this.idleFor > this.idleWait) {
          const a = Math.random() * Math.PI * 2;
          const r = Math.sqrt(Math.random()) * p.wanderRadius;
          this.moveTo(Math.cos(a) * r, Math.sin(a) * r);
          break; // 新しい行き先への判断は次のステップで行う
        }
        // 向きを変えてから動くのではなく、すぐに動き出して進みながら向きを変える
        if (needsMove) this.go(this.moveState());
        else if (this.hasTarget) this.arrive();
        break;
      }
      case 'crouch': {
        // 着地の反動で浮いている間は溜めを進めない
        if (b.groundContacts === 0) this.t -= dt;
        const k = Math.min(Math.max(this.t, 0) / p.crouchTime, 1);
        squashGoal = 1 - (1 - p.crouchDepth) * easeOut(k);
        leanGoal = 0.1 + 0.05 * k;
        rate = 30;
        // 背骨を曲げている間は姿勢を最大の強さで保つ（曲がった体を「回った」と読み取って
        // 体ごと回り始めるのを防ぐ。這うときと同じ）
        act.uprightMin = 1;
        // 溜めながら背骨を曲げて、顔（頭）を先に跳ぶ方向へ向ける。体の向きはまだ変えない
        sideGoal = this.hopTurn * easeOut(k);
        this.cmdYaw = this.hopYaw0;
        act.yaw = this.cmdYaw;
        if (k >= 1) {
          // 踏み切り：地面を蹴って離陸する。正確な軌道は離陸後に合わせる（'air' を参照）
          const hopHeight = Math.max(p.hopHeight, MIN_HOP_HEIGHT);
          // 顔が向いている方向（溜めで決めた向き）へ跳ぶ。
          // 目的地がそれより横や後ろにあるほど小さく跳んで、次の跳躍で向きを合わせる
          this.hopYaw = this.hopYaw0 + this.hopTurn;
          this.hopDirX = Math.sin(this.hopYaw);
          this.hopDirZ = Math.cos(this.hopYaw);
          const errAfter = wrapAngle(Math.atan2(dx, dz) - this.hopYaw);
          this.hopDist = Math.min(p.hopDistance, dist) * headingFactor(errAfter);
          this.apexY = this.standY + hopHeight;
          this.hopFrom.copy(b.center);
          const vy = Math.sqrt(2 * gravity * hopHeight);
          const vf = this.hopDist / ((2 * vy) / gravity);
          // 溜めで縮みながら下向きに動いているので、速度は足すのではなく狙いの値にそろえる
          const v = b.meanVelocity(this._v);
          b.addVelocity(this.hopDirX * vf - v.x, vy - v.y, this.hopDirZ * vf - v.z);
          this.airborne = false;
          this.go('air');
        }
        break;
      }
      case 'air': {
        // 地面を離れるまでは縮んだまま（伸びる動きで地面を押すと跳躍量が狂う）。
        // 離れたら空中で縦に伸び、落ち始めたら元に戻して着地に備える
        const rising = this.velocity.y > 0;
        squashGoal = !this.airborne ? this.squash : rising ? 1.12 : 1.0;
        leanGoal = 0.1;
        rate = 25;
        // 空中では体のひねりを着地までに終えられるよう、姿勢をより強く保つ
        act.uprightMin = AIR_POSTURE;
        // 体が顔の向きに追いつく分だけ背骨の曲げを戻す（顔は跳ぶ方向を向いたまま）
        sideGoal = wrapAngle(this.hopYaw - (this.cmdYaw ?? this.hopYaw));
        // 上昇中は底を前に滑らせる（伸びた底が地面を叩いても勢いを失わない）
        if (rising) act.slideFriction = 0.02;
        // 離陸の判定：底が完全に離れたか、重心が立ち姿勢の高さを超えて上昇している
        // （大きく柔らかい体は底が地面に触れたまま跳ぶことがある）。
        // 一度離陸してから、落ちてきて接地したら着地とする
        if (b.groundContacts === 0 || (rising && b.center.y > this.standY)) this.airborne = true;
        // 上昇中は毎ステップ軌道を合わせ直す（空中で伸びた底が地面を押して余分に加速するのを打ち消す）
        if (this.airborne && rising && b.center.y < this.apexY - 0.005) this.alignTrajectory(gravity, this.hopDirX, this.hopDirZ);
        if ((this.airborne && !rising && b.groundContacts > 0) || this.t > 2) this.go('land');
        break;
      }
      case 'land': {
        // 着地の潰れは物理で自然に起きる。少しだけ自分でも沈み込む
        // 前傾は保つ（接地中に傾きを戻すと底が前に滑ろうとして体が後ろへ押し戻される）
        squashGoal = this.t < 0.08 ? 0.92 : 1;
        leanGoal = 0.1;
        rate = 12;
        act.uprightMin = HOP_POSTURE;
        if (this.t > p.restTime) {
          if (!needsMove) this.arrive();
          else this.go(this.moveState());
        }
        break;
      }
      case 'crawl': {
        // 尺取り虫の動き：
        //   前半 … 後ろの底で踏ん張り、潰れながら頭（上部）を前に突き出して伸びる
        //   後半 … 前の底で踏ん張り、後部を引き寄せながら頭を起こして元の形に戻る
        const cycles = this.t * p.crawlRhythm;
        const u = cycles % 1;
        if (cycles >= 1) {
          // 1回の伸び縮みが終わったところでだけ、止まるかを判断する。
          // 次の1回で進む距離より目的地が近ければ、そこで止まる（通り過ぎない）。
          // 向きは這いながら変えるので、目的地が横や後ろにあるほど小さく伸び縮みする
          // 1回で進んだ距離は、向いている方向へ進んだ分だけで測る
          const stride = Math.max(0, (b.center.x - this.cycleFrom.x) * fx + (b.center.z - this.cycleFrom.z) * fz);
          this.cycleFrom.copy(b.center);
          if (!needsMove || dist < stride * 0.5) { this.arrive(); break; }
          this.t = u / p.crawlRhythm;
          this.planCrawlTurn(yawErr);
          const fullStride = stride / Math.max(this.crawlAmp, 0.15);
          this.crawlAmp = Math.min(1, dist / Math.max(fullStride, 0.1)) * headingFactor(yawErr - this.crawlTurn);
        }
        const extending = u < 0.5;
        const k = smooth(extending ? u * 2 : 1 - (u - 0.5) * 2);
        // 方向転換：伸びる間に背骨を曲げて頭（顔）ごと新しい向きへ向け、
        // 縮む間に曲げを戻しながら体の向きを回す（頭はその向きのまま、後部がついてくる）
        sideGoal = this.crawlTurn * k;
        this.cmdYaw = extending ? this.crawlYaw0 : this.crawlYaw0 + this.crawlTurn * (1 - k);
        act.yaw = this.cmdYaw;
        squashGoal = 1 - (1 - p.crawlSquash) * k * this.crawlAmp;
        stretchGoal = 1 + (p.crawlStretch - 1) * k * this.crawlAmp;
        bendGoal = p.crawlBend * k * this.crawlAmp;
        act.anchor = extending ? 'rear' : 'front';
        act.pivot = extending ? 'rear' : 'front';
        // 端を固定して伸び縮みすると体がせん断されて前のめりになるので、姿勢を強めに保つ
        act.uprightMin = 1;
        rate = 15;
        break;
      }
    }

    // 状況ごとに形に戻る強さを切り替える
    act.stiffnessMode =
      this.state === 'crouch' || this.state === 'air' || this.state === 'land' ? 'hop'
        : this.state === 'lieDown' || this.state === 'lying' || this.state === 'getUp'
          ? (this.lieSign > 0 ? 'prone' : 'supine')
          : 'normal';

    const s = Math.min(1, dt * rate);
    this.squash += (squashGoal - this.squash) * s;
    this.stretch += (stretchGoal - this.stretch) * s;
    this.bend += (bendGoal - this.bend) * s;
    this.sideBend += (sideGoal - this.sideBend) * s;
    this.lean += (leanGoal - this.lean) * Math.min(1, dt * leanRate);
    act.squash = this.squash;
    act.stretch = this.stretch;
    act.bend = this.bend;
    act.sideBend = this.sideBend;
    act.lean = this.lean;
  }

  /**
   * 全体の平均速度をそろえ、頂点の高さ apexY を通って
   * 立ち姿勢の高さで残りの距離ちょうどに着地する放物線に乗せる。
   * 全頂点に同じ速度を足すので、体の変形・揺れはそのまま残る。
   */
  private alignTrajectory(g: number, fx: number, fz: number): void {
    const b = this.body;
    const c = b.center;
    const up = Math.max(this.apexY - c.y, 0);
    const down = Math.max(this.apexY - this.standY, 0.01);
    const vy = Math.sqrt(2 * g * up);
    const flight = vy / g + Math.sqrt((2 * down) / g);
    const done = (c.x - this.hopFrom.x) * fx + (c.z - this.hopFrom.z) * fz;
    const vf = Math.max(this.hopDist - done, 0) / flight;
    const v = b.meanVelocity(this._v);
    b.addVelocity(fx * vf - v.x, vy - v.y, fz * vf - v.z);
  }

  /**
   * 姿勢の指令を目標へ一定の角速度で回す。指令が目標に届き、体も追いついたら true。
   * 体が追いつかないまま長く経ったら（引っかかり等）先へ進める
   */
  private followPose(dt: number, speed: number): boolean {
    this.poseCmd.rotateTowards(this.phaseTarget, speed * dt);
    if (this.poseCmd.angleTo(this.phaseTarget) > 1e-3) {
      this.reachedFor = 0;
      return false;
    }
    this.reachedFor += dt;
    const bodyClose = this.body.rotation.angleTo(this.phaseTarget) < POSE_TOLERANCE;
    return bodyClose || this.reachedFor > POSE_WAIT;
  }

  /** 寝返り：水平な軸まわりに一定の角速度で 180° 転がす。転がり終えて体も追いついたら true */
  private followRoll(dt: number): boolean {
    this.rollAngle = Math.min(Math.PI, this.rollAngle + ROLL_SPEED * dt);
    this._rq.setFromAxisAngle(this.rollAxis, this.rollSign * this.rollAngle);
    this.poseCmd.copy(this._rq).multiply(this.rollStart);
    if (this.rollAngle < Math.PI) return false;
    this.reachedFor += dt;
    const bodyClose = this.body.rotation.angleTo(this.poseCmd) < POSE_TOLERANCE;
    return bodyClose || this.reachedFor > POSE_WAIT;
  }

  private moveState(): State {
    return this.params.mode === 'hop' && this.params.canHop ? 'crouch' : 'crawl';
  }

  /** 這う動作の次の伸び縮みで変える向きを決める */
  private planCrawlTurn(yawErr: number): void {
    this.crawlYaw0 = this.cmdYaw ?? this.body.yaw;
    const max = (this.params.crawlTurnMax * Math.PI) / 180;
    this.crawlTurn = Math.max(-max, Math.min(max, yawErr));
  }

  private arrive(): void {
    this.hasTarget = false;
    this.go('idle');
  }

  private go(s: State): void {
    this.state = s;
    this.t = 0;
    if (s === 'crouch') {
      // 跳ぶ前に、今回の跳躍で向ける方向を決める（今の向きから最大 hopTurnMax まで目的地側へ）
      const b = this.body;
      const c = b.center;
      const yawErr = wrapAngle(Math.atan2(this.target.x - c.x, this.target.z - c.z) - b.yaw);
      this.hopYaw0 = b.yaw;
      const max = (this.params.hopTurnMax * Math.PI) / 180;
      this.hopTurn = Math.max(-max, Math.min(max, yawErr));
      this.cmdYaw = b.yaw;
    }
    if (s === 'crawl') {
      const b = this.body;
      const c = b.center;
      const dx = this.target.x - c.x, dz = this.target.z - c.z;
      const yawErr = wrapAngle(Math.atan2(dx, dz) - b.yaw);
      this.cmdYaw = b.yaw;
      this.planCrawlTurn(yawErr);
      this.crawlAmp = Math.min(1, Math.hypot(dx, dz) / 0.35) * headingFactor(yawErr - this.crawlTurn);
      this.cycleFrom.copy(c);
    }
    if (s === 'idle') {
      this.idleFor = 0;
      this.idleWait = 1 + Math.random() * 3;
    }
  }
}

/** 体の傾き（鉛直からの角度, rad） */
function tiltOf(b: SoftBody): number {
  const q = b.rotation;
  return Math.acos(Math.max(-1, Math.min(1, 1 - 2 * (q.x * q.x + q.z * q.z))));
}

function wrapAngle(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

/** 0→1 をなめらかにつなぐ（始めと終わりがゆっくり） */
function smooth(k: number): number {
  return 0.5 - 0.5 * Math.cos(Math.PI * k);
}

function easeOut(k: number): number {
  return 1 - (1 - k) * (1 - k);
}
