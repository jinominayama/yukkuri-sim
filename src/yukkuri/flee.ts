import * as THREE from 'three';
import { showFace, type Word } from './fx';
import type { PartSelection } from '../face/parts';
import type { MoveMode } from './locomotion';
import type { Yukkuri } from './Yukkuri';

/**
 * 汚れから離れる：うんうん・吐いた餡子の近くにしばらくいると、嫌がる一言とともに、汚れのない所まで移動する。
 *   ・ストレスが STRESS_CRAWL 以上なら這う（元気がない）。それより下なら跳ねる（跳ねられない体型は這う）
 *   ・寝転がっていれば、起き上がってから離れる
 *   ・食べる・うんうん・体操・吐餡・もるんもるんの最中は離れない（その動きを優先する）
 *   ・行き先：今いる所のまわりを、近い順・汚れから遠ざかる向きの順に探し、体の広がり＋「近いとみなす距離」に
 *     汚れが入らない所を選ぶ。見つからなければ、汚れのかたまりの反対側へ遠めに行く
 * 「近いか」の判定と距離は Stress と同じもの（調整パネルの「ストレスのたまり方」→「近いとみなす距離」）を使う
 */

/** 近くにこの時間（秒）いたら離れ始める（すっきりーで跳ねた直後などに、すぐ逃げ出さないように） */
const REACT_AFTER = 1.2;
/** ストレスがこれ以上なら這う */
const STRESS_CRAWL = 50;
/** 行き先を探す：向きの数と、距離（体の広がり＋近いとみなす距離 に足す m）の候補 */
const DIRECTIONS = 16;
const EXTRA_DISTANCES = [0.3, 0.6, 1.0, 1.5, 2.2];
/** 行き先に余分に空ける距離（m。着いた所が判定の縁ぎりぎりにならないように） */
const CLEAR_MARGIN = 0.15;
/** 離れ終えたのにまだ近いとき、もう一度試すまでの時間（秒） */
const RETRY_AFTER = 3;
/** 移動し始めてからこの時間（秒）たっても着かなければやめる（引っかかったとき） */
const GIVE_UP = 20;
/** 原点からこれより遠い所は行き先にしない（m。画面の外へ行ってしまわないように） */
const MAX_RANGE = 4.5;

/** 嫌がる一言（跳ねて離れるとき＝まだ元気、這って離れるとき＝ぐったり） */
const LINES_HOP = [
  'ここはゆっくりできないよ！',
  'くさいよ！ゆっくりできないよ！',
  'ゆっくりできないものがあるよ！',
  'こんなところじゃゆっくりできないよ！',
  'ゆっくりしないでおひっこしするよ！',
  'ゆゆっ！？きたないよ！',
];
const LINES_CRAWL = [
  'ここは…ゆっくりできない…よ…',
  'もう…やだ…ゆっくりしたい…',
  'ゆぅ…くさくて…ゆっくりできない…',
  'ゆっくり…できるところに…いきたい…',
  'どぼじで…ゆっくりできないの…',
];
/** 顔：跳ねるときは怒って顔をしかめる、這うときは困って泣きそう */
const FACE_HOP: Partial<PartSelection> = { eyes: 'half', brows: 'angry', mouth: 'grit' };
const FACE_CRAWL: Partial<PartSelection> = { eyes: 'tearyNarrow', brows: 'worried', mouth: 'sob' };

type Phase = 'none' | 'getUp' | 'moving';

export class Flee {
  private phase: Phase = 'none';
  /** 汚れの近くにいる時間（秒） */
  private nearFor = 0;
  private retryIn = 0;
  private t = 0;
  /** 決めた行き先（ほかの行き先を指示されたら、離れるのをやめる） */
  private readonly dest = new THREE.Vector3();
  private word: Word | null = null;
  /** こちらで出した顔（ほかの動きが顔を変えていたら、戻すときに触らない） */
  private face: Partial<PartSelection> | null = null;

  constructor(private readonly y: Yukkuri) {}

  /** 汚れから離れている最中か */
  get active(): boolean {
    return this.phase !== 'none';
  }

