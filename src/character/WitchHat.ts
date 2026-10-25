import * as THREE from 'three';
import { createAccessoryMaterial } from '../render/accessoryMaterial';
import type { ToonColors } from '../render/toonMaterial';
import { GROUND_BRIM, GROUND_CROWN, GROUND_FRILL } from '../render/ground';
import { readVertex } from './FaceIndex';
import { bowGeometries, lathe, tubeAlong, withOutline } from './shapes';
import type { Accessory, AttachContext, OutfitParams } from './types';

export interface WitchHatStyle {
  /** 帽子の布（黒） */
  cloth: ToonColors;
  /** 帯・リボン・フリル（白） */
  trim: ToonColors;
  /** つばの外側の半径（かぶる所の半径に対する比） */
  brim: number;
  /** 円錐の高さ（同上） */
  height: number;
  /** 先の折れ曲がる向き（度。0 で真後ろ、+ で右後ろ） */
  bendAngle: number;
  /** 正面のリボンの位置（度。0 で正面、+ で右） */
  bowAngle: number;
  /** つばの下のフリル */
  frill: boolean;
}

/**
 * 魔女帽子：広いつば、先の折れた円錐、白い帯と大きなリボン、つばの下のフリル。
 * 頭のまわりの4点（前・後ろ・左・右）から向きと位置を決めて載せるので、
 * 体が傾く・つぶれる・寝転がるとそれについていく。
 *
 * 帽子の形は「かぶる所の半径 = 1」で作り、体型ごとに大きさを合わせる
 */
export class WitchHat implements Accessory {
  readonly object = new THREE.Group();
  private readonly hat = new THREE.Group();
  private anchors = [0, 0, 0, 0]; // 前・右・後ろ・左
  private readonly restInv = new THREE.Matrix4();
  private readonly local = new THREE.Matrix4();
  private readonly materials: THREE.Material[] = [];
  private readonly geometries: THREE.BufferGeometry[] = [];
  private frill: Frill | null = null;
  /** 円錐と帯（頭を避けて太らせる） */
  private readonly crownParts: Swell[] = [];
  private readonly bow = new THREE.Group();
  private readonly bowDir = new THREE.Vector3();
  /** リボンの頂点を円錐の表面に追従させる（円錐が太る・折れるとき） */
  private bowFollow: Follow[] = [];
  /** つばの上面の高さ（中心からの距離 → 帽子の座標の y）と、つばの外周の半径 */
  private brimTop: (r: number) => number = () => 0;
  private brimR = 1;
  /** object.matrix の逆（体の座標 → 帽子の座標） */
  private readonly inverse = new THREE.Matrix4();
  /** つば（寝転がって折れているときは頭の外へ押し出す） */
  private brimGeometry: THREE.BufferGeometry | null = null;
  private brimBase = new Float32Array(0);
  private crownPush: Float32Array = new Float32Array(CROWN_N + 1);
  /** 太らせる量が変わって、円錐を置き直す必要がある */
  private crownDirty = true;
  /** 前のフレームで円錐を地面で折り曲げていた */
  private folded = false;
  /** 当たり判定に使う体の頂点（帽子のまわりにあるもの） */
  private near = new Int32Array(0);
  /** あと何回の update で、落ち着いた体の形でかぶる高さを探し直すか（0 で済み） */
  private reseatIn = 0;
  /** 動いて頭が食い込んだときに帽子を持ち上げている量（帽子の単位）と、かぶったときの円錐の根元の太らせ量（-1 は未測定） */
  private lift = 0;
  /** 持ち上げたい量。lift は毎回ここへ近づける（一度に持ち上げると帽子と三つ編みの編み始めが跳んで見える） */
  private liftGoal = 0;
  /**
   * 持ち上げた帽子を下げずに保つ（皿に顔を突っ込んで食べる・飲む間など、同じ姿勢を続けるとき）。
   * 食い込みが少し減るたびに下げてはまた持ち上げ、帽子が小刻みに揺れて髪が突き抜けていた
   */
  holdLift = false;
  private basePush = -1;
  /** 実際に使った前後の傾き（制限で調整値より小さくなることがある） */
  tiltUsed = 0;
  private reseating = false;
  private local3 = new Float32Array(0);
  /**
   * 頭から外して動かすときの置き場（ワールドの行列。大きさを含む）。null なら頭にかぶる。
   * 外している間は頭を避けて太らせるのをやめ、元の形に戻す（地面で折り曲げるのはそのまま）
   */
  carry: THREE.Matrix4 | null = null;
  /**
   * かぶったまま押しのける回転（ワールドの行列。かぶった置き場の左から掛ける）。null なら押しのけない。
   * 箱に顔を押し付けたとき、つばが箱に当たって帽子が後ろへ傾くのに使う
   */
  nudge: THREE.Matrix4 | null = null;
  /** 頭にかぶっているときの置き場（外している間も毎回求める。carry を決めるのに使う） */
  readonly worn = new THREE.Matrix4();
  /** 外して元の形に戻してある */
  private relaxed = false;
  /**
   * 円錐をつぶす割合（0〜1。外して逆さに置くとき）。つばより上（円錐の中）の高さを縮め、円錐の先までを低くする。
   * つぶさずに置くと、帽子が円錐の先で地面に逆立ちして見えた（指示）
   */
  crush = 0;
  /** 円錐の形に使ったつぶす割合 */
  private crushUsed = 0;
  /** 外している間、裏地のおわんを出して円錐と帯の輪郭線を隠すか（逆さに置くとき。かぶる向きのまま置くときは false） */
  lined = true;
  /** 円錐と帯の輪郭線（外している間は隠す） */
  private readonly crownLines: THREE.Object3D[] = [];
  /** 裏地のおわん（外している間だけ出す） */
  private dome: THREE.Mesh | null = null;
  /** local3 の各点の法線（帽子の座標） */
  private localN = new Float32Array(0);

  constructor(ctx: AttachContext, private readonly style: WitchHatStyle, private readonly params: OutfitParams) {
    this.object.add(this.hat);
    this.object.matrixAutoUpdate = false;
    this.build(ctx);
  }

