import * as THREE from 'three';
import { loadJSON, saveJSON } from '../platform/storage';
import { createAccessoryMaterial } from '../render/accessoryMaterial';
import { createAccessoryOutlineMaterial } from '../render/outlineMaterial';
import { withOutline } from '../character/shapes';
import { bodyFacing, faceFrame, showFace, type Word } from './fx';
import type { PartSelection } from '../face/parts';
import type { Yukkuri } from './Yukkuri';

/**
 * 足焼き：ゆっくりは饅頭なので、焼くとおいしくなる（指示）。ホットプレートに乗せて、「下ろす」まで焼く（指示：始める・やめるのボタン）。
 *   焼いた時間の合計で、跳ねられなくなる（初期値 10 秒）→ 移動できなくなる（30 秒）→ 「もっとゆっくりしたかったよ…」で死ぬ（60 秒）（指示）。
 *   焼いた後もそのまま治らない（指示。保存しないので、ページを読み直すと戻る）。
 * 焼かれている間は泣き叫んでもがく（指示）：「あぢゅい！」などと叫び、跳んで逃げようと体を伸び縮みさせるが、底が張り付いて動けない。
 * 「ジュー」の文字と湯気。底は焼けるにつれてこんがり茶色から黒っぽくなる（体の塗りの uBurn）。
 * 焼き加減（焼いた時間）は覚えておく（今後、食べたときのおいしさに使う）
 * つつかれたり叩かれたりしてホットプレートから外れたら（体の真ん中が焼き面の外へ出る・寝転がる）、そこで焼くのをやめる。
 * ホットプレートはその場に残し、「下ろす」で片付ける。焼くのは体の底が焼き面に着いている間だけ
 * 顔や背中を焼くのは作らない（指示）：寝転んだまま焼き面に乗っていたら（焼いている途中に倒された・残ったホットプレートにつついて乗せた）、
 * 焼き面の真ん中から離れる向きへ転がって逃げ出す（指示）。乗ってから・最後につついてから ESCAPE_DELAY 秒待ってから（その間につついて立たせられるように）。
 * つついて転がして、焼き面の上で立ち上がったら（Locomotion.knockStands）、また焼き始める（指示：つついて下ろしたのを、つついて戻す）
 */
type Phase = 'idle' | 'getUp' | 'grill' | 'after';

export interface GrillParams {
  /** 焼いた時間の合計（秒）がこれを超えると、跳ねられなくなる・移動できなくなる・死ぬ */
  noHop: number;
  noMove: number;
  death: number;
}

export const DEFAULT_GRILL: GrillParams = { noHop: 10, noMove: 30, death: 60 };
const STORAGE_KEY = 'grill';

/** ホットプレート：一辺（胴の半径に対する比）・厚み（m）。体は上に乗る（地面は平らなので、薄い板を体の下に敷く） */
const PLATE = 3.2;
const PLATE_T = 0.025;
/** もがく：跳ぼうとする間隔（秒。この範囲でランダム）と、伸びる・縮む時間（秒）・大きさ */
const STRUGGLE_MIN = 0.9;
const STRUGGLE_MAX = 1.8;
const STRETCH_TIME = 0.18;
const SQUASH_TIME = 0.22;
const STRETCH_UP = 1.14;
const SQUASH_DOWN = 0.86;
/** 震え（胴の半径に対する比）。焼かれている間と、下ろした後 */
const TREMBLE = 0.02;
const TREMBLE_AFTER = 0.008;
/** 叫ぶ間隔・「ジュー」の間隔・湯気を出す間隔（秒） */
const SCREAM_EVERY = 2.4;
const SIZZLE_EVERY = 0.9;
const STEAM_EVERY = 0.12;
/** 湯気：のぼる速さ（m/s）・消えるまでの時間（秒）・大きさ（胴の半径に対する比） */
const STEAM_RISE = 0.35;
const STEAM_LIFE = 1.4;
const STEAM_SIZE = 0.12;
/** 体の真ん中がホットプレートの縁からこの距離（胴の半径に対する比）より外へ出たら、外れたことにする */
const OFF_MARGIN = 0.1;
/**
 * 寝転んで焼き面に乗っていたら転がって逃げる：体の真ん中が縁からこの距離（胴の半径に対する比）より外へ出るまで、
 * この強さ（m/s。つつく強さと同じ単位）で 1 回ずつ転がる
 */
