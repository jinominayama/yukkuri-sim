import * as THREE from 'three';
import { loadJSON, saveJSON } from '../platform/storage';
import { createAccessoryOutlineMaterial } from '../render/outlineMaterial';
import { FaceIndex } from './FaceIndex';
import { HairShell } from './HairShell';
import { Braid } from './Braid';
import { WitchHat } from './WitchHat';
import { findCharacter } from './index';
import type { Accessory, AttachContext, CharacterDef, OutfitParams } from './types';

const STORAGE_KEY = 'outfit';

export const DEFAULT_OUTFIT: OutfitParams = {
  showHair: true,
  showHat: true,
  showBraid: true,
  hatScale: 1,
  hatX: 0,
  hatY: 0,
  hatZ: 0,
  hatTilt: 5,
  hatSide: 6,
  hairThickness: 0.035,
  braidLength: 0.75,
  hairParts: {},
};

/** 体型ごとに別々に持つ調整値（帽子の大きさ・位置・傾き、髪の厚み、三つ編みの長さ） */
const FIT_KEYS = ['hatScale', 'hatX', 'hatY', 'hatZ', 'hatTilt', 'hatSide', 'hairThickness', 'braidLength'] as const;
type Fit = Pick<OutfitParams, (typeof FIT_KEYS)[number]>;

interface Saved {
  character: string;
  params: OutfitParams;
  /** 体型 ID → その体型の調整値（初期値のままの体型は持たない） */
  fits?: Record<string, Fit>;
}

/**
 * ゆっくり1体の装飾（キャラクター）。選んだキャラクターのアクセサリーを作り、
 * 体型が変わったら付け直し、毎フレーム体の形に合わせて動かす
 */
export class Outfit {
  readonly object = new THREE.Group();
  readonly params: OutfitParams;
  characterId: string;
  /** 保存された設定がなかった（初めて開いた） */
  readonly fresh: boolean;
  private accessories: Accessory[] = [];
  /** 体型 ID → 調整値（初期値から変えた体型だけ） */
  private fits: Record<string, Fit>;
  /** 今の体型（調整値をどの体型のものとして読み書きするか） */
  private presetId = '';
  /** 体型ごとに持つ前の版で保存した調整値（最初に使う体型に引き継ぐ） */
  private legacyFit: Fit | null = null;
  private readonly index = new FaceIndex();
  private readonly ctx: AttachContext;

  constructor(geometry: THREE.BufferGeometry, bodyMaterial: THREE.ShaderMaterial, outlineMaterial: THREE.ShaderMaterial) {
    const stored = loadJSON<Partial<Saved>>(STORAGE_KEY);
    const saved = stored ?? {};
    this.fresh = stored === null || stored === undefined;
    this.characterId = saved.character ?? 'none';
    this.params = { ...DEFAULT_OUTFIT, ...saved.params };
    this.params.hairParts = { ...this.params.hairParts };
    delete (this.params as unknown as Record<string, unknown>).hatHeight; // 旧版の調整値
    this.fits = { ...saved.fits };
    if (!saved.fits && saved.params) this.legacyFit = pickFit(this.params);
    this.ctx = {
      geometry,
      pos: geometry.getAttribute('position').array as Float32Array,
      nrm: new Float32Array(0),
      index: this.index,
      bodyMaterial,
      // 体と同じ輪郭線（太さ・色を共有）。地面より下に行かない
      outlineMaterial: createAccessoryOutlineMaterial(outlineMaterial),
    };
  }

  get character(): CharacterDef {
    return findCharacter(this.characterId);
  }

  /** キャラクターを切り替える（調整値はそのキャラクターの初期値に戻す） */
  setCharacter(id: string, resetParams = true): void {
    this.characterId = id;
    if (resetParams) {
      const d = findCharacter(id).defaults;
      Object.assign(this.params, DEFAULT_OUTFIT, d);
      // 入れ物ごと共有しないよう写す（選ぶと初期値まで書き換わってしまう）
      this.params.hairParts = { ...d?.hairParts };
      this.fits = {};
      this.legacyFit = null;
    }
    this.create();
    this.save();
  }

  /**
   * 体型を切り替える：体型ごとの調整値を、その体型で保存したもの（なければキャラクターの初期値）にする。
   * 付け直しは呼び出し側で（体型を置き直すときに一緒に行われる）
   */
  usePreset(id: string): void {
    this.presetId = id;
    const fit = this.legacyFit ?? this.fits[id];
    this.legacyFit = null;
    Object.assign(this.params, this.fitDefaults(), fit);
    this.save();
  }