  /** 形を作る（かぶる所の半径 1） */
  private build(ctx: AttachContext): void {
    const st = this.style;
    const clothBoth = createAccessoryMaterial(ctx.bodyMaterial, st.cloth, { rim: 0.35, doubleSide: true, ground: GROUND_BRIM });
    // 円錐と帯：寝転がって地面に押し付けられたとき、髪より上・つばより下の高さで止める
    // （同じ高さだと重なってちらつく）。帯は押しつぶされて面が裏返っても縞にならないよう両面
    const trim = createAccessoryMaterial(ctx.bodyMaterial, st.trim, { doubleSide: true, ground: GROUND_CROWN });
    const crownCloth = createAccessoryMaterial(ctx.bodyMaterial, st.cloth, { rim: 0.35, doubleSide: true, ground: GROUND_CROWN });
    // 白い裏地：つばの内側の縁の裏（円錐の口の内側に張り出した所）と、外したときに口をふさぐ浅いおわん（dome）
    const brimLining = createAccessoryMaterial(ctx.bodyMaterial, st.trim, { rim: 0.2, doubleSide: true, ground: GROUND_BRIM });
    this.materials.push(crownCloth, brimLining);
    // 帯のリボン：帯と同じ高さで止める（ほかの飾りと同じ高さだと、逆さまに押しつぶされたとき、つばより上に出て突き抜けて見える）
    const trimBoth = createAccessoryMaterial(ctx.bodyMaterial, st.trim, { doubleSide: true, ground: GROUND_CROWN });
    this.materials.push(clothBoth, trim, trimBoth);
    const ol = ctx.outlineMaterial;
    const add = (g: THREE.BufferGeometry, m: THREE.Material, outline = true) => {
      this.geometries.push(g);
      this.hat.add(withOutline(g, m, outline ? ol : null));
    };

    // つば：内側はわずかに上がり、外へ向かってなだらかに垂れる。外周は少し波打つ
    const B = st.brim;
    this.brimTop = brimTopAt(B);
    this.brimR = B;
    // 断面の点：0〜4 が上面（BRIM_TOP_LAST まで）、5〜8 が下面。閉じるので点は BRIM_PROFILE 個
    const brim = lathe([
      [0.8, 0.02], [1.15, 0.035], [B * 0.8, 0.0], [B * 0.97, -0.09], [B, -0.12],
      [B * 0.985, -0.135], [B * 0.8, -0.03], [1.15, 0.0], [0.8, -0.01],
    ], 128, true);
    waveRim(brim, B * 0.75, 6, 0.035);
    liningGroups(brim, BRIM_PROFILE, BRIM_LINING_FROM);
    this.geometries.push(brim);
    // 輪郭線は白い裏地の所には引かない（逆さに置いたとき、口の内側の縁の線がおわんの上に弧になって見えた）
    const noLine = new THREE.MeshBasicMaterial({ visible: false });
    this.materials.push(noLine);
    const brimGroup = new THREE.Group();
    brimGroup.add(new THREE.Mesh(brim, [ol, noLine]), new THREE.Mesh(brim, [clothBoth, brimLining]));
    this.hat.add(brimGroup);
    this.brimBase = Float32Array.from(brim.getAttribute('position').array as Float32Array);
    this.brimGeometry = brim;

    // 円錐：先は後ろ（bendAngle の向き）へ折れて垂れる
    const curve = this.crownCurve();
    const tube = tubeAlong(curve, crownBase, 56, 56);
    // 内側も布の色で描く（寝転がって折れ曲がると、口の内側が見えることがある）
    add(tube, crownCloth);
    this.crownLines.push(this.hat.children[this.hat.children.length - 1].children[0]);
    this.crownParts.push(new Swell(tube, 56, 57, (i) => i / 56, curve, 1));

    // 裏地のおわん：フリルの内側に、円錐の中へ浅くふくらむ半球（逆さに置いたとき、口から見える内側を白くなめらかに。
    // かぶっているときは頭が入るので出さない）
    const dome = lathe(DOME_PROFILE, 96);
    this.geometries.push(dome);
    // 円錐との重なりでは必ずおわんが手前に描かれるよう、奥行きを少しだけ手前へずらす
    const domeMat = createAccessoryMaterial(ctx.bodyMaterial, st.trim, { rim: 0.2, doubleSide: true, ground: GROUND_BRIM });
    domeMat.polygonOffset = true;
    domeMat.polygonOffsetFactor = -2;
    domeMat.polygonOffsetUnits = -4;
    this.materials.push(domeMat);
    this.dome = new THREE.Mesh(dome, domeMat);
    this.dome.visible = false;
    this.hat.add(this.dome);

    // 帯（白）：円錐の根元
    const bandT = (i: number) => 0.02 + (i / 6) * 0.1;
    const band = tubeAlong((t) => curve(0.02 + t * 0.1), (t, a) => crownBase(0.02 + t * 0.1, a) * 1.035, 6, 56);
    add(band, trim);
    this.crownLines.push(this.hat.children[this.hat.children.length - 1].children[0]);
    this.crownParts.push(new Swell(band, 6, 57, bandT, curve, 1.035));

    // 正面のリボン：帯の上、円錐の表面から外へ
    const bowA = (st.bowAngle * Math.PI) / 180;
    this.bowDir.set(Math.sin(bowA), 0, Math.cos(bowA));
    // 円錐の表面に沿わせる（羽の先は円錐の丸みに沿って奥へ）
    // 垂れはなし（羽と結び目だけ）
    const BOW = 0.82;
    for (const g of bowGeometries(BOW, { tail: 0, wrap: crownBase(0.08, 0), lift: 0.12 })) {
      this.geometries.push(g);
      this.bow.add(withOutline(g, trimBoth, ol));
    }
    // 結び目は帯の上。円錐の傾きに合わせて上を奥へ倒す
    const at = curve(0.07).addScaledVector(this.bowDir, crownBase(0.07, 0) * 1.04).add(new THREE.Vector3(0, BOW_RAISE, 0));
    this.bow.position.copy(at);
    this.bow.lookAt(at.clone().add(this.bowDir));
    this.bow.rotateX(-0.12);
    this.bow.rotateZ(-0.08);
    // 形を帽子の座標に焼き込み、つばの上面より下に入る所はつばの上に載せる
    // （羽は結び目より下へ広がるので、下の角がつばに当たる）
    this.bow.updateMatrix();
    const brimTop = brimTopAt(B);
    const baked = new Set<THREE.BufferGeometry>();
    this.bow.traverse((o) => {
      if (!(o instanceof THREE.Mesh) || baked.has(o.geometry)) return;
      const g = o.geometry as THREE.BufferGeometry;
      baked.add(g);
      g.applyMatrix4(this.bow.matrix);
      const p = g.getAttribute('position') as THREE.BufferAttribute;
      for (let i = 0; i < p.count; i++) {
        const floor = brimTop(Math.hypot(p.getX(i), p.getZ(i))) + BRIM_CLEAR;
        if (p.getY(i) < floor) p.setY(i, floor);
      }
      g.computeVertexNormals();
      g.computeBoundingSphere();
    });
    this.bow.position.set(0, 0, 0);
    this.bow.quaternion.identity();
    this.bowFollow = [...baked].map((g) => new Follow(g, this.crownParts[0]));
    this.hat.add(this.bow);

    // つばの下のフリル：頭のまわりに垂れる波打った布
    if (st.frill) {
      this.frill = new Frill(this.brimTop, B);
      // 寝転がったとき、フリルはつばの頭側（上）にあるので、地面に垂らしたつばより上で止める
      const frillMat = createAccessoryMaterial(ctx.bodyMaterial, st.trim, { doubleSide: true, ground: GROUND_FRILL });
      this.materials.push(frillMat);
      add(this.frill.geometry, frillMat, false);
    }
  }

  /** 円錐の中心線（t = 0 が根元） */
  private crownCurve(): (t: number) => THREE.Vector3 {
    const st = this.style;
    const ba = (st.bendAngle * Math.PI) / 180;
    const back = new THREE.Vector3(Math.sin(ba), 0, -Math.cos(ba));
    const H = st.height;
    const p0 = new THREE.Vector3(0, -0.05, 0);
    const p1 = new THREE.Vector3(0, H * 0.75, 0).addScaledVector(back, 0.05);
    const p2 = new THREE.Vector3(0, H * 1.05, 0).addScaledVector(back, 0.45);
    const p3 = new THREE.Vector3(0, H * 0.8, 0).addScaledVector(back, 0.95);
    return (t: number) => cubic(p0, p1, p2, p3, t);
  }


  /**
   * 帽子が頭（と髪）にめり込まないようにする（毎フレーム）。今の体の頂点を帽子の中の座標へ移し、
   *   ・円錐 … 各段の輪切りの面（中心線に垂直）で頭の外周を測り、それより細い所を太らせる
   *   ・フリル … 各段の高さで頭の外周を測り、内側にある所を外へ押し出す
   * 這う・つぶれるなどで頭の形が変わっても重ならない
   */
  private avoidHead(ctx: AttachContext): void {
    const n = this.near.length;
    if (n === 0) return;
    const e = this.object.matrix.clone().invert().elements;
    // 髪を隠しているときは頭の表面そのもの
    const off = this.params.showHair ? ctx.index.headR * this.params.hairThickness : 0;
    const pos = ctx.pos, nrm = ctx.nrm;
    const pts = this.local3;
    for (let j = 0; j < n; j++) {
      const i = 3 * this.near[j];
      // 髪の表面（髪の殻と同じく法線方向へ浮かせた所）
      const x = pos[i] + nrm[i] * off, y = pos[i + 1] + nrm[i + 1] * off, z = pos[i + 2] + nrm[i + 2] * off;
      pts[3 * j] = e[0] * x + e[4] * y + e[8] * z + e[12];
      pts[3 * j + 1] = e[1] * x + e[5] * y + e[9] * z + e[13];
      pts[3 * j + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];
      // 法線は向きだけ（拡大の分は正規化で消す）
      const nx = e[0] * nrm[i] + e[4] * nrm[i + 1] + e[8] * nrm[i + 2];
      const ny = e[1] * nrm[i] + e[5] * nrm[i + 1] + e[9] * nrm[i + 2];
      const nz = e[2] * nrm[i] + e[6] * nrm[i + 1] + e[10] * nrm[i + 2];
      const l = Math.hypot(nx, ny, nz) || 1;
      this.localN[3 * j] = nx / l;
      this.localN[3 * j + 1] = ny / l;
      this.localN[3 * j + 2] = nz / l;
    }
    const push = crownPush(pts, n, this.crownCurve());
    this.follow(push);
    this.frill?.fit(pts, n);
    let change = 0;
    for (let k = 0; k <= CROWN_N; k++) change = Math.max(change, Math.abs(push[k] - this.crownPush[k]));
    if (change < 0.002) return;
    this.crownPush = push;
    this.crownDirty = true;
  }

  /**
   * 動いて頭が帽子に食い込んだら、帽子を持ち上げる量 lift を増やす（次のフレームから効く）。
   * 食い込んでいなければゆっくり戻す。食い込みは円錐の根元を太らせる量で測り、
   * かぶったときの量（basePush）より LIFT_SLACK 以上増えた分を食い込みとみなす。寝転がって折れているときは持ち上げない
   */
  private follow(push: Float32Array): void {
    let m = 0;
    for (let k = 0; k <= SEAT_ROWS; k++) m = Math.max(m, push[k]);
    if (this.basePush < 0) this.basePush = m;
    const over = m - Math.max(this.basePush, SEAT_ALLOW) - LIFT_SLACK;
    // 食い込みは今の lift で測っているので、持ち上げたい量は今の lift からの上乗せ（追いつく途中で積み増さない）
    if (this.folded) this.liftGoal = Math.max(0, this.liftGoal - LIFT_DROP * 4);
    else if (over > 0) this.liftGoal = Math.min(LIFT_MAX, Math.max(this.liftGoal, this.lift + over * LIFT_GAIN));
    else if (over < -LIFT_SLACK && !this.holdLift) this.liftGoal = Math.max(0, this.liftGoal - LIFT_DROP);
  }

  /**
   * 折れた円錐がつばを抜けて頭の側（つばより下、フリルのある側）へ出ないよう、
   * つばの外周より内側の頂点をつばの上面の上へ押し上げる（つばと地面の間でつぶれる）
   */
  private keepAboveBrim(a: Float32Array, extra: number): void {
    const R = this.brimR * BRIM_COVER;
    for (let v = 0; v < a.length; v += 3) {
      const r = Math.hypot(a[v], a[v + 2]);
      if (r > R) continue;
      const floor = this.brimTop(r) + FOLD_BRIM_CLEAR + extra;
      if (a[v + 1] < floor) a[v + 1] = floor;
    }
  }

  /**
   * 寝転がったとき、地面に近い側のつばを布のように垂らし、縁を地面に付ける。
   * つばと地面の間の隙間から帽子の中（頭）が見えないように。
   * 地面から DRAPE_HEIGHT より高い所は垂らさない（上側のつばは元の形）
   */
  private drapeBrim(a: Float32Array, amount = 1): void {
    // 上面（円錐の側。寝転がると地面を向く）は地面まで、下面はつばの厚みだけ上で止める
    // （同じ高さに重なるとちらつく）
    this.drape(a, (j) => (j <= BRIM_TOP_LAST || j === BRIM_PROFILE - 1 ? DRAPE_CLEAR : DRAPE_CLEAR + DRAPE_THICK), BRIM_PROFILE, amount);
  }