const ESCAPE_MARGIN = 0.7;
const ESCAPE_POWER = 4;
const ESCAPE_DELAY = 1.2;
/** つついて立たせたとき、体の真ん中が焼き面の縁からこの距離（胴の半径に対する比）より内側なら、また焼き始める */
const RESUME_MARGIN = 0.2;
/** 下ろした後、泣いている時間（秒） */
const AFTER_TIME = 3.5;
/** 焦げる高さ：静止形状の底から、高さに対する比（焼き始め → 死ぬまで焼いたとき） */
const BURN_TOP_MIN = 0.1;
const BURN_TOP_MAX = 0.24;

const FACE_GRILL: Partial<PartSelection> = { eyes: 'squeeze', brows: 'strain', mouth: 'wail', strain: 'max', blush: 'red', sweat: 'forehead,templeL,templeR,cheekL,cheekR' };
const AT_LEAST_GRILL: Partial<PartSelection> = { tears: 'lots', stream: 'lots' };
const FACE_AFTER: Partial<PartSelection> = { eyes: 'cry', brows: 'worried', mouth: 'sob', strain: 'light', sweat: 'forehead,templeL,templeR' };
const AT_LEAST_AFTER: Partial<PartSelection> = { tears: 'lots', stream: 'few' };

const PLATE_COLORS = { lit: '#4a4d52', shade: '#36383c', deep: '#232427', rim: '#8a8f96' };
const RIM_COLORS = { lit: '#c9ccd1', shade: '#a2a6ad', deep: '#7c8088', rim: '#ffffff' };
const KNOB_COLORS = { lit: '#e2463b', shade: '#b8322a', deep: '#8a221c', rim: '#ffd0c8' };

interface Puff { mesh: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>; t: number; v: THREE.Vector3 }

export class Grill {
  /** ホットプレートと湯気（シーンに置く） */
  readonly object = new THREE.Group();
  readonly params: GrillParams = { ...DEFAULT_GRILL, ...loadJSON<Partial<GrillParams>>(STORAGE_KEY) };
  /** 焼いた時間の合計（秒。保存しない） */
  cooked = 0;
  private phase: Phase = 'idle';
  private t = 0;
  private plate: THREE.Group | null = null;
  private readonly disposables: { dispose(): void }[] = [];
  private nextStruggle = 0;
  private struggleT = -1;
  private screamIn = 0;
  private sizzleIn = 0;
  private steamIn = 0;
  private readonly puffs: Puff[] = [];
  private readonly puffGeo = new THREE.SphereGeometry(1, 10, 8);
  private heading = 0;
  private readonly pose = new THREE.Quaternion();
  private readonly euler = new THREE.Euler(0, 0, 0, 'YXZ');
  private face: Partial<PartSelection> | null = null;
  private word: Word | null = null;

  constructor(private readonly y: Yukkuri) {}

  /** ホットプレートに乗っている間（起き上がるのを待つ間を含む） */
  get active(): boolean {
    return this.phase === 'getUp' || this.phase === 'grill';
  }

  /** 焼き加減の言葉（調整パネルの表示用） */
  get stateLabel(): string {
    const p = this.params;
    const s = `${this.cooked.toFixed(1)} 秒`;
    if (this.cooked >= p.death) return `${s}（焼け死んだ）`;
    if (this.cooked >= p.noMove) return `${s}（移動できない）`;
    if (this.cooked >= p.noHop) return `${s}（跳ねられない）`;
    return this.cooked > 0 ? `${s}（まだ動ける）` : '焼いていない';
  }

  save(): void {
    saveJSON(STORAGE_KEY, this.params);
  }