  /** 今の体型の調整値（帽子・髪の厚み・三つ編みの長さ）を、キャラクターの初期値に戻す。付け直しは呼び出し側で */
  resetFit(): void {
    delete this.fits[this.presetId];
    Object.assign(this.params, this.fitDefaults());
    this.save();
  }

  /** 今の体型ごとの調整値を、別の体型（ユーザー設定など）にも写す */
  copyFitTo(id: string): void {
    if (id === this.presetId) return;
    const fit = pickFit(this.params);
    if (sameFit(fit, this.fitDefaults())) delete this.fits[id];
    else this.fits[id] = fit;
    this.save();
  }

  private fitDefaults(): Fit {
    return pickFit({ ...DEFAULT_OUTFIT, ...this.character.defaults });
  }

  /**
   * 体型に合わせて制限した調整値（帽子の前後の傾き）を、調整値そのものにも反映する。
   * 画面で動かしたとき用（スライダーが制限の所で止まる）。変わったら true
   */
  applyLimits(): boolean {
    const hat = this.accessories.find((a): a is WitchHat => a instanceof WitchHat);
    if (!hat || hat.tiltUsed === this.params.hatTilt) return false;
    this.params.hatTilt = hat.tiltUsed;
    return true;
  }

  /** アクセサリーを作り直す */
  create(): void {
    for (const a of this.accessories) {
      this.object.remove(a.object);
      a.dispose?.();
    }
    this.accessories = this.character.create(this.ctx, this.params);
    for (const a of this.accessories) this.object.add(a.object);
    // 三つ編みの編み始めは帽子の外へ（帽子を表示しているときだけ）
    const hat = this.accessories.find((a): a is WitchHat => a instanceof WitchHat);
    for (const a of this.accessories) {
      if (a instanceof Braid && hat) a.cover = (p) => this.params.showHat && hat.covers(p);
    }
    this.rebuild();
  }

  /** 体型（静止形状・顔の位置）が変わったときに呼ぶ */
  rebuild(): void {
    const u = this.ctx.bodyMaterial.uniforms;
    const rest = this.ctx.geometry.getAttribute('aRest');
    if (!rest) return;
    this.index.build(rest.array as Float32Array, u.uHeadC.value as THREE.Vector3, u.uHeadR.value as number);
    this.refreshArrays();
    for (const a of this.accessories) a.rebuild(this.ctx);
    this.applyVisibility();
  }

  /** 描画の直前に呼ぶ（体の描画メッシュを更新した後） */
  update(): void {
    if (this.accessories.length === 0) return;
    this.refreshArrays();
    // 帽子を先に（三つ編みが帽子の今の位置を見るので）
    for (const a of this.accessories) if (a instanceof WitchHat) a.update(this.ctx);
    for (const a of this.accessories) if (!(a instanceof WitchHat)) a.update(this.ctx);
  }

  /** 髪型のパーツの今の選択（未選択なら先頭の選択肢） */
  hairPart(part: string): string {
    const def = this.character.hairParts?.find((p) => p.part === part);
    const id = this.params.hairParts[part];
    return def?.options.some((o) => o.id === id) ? id : (def?.options[0]?.id ?? '');
  }

  /** 髪型のパーツを選ぶ（髪を描き直して保存） */
  setHairPart(part: string, id: string): void {
    this.params.hairParts[part] = id;
    for (const a of this.accessories) if (a instanceof HairShell) a.repaint();
    this.save();
  }

  applyVisibility(): void {
    for (const a of this.accessories) {
      if (a instanceof HairShell) a.object.visible = this.params.showHair;
      else if (a instanceof WitchHat) a.object.visible = this.params.showHat;
      else if (a instanceof Braid) a.object.visible = this.params.showBraid;
    }
  }

  save(): void {
    if (this.presetId) {
      const fit = pickFit(this.params);
      if (sameFit(fit, this.fitDefaults())) delete this.fits[this.presetId];
      else this.fits[this.presetId] = fit;
    }
    saveJSON(STORAGE_KEY, { character: this.characterId, params: this.params, fits: this.fits } satisfies Saved);
  }

  private refreshArrays(): void {
    const g = this.ctx.geometry;
    this.ctx.pos = g.getAttribute('position').array as Float32Array;
    this.ctx.nrm = (g.getAttribute('normal')?.array as Float32Array) ?? new Float32Array(this.ctx.pos.length);
  }
}

function pickFit(p: OutfitParams): Fit {
  return Object.fromEntries(FIT_KEYS.map((k) => [k, p[k]])) as Fit;
}

function sameFit(a: Fit, b: Fit): boolean {
  return FIT_KEYS.every((k) => Math.abs(a[k] - b[k]) < 1e-9);
}