  /**
   * 円錐が地面に当たらないまま、つばの縁だけが床に潜りそうなときに垂らす量（0〜1）。
   * 顔を床に付けるほど前へ倒すと（もるんもるん）、円錐は上を向いたまま、顔の前のつばの縁が床に潜る。
   * 縁が床から BRIM_DIP_FROM より下がり始めたら垂らし始め、BRIM_DIP_RANGE 下がるまでに全部垂らす（急に形が変わらないように）
   */
  private brimDip(): number {
    const e = this.object.matrix.elements;
    const a = this.brimBase;
    let low = Infinity;
    for (let v = 0; v < a.length; v += 3) low = Math.min(low, e[1] * a[v] + e[5] * a[v + 1] + e[9] * a[v + 2]);
    const h = low + e[13] - GROUND_BRIM;
    return THREE.MathUtils.clamp((BRIM_DIP_FROM - h) / BRIM_DIP_RANGE, 0, 1);
  }

  /**
   * つばを垂らすのと同じ動かし方で、点の列 a を地面の側へ寄せる。止める高さは floor(点の番号 % period)（地面からの高さ）。
   * 帯・リボンにも使う（つばだけ垂らすと、垂れたつばが円錐の付け根の帯とリボンを越えて、頭の側へ突き抜けて見える）
   */
  private drape(a: Float32Array, floorOf: (j: number) => number, period = 1, amount = 1): void {
    const e = this.object.matrix.elements;
    // 帽子の座標で動かす向き：ワールドの高さが一番速く下がる向き
    const gx = e[1], gy = e[5], gz = e[9];
    const g2 = gx * gx + gy * gy + gz * gz;
    const inner = DRAPE_FROM, outer = this.brimR;
    for (let v = 0; v < a.length; v += 3) {
      const x = a[v], y = a[v + 1], z = a[v + 2];
      const r = Math.hypot(x, z);
      const floor = floorOf((v / 3) % period);
      const h = gx * x + gy * y + gz * z + e[13] - GROUND_BRIM - floor;
      if (h >= DRAPE_HEIGHT) continue;
      // 外ほど、低いほどよく垂れる（縁の低い所はちょうど止める高さまで）。
      // 止める高さより下にある所は、そこまで持ち上げる（上面と下面が同じ高さでつぶれないように）
      const w = h <= 0 ? 1 : THREE.MathUtils.smoothstep(r, inner, outer) * (1 - THREE.MathUtils.smoothstep(h, 0, DRAPE_HEIGHT));
      const k = (h * w * amount) / g2;
      a[v] = x - gx * k;
      a[v + 1] = y - gy * k;
      a[v + 2] = z - gz * k;
    }
  }

  /**
   * 円錐をつぶす：つばより上の高さを縮める（上ほど縮める。先は根元の CRUSH_HEIGHT 倍の高さまで下がる）。
   * 縮めた分、少し横へふくらませる（布がたわんだように）
   */
  private squash(a: Float32Array): void {
    const k = this.crush;
    const s = 1 - k * (1 - CRUSH_HEIGHT);
    for (let v = 0; v < a.length; v += 3) {
      const y = a[v + 1];
      if (y <= 0) continue;
      const bulge = 1 + k * CRUSH_BULGE * Math.sin(Math.PI * Math.min(1, y / this.style.height));
      a[v] *= bulge;
      a[v + 2] *= bulge;
      a[v + 1] = y * s;
    }
    // つぶした円錐が裏地のおわんより手前（口の側）に出ないよう、おわんの面から DOME_CLEAR 奥へ押し込む
    // （出ると、円錐の内側とその輪郭線が口の真ん中に黒い穴のように見えた）
    for (let v = 0; v < a.length; v += 3) {
      const floor = domeHeight(Math.hypot(a[v], a[v + 2]));
      if (floor !== null && a[v + 1] < floor + DOME_CLEAR) a[v + 1] = floor + DOME_CLEAR;
    }
  }

  /** 太らせる量 t → 押し出し（帽子の単位） */
  private pushAt(t: number): number {
    const push = this.crownPush;
    const f = Math.min(1, Math.max(0, t)) * CROWN_N, k = Math.min(CROWN_N - 1, Math.floor(f)), w = f - k;
    return Math.max(0, push[k] * (1 - w) + push[k + 1] * w);
  }

  /**
   * 円錐が地面に潜らないよう、布として折り曲げる（寝転がったときなど）。
   * 中心線を根元からたどり、地面に近づく所から先は地面に沿って寝かせる。
   * 地面側の断面は、地面までの高さに収まるようにつぶす（上側は丸いまま）。
   * 当たらなければ null
   */
  private groundFold(): Fold | null {
    const m = this.object.matrix;
    const e = m.elements;
    // 帽子の座標の点の、地面からの高さ（ワールド）
    const height = (p: THREE.Vector3) => e[1] * p.x + e[5] * p.y + e[9] * p.z + e[13] - GROUND_CROWN;
    // 帽子の座標での「上」（地面の法線）と、帽子の単位 → ワールドの長さ
    const inv3 = new THREE.Matrix3().setFromMatrix4(m).invert();
    const upL = new THREE.Vector3(0, 1, 0).applyMatrix3(inv3);
    const unit = 1 / upL.length(); // 帽子の座標で長さ 1 の、ワールドでの高さ方向の長さ
    upL.normalize();
    const curve = this.crownCurve();
    const N = FOLD_N;
    const c = Array.from({ length: N + 1 }, (_, i) => curve(i / N));
    // 中心線は地面から断面の半径の FOLD_LIFT 倍より下へ行かせない（そこから下の断面はつぶす）
    const need = (i: number) => (crownBase(i / N, 0) + this.pushAt(i / N)) * unit * FOLD_LIFT + FOLD_CLEAR;
    let first = -1;
    for (let i = 0; i <= N; i++) {
      if (height(c[i]) < need(i)) { first = i; break; }
    }
    if (first < 0) return null;
    // 寝かせる向き：当たった所の中心線の向きを地面に沿わせたもの
    const i0 = Math.max(0, first - 1);
    const tan = c[Math.min(N, i0 + 1)].clone().sub(c[i0]).normalize();
    const along = tan.clone().addScaledVector(upL, -tan.dot(upL));
    if (along.lengthSq() < 1e-6) {
      // 真下を向いているとき：先の折れる向き（後ろ）を地面に沿わせる
      const back = c[N].clone().sub(c[0]);
      along.copy(back).addScaledVector(upL, -back.dot(upL));
      if (along.lengthSq() < 1e-6) along.set(1, 0, 0).addScaledVector(upL, -upL.x);
    }
    along.normalize();
    // 新しい中心線：i0 までは元のまま。そこから先は、少しずつ地面に沿う向きへ曲げながら同じ長さだけ進む
    const P = c.map((v) => v.clone());
    for (let i = i0 + 1; i <= N; i++) {
      const seg = c[i].distanceTo(c[i - 1]);
      const orig = c[i].clone().sub(c[i - 1]).normalize();
      const w = Math.min(1, (i - i0) / FOLD_BEND);
      const d = orig.lerp(along, w).normalize();
      P[i].copy(P[i - 1]).addScaledVector(d, seg);
      // 地面の上に断面の半径ぶん浮かせる
      const h = height(P[i]);
      if (h < need(i)) P[i].addScaledVector(upL, (need(i) - h) / unit);
    }
    // 各段の断面を、元の中心線の向きから新しい向きへ回す
    const q: THREE.Quaternion[] = [];
    for (let i = 0; i <= N; i++) {
      const a = Math.max(0, i - 1), b = Math.min(N, i + 1);
      const t0 = c[b].clone().sub(c[a]).normalize();
      const t1 = P[b].clone().sub(P[a]).normalize();
      // 頭を包む付け根の断面は回さない（回すと縁が持ち上がって顔にかかる）。先へ行くほど中心線に合わせる
      const keep = THREE.MathUtils.smoothstep(i / N, FOLD_KEEP, FOLD_KEEP + 0.25);
      q.push(new THREE.Quaternion().slerp(new THREE.Quaternion().setFromUnitVectors(t0, t1), keep));
    }
    // 各段の中心の、地面からの高さ（帽子の単位。つぶすときに使う）
    const room = P.map((v) => Math.max(0, (height(v) - FOLD_CLEAR) / unit));
    return { centers: P, rot: q, orig: c, up: upL, room };
  }