  /** ホットプレートに乗せて焼き始める（寝転がっていれば起き上がってから）。死んでいる・割れている・気絶中は何もしない */
  start(): boolean {
    const y = this.y;
    if (this.active || y.death.active || y.otabe.active || y.rest.fainting) return false;
    // 足焼きで移動できず寝転がっていれば、起き上がって乗れない
    if ((y.locomotion.isLying || y.locomotion.tilted) && y.stuck()) return false;
    y.rest.wake(true);
    if (y.feeding.active) y.feeding.cancel();
    y.locomotion.stop();
    y.locomotion.hold();
    if (y.locomotion.isLying || y.locomotion.tilted) {
      y.getUp();
      this.go('getUp');
    } else this.begin();
    return true;
  }

  /** 下ろす（ホットプレートを片付ける）。焼けた所はそのまま。外れて焼くのをやめた後なら、残っていたホットプレートを片付けるだけ */
  stop(): void {
    this.removePlate();
    if (this.active) this.leave();
  }

  /** 焼くのをやめる（下ろした・外れた）：泣き顔でしばらく震える。ホットプレートは片付けない */
  private leave(): void {
    const y = this.y;
    this.clearPose();
    y.tremble = TREMBLE_AFTER;
    this.showFace(FACE_AFTER, AT_LEAST_AFTER);
    this.say(y.line('grillAfter'), AFTER_TIME * 0.8, 0.22);
    this.go('after');
  }

  /** 固定時間刻みで呼ぶ */
  update(dt: number): void {
    this.updatePuffs(dt);
    this.escape(dt);
    this.resume();
    if (this.phase === 'idle') return;
    const y = this.y;
    this.t += dt;
    switch (this.phase) {
      case 'getUp':
        if ((y.locomotion.idle && !y.locomotion.tilted) || this.t > 6) this.begin();
        break;
      case 'grill':
        this.grill(dt);
        break;
      case 'after':
        y.tremble = TREMBLE_AFTER * (1 - Math.min(1, this.t / AFTER_TIME));
        if (this.t >= AFTER_TIME) this.end();
        break;
    }
  }

  /** 焼き始める：体の下にホットプレートを敷く（前のホットプレートが残っていれば、体の下へ置き直す） */
  private begin(): void {
    const y = this.y;
    this.heading = y.body.yaw;
    // ホットプレートが残っていて、その上に立っていれば置き直さない（つついて戻したとき）。なければ体の下に敷く
    const keep = !!this.plate && this.plateOffset(-RESUME_MARGIN) <= 0;
    this.makePlate();
    if (!keep) {
      this.plate!.position.set(y.center.x, 0, y.center.z);
      this.plate!.rotation.y = this.heading;
    }
    this.object.add(this.plate!);
    this.showFace(FACE_GRILL, AT_LEAST_GRILL);
    this.nextStruggle = 0.4;
    this.struggleT = -1;
    this.screamIn = 0;
    this.sizzleIn = 0;
    this.say(y.line('grillStart'), 1.6, 0.26);
    this.screamIn = SCREAM_EVERY;
    this.go('grill');
  }

