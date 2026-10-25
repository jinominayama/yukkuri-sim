import * as THREE from 'three';
import type { BoxCollider } from '../physics/SoftBody';
import { loadJSON, saveJSON } from '../platform/storage';
import { Cage } from './cage';
import type { FloorId } from './floorTextures';

/**
 * マップ（ゆっくりのいる場所）。地面はどのマップも高さ 0 の平らな面（指示）。
 *   平地（open）… これまでの何もない地面。行ける範囲の限りなし
 *   飼育ケース（cage）… ガラスの水槽の中（cage.ts）。行ける範囲はケースの中だけ
 * マップごとに、置く物（object）・当たる物（colliders。体を押し返す）・行ける範囲（area）を持つ。
 * 選んだマップと床材は保存する
 */
export type MapId = 'open' | 'cage';
export type { FloorId };

/** 行ける範囲（地面の上の長方形。m） */
export interface Area {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export const MAPS: { id: MapId; label: string }[] = [
  { id: 'open', label: '平地' },
  { id: 'cage', label: '飼育ケース' },
];
export const FLOORS: { id: FloorId; label: string }[] = [
  { id: 'newspaper', label: '新聞紙' },
  { id: 'sawdust', label: 'おがくず' },
  { id: 'towel', label: 'タオル' },
];

const STORAGE_KEY = 'stage';

export class Stage {
  readonly object = new THREE.Group();
  /** 今のマップの当たる物（マップを変えると中身を入れ替える。同じ配列のまま） */
  readonly colliders: BoxCollider[] = [];
  /** マップを変えた後に呼ぶ（体の当たり・居場所を合わせる） */
  onChange: (() => void) | null = null;
  private mapId: MapId = 'open';
  private floorId: FloorId = 'newspaper';
  private cage: Cage | null = null;

  constructor(private readonly bodyMaterial: THREE.ShaderMaterial, private readonly outlineMaterial: THREE.ShaderMaterial) {
    const saved = loadJSON<{ map?: MapId; floor?: FloorId }>(STORAGE_KEY);
    if (saved?.floor && FLOORS.some((f) => f.id === saved.floor)) this.floorId = saved.floor;
    if (saved?.map && MAPS.some((m) => m.id === saved.map)) this.build(saved.map);
  }

  get map(): MapId {
    return this.mapId;
  }

  set map(id: MapId) {
    if (id === this.mapId) return;
    this.build(id);
    this.save();
    this.onChange?.();
  }

  /** 飼育ケースの床材 */
  get floor(): FloorId {
    return this.floorId;
  }

  set floor(id: FloorId) {
    this.floorId = id;
    this.cage?.setFloor(id);
    this.save();
  }

  /** 行ける範囲（限りがなければ null） */
  get area(): Readonly<Area> | null {
    return this.cage?.area ?? null;
  }

  /** 餌皿（飼育ケースのとき。中心・餌を置く輪・内側の底の高さ） */
  get foodDish(): { x: number; z: number; r: number; ring: readonly [number, number]; floorAt: (dist: number) => number } | null {
    return this.cage?.foodDish ?? null;
  }

  /** 置いてある物（皿など。体が乗れない所）：中心と半径（m） */
  get props(): readonly { x: number; z: number; r: number }[] {
    return this.cage?.props ?? [];
  }

  /**
   * 点 p（x, z）を行ける範囲の内側へ寄せる（範囲の縁から、横は margin m・奥行きは marginZ m 内側まで）。寄せたら true
   */
  limit(p: { x: number; z: number }, margin: number, marginZ = margin): boolean {
    const a = this.area;
    if (!a) return false;
    const x = THREE.MathUtils.clamp(p.x, a.minX + margin, a.maxX - margin);
    const z = THREE.MathUtils.clamp(p.z, a.minZ + marginZ, a.maxZ - marginZ);
    const moved = x !== p.x || z !== p.z;
    p.x = x;
    p.z = z;
    return moved;
  }

  /** 点（x, z）が行ける範囲の縁から、横は margin m・奥行きは marginZ m より内側か */
  inside(x: number, z: number, margin = 0, marginZ = margin): boolean {
    const a = this.area;
    return !a || (x >= a.minX + margin && x <= a.maxX - margin && z >= a.minZ + marginZ && z <= a.maxZ - marginZ);
  }

  /** 中心（x, z）・半径 r の円が、置いてある物（皿など）と重なるなら、その物（重なりの深さ順で一番深いもの） */
  overlapProp(x: number, z: number, r: number): { x: number; z: number; r: number } | null {
    let best: { x: number; z: number; r: number } | null = null;
    let depth = 0;
    for (const p of this.props) {
      const d = p.r + r - Math.hypot(x - p.x, z - p.z);
      if (d > depth) {
        depth = d;
        best = p;
      }
    }
    return best;
  }

  /** 毎フレーム（カメラの位置で見え方を変える物があれば） */
  update(camera: THREE.Vector3): void {
    this.cage?.update(camera);
  }

  private build(id: MapId): void {
    this.mapId = id;
    if (this.cage) {
      this.object.remove(this.cage.object);
      this.cage.dispose();
      this.cage = null;
    }
    this.colliders.length = 0;
    if (id === 'cage') {
      this.cage = new Cage(this.bodyMaterial, this.outlineMaterial, this.floorId);
      this.object.add(this.cage.object);
      this.colliders.push(...this.cage.colliders);
    }
  }

  private save(): void {
    saveJSON(STORAGE_KEY, { map: this.mapId, floor: this.floorId });
  }
}