  /**
   * 帽子が頭に当たらずに載る一番低い高さ（4点の向きの座標）。上から下へ下ろしていき、
   * 円錐の根元を太らせる量が allow を超える手前で止める。
   * toFrame：静止形状 → 4点の向きの座標、tilt：傾き、s：大きさ、hair：髪の厚み（帽子の単位）
   */
  private findSeat(
    rest: Float32Array, toFrame: THREE.Matrix4, tilt: THREE.Quaternion, s: number, hair: number,
    x: number, z: number, allow: number,
  ): number {
    let top = -Infinity;
    const n = rest.length / 3;
    const frame = new Float32Array(rest.length);
    const v = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
      v.set(rest[3 * i], rest[3 * i + 1], rest[3 * i + 2]).applyMatrix4(toFrame);
      frame[3 * i] = v.x; frame[3 * i + 1] = v.y; frame[3 * i + 2] = v.z;
      if (v.y > top) top = v.y;
    }
    const inv = tilt.clone().invert();
    const pts = new Float32Array(rest.length);
    const curve = this.crownCurve();
    const need = (h: number) => {
      for (let i = 0; i < n; i++) {
        v.set(frame[3 * i] - x, frame[3 * i + 1] - h, frame[3 * i + 2] - z).applyQuaternion(inv).multiplyScalar(1 / s);
        pts[3 * i] = v.x; pts[3 * i + 1] = v.y; pts[3 * i + 2] = v.z;
      }
      // 髪の厚みは、頭の点を外へ厚くして当てる（当たっていない所まで厚みの分を数えないように。
      // 数えると、厚みが SEAT_ALLOW を超えたとたん、どの高さでも載らないことになって帽子が飛んでいく）
      const push = crownPush(pts, n, curve, hair);
      let m = 0;
      for (let k = 0; k <= SEAT_ROWS; k++) m = Math.max(m, push[k]);
      // つばの下に体（と髪）が入り込んでいたら載せられない（胴の長い体型で、頭の後ろの背中に当たる）
      for (let i = 0; i < n; i++) {
        const r = Math.hypot(pts[3 * i], pts[3 * i + 2]);
        if (r < MOUTH || r > this.brimR) continue;
        if (pts[3 * i + 1] + hair > this.brimTop(r) - BRIM_UNDER) return Infinity;
      }
      return m;
    };
    // 体の一番高い所より上（傾いたつばの低い側も含めて、どこにも当たらない高さ）から下ろす
    let hi = top + s * (this.brimR + 0.3);
    const step = s * 0.1;
    let lo = hi;
    while (lo > top - s * 4) {
      lo -= step;
      if (need(lo) > allow) break;
      hi = lo;
    }
    for (let k = 0; k < 10; k++) {
      const mid = (lo + hi) / 2;
      if (need(mid) > allow) lo = mid;
      else hi = mid;
    }
    return hi;
  }

  rebuild(ctx: AttachContext): void {
    const ix = ctx.index;
    // 向きと大きさは決まった高さの4点で決める（位置の調整で大きさが変わらないように）。
    // 背の低い体型では頭のてっぺんより上にならないよう抑える（4点が1か所に集まると向きが決まらない）
    const fy = Math.min(ANCHOR_FY, ix.topFy - 0.3);
    this.anchors = [0, Math.PI / 2, Math.PI, -Math.PI / 2].map((az) => ix.nearestAz(az, fy));
    const p = this.anchors.map((i) => ix.restPoint(i));
    const m = frameOf(p[0], p[1], p[2], p[3]);
    this.restInv.copy(m).invert();
    // 4点からは向きだけを取る。大きさとかぶる高さは、頭の輪切りの太さ（髪の厚みを含む）から決める
    const hair = ix.headR * this.params.hairThickness;
    // 体の今の形（重さで沈んだ形）を、静止形状の座標へ戻したもの。
    // 静止形状のままだと、沈んで低くなる体型（扁平・いもむし）で頭とずれる
    const shape = currentShape(ctx, this.anchors, this.restInv);
    const section = headSection(shape, this.restInv, ix.headR);
    // 大きさ：4点の高さで、帽子の口がちょうど頭の太さになる大きさを 1 とする
    const fit = (section.at(0) + hair) / MOUTH;
    const s = fit * this.params.hatScale;
    // 位置の調整（頭の太さが単位。x：右、y：上、z：前）
    const u = fit * MOUTH;
    const { hatX, hatY, hatZ } = this.params;
    // 傾けるときは、頭の丸みの中心を軸に回す（帽子は頭に沿って低い側へずれ落ちる）。
    // その場で回すと、低い側のつばの付け根が頭の横に当たり、まっすぐ上へ逃げて浮いてしまう
    const flat = this.findSeat(shape, this.restInv, new THREE.Quaternion(), s, hair / s, hatX * u, hatZ * u, SEAT_ALLOW);
    const pivot = roundCenter(section, flat, u);
    /**
     * 前後の傾き tiltDeg で置いたとき。seat：かぶる高さ（頭（と髪）に当たらずに載る一番低い高さ。
     * 円錐の形と傾きを含めて探す）、float：頭の丸みに沿って回しただけの高さより、どれだけ浮いたか（頭の太さが単位）
     */
    const tilted = (tiltDeg: number) => {
      const quat = new THREE.Quaternion().setFromEuler(new THREE.Euler(
        (-tiltDeg * Math.PI) / 180, 0, (-this.params.hatSide * Math.PI) / 180, 'XZY',
      ));
      const off = new THREE.Vector3(0, flat - pivot, 0).applyQuaternion(quat);
      const x = hatX * u + off.x, z = hatZ * u + off.z;
      const seat = Math.max(0, this.findSeat(shape, this.restInv, quat, s, hair / s, x, z, SEAT_ALLOW));
      return { quat, x, z, seat, float: (seat - (pivot + off.y)) / u };
    };
    // 前後の傾きの制限：つばが頭以外（胴の長い体型で、頭の後ろに続く背中など）に当たって
    // 帽子が浮いてしまう角度までは傾けない（調整値はそのまま。画面で動かしたときに調整値も戻すのは tiltUsed を見て）
    let at = tilted(this.params.hatTilt);
    this.tiltUsed = this.params.hatTilt;
    // 浮きは、傾けていないときより増えた分で見る（平たい頭は、丸みに沿って回すだけでも少し浮くので）
    const lim = this.params.hatTilt !== 0 && at.float > TILT_FLOAT_MAX ? tilted(0).float + TILT_FLOAT_MAX : Infinity;
    if (at.float > lim) {
      let ok = 0, ng = this.params.hatTilt;
      for (let k = 0; k < 5; k++) {
        const mid = (ok + ng) / 2;
        if (tilted(mid).float > lim) ng = mid;
        else ok = mid;
      }
      this.tiltUsed = Math.trunc(ok);
      at = tilted(this.tiltUsed);
    }
    const { quat, x, z, seat } = at;
    // 口が頭より大きいときは 4点の高さより下げない（大きな帽子が顔まで沈まないように）。
    // 上下の調整値は、載った高さからのずらしとして足す（載る高さの探し方に打ち消されない）
    // 下げられるのは、円錐の根元を太らせる量が上限 CROWN_PUSH_MAX に届く所まで（それより下げると頭にめり込む）
    let y = seat + hatY * u;
    if (hatY < 0) y = Math.max(y, this.findSeat(shape, this.restInv, quat, s, hair / s, x, z, CROWN_PUSH_MAX * 0.8));
    const base = new THREE.Vector3(x, y, z).applyMatrix4(m);
    // 静止形状の中で、帽子を4点の向きに立てて置く（傾きは調整値で加える）
    const frameQuat = new THREE.Quaternion().setFromRotationMatrix(m);
    this.local.compose(base, frameQuat.multiply(quat), new THREE.Vector3(s, s, s));
    // 当たり判定に使う頂点：静止形状で帽子のまわり（顔の下あたりから上）にあるもの
    const inv = this.local.clone().invert();
    const v = new THREE.Vector3();
    const near: number[] = [];
    for (let i = 0; i < ix.rest.length / 3; i++) {
      v.set(ix.rest[3 * i], ix.rest[3 * i + 1], ix.rest[3 * i + 2]).applyMatrix4(inv);
      // 寝転がって折れ曲がった円錐が顔にかかることがあるので、顔の下まで含める
      if (v.y > NEAR_BELOW && Math.hypot(v.x, v.z) < 2.6) near.push(i);
    }
    this.near = Int32Array.from(near);
    this.local3 = new Float32Array(near.length * 3);
    this.localN = new Float32Array(near.length * 3);
    this.crownPush.fill(-1); // 次の update で必ず当て直す
    this.lift = 0;
    this.liftGoal = 0;
    this.basePush = -1;
    this.frill?.invalidate();
    // 体型を変えた直後は体がまだ揺れているので、落ち着いた頃にもう一度置き直す
    if (!this.reseating) this.reseatIn = RESEAT_FRAMES;
    this.update(ctx);
  }

  /**
   * つばの上の置き場：帽子の前（向き 0）から angle（rad。上から見て反時計回り＝帽子の左が +）、円錐の根元からつばの縁までの
   * rFrac（0〜1）の所の、つばの上面の点（ワールド）と、帽子の上向き（単位ベクトル）。物を帽子に乗せるのに使う
   */
  brimSpot(angle: number, rFrac: number, pos: THREE.Vector3, up: THREE.Vector3): void {
    this.brimLocal(angle, rFrac, pos).applyMatrix4(this.object.matrix);
    const e = this.object.matrix.elements;
    up.set(e[4], e[5], e[6]).normalize();
  }

  /** 押しのける回転を変えて、すぐ置き場に反映する（update の後で、今のかぶった置き場に合わせて決めたいとき） */
  setNudge(m: THREE.Matrix4 | null): void {
    this.nudge = m;
    if (this.carry) return;
    if (m) this.object.matrix.multiplyMatrices(m, this.worn);
    else this.object.matrix.copy(this.worn);
    this.object.matrixWorldNeedsUpdate = true;
    this.inverse.copy(this.object.matrix).invert();
  }

  /** brimSpot の点の、帽子の座標での位置 */
  brimLocal(angle: number, rFrac: number, out: THREE.Vector3): THREE.Vector3 {
    const r = CROWN_FOOT + (this.brimR - CROWN_FOOT) * rFrac;
    return out.set(Math.sin(angle) * r, this.brimTop(r), Math.cos(angle) * r);
  }

  /** 帽子の向き：横（帽子の左が +）・上・前（単位ベクトル） */
  axes(side: THREE.Vector3, up: THREE.Vector3, front: THREE.Vector3): void {
    const e = this.object.matrix.elements;
    side.set(e[0], e[1], e[2]).normalize();
    up.set(e[4], e[5], e[6]).normalize();
    front.set(e[8], e[9], e[10]).normalize();
  }

  /** 帽子の上向き（単位ベクトル） */
  upVector(out: THREE.Vector3): THREE.Vector3 {
    const e = this.object.matrix.elements;
    return out.set(e[4], e[5], e[6]).normalize();
  }

  /**
   * 点 p（体と同じ座標）が帽子の下（つばの内側で、フリルの裾より上）に隠れているか。
   * 三つ編みの編み始めを帽子の外へ出すのに使う。margin：裾より下へこれだけ（帽子の単位）までは隠れているとみなす
   */
  covers(p: THREE.Vector3, margin = 0): boolean {
    if (!this.object.visible || !this.frill) return false;
    const v = p.clone().applyMatrix4(this.inverse);
    if (Math.hypot(v.x, v.z) > this.brimR) return false;
    const { SEG, ROWS } = Frill;
    const a = Math.atan2(v.x, v.z);
    const s = ((Math.round((a / (Math.PI * 2)) * SEG) % SEG) + SEG) % SEG;
    const pos = this.frill.geometry.getAttribute('position');
    let hem = Infinity;
    for (let r = 0; r <= ROWS; r++) hem = Math.min(hem, pos.getY(r * (SEG + 1) + s));
    return v.y > hem - margin;
  }

  update(ctx: AttachContext): void {
    if (this.reseatIn > 0 && --this.reseatIn === 0) {
      this.reseating = true;
      this.rebuild(ctx);
      this.reseating = false;
      return;
    }
    const p = this.anchors.map((i) => {
      const v = new THREE.Vector3();
      readVertex(ctx.pos, ctx.nrm, i, v);
      return v;
    });
    // 帽子は形を変えずに頭について行く（体の幅に合わせて広げたり縮めたりすると、跳ねるたびに伸び縮みして見える）。
    // 頭が帽子に食い込んだ分は、円錐を太らせる代わりに帽子ごと持ち上げる（lift）
    // 持ち上げは数コマかけて追いつく。下ろすのは持ち上げたい量がもともとゆっくり減るのでそのまま
    this.lift = this.liftGoal > this.lift ? this.lift + (this.liftGoal - this.lift) * LIFT_RISE : this.liftGoal;
    const cur = frameOf(p[0], p[1], p[2], p[3]);
    this.worn.copy(cur).multiply(this.restInv).multiply(this.local)
      .multiply(new THREE.Matrix4().makeTranslation(0, this.lift, 0));
    if (this.carry) this.object.matrix.copy(this.carry);
    else if (this.nudge) this.object.matrix.multiplyMatrices(this.nudge, this.worn);
    else this.object.matrix.copy(this.worn);
    this.object.matrixWorldNeedsUpdate = true;
    this.inverse.copy(this.object.matrix).invert();
    if (this.dome) this.dome.visible = this.carry !== null && this.lined;
    // 外している間は円錐と帯の輪郭線を描かない（逆さに置くと、口の真ん中に輪郭線の色の穴が見える角度があった。
    // 輪郭線は面の裏を描くので、口の側から見える円錐の内側に出る）
    for (const line of this.crownLines) line.visible = this.carry === null || !this.lined;
    if (this.carry && !this.relaxed) {
      // 外した：頭に合わせて太らせた円錐・広げたフリルを元の形に戻す
      this.relaxed = true;
      this.crownPush.fill(0);
      this.crownDirty = true;
      this.frill?.fit(new Float32Array(0), 0);
      this.lift = 0;
      this.liftGoal = 0;
    } else if (!this.carry && this.relaxed) {
      // かぶり直した：次の avoidHead で必ず当て直す
      this.relaxed = false;
      this.crownPush.fill(-1);
      this.frill?.invalidate();
    }
    if (this.object.visible) {
      if (!this.carry) this.avoidHead(ctx);
      // 外して逆さに置いたときは折らない（折った円錐の輪郭線がつばを突き抜けて見えた。地面より下は描くときに地面の高さで止まる）
      const fold = this.carry ? null : this.groundFold();
      if (!this.carry) this.crush = 0; // つぶすのは外している間だけ（かぶったら必ず元の形）
      if (Math.abs(this.crush - this.crushUsed) > 1e-4) this.crownDirty = true;
      const squash = this.crush > 0 ? (a: Float32Array) => this.squash(a) : undefined;
      // 円錐は当たっていないが、つばの縁が床に潜りそう（深くお辞儀したとき）
      const dip = fold ? 0 : this.brimDip();
      if (fold || dip > 0 || this.folded || this.crownDirty) {
        // 折り曲げた円錐は断面が回って頭にかかることがあるので、体の外へ押し出す
        const grid = fold ? new PointGrid(this.local3, this.localN, this.near.length, BODY_CELL) : null;
        this.crownParts.forEach((part, k) => {
          // 帯（外側の布）はつばの側、円錐はその内側に重ねる（同じ高さだと重なってちらつく）
          const layer = k === 0 ? FOLD_LAYER : 0;
          part.apply((t) => this.pushAt(t), fold, fold ? (a) => {
            grid?.pushOut(a, BODY_CLEAR);
            this.keepAboveBrim(a, layer);
            // 円錐と帯もつばと一緒に垂らす（つばより地面の側で止める）。垂らしたつばを越えると、
            // 頭の側から円錐の布の縁が白っぽい線として見える
            this.drape(a, () => DRAPE_UNDER);
          } : squash);
        });
        // 折れているときは円錐の表面について行く。普段は元の形のまま、円錐が太った分だけ外へ
        const shift = this.bowDir.clone().multiplyScalar(this.pushAt(0.08) * 0.98);
        // 帯と同じく、つばの円錐の側に保ち、つばと一緒に垂らす（帽子が逆さまに押しつぶされたときも、つばを突き抜けない）
        for (const f of this.bowFollow) {
          f.apply(fold !== null || this.crush > 0, shift, fold ? (a) => {
            this.keepAboveBrim(a, FOLD_LAYER);
            this.drape(a, () => DRAPE_UNDER);
          } : undefined);
        }
        // つば：折れているときは頭（髪）にめり込む所を外へ押し出す。普段は元の形
        if (this.brimGeometry) {
          const p = this.brimGeometry.getAttribute('position') as THREE.BufferAttribute;
          const a = p.array as Float32Array;
          a.set(this.brimBase);
          if (fold) this.drapeBrim(a);
          else if (dip > 0) this.drapeBrim(a, dip);
          grid?.pushOut(a, BODY_CLEAR);
          p.needsUpdate = true;
          this.brimGeometry.computeVertexNormals();
          this.brimGeometry.computeBoundingSphere();
        }
        // 垂らしたつばを元へ戻すため、次も作り直す（垂らす量が 0 になった回で元の形に戻る）
        this.folded = fold !== null || dip > 0;
        this.crownDirty = false;
        this.crushUsed = this.crush;
      }
    }
  }

  dispose(): void {
    this.materials.forEach((m) => m.dispose());
    this.geometries.forEach((g) => g.dispose());
  }
}