  /** 焼いている間：焼き加減を進め、もがいて叫ぶ。決めた時間を超えたら跳ねられない・動けない・死ぬ */
  private grill(dt: number): void {
    const y = this.y;
    const p = this.params;
    // つつかれる・叩かれるなどでホットプレートから外れたら、焼くのをやめる
    if (this.offPlate()) {
      this.leave();
      return;
    }
    const before = this.cooked;
    // 焼くのは底が焼き面に着いている間だけ（跳ね上げられて宙にいる間は焼けない）
    if (y.body.groundContacts > 0) this.cooked += dt;
    this.applyBurn();
    const crossed = (v: number) => before < v && this.cooked >= v;
    if (crossed(p.noHop)) {
      y.locomotion.noHop = true;
      this.say(y.line('grillNoHop'), 2, 0.24);
      this.screamIn = SCREAM_EVERY;
    }
    if (crossed(p.noMove)) {
      y.locomotion.noHop = true;
      y.locomotion.immobile = true;
      this.say(y.line('grillNoMove'), 2, 0.24);
      this.screamIn = SCREAM_EVERY;
    }
    if (this.cooked >= p.death) {
      // 焼け死ぬ：下ろして「もっとゆっくりしたかったよ…」（指示）
      this.removePlate();
      this.clearPose();
      this.end();
      y.greet.say('greetLast');
      y.death.start();
      return;
    }
    y.tremble = TREMBLE;
    if (y.face.override !== this.face) this.showFace(FACE_GRILL, AT_LEAST_GRILL);
    // もがく：跳ぼうとして伸び上がり、底が張り付いて縮む（体はその場から動かない）
    this.nextStruggle -= dt;
    if (this.struggleT < 0 && this.nextStruggle <= 0) this.struggleT = 0;
    let squash = 1;
    if (this.struggleT >= 0) {
      this.struggleT += dt;
      const s = this.struggleT;
      if (s < STRETCH_TIME) squash = 1 + (STRETCH_UP - 1) * Math.sin((s / STRETCH_TIME) * Math.PI * 0.5);
      else if (s < STRETCH_TIME + SQUASH_TIME) {
        const u = (s - STRETCH_TIME) / SQUASH_TIME;
        squash = STRETCH_UP + (SQUASH_DOWN - STRETCH_UP) * Math.sin(u * Math.PI * 0.5);
      } else if (s < STRETCH_TIME + SQUASH_TIME * 2) {
        const u = (s - STRETCH_TIME - SQUASH_TIME) / SQUASH_TIME;
        squash = SQUASH_DOWN + (1 - SQUASH_DOWN) * u;
      } else {
        this.struggleT = -1;
        this.nextStruggle = STRUGGLE_MIN + Math.random() * (STRUGGLE_MAX - STRUGGLE_MIN);
      }
    }
    this.euler.set(0, this.heading, 0);
    this.pose.setFromEuler(this.euler);
    y.locomotion.gesture = { orientation: this.pose, squash, pin: true };
    // 叫ぶ・ジュー・湯気
    this.screamIn -= dt;
    if (this.screamIn <= 0) {
      this.say(y.line('grillScream'), 1.6, 0.26);
      this.screamIn = SCREAM_EVERY * (0.8 + Math.random() * 0.4);
    }
    this.sizzleIn -= dt;
    if (this.sizzleIn <= 0) {
      this.sizzle();
      this.sizzleIn = SIZZLE_EVERY * (0.7 + Math.random() * 0.6);
    }
    this.steamIn -= dt;
    while (this.steamIn <= 0) {
      this.steam();
      this.steamIn += STEAM_EVERY;
    }
  }

  /**
   * 寝転んで焼き面に乗っていたら、焼き面の真ん中から離れる向きへ転がって逃げる（顔・背中は焼かない）。
   * 寝転び終えて落ち着いているときに 1 回ずつ。下ろした後の泣いている間も逃げる（移動の保留を解く）
   */
  private escape(dt: number): void {
    const y = this.y;
    const plate = this.plate;
    const loco = y.locomotion;
    if (!plate || this.phase === 'grill' || this.phase === 'getUp' || !loco.resting) {
      this.restingFor = 0;
      return;
    }
    const R = y.shape.radius;
    const dx = y.center.x - plate.position.x, dz = y.center.z - plate.position.z;
    if (this.plateOffset(ESCAPE_MARGIN) > 0) {
      this.escaping = false;
      this.restingFor = 0;
      return;
    }
    // 乗ってすぐ・つつかれている間は転がらない（つついて立たせる間。転がすには何回かつつく）
    this.restingFor = y.poking.sincePoke < ESCAPE_DELAY ? 0 : this.restingFor + dt;
    if (this.restingFor < ESCAPE_DELAY && !this.escaping) return;
    // 真ん中から離れる向き（真ん中ちょうどなら、体の向きの横へ）
    let ex = dx, ez = dz;
    if (Math.hypot(ex, ez) < R * 0.05) {
      ex = Math.cos(y.body.yaw);
      ez = -Math.sin(y.body.yaw);
    }
    if (this.phase === 'after' && loco.held) loco.release();
    if (loco.knock(ex, ez, ESCAPE_POWER, 1) && !this.escaping) {
      this.escaping = true;
      this.say(y.line('grillEscape'), 1.6, 0.24);
    }
  }
  private escaping = false;
  private restingFor = 0;
  private stands = 0;

