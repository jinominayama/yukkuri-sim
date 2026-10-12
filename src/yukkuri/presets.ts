import { DEFAULT_SHAPE, type BodyShapeParams } from './bodyShape';
import { DEFAULT_LOCOMOTION, type LocomotionParams } from './locomotion';
import { DEFAULT_SOFTBODY, type SoftBodyParams } from '../physics/SoftBody';
import { loadJSON, remove, saveJSON } from '../platform/storage';

/** 体型プリセット：体の形と、その体型に伴う運動能力 */
export interface BodyPreset {
  id: string;
  name: string;
  /** 体型の特徴（画面表示用の短い説明） */
  description: string;
  shape: BodyShapeParams;
  physics: SoftBodyParams;
  move: LocomotionParams;
}

/**
 * 体型プリセットの基準（各体型はここからの差分で定義する）。
 * ユーザー設定の初期値（DEFAULT_SHAPE / DEFAULT_LOCOMOTION）とは独立させ、
 * ユーザー設定を変えても他の体型が変わらないようにする
 */
const BASE_SHAPE: BodyShapeParams = {
  radius: 0.5,
  bodyLength: 0,
  headSize: 0.79,
  headHeight: 0.48,
  headForward: 0,
  rearSize: 0,
  rearBack: 0.5,
  rearHeight: -0.2,
  blend: 0.31,
  width: 1,
  heightScale: 1,
  length: 1,
  bottomFlat: 0.1,
  lean: 0,
  leanAngle: 0,
  faceSize: 1,
  faceHeight: 0,
};

const BASE_MOVE: LocomotionParams = {
  mode: 'crawl',
  canHop: true,
  hopHeight: 0.18,
  hopDistance: 0.4,
  crouchDepth: 0.72,
  crouchTime: 0.22,
  restTime: 0.25,
  crawlStretch: 1.12,
  crawlSquash: 0.82,
  crawlBend: 0.23,
  crawlRhythm: 0.5,
  turnSpeed: 2.2,
  hopTurnMax: 30,
  crawlTurnMax: 60,
  arriveRadius: 0.2,
  wander: false,
  wanderRadius: 3,
};

function preset(
  id: string, name: string, description: string,
  shape: Partial<BodyShapeParams>, move: Partial<LocomotionParams> = {}, physics: Partial<SoftBodyParams> = {},
): BodyPreset {
  return {
    id, name, description,
    shape: { ...BASE_SHAPE, ...shape },
    physics: { ...DEFAULT_SOFTBODY, ...physics },
    move: { ...BASE_MOVE, ...move },
  };
}

/** 資料「ゆっくりの体型」をもとにした体型プリセット */
export const BUILTIN_PRESETS: BodyPreset[] = [
  preset('ball', 'ボール型',
    '球に近く、底だけがやや潰れた理想的な健康体型。跳ねるのも這うのもバランスよくこなす。',
    { headSize: 0.95, headHeight: 0.12, blend: 0.4, bottomFlat: 0.08 },
    { mode: 'hop', hopHeight: 0.2, hopDistance: 0.45, crawlTurnMax: 30 },
    { proneStiffness: 0.55 }),
  preset('egg', 'たまご型',
    'やや下方向に広がった健康体型。運動能力に長け、高く遠くまで跳ねる。',
    { headSize: 0.66, headHeight: 0.62, blend: 0.85, bottomFlat: 0.12, width: 1.05, length: 1.05, faceSize: 1.12, faceHeight: -0.28 },
    { mode: 'hop', hopHeight: 0.26, hopDistance: 0.55, crouchTime: 0.18, restTime: 0.18 },
    { proneStiffness: 0.31 }),
  preset('chick', 'ひよこ型',
    '後部に餡が寄って膨らんだ不健康な体型。動きにムラがあり、跳躍はやや苦手。',
    { headSize: 0.8, headHeight: 0.4, headForward: 0.12, rearSize: 0.78, rearBack: 0.55, rearHeight: -0.22, blend: 0.4, bottomFlat: 0.25 },
    { mode: 'hop', hopHeight: 0.14, hopDistance: 0.3, crouchTime: 0.3, restTime: 0.45, hopTurnMax: 60 },
    { shapeStiffness: 0.205, proneStiffness: 0.015, supineStiffness: 0.105 }),
  preset('flat', '扁平型',
    '頭が大きく、全体が横に広がった体型。跳ねるのは苦手だが、接地面が広く這うのが速い。',
    { headSize: 0.95, headHeight: 0.76, blend: 0.45, width: 1.35, length: 1.2, heightScale: 0.62, bottomFlat: 0.15 },
    { mode: 'hop', hopHeight: 0.12, hopDistance: 0.2, crawlRhythm: 0.85, crawlStretch: 1.18, hopTurnMax: 20 },
    { shapeStiffness: 0.205, hopStiffness: 0.395, proneStiffness: 0.035, supineStiffness: 0.015 }),
  preset('eggplant', 'なすび型',
    '腹部が肥大化し、頭が極端に小さい体型。動くのが億劫で、移動はとても遅い。',
    { radius: 0.55, headSize: 0.68, headHeight: 0.95, rearSize: 0.85, rearBack: 0.35, rearHeight: -0.1, blend: 0.3, bottomFlat: 0.22, faceSize: 1.12, faceHeight: -0.28 },
    { mode: 'hop', hopHeight: 0.12, hopDistance: 0.21, crouchTime: 0.5, crawlRhythm: 0.5, crawlStretch: 1.1, crawlBend: 0.15 },
    { shapeStiffness: 0.32, hopStiffness: 0.38, proneStiffness: 0.085, supineStiffness: 0.035, upright: 0.13 }),
  preset('caterpillar', 'いもむし型',
    '前後に伸びた特殊な体型。太めのソーセージのような胴の前端に顔がある。主に這って移動する。',
    { radius: 0.42, bodyLength: 0.95, headSize: 0.98, headHeight: 0.06, headForward: 0.9, blend: 0.35, bottomFlat: 0.1 },
    { mode: 'crawl', hopHeight: 0.15, crawlRhythm: 0.6, crawlStretch: 1.2, crawlBend: 0.15, hopTurnMax: 60 },
    {
      edgeCompliance: 0.0053, volumeCompliance: 0.0022,
      shapeStiffness: 0.275, hopStiffness: 0.155, proneStiffness: 0.015, supineStiffness: 0.015,
    }),
];