/**
 * 前・右・後ろ・左の4点から、左右の中点を原点・右を x・上を y・前を z とする枠。
 * 前後は向きにだけ使う（胴の長い体型では後ろの点が頭から離れるため）
 */
function frameOf(f: THREE.Vector3, r: THREE.Vector3, b: THREE.Vector3, l: THREE.Vector3): THREE.Matrix4 {
  const c = r.clone().add(l).multiplyScalar(0.5);
  const x = r.clone().sub(l).normalize();
  const z0 = f.clone().sub(b).normalize();
  const y = new THREE.Vector3().crossVectors(z0, x).normalize();
  const z = new THREE.Vector3().crossVectors(x, y).normalize();
  return new THREE.Matrix4().makeBasis(x, y, z).setPosition(c);
}

function cubic(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3, t: number): THREE.Vector3 {
  const u = 1 - t;
  return a.clone().multiplyScalar(u * u * u)
    .addScaledVector(b, 3 * u * u * t)
    .addScaledVector(c, 3 * u * t * t)
    .addScaledVector(d, t * t * t);
}

/**
 * 動いて頭が食い込んだときの持ち上げ：かぶったときより円錐の根元の太らせ量がこれ以上増えたら持ち上げ始める、
 * 増えた量に掛けて1回に持ち上げる量（根元の傾きのおよそ逆数の半分）、戻す速さ、上限（いずれも帽子の単位）
 */
const LIFT_SLACK = 0.03;
const LIFT_GAIN = 3;
const LIFT_DROP = 0.004;
const LIFT_MAX = 1.5;
/** 持ち上げたい量へ、update 1回に縮める差の割合 */
const LIFT_RISE = 0.3;

/** 体型を変えてから、落ち着いた形で置き直すまでの update の回数 */
const RESEAT_FRAMES = 45;

/**
 * 体の今の頂点を、帽子を載せる座標（静止形状の座標）へ戻す。update と同じ 4点の枠で戻すので、
 * 戻した形の上に置いた帽子は、今の体の上にちょうど載る
 */
function currentShape(ctx: AttachContext, anchors: number[], restInv: THREE.Matrix4): Float32Array {
  const p = anchors.map((i) => {
    const v = new THREE.Vector3();
    readVertex(ctx.pos, ctx.nrm, i, v);
    return v;
  });
  const back = frameOf(p[0], p[1], p[2], p[3]).multiply(restInv).invert();
  const out = new Float32Array(ctx.pos.length);
  const v = new THREE.Vector3();
  for (let i = 0; i < out.length; i += 3) {
    v.set(ctx.pos[i], ctx.pos[i + 1], ctx.pos[i + 2]).applyMatrix4(back);
    out[i] = v.x; out[i + 1] = v.y; out[i + 2] = v.z;
  }
  return out;
}

/** 帽子の口の半径（帽子の単位。円錐の根元の内側とフリルの付け根のあいだ） */
const MOUTH = 1.1;

/**
 * 頭の輪切りの太さ。静止形状の頂点を 4点の向きの座標（原点は 4点の高さ、y が上、z が前）へ移し、
 * 高さごとに、前と左右（後ろは除く：胴の長い体型では頭から離れるため）の一番外の半径を測る。
 *   at(h) … 高さ h の太さ
 */