  /** つついて転がされ、焼き面の上で立ち上がったら、また焼き始める */
  private resume(): void {
    const loco = this.y.locomotion;
    if (loco.knockStands === this.stands) return;
    this.stands = loco.knockStands;
    if (!this.plate || this.phase === 'grill' || this.phase === 'getUp') return;
    if (this.plateOffset(-RESUME_MARGIN) > 0) return;
    if (this.phase === 'after') this.end();
    this.start();
  }

  /**
   * 体の真ん中が、焼き面の縁から外側へ（縁 + 胴の半径 × margin の線より）どれだけ出ているか（m。内側なら 0 以下）
   */
  private plateOffset(margin: number): number {
    const y = this.y;
    const plate = this.plate!;
    const R = y.shape.radius;
    const dx = y.center.x - plate.position.x, dz = y.center.z - plate.position.z;
    const a = plate.rotation.y;
    const lx = dx * Math.cos(a) - dz * Math.sin(a), lz = dx * Math.sin(a) + dz * Math.cos(a);
    const half = (R * PLATE) / 2 + R * margin;
    return Math.max(Math.abs(lx), Math.abs(lz)) - half;
  }

  /** ホットプレートから外れたか：体の真ん中が焼き面の外へ出た、または寝転がった・体勢が崩れた */
  private offPlate(): boolean {
    const y = this.y;
    const plate = this.plate;
    if (!plate) return true;
    if (y.locomotion.isLying || y.locomotion.tilted) return true;
    const half = (y.shape.radius * PLATE) / 2 + y.shape.radius * OFF_MARGIN;
    const dx = y.center.x - plate.position.x, dz = y.center.z - plate.position.z;
    const a = plate.rotation.y;
    const lx = dx * Math.cos(a) - dz * Math.sin(a), lz = dx * Math.sin(a) + dz * Math.cos(a);
    return Math.abs(lx) > half || Math.abs(lz) > half;
  }

  /** 焦げの強さと高さを体の塗りへ */
  private applyBurn(): void {
    const k = Math.min(1, this.cooked / Math.max(1e-3, this.params.death));
    const u = this.y.bodyMaterial.uniforms;
    u.uBurn.value = k;
    u.uBurnTop.value = BURN_TOP_MIN + (BURN_TOP_MAX - BURN_TOP_MIN) * k;
  }

  /** 体の下の縁あたりに「ジュー」 */
  private sizzle(): void {
    const y = this.y;
    const R = y.shape.radius;
    const a = Math.random() * Math.PI * 2;
    const pos = new THREE.Vector3(y.center.x + Math.sin(a) * R * 1.1, R * 0.15, y.center.z + Math.cos(a) * R * 1.1);
    y.texts.say(Math.random() < 0.5 ? 'ジュー' : 'ジュウウ', pos, R * 0.22, 1.0, new THREE.Vector3(0, R * 0.25, 0));
  }

