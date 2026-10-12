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
};

interface Saved {
  character: string;
  params: OutfitParams;
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
  private readonly index = new FaceIndex();
  private readonly ctx: AttachContext;

  constructor(geometry: THREE.BufferGeometry, bodyMaterial: THREE.ShaderMaterial, outlineMaterial: THREE.ShaderMaterial) {
    const stored = loadJSON<Partial<Saved>>(STORAGE_KEY);
    const saved = stored ?? {};
    this.fresh = stored === null || stored === undefined;
    this.characterId = saved.character ?? 'none';
    this.params = { ...DEFAULT_OUTFIT, ...saved.params };
    delete (this.params as unknown as Record<string, unknown>).hatHeight; // 旧版の調整値
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
    if (resetParams) Object.assign(this.params, DEFAULT_OUTFIT, findCharacter(id).defaults);
    this.create();
    this.save();
  }

  /** アクセサリーを作り直す */
  create(): void {
    for (const a of this.accessories) {
      this.object.remove(a.object);
      a.dispose?.();
    }
    this.accessories = this.character.create(this.ctx, this.params);
    for (const a of this.accessories) this.object.add(a.object);
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
    for (const a of this.accessories) a.update(this.ctx);
  }

  applyVisibility(): void {
    for (const a of this.accessories) {
      if (a instanceof HairShell) a.object.visible = this.params.showHair;
      else if (a instanceof WitchHat) a.object.visible = this.params.showHat;
      else if (a instanceof Braid) a.object.visible = this.params.showBraid;
    }
  }

  save(): void {
    saveJSON(STORAGE_KEY, { character: this.characterId, params: this.params } satisfies Saved);
  }

  private refreshArrays(): void {
    const g = this.ctx.geometry;
    this.ctx.pos = g.getAttribute('position').array as Float32Array;
    this.ctx.nrm = (g.getAttribute('normal')?.array as Float32Array) ?? new Float32Array(this.ctx.pos.length);
  }
}