  /** 固定時間刻みで呼ぶ（ストレスの「近いか」を調べた後） */
  update(dt: number): void {
    const y = this.y;
    this.retryIn -= dt;
    if (this.busy()) {
      if (this.active) this.end();
      this.nearFor = 0;
      return;
    }
    const loco = y.locomotion;
    switch (this.phase) {
      case 'none': {
        this.nearFor = y.stress.near ? this.nearFor + dt : 0;
        if (this.nearFor >= REACT_AFTER && this.retryIn <= 0) this.begin();
        break;
      }
      case 'getUp': {
        // 起き上がり終えたら動き出す
        if (!loco.tilted && loco.idle) this.go();
        else if (loco.resting) y.getUp(); // 寝返りで横へずれた後など、まだ寝転んでいれば起き上がり直す
        break;
      }
      case 'moving': {
        this.t += dt;
        // 着いた（行き先がなくなった）・ほかの行き先を指示された・引っかかった
        const other = loco.target.distanceTo(this.dest) > 1e-3;
        if (!loco.hasTarget || other || this.t > GIVE_UP) this.end();
        break;
      }
    }
  }

  private begin(): void {
    const y = this.y;
    this.nearFor = 0;
    const crawl = y.stress.value >= STRESS_CRAWL || !y.move.canHop;
    const lines = crawl ? LINES_CRAWL : LINES_HOP;
    this.say(lines[Math.floor(Math.random() * lines.length)]);
    if (!y.face.override) {
      showFace(y, crawl ? FACE_CRAWL : FACE_HOP, crawl ? { tears: 'few' } : {});
      this.face = y.face.override;
    }
    if (y.locomotion.tilted) {
      this.phase = 'getUp';
      y.getUp();
    } else this.go();
  }

  /** 行き先を決めて動き出す */
  private go(): void {
    const y = this.y;
    const loco = y.locomotion;
    const to = this.destination();
    // 跳ねる・這うは、そのときのストレスで決める（起き上がっている間に変わっていることもある）
    const mode: MoveMode = y.stress.value >= STRESS_CRAWL || !y.move.canHop ? 'crawl' : 'hop';
    loco.modeOverride = mode;
    loco.moveTo(to.x, to.z);
    this.dest.copy(loco.target);
    this.phase = 'moving';
    this.t = 0;
  }

  private end(): void {
    const y = this.y;
    y.locomotion.modeOverride = null;
    if (this.face && y.face.override === this.face) y.face.override = null;
    this.face = null;
    this.phase = 'none';
    this.nearFor = 0;
    this.retryIn = RETRY_AFTER;
  }

  /**
   * 汚れのない行き先。今いる所から近い順に、汚れのかたまりから遠ざかる向きを先に試す。
   * どこもだめなら、汚れの反対側へ一番遠い候補の距離だけ行く
   */
  private destination(): THREE.Vector3 {
    const y = this.y;
    const c = y.center;
    const reach = y.stress.reach();
    const clear = reach + y.stress.params.nearDist + CLEAR_MARGIN;
    const away = y.stress.dirtAway(c);
    const base = Math.atan2(away.x, away.z);
    const p = new THREE.Vector3();
    for (const extra of EXTRA_DISTANCES) {
      const dist = clear + extra;
      // 汚れから遠ざかる向きから、左右へ交互に広げて試す
      for (let k = 0; k < DIRECTIONS; k++) {
        const step = Math.ceil(k / 2) * (k % 2 ? 1 : -1);
        const a = base + (step * Math.PI * 2) / DIRECTIONS;
        p.set(c.x + Math.sin(a) * dist, 0, c.z + Math.cos(a) * dist);
        if (Math.hypot(p.x, p.z) > MAX_RANGE) continue;
        if (!y.stress.dirtWithin(p, clear)) return p;
      }
    }
    const far = clear + EXTRA_DISTANCES[EXTRA_DISTANCES.length - 1];
    return p.set(c.x + Math.sin(base) * far, 0, c.z + Math.cos(base) * far);
  }

  /** 顔の上に一言 */
  private say(text: string): void {
    const y = this.y;
    const R = y.shape.radius;
    const pos = new THREE.Vector3(y.center.x, y.center.y + R * 1.5, y.center.z);
    if (this.word) y.texts.fade(this.word);
    this.word = y.texts.say(text, pos, R * 0.22, 2.6, new THREE.Vector3(0, R * 0.12, 0));
  }

  /** 食べている・うんうん・体操・吐いている・もるんもるんの最中か */
  private busy(): boolean {
    const y = this.y;
    return y.feeding.active || y.dropping.active || y.exercise.active || y.vomit.active || y.moru.active;
  }
}