export const USER_PRESET_ID = 'user';

/** プリセットのうち保存・上書きの対象になる部分 */
export type PresetData = Pick<BodyPreset, 'shape' | 'physics' | 'move'>;

const overrideKey = (id: string) => `preset.${id}`;
const LAST_PRESET_KEY = 'lastPreset';

/** ユーザー設定の初期設定 */
function factoryUserPreset(): BodyPreset {
  return {
    id: USER_PRESET_ID,
    name: 'ユーザー設定',
    description: '自由に調整するための設定。調整した値は「現在の値をこの体型に保存」で残せる。',
    shape: { ...DEFAULT_SHAPE },
    physics: { ...DEFAULT_SOFTBODY },
    move: { ...DEFAULT_LOCOMOTION },
  };
}

/** 各プリセットの初期設定（保存による上書き前） */
function factoryPresets(): BodyPreset[] {
  return [factoryUserPreset(), ...BUILTIN_PRESETS];
}

/** 保存済みの上書きを反映したプリセット。項目が増えても欠けた値は初期設定で補う */
function withOverride(base: BodyPreset): BodyPreset {
  const saved = loadJSON<Partial<PresetData>>(overrideKey(base.id));
  if (!saved) return base;
  // 旧項目「横になる間の形に戻る強さ」は、腹ばい・仰向けの両方に引き継ぐ
  const legacyTurn = (saved.move as { headTurnMax?: number } | undefined)?.headTurnMax;
  if (legacyTurn !== undefined && saved.move) {
    saved.move.hopTurnMax ??= legacyTurn;
    saved.move.crawlTurnMax ??= legacyTurn;
    delete (saved.move as { headTurnMax?: number }).headTurnMax;
  }
  const legacy = (saved.physics as { lyingStiffness?: number } | undefined)?.lyingStiffness;
  if (legacy !== undefined && saved.physics) {
    saved.physics.proneStiffness ??= legacy;
    saved.physics.supineStiffness ??= legacy;
    delete (saved.physics as { lyingStiffness?: number }).lyingStiffness;
  }
  return {
    ...base,
    shape: { ...base.shape, ...saved.shape },
    physics: { ...base.physics, ...saved.physics },
    move: { ...base.move, ...saved.move },
  };
}

/** 全プリセット（ユーザー設定が先頭。保存済みの上書きを反映済み） */
export function allPresets(): BodyPreset[] {
  return factoryPresets().map(withOverride);
}

export function findPreset(id: string): BodyPreset | undefined {
  return allPresets().find((p) => p.id === id);
}

/** 現在の値でプリセットを上書き保存する */
export function savePreset(id: string, data: PresetData): boolean {
  return saveJSON(overrideKey(id), { shape: data.shape, physics: data.physics, move: data.move });
}

/** プリセットの上書きを消して初期設定に戻す。戻した後のプリセットを返す */
export function resetPreset(id: string): BodyPreset | undefined {
  remove(overrideKey(id));
  return findPreset(id);
}

/** プリセットが保存で上書きされているか */
export function isOverridden(id: string): boolean {
  return loadJSON(overrideKey(id)) !== null;
}

/** 最後に選んだプリセット（起動時に使う。なければユーザー設定） */
export function loadStartPreset(): BodyPreset {
  // 旧形式（ユーザー設定だけを保存していた版）のデータを引き継ぐ
  const legacy = loadJSON<PresetData>('userPreset');
  if (legacy) {
    if (!isOverridden(USER_PRESET_ID)) savePreset(USER_PRESET_ID, legacy);
    remove('userPreset');
  }
  const id = loadJSON<string>(LAST_PRESET_KEY);
  return (id && findPreset(id)) || findPreset(USER_PRESET_ID)!;
}

export function saveLastPresetId(id: string): void {
  saveJSON(LAST_PRESET_KEY, id);
}