function headSection(rest: Float32Array, toFrame: THREE.Matrix4, headR: number): { at(h: number): number } {
  const v = new THREE.Vector3();
  const pts: number[] = [];
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < rest.length; i += 3) {
    v.set(rest[i], rest[i + 1], rest[i + 2]).applyMatrix4(toFrame);
    // 後ろ（前から ±SECTION_ANGLE より外）は見ない
    if (Math.abs(Math.atan2(v.x, v.z)) > SECTION_ANGLE) continue;
    pts.push(v.y, Math.hypot(v.x, v.z));
    lo = Math.min(lo, v.y);
    hi = Math.max(hi, v.y);
  }
  const step = headR * 0.02;
  const n = Math.max(1, Math.ceil((hi - lo) / step));
  const bins = new Float32Array(n + 1);
  for (let k = 0; k < pts.length; k += 2) {
    const b = Math.round((pts[k] - lo) / step);
    if (pts[k + 1] > bins[b]) bins[b] = pts[k + 1];
  }
  // 頂点の粗さで欠けないよう、隣の高さも見る
  const R = Float32Array.from(bins, (_, b) => Math.max(bins[Math.max(0, b - 1)], bins[b], bins[Math.min(n, b + 1)]));
  return {
    at(h) {
      const b = Math.min(n, Math.max(0, Math.round((h - lo) / step)));
      return R[b];
    },
  };
}
/**
 * 帽子を傾けるときの軸の高さ：かぶる高さ seat のあたりの頭の丸みを円とみなした中心。
 * seat と、その ROUND_SPAN 下の 2 か所の太さから求める。u：頭の太さ（帽子の口の半径）
 */
function roundCenter(section: { at(h: number): number }, seat: number, u: number): number {
  const h1 = seat, h2 = seat - ROUND_SPAN * u;
  const r1 = section.at(h1), r2 = section.at(h2);
  // 円 r² + (h - c)² = R² が 2 点を通る c
  const c = (r1 * r1 - r2 * r2 + h1 * h1 - h2 * h2) / (2 * (h1 - h2));
  return THREE.MathUtils.clamp(c, seat - ROUND_MAX * u, seat - ROUND_MIN * u);
}
const ROUND_SPAN = 0.5;
/** 前後に傾けたとき、傾けていないときよりこれ以上浮く角度までは傾けない（頭の太さが単位） */
const TILT_FLOAT_MAX = 0.3;
/** 軸の深さの範囲（かぶる高さから下へ、頭の太さが単位）。平たい頭や細長い頭で極端にならないように */
const ROUND_MIN = 0.3;
const ROUND_MAX = 1.5;
/** つばの下面の、上面からの深さ（帽子の単位。かぶる高さを探すときに使う） */
const BRIM_UNDER = 0.04;
/** かぶる高さを探すとき：円錐の根元（この段まで）を太らせてよい量（帽子の単位） */
const SEAT_ALLOW = 0.1;
/** 円錐の根元を太らせる量の上限（帽子の単位。これ以上は形が崩れて見える） */
const CROWN_PUSH_MAX = 0.3;
const SEAT_ROWS = 8;
/** 頭の輪切りで見る向き：前から左右へこの角度まで（ラジアン） */
const SECTION_ANGLE = (110 * Math.PI) / 180;

/** 寝転がったとき、つばを垂らす範囲：中心からこの半径より外（帽子の単位） */
const DRAPE_FROM = 1.15;
/** つばの断面の点の数（閉じた分を含む）と、上面の最後の点 */
const BRIM_PROFILE = 10;
const BRIM_TOP_LAST = 4;
/** つばの断面で、この番号の点から先（下面の内側の縁 → 内側の端）を白い裏地にする */
const BRIM_LINING_FROM = 7;
/** 円錐をつぶしたときの高さ（元の高さに対する比）と、横へのふくらみ（半径に対する比） */
const CRUSH_HEIGHT = 0.33;
/** つぶした円錐を裏地のおわんから離しておく隙間（帽子の単位） */
const DOME_CLEAR = 0.04;
const CRUSH_BULGE = 0.12;
/**
 * 裏地のおわんの断面（[半径, 高さ]。帽子の単位。高さ + が円錐の中）：真ん中は円錐の中へ浅くふくらみ、縁は平らなつばにして
 * 円錐の根元より下・外まで広げる。根元の輪は円錐の傾きに合わせて斜めで、つばの下面より下へ最大 0.1 はみ出している（半径 1.13〜1.18）。
 * 半球のままだと、縁の近くでおわんが根元より奥に入り、根元の紺が細い筋になってのぞいた（フリルの付け根の段は、おわんの縁で隠す）。
 * 真ん中は浅く（0.22）：逆さに置くと円錐をつぶすので（CRUSH_HEIGHT）、深い（0.4）とつぶした円錐の内側がおわんの真ん中のすぐ裏に来て、
 * 遠くから見下ろすと円錐の輪郭線（裏の面を描く）がおわんを突き抜け、口の真ん中が黒い穴に見えた
 */
const DOME_PROFILE: [number, number][] = [
  [0, 0.22], [0.35, 0.21], [0.65, 0.17], [0.88, 0.09], [1.0, 0.0], [1.05, -0.1], [1.24, -0.12],
];
/** 垂らしたつばを止める高さ：上面は地面から DRAPE_CLEAR、下面はさらに DRAPE_THICK 上（ワールド） */
const DRAPE_CLEAR = 0.002;
const DRAPE_THICK = 0.012;
/** 垂らしたつばと一緒に寄せる円錐・帯・リボンを止める高さ（ワールド。つばの上面より地面の側） */
const DRAPE_UNDER = -0.001;
/** 同じく、地面からこの高さ（ワールド）より低い所だけ垂らす */
const DRAPE_HEIGHT = 0.6;
/** 円錐が当たらずにつばの縁だけ床に近づいたとき：縁が床からこの高さ（ワールド）より下がったら垂らし始め、さらにこれだけ下がるまでに全部垂らす */
const BRIM_DIP_FROM = 0.03;
const BRIM_DIP_RANGE = 0.08;

/** リボンを帯の上へ持ち上げる量（帽子の単位） */
const BOW_RAISE = 0.06;
/** 折れた円錐をつばの上に保つ範囲（つばの外周の半径に対する比。外周の波の分だけ広め） */
const BRIM_COVER = 1.04;
/** 折れた円錐をつばの上面から離しておく隙間（帽子の単位。狭いと重なった面がちらつく） */
const FOLD_BRIM_CLEAR = 0.07;
/** 折れた円錐を、帯よりさらにつばから離す量（帽子の単位） */
const FOLD_LAYER = 0.05;
/** リボンをつばの上面から離しておく隙間（帽子の単位） */
const BRIM_CLEAR = 0.02;

/** つばの上面の高さ（中心からの距離 r の所。つばの断面の上側。外周の波は含まない） */
function brimTopAt(B: number): (r: number) => number {
  const pts: [number, number][] = [[0.8, 0.02], [1.15, 0.035], [B * 0.8, 0.0], [B * 0.97, -0.09], [B, -0.12]];
  return (r) => {
    if (r <= pts[0][0]) return pts[0][1];
    for (let i = 1; i < pts.length; i++) {
      if (r <= pts[i][0]) {
        const [x0, y0] = pts[i - 1], [x1, y1] = pts[i];
        return y0 + ((y1 - y0) * (r - x0)) / (x1 - x0);
      }
    }
    return pts[pts.length - 1][1];
  };
}

/** つばの外周を上下に波打たせる（中心から minR より外だけ） */
function waveRim(g: THREE.BufferGeometry, minR: number, waves: number, amp: number): void {
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), z = p.getZ(i);
    const r = Math.hypot(x, z);
    if (r <= minR) continue;
    const a = Math.atan2(x, z);
    p.setY(i, p.getY(i) + amp * ((r - minR) / (1 - minR + 1e-6)) * Math.sin(a * waves + 0.7));
  }
  g.computeVertexNormals();
}

/** 円錐の元の太さ（根元は頭を包む太さ。上ほど細く、少しくびれてから先がとがる） */
function crownBase(t: number, a: number): number {
  return 1.15 * Math.pow(1 - t, 0.8) * (1 + CROWN_WAVE * Math.sin(a * 5 + t * 6)) + 0.005;
}
const CROWN_WAVE = 0.025;

/**
 * 回転体（lathe。断面 profile 個の点の列を回したもの）の三角形を並べ替えて、断面の点 from から先の帯を 2 つ目の材質にする
 * （頂点は動かさないので、頂点の番号で形を変える処理はそのまま使える）
 */
function liningGroups(g: THREE.BufferGeometry, profile: number, from: number): void {
  const index = g.getIndex()!;
  const outer: number[] = [], inner: number[] = [];
  for (let t = 0; t < index.count; t += 3) {
    const a = index.getX(t), b = index.getX(t + 1), c = index.getX(t + 2);
    const j = Math.min(a % profile, b % profile, c % profile);
    (j >= from ? inner : outer).push(a, b, c);
  }
  g.setIndex([...outer, ...inner]);
  g.clearGroups();
  g.addGroup(0, outer.length, 0);
  g.addGroup(outer.length, inner.length, 1);
}
/** 裏地のおわんの、中心から r の所の高さ（おわんの外なら null） */
function domeHeight(r: number): number | null {
  const pr = DOME_PROFILE;
  for (let i = 1; i < pr.length; i++) {
    if (r <= pr[i][0]) {
      const [r0, y0] = pr[i - 1], [r1, y1] = pr[i];
      return y0 + ((y1 - y0) * (r - r0)) / (r1 - r0);
    }
  }
  return null;
}

/** 円錐の根元の半径（つばの置き場の内側。crownBase(0, a) とほぼ同じ） */
const CROWN_FOOT = 1.15;
/** つばの上面の高さ（つばの形の内側の高さ） */
const BRIM_TOP = 0.035;
/** 円錐の当たり判定の段の数 */
const CROWN_N = 40;

/**
 * 円錐の各段をどれだけ太らせるか。pts は帽子の中の座標の点（髪の表面）。
 * 円錐は後ろへ傾いて曲がるので、各段の輪切りの面（中心線に垂直）に沿って測る
 */