  /** 体の底のまわりから湯気をひとつ */
  private steam(): void {
    const y = this.y;
    const R = y.shape.radius;
    const a = Math.random() * Math.PI * 2;
    const r = R * (0.75 + Math.random() * 0.35);
    const m = new THREE.Mesh(this.puffGeo, new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.5, depthWrite: false }));
    m.position.set(y.center.x + Math.sin(a) * r, 0.04, y.center.z + Math.cos(a) * r);
    m.scale.setScalar(R * STEAM_SIZE * 0.5);
    this.object.add(m);
    this.puffs.push({ mesh: m, t: 0, v: new THREE.Vector3(Math.sin(a) * 0.05, STEAM_RISE * (0.7 + Math.random() * 0.6), Math.cos(a) * 0.05) });
  }

  private updatePuffs(dt: number): void {
    const R = this.y.shape.radius;
    for (let i = this.puffs.length - 1; i >= 0; i--) {
      const p = this.puffs[i];
      p.t += dt;
      const k = p.t / STEAM_LIFE;
      p.mesh.position.addScaledVector(p.v, dt);
      p.mesh.scale.setScalar(R * STEAM_SIZE * (0.5 + k));
      p.mesh.material.opacity = 0.5 * (1 - k);
      if (k >= 1) {
        this.object.remove(p.mesh);
        p.mesh.material.dispose();
        this.puffs.splice(i, 1);
      }
    }
  }

  /** ホットプレート：黒い焼き面と銀の縁、手前に赤いつまみ（体の大きさに合わせて作る） */
  private makePlate(): void {
    if (this.plate) return;
    const y = this.y;
    const R = y.shape.radius;
    const outline = createAccessoryOutlineMaterial(y.outlineMaterial);
    const mat = (c: typeof PLATE_COLORS) => createAccessoryMaterial(y.bodyMaterial, c, { rim: 0.15, ground: -10 });
    const plateMat = mat(PLATE_COLORS), rimMat = mat(RIM_COLORS), knobMat = mat(KNOB_COLORS);
    const S = R * PLATE;
    const g = new THREE.Group();
    const top = new THREE.BoxGeometry(S, PLATE_T, S).translate(0, PLATE_T / 2, 0);
    const rim = new THREE.BoxGeometry(S + 0.06, PLATE_T * 0.6, S + 0.06).translate(0, PLATE_T * 0.3, 0);
    const box = new THREE.BoxGeometry(S * 0.3, PLATE_T * 2.2, R * 0.35).translate(0, PLATE_T * 1.1, S / 2 + R * 0.2);
    const knob = new THREE.CylinderGeometry(R * 0.06, R * 0.06, R * 0.05, 16).rotateX(Math.PI / 2).translate(S * 0.06, PLATE_T * 1.2, S / 2 + R * 0.38);
    this.disposables.push(outline, plateMat, rimMat, knobMat, top, rim, box, knob);
    g.add(withOutline(rim, rimMat, outline), withOutline(top, plateMat, outline), withOutline(box, rimMat, outline), withOutline(knob, knobMat, outline));
    this.plate = g;
  }

  private removePlate(): void {
    if (!this.plate) return;
    this.object.remove(this.plate);
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
    this.plate = null;
  }

  private clearPose(): void {
    const loco = this.y.locomotion;
    if (loco.gesture?.orientation === this.pose) loco.gesture = null;
  }

  private end(): void {
    const y = this.y;
    y.tremble = 0;
    if (this.face && y.face.override === this.face) y.face.override = null;
    this.face = null;
    if (this.phase !== 'idle') y.locomotion.release();
    this.phase = 'idle';
  }

  private showFace(f: Partial<PartSelection>, atLeast: Partial<PartSelection>): void {
    showFace(this.y, f, atLeast);
    this.face = this.y.face.override;
  }

  private go(phase: Phase): void {
    this.phase = phase;
    this.t = 0;
  }

  /** 顔の上に文字（前の文字は早めに消す） */
  private say(text: string, life: number, size: number): void {
    const y = this.y;
    const R = y.shape.radius;
    const facing = bodyFacing(y);
    const top = faceFrame(y, 0, 0.5).pos;
    const pos = new THREE.Vector3(y.center.x, Math.max(top.y, y.center.y + y.height * 0.5) + R * 0.35, y.center.z).addScaledVector(facing, R * 0.3);
    if (this.word) y.texts.fade(this.word);
    this.word = y.texts.say(text, pos, R * size, life, new THREE.Vector3(0, R * 0.15, 0));
  }
}
