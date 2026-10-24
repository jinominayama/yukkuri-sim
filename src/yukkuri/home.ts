import { loadJSON, saveJSON } from '../platform/storage';

/**
 * おうち（ゆっくりぷれいす）：おうちせんげんをした場所（地面の上の位置）を覚える。画面には何も出さない。
 * 巣作りなど、あとで作る動きの起点にする。せんげんし直すと、その場所に置き換わる。保存して、読み直しても残す
 */
const STORAGE_KEY = 'home';

export interface HomeSpot {
  /** 地面の上の位置（ワールドの x, z） */
  x: number;
  z: number;
  /** せんげんしたときに向いていた向き（rad） */
  yaw: number;
}

export class Home {
  private spot: HomeSpot | null;

  constructor() {
    const saved = loadJSON<HomeSpot>(STORAGE_KEY);
    this.spot = saved && Number.isFinite(saved.x) && Number.isFinite(saved.z) ? { x: saved.x, z: saved.z, yaw: saved.yaw ?? 0 } : null;
  }

  /** おうち（決めていなければ null） */
  get current(): Readonly<HomeSpot> | null {
    return this.spot;
  }

  /** おうちをこの場所に決める */
  set(x: number, z: number, yaw: number): void {
    this.spot = { x, z, yaw };
    saveJSON(STORAGE_KEY, this.spot);
  }

  /** おうちを忘れる */
  clear(): void {
    this.spot = null;
    saveJSON(STORAGE_KEY, null);
  }
}