function crownPush(pts: Float32Array, n: number, curve: (t: number) => THREE.Vector3, pad = 0): Float32Array {
  const N = CROWN_N;
  // 円錐の元の太さ（波の一番内側）
  const inner = (t: number) => 1.15 * Math.pow(1 - t, 0.8) * (1 - CROWN_WAVE) + 0.005;
  // 円錐の表面からこれより外の点は見ない（傾いた輪切りの面が遠くで体を横切る所）
  const REACH = 0.6;
  const band = 0.06;
  const cs = Array.from({ length: N + 1 }, (_, i) => curve(i / N));
  const ts = cs.map((_, i) => curve(Math.min(1, (i + 1) / N)).sub(curve(Math.max(0, (i - 1) / N))).normalize());
  const lim = cs.map((_, k) => inner(k / N) + REACH);
  const need = new Float32Array(N + 1);
  for (let j = 0; j < n; j++) {
    const x = pts[3 * j], y = pts[3 * j + 1], z = pts[3 * j + 2];
    // つばより下はつばとフリルに隠れるので見ない
    if (y < BRIM_TOP) continue;
    for (let k = 0; k <= N; k++) {
      const c = cs[k], t = ts[k];
      const dx = x - c.x, dy = y - c.y, dz = z - c.z;
      const along = dx * t.x + dy * t.y + dz * t.z;
      if (along > band || along < -band) continue;
      const rad = Math.hypot(dx - t.x * along, dy - t.y * along, dz - t.z * along);
      if (rad > need[k] && rad < lim[k]) need[k] = rad;
    }
  }
  // 波の一番内側が「髪の表面 + 隙間」に届くまで（pad：点を外へ厚くして見る量。頭の表面の点に髪の厚みを足すとき）
  const raw = Float32Array.from(need, (R, k) => (R > 0 ? Math.max(0, R + pad + CROWN_GAP - inner(k / N)) : 0));
  // 測った段の間で足りなくならないよう、隣の段も見る
  const push = Float32Array.from(raw, (_, k) => Math.max(raw[Math.max(0, k - 1)], raw[k], raw[Math.min(N, k + 1)]));
  // 半径（元の太さ + 押し出し）が上の段より細くならないよう、下の段を広げる
  for (let k = N - 1; k >= 0; k--) {
    push[k] = Math.max(push[k], inner((k + 1) / N) + push[k + 1] - inner(k / N));
  }
  // 太らせすぎると形が崩れるので上限で止める（動いて一時的に頭がふくらんだときなど）
  for (let k = 0; k <= N; k++) push[k] = Math.min(push[k], CROWN_PUSH_MAX);
  return push;
}

/** tubeAlong で作った管を、段ごとに外へ太らせる（作り直さずに頂点を動かす） */
/** 地面で折り曲げた円錐の中心線（FOLD_N 段）。orig は元の中心線、rot は各段の断面の回転 */
interface Fold {
  centers: THREE.Vector3[];
  orig: THREE.Vector3[];
  rot: THREE.Quaternion[];
  /** 帽子の座標での上（地面の法線） */
  up: THREE.Vector3;
  /** 各段の中心から地面までの高さ（帽子の単位） */
  room: number[];
}
/** 折り曲げの段の数 */
const FOLD_N = 56;
/** 何段かけて地面に沿う向きへ曲げるか */
const FOLD_BEND = 6;
/** 付け根からここ（中心線の割合）までは断面を回さない */
const FOLD_KEEP = 0.12;
/** 寝かせた円錐の中心を、地面から断面の半径の何倍の高さに置くか（それより下はつぶす） */
const FOLD_LIFT = 0.35;
/** 折り曲げた円錐を地面から離しておく隙間（ワールド） */
const FOLD_CLEAR = 0.004;

/** 当たり判定に使う体の頂点の範囲：帽子の座標でこれより上 */
const NEAR_BELOW = -2.4;
/** 体の外へ押し出すときの升目の大きさと、体から離しておく隙間（帽子の単位） */
const BODY_CELL = 0.2;
const BODY_CLEAR = 0.03;

/**
 * 体の表面の点（と法線）を升目に分けたもの。近い点を素早く探して、
 * 体の内側に入った頂点を外へ押し出す
 */
class PointGrid {
  private readonly cells = new Map<number, number[]>();

  constructor(
    private readonly pts: Float32Array,
    private readonly nrm: Float32Array,
    n: number,
    private readonly cell: number,
  ) {
    for (let j = 0; j < n; j++) {
      const k = this.key(pts[3 * j], pts[3 * j + 1], pts[3 * j + 2]);
      const list = this.cells.get(k);
      if (list) list.push(j);
      else this.cells.set(k, [j]);
    }
  }

  private key(x: number, y: number, z: number): number {
    const c = this.cell;
    return this.keyOf(Math.floor(x / c), Math.floor(y / c), Math.floor(z / c));
  }

  private keyOf(i: number, j: number, k: number): number {
    return ((i + 512) * 1024 + (j + 512)) * 1024 + (k + 512);
  }

  /** a（x,y,z の並び）の各頂点で、一番近い体の点の法線の向きに clear 以上離れていなければ外へ出す */
  pushOut(a: Float32Array, clear: number): void {
    const c = this.cell, P = this.pts, N = this.nrm;
    for (let v = 0; v < a.length; v += 3) {
      const x = a[v], y = a[v + 1], z = a[v + 2];
      const ci = Math.floor(x / c), cj = Math.floor(y / c), ck = Math.floor(z / c);
      let best = -1, bestD = Infinity;
      for (let di = -1; di <= 1; di++) {
        for (let dj = -1; dj <= 1; dj++) {
          for (let dk = -1; dk <= 1; dk++) {
            const list = this.cells.get(this.keyOf(ci + di, cj + dj, ck + dk));
            if (!list) continue;
            for (const j of list) {
              const d = (P[3 * j] - x) ** 2 + (P[3 * j + 1] - y) ** 2 + (P[3 * j + 2] - z) ** 2;
              if (d < bestD) { bestD = d; best = j; }
            }
          }
        }
      }
      if (best < 0) continue;
      const nx = N[3 * best], ny = N[3 * best + 1], nz = N[3 * best + 2];
      const out = (x - P[3 * best]) * nx + (y - P[3 * best + 1]) * ny + (z - P[3 * best + 2]) * nz;
      if (out >= clear) continue;
      a[v] = x + nx * (clear - out);
      a[v + 1] = y + ny * (clear - out);
      a[v + 2] = z + nz * (clear - out);
    }
  }
}

/**
 * 円錐の表面に貼った部品（リボン）を、円錐の頂点の動きに合わせて動かす。
 * 部品の各頂点に一番近い円錐の頂点を最初に決めておき、その頂点と同じだけずらす
 */
class Follow {
  private readonly base: Float32Array;
  private readonly baseNormal: Float32Array;
  private readonly near: Int32Array;

  constructor(private readonly geometry: THREE.BufferGeometry, private readonly target: Swell) {
    const p = geometry.getAttribute('position') as THREE.BufferAttribute;
    this.base = Float32Array.from(p.array as Float32Array);
    this.baseNormal = Float32Array.from(geometry.getAttribute('normal').array as Float32Array);
    this.near = new Int32Array(p.count);
    const t = target.rest;
    for (let v = 0; v < p.count; v++) {
      const x = this.base[3 * v], y = this.base[3 * v + 1], z = this.base[3 * v + 2];
      let best = 0, bd = Infinity;
      for (let j = 0; j < t.length; j += 3) {
        const d = (t[j] - x) ** 2 + (t[j + 1] - y) ** 2 + (t[j + 2] - z) ** 2;
        if (d < bd) { bd = d; best = j; }
      }
      this.near[v] = best;
    }
  }

  /** follow なら円錐の頂点について行く。そうでなければ元の形を shift だけずらす。adjust：動かした後、法線を求める前に手を加える */
  apply(follow: boolean, shift: THREE.Vector3, adjust?: (a: Float32Array) => void): void {
    const p = this.geometry.getAttribute('position') as THREE.BufferAttribute;
    const a = p.array as Float32Array;
    const rest = this.target.rest, cur = this.target.current;
    const s = [shift.x, shift.y, shift.z];
    for (let v = 0; v < p.count; v++) {
      const j = this.near[v];
      for (let c = 0; c < 3; c++) {
        a[3 * v + c] = this.base[3 * v + c] + (follow ? cur[j + c] - rest[j + c] : s[c]);
      }
    }
    adjust?.(a);
    p.needsUpdate = true;
    if (follow) this.geometry.computeVertexNormals();
    else {
      const n = this.geometry.getAttribute('normal') as THREE.BufferAttribute;
      (n.array as Float32Array).set(this.baseNormal);
      n.needsUpdate = true;
    }
    this.geometry.computeBoundingSphere();
  }
}

class Swell {
  private readonly base: Float32Array;
  private readonly dir: Float32Array;
  private readonly dist: Float32Array;
  private readonly t: Float32Array;

  constructor(
    private readonly geometry: THREE.BufferGeometry,
    segments: number,
    ring: number,
    tOf: (row: number) => number,
    curve: (t: number) => THREE.Vector3,
    private readonly scale: number,
  ) {
    const p = geometry.getAttribute('position') as THREE.BufferAttribute;
    this.base = Float32Array.from(p.array as Float32Array);
    this.dir = new Float32Array(p.count * 3);
    this.dist = new Float32Array(p.count);
    this.t = new Float32Array(p.count);
    for (let i = 0; i <= segments; i++) {
      const t = tOf(i);
      const c = curve(t);
      for (let j = 0; j < ring; j++) {
        const v = i * ring + j;
        const d = new THREE.Vector3(p.getX(v) - c.x, p.getY(v) - c.y, p.getZ(v) - c.z);
        this.dist[v] = d.length();
        d.normalize();
        this.dir.set([d.x, d.y, d.z], 3 * v);
        this.t[v] = t;
      }
    }
  }

  /** 元の頂点位置 */
  get rest(): Float32Array {
    return this.base;
  }

  /** 今の頂点位置 */
  get current(): Float32Array {
    return (this.geometry.getAttribute('position') as THREE.BufferAttribute).array as Float32Array;
  }

  /** push(t) だけ太らせる。fold があれば、断面を折り曲げた中心線へ移す */
  apply(push: (t: number) => number, fold: Fold | null = null, post?: (a: Float32Array) => void): void {
    const p = this.geometry.getAttribute('position') as THREE.BufferAttribute;
    const a = p.array as Float32Array;
    const off = new THREE.Vector3(), q = new THREE.Quaternion(), c = new THREE.Vector3();
    for (let v = 0; v < p.count; v++) {
      const t = this.t[v];
      const k = push(t) * this.scale;
      if (!fold) {
        for (let j = 0; j < 3; j++) a[3 * v + j] = this.base[3 * v + j] + this.dir[3 * v + j] * k;
        continue;
      }
      // 元の中心からのずれを、折り曲げた段の向きへ回して、新しい中心に足す
      const f = Math.min(1, Math.max(0, t)) * FOLD_N, i = Math.min(FOLD_N - 1, Math.floor(f)), w = f - i;
      const o = fold.orig[i].clone().lerp(fold.orig[i + 1], w);
      c.copy(fold.centers[i]).lerp(fold.centers[i + 1], w);
      q.copy(fold.rot[i]).slerp(fold.rot[i + 1], w);
      off.set(this.base[3 * v], this.base[3 * v + 1], this.base[3 * v + 2]).sub(o)
        .addScaledVector(new THREE.Vector3(this.dir[3 * v], this.dir[3 * v + 1], this.dir[3 * v + 2]), k)
        .applyQuaternion(q);
      // 地面側（下向き）のずれは、地面までの高さに収まるよう縮める
      const down = -off.dot(fold.up);
      if (down > 0) {
        const room = fold.room[i] * (1 - w) + fold.room[i + 1] * w;
        const r = this.dist[v] + k;
        if (r > room) off.addScaledVector(fold.up, down * (1 - room / r));
      }
      a[3 * v] = c.x + off.x;
      a[3 * v + 1] = c.y + off.y;
      a[3 * v + 2] = c.z + off.z;
    }
    post?.(a);
    p.needsUpdate = true;
    this.geometry.computeVertexNormals();
    this.geometry.computeBoundingSphere();
  }
}
/** 垂らせない所のフリル：つばの裏をどこまで外へ流すか（つばの半径に対する比）と、つばの上面からの深さ */
const FRILL_TUCK_R = 0.9;
const FRILL_TUCK_Y = 0.07;
/** フリルを外へ広げる量の上限（帽子の単位。裾がつばの縁より外へ出ないくらい） */
const FRILL_PUSH_MAX = 0.35;
/** 円錐を広げたとき、頭・髪から離しておく隙間（帽子の単位） */
const CROWN_GAP = 0.015;

/** 帽子の4点を取る高さ（顔座標の y） */
const ANCHOR_FY = 0.98;

/**
 * つばの下に垂れるフリル：根元はかぶる所の半径、下へ広がりながら細かく波打つ。
 * 頭（と髪）にめり込む所は、波の形を保ったまま外へ押し出す（fit）
 */
class Frill {
  static readonly SEG = 220;
  static readonly ROWS = 6;
  static readonly WAVES = 30;
  /** 押し出したあとも頭・髪から離しておく隙間（帽子の単位） */
  static readonly GAP = 0.05;
  readonly geometry = new THREE.BufferGeometry();
  private last: Float32Array[] = [];

  /** brimTop：つばの上面の高さ（中心からの距離 → y）、brimR：つばの外周の半径 */
  constructor(private readonly brimTop: (r: number) => number, private readonly brimR: number) {
    const { SEG, ROWS } = Frill;
    this.geometry.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array((ROWS + 1) * (SEG + 1) * 3), 3));
    const index: number[] = [];
    for (let r = 0; r < ROWS; r++) {
      for (let s = 0; s < SEG; s++) {
        const a = r * (SEG + 1) + s, b = a + SEG + 1;
        index.push(a, a + 1, b, b, a + 1, b + 1);
      }
    }
    this.geometry.setIndex(index);
    this.place(() => 0);
  }

  /** 元の形。push(段, 列) だけ外へ広げる。length(列) は段の数で数えた長さ（それより下の段はそこにまとめる） */
  private place(push: (r: number, s: number) => number, length: (s: number) => number = () => Frill.ROWS): void {
    const { SEG, ROWS, WAVES } = Frill;
    const p = this.geometry.getAttribute('position') as THREE.BufferAttribute;
    for (let r = 0; r <= ROWS; r++) {
      for (let s = 0; s <= SEG; s++) {
        const a = (s / SEG) * Math.PI * 2;
        const L = length(s % SEG);
        // 根元はつばの裏（頭の少し外）、下へ広がって頭のまわりに垂れる
        const v = Math.min(r, L) / ROWS;
        let rad = Frill.baseRad(v) + push(r, s % SEG);
        let y = Frill.baseY(v);
        if (r > L) {
          // 垂らせない所（頭に当たる所）は、裾をつばの裏に沿わせて外へ流し、縁からのぞかせる
          const t = (r - L) / Math.max(1e-3, ROWS - L);
          const out = Math.max(rad, this.brimR * FRILL_TUCK_R);
          rad += (out - rad) * t;
          y += (this.brimTop(rad) - FRILL_TUCK_Y - y) * t;
        }
        const w = r / ROWS; // 波は段の番号で（たくし上げた所も、垂れた所と同じだけ波打つ）
        rad += 0.07 * w * Math.sin(a * WAVES);
        y += 0.035 * w * Math.sin(a * WAVES * 0.5 + 1);
        p.setXYZ(r * (SEG + 1) + s, Math.sin(a) * rad, y, Math.cos(a) * rad);
      }
    }
    p.needsUpdate = true;
    this.geometry.computeVertexNormals();
    this.geometry.computeBoundingSphere();
  }

  private static baseRad(v: number): number { return 1.1 + 0.45 * v; }
  private static baseY(v: number): number { return -0.03 - 0.38 * v; }

  /** 次の fit で必ず頂点を置き直す */
  invalidate(): void {
    this.last = [];
  }

  /**
   * pts（帽子の中の座標の点。髪の表面）について、フリルの各段の高さで頭の外周の半径を測り、
   * そこに隙間を足した所より内側にあるフリルを外へ押し出す
   */
  fit(pts: Float32Array, n: number): void {
    const { SEG, ROWS } = Frill;
    // 段ごと・角度ごとの頭の外周の半径
    const BINS = 90;
    const need = Array.from({ length: ROWS + 1 }, () => new Float32Array(BINS));
    const band = 0.07; // 段の高さからこの範囲の点を見る
    for (let j = 0; j < n; j++) {
      const x = pts[3 * j], y = pts[3 * j + 1], z = pts[3 * j + 2];
      const rad = Math.hypot(x, z);
      const bin = Math.floor(((Math.atan2(x, z) / (Math.PI * 2) + 1) % 1) * BINS) % BINS;
      for (let r = 0; r <= ROWS; r++) {
        if (Math.abs(y - Frill.baseY(r / ROWS)) > band) continue;
        if (rad > need[r][bin]) need[r][bin] = rad;
      }
    }
    // 押し出す量：波の一番内側が「頭の外周 + 髪 + 隙間」に届くまで
    const push = need.map((row, r) => {
      const v = r / ROWS;
      const inner = Frill.baseRad(v) - 0.07 * v;
      return Float32Array.from(row, (R) => (R > 0 ? Math.max(0, R + Frill.GAP - inner) : 0));
    });
    // 隣の角度も見て（頂点の間をすり抜けないように）なめらかにする
    const smooth = push.map((row) => Float32Array.from(row, (_, b) => {
      let m = 0;
      for (let k = -2; k <= 2; k++) m = Math.max(m, row[(b + k + BINS) % BINS]);
      return m;
    }));
    // 下の段は上の段より内側に入らない（裾がすぼまって頭に巻き込まないように）
    for (let r = 1; r <= ROWS; r++) {
      for (let b = 0; b < BINS; b++) smooth[r][b] = Math.max(smooth[r][b], smooth[r - 1][b]);
    }
    // 外へ広げるのは FRILL_PUSH_MAX まで。それ以上押し出す必要がある所は、その段から下を
    // つばの裏に沿わせて外へ流す（頭の横幅が広い体型や、胴の長い体型で頭の後ろの背中に当たる所など）
    const len = new Float32Array(BINS).fill(ROWS);
    for (let b = 0; b < BINS; b++) {
      for (let r = 0; r <= ROWS; r++) {
        if (smooth[r][b] > FRILL_PUSH_MAX) { len[b] = Math.max(0, r - 1); break; }
      }
    }
    // 長さは隣の角度となめらかにつなぐ（短い方に合わせる）
    const lenS = Float32Array.from(len, (_, b) => {
      let m = ROWS;
      for (let k = -3; k <= 3; k++) m = Math.min(m, len[(b + k + BINS) % BINS] + Math.abs(k) * 0.5);
      return m;
    });
    for (let r = 0; r <= ROWS; r++) for (let b = 0; b < BINS; b++) smooth[r][b] = Math.min(smooth[r][b], FRILL_PUSH_MAX);
    const state = [...smooth, lenS];
    // 前と変わらなければ頂点を動かさない
    let change = this.last.length === 0 ? 1 : 0;
    for (let r = 0; r < state.length && change < 0.002; r++) {
      for (let b = 0; b < BINS; b++) change = Math.max(change, Math.abs(state[r][b] - this.last[r][b]));
    }
    if (change < 0.002) return;
    this.last = state;
    const at = (row: Float32Array, s: number) => {
      const t = (s / SEG) * BINS - 0.5;
      const b0 = Math.floor(t), f = t - b0;
      return row[(b0 + BINS) % BINS] * (1 - f) + row[(b0 + 1) % BINS] * f;
    };
    this.place((r, s) => at(smooth[Math.min(r, Math.floor(at(lenS, s)))], s), (s) => at(lenS, s));
  }
}
