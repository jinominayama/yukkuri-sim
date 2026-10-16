import type { BrowKind, ExpressionDef, EyeKind, FaceState, FaceStyle, MouthKind, SweatSpot } from '../types';

/**
 * 顔のパーツの配置（顔座標・単位は頭の半径）。絵柄ごとに変えられる。
 * 目は右目（見る人から見て右、+x 側）の値で、左目は左右反転して描く
 */
export interface FaceLayout {
  /** 目の中心 */
  eyeX: number;
  eyeY: number;
  /** 目の大きさ（横・縦の半径） */
  eyeW: number;
  eyeH: number;
  /** 眉の、目の上端からの高さ */
  browGap: number;
  /** 口の中心の高さと横の半径 */
  mouthY: number;
  mouthW: number;
  /** 頬の赤みの中心 */
  cheekX: number;
  cheekY: number;
}

export interface FacePalette {
  /** 線（まつ毛・眉・口の輪郭） */
  line: string;
  /** 白目 */
  white: string;
  /** 口の中（奥と手前） */
  mouth: string;
  mouthDeep: string;
  /** 大きく開けた口の奥（赤黒い） */
  mouthDark: string;
  tongueLight: string;
  /** 歯の影 */
  teethShade: string;
  tongue: string;
  teeth: string;
  /** 頬の赤み（rgb） */
  blush: [number, number, number];
  /** 涙・汗の塗りと輪郭 */
  water: string;
  waterLine: string;
  /** つぶった目尻にたまる涙（肌が透けて薄桃色に見える） */
  tearPink: string;
  tearPinkLine: string;
  /** 汗の粒・透けた肌の色・肌に落ちる影 */
  sweat: string;
  sweatPink: string;
  sweatShadow: string;
  /** 口の線の縁のにじみ（茶色） */
  lipEdge: string;
  /** 眉 */
  brow: string;
  /** 閉じた目の上のしわ */
  crease: string;
  /** 口の中の斜線の影 */
  hatch: string;
}

type Pt = [number, number];

/**
 * 参考画像に合わせたアニメ調の絵柄。
 * 他の絵柄はこのクラスを継承し、変えたいパーツのメソッドだけ上書きする（simple.ts を参照）
 */
export class AnimeStyle implements FaceStyle {
  id = 'anime';
  name = 'アニメ調';

  protected layout: FaceLayout = {
    eyeX: 0.47, eyeY: 0.26, eyeW: 0.22, eyeH: 0.18,
    browGap: 0.05,
    mouthY: -0.03, mouthW: 0.13,
    cheekX: 0.68, cheekY: 0.06,
  };

  protected palette: FacePalette = {
    line: '#1c0f09',
    white: '#ffffff',
    mouth: '#b4473f',
    mouthDeep: '#7a2622',
    mouthDark: '#3e0f0a',
    tongueLight: '#f6b9a2',
    teethShade: 'rgba(150, 166, 204, 0.75)',
    tongue: '#ec8a80',
    teeth: '#fffdf8',
    blush: [240, 100, 100],
    water: 'rgba(240, 248, 255, 0.92)',
    waterLine: '#86a6c4',
    tearPink: 'rgba(255, 226, 228, 0.95)',
    tearPinkLine: '#cf8f98',
    sweat: '#fffdf9',
    sweatPink: 'rgba(238, 160, 160, 0.55)',
    sweatShadow: 'rgba(226, 128, 92, 0.42)',
    lipEdge: 'rgba(176, 98, 64, 0.75)',
    brow: '#4a2a1a',
    crease: 'rgba(150, 82, 52, 0.7)',
    hatch: 'rgba(70, 18, 16, 0.75)',
  };

  /** 線の太さの基準（頭の半径に対する比） */
  protected lineWidth = 0.018;

  draw(ctx: CanvasRenderingContext2D, state: FaceState): void {
    const ex = state.expression;
    const f = ex.flip ?? {};
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    // パーツごとに、左右反転するなら顔の中心線で鏡写しにして描く
    const layer = (flip: boolean | undefined, draw: () => void) => {
      ctx.save();
      if (flip) ctx.scale(-1, 1);
      draw();
      ctx.restore();
    };
    /** 画面上の側 side（+1 = 右）にある目の形。目の左右反転も考える */
    const eyeAt = (side: 1 | -1, partFlip: boolean | undefined): EyeKind => {
      const screen = partFlip ? -side : side;
      return this.eyeKind(ex, (f.eyes ? -screen : screen) as 1 | -1);
    };
    const sides = [1, -1] as const;
    if (ex.blush) layer(f.blush, () => this.drawBlush(ctx, ex.blush!));
    layer(f.eyes, () => sides.forEach((s) => this.drawEye(ctx, s, state)));
    if (ex.tearStream) layer(f.stream, () => sides.forEach((s) => this.drawTearStream(ctx, s, eyeAt(s, f.stream) !== 'open', ex.tearStream!)));
    if (ex.tears) layer(f.tears, () => sides.forEach((s) => this.drawTearPool(ctx, s, eyeAt(s, f.tears) !== 'open', ex.tears!)));
    if (ex.brows !== 'none') layer(f.brows, () => sides.forEach((s) => this.drawBrow(ctx, s, ex.brows, eyeAt(s, f.brows) === 'squeeze')));
    if (ex.mouth.kind !== 'none') {
      layer(f.mouth, () => {
        const from = this.drawMouth(ctx, ex.mouth.kind, ex.mouth.open ?? 1, ex.mouth.width ?? 1);
        // よだれは口と一緒に左右反転する
        if (ex.drool && from) this.drawDrool(ctx, from, ex.drool);
      });
    }
    if (ex.strain) layer(f.strain, () => this.drawStrain(ctx, ex.strain!));
    if (ex.sweat?.length) layer(f.sweat, () => this.drawSweat(ctx, ex.sweat!));
  }

  /** 目の形。左目（s = -1）だけ別の形を指定できる（ウインクなど） */
  protected eyeKind(ex: ExpressionDef, s: 1 | -1): EyeKind {
    return s === -1 && ex.eyes.other ? ex.eyes.other : ex.eyes.kind;
  }

  // ---- 目 ----
  //
  // 目の形は参考画像（顔の傾きを補正したもの）の輪郭をなぞった点列で持つ。
  // 目の座標：目の中心が原点、横は目の半幅・縦は目の半高を 1 とし、x は目尻側が +、y は上が +。

  /** s：+1 = 右目（見る人から見て）、-1 = 左目 */
  protected drawEye(ctx: CanvasRenderingContext2D, s: 1 | -1, state: FaceState): void {
    const eyes = state.expression.eyes;
    switch (this.eyeKind(state.expression, s)) {
      case 'open': {
        // まばたき：上まぶたが下りる。ほぼ閉じたら閉じた目として描く
        const open = (eyes.open ?? 1) * (1 - state.blink);
        if (open < 0.15) this.drawClosedEye(ctx, s);
        else this.drawOpenEye(ctx, s, open, state);
        break;
      }
      case 'smile': this.drawSmileEye(ctx, s); break;
      case 'closed': this.drawClosedEye(ctx, s); break;
      case 'squeeze': this.drawSqueezeEye(ctx, s); break;
    }
  }

  /** 目の座標の点列を、顔座標の滑らかな折れ線にする */
  protected eyeLine(pts: Pt[], s: 1 | -1, steps = 10): Pt[] {
    const { eyeX, eyeY, eyeW: w, eyeH: h } = this.layout;
    return this.spline(pts.map(([x, y]): Pt => [s * eyeX + s * x * w, eyeY + y * h]), steps);
  }

  /**
   * 開いた目の輪郭（目の座標）。参考画像の目は角の丸い四角に近い：
   * 目頭側はほぼ垂直で線がなく、上は平ら、目尻側は太い黒でまっすぐ下りる。
   * open が小さいほど上まぶたがまっすぐな線で下りてきて、lid が + なら目尻側が下がる（困り目）
   */
  protected eyeOpening(open: number, lid: number): { top: Pt[]; outer: Pt[]; bottom: Pt[]; inner: Pt[] } {
    // 上まぶたの線：これより上は隠れる
    const lidAt = (x: number) => -0.95 + 1.95 * open - lid * 0.55 * (x + 1) * 0.5 + lid * 0.25;
    const clamp = (p: Pt[]): Pt[] => p.map(([x, y]): Pt => [x, Math.min(y, lidAt(x))]);
    return {
      top: clamp([[-0.95, 0.35], [-0.82, 0.74], [-0.45, 0.93], [0.15, 0.97], [0.62, 0.88], [0.92, 0.6]]),
      outer: clamp([[0.92, 0.6], [1.0, 0.2], [0.98, -0.3], [0.88, -0.68]]),
      bottom: [[0.88, -0.68], [0.5, -0.94], [-0.1, -0.98], [-0.6, -0.86], [-0.9, -0.45]],
      inner: clamp([[-0.9, -0.45], [-1.0, -0.05], [-0.95, 0.35]]),
    };
  }

  protected drawOpenEye(ctx: CanvasRenderingContext2D, s: 1 | -1, open: number, state: FaceState): void {
    const { eyeW: w, eyeH: h } = this.layout;
    const eyes = state.expression.eyes;
    const teary = eyes.teary ?? 0;
    const look = eyes.look ?? [0, 0];
    const lw = this.lineWidth;
    const o = this.eyeOpening(open, eyes.lid ?? 0);
    const top = this.eyeLine(o.top, s);
    const outer = this.eyeLine(o.outer, s);
    const bottom = this.eyeLine(o.bottom, s);
    const inner = this.eyeLine(o.inner, s);
    const shape = this.closedPath([top, outer, bottom, inner]);
    /** 目の座標 → 顔座標 */
    const P = (x: number, y: number): Pt => this.eyeLine([[x, y]], s, 1)[0];

    // 白目
    ctx.fillStyle = this.palette.white;
    ctx.fill(shape);
    ctx.save();
    ctx.clip(shape);
    // 上まぶたの下の青灰色の影
    ctx.fillStyle = 'rgba(150, 162, 196, 0.55)';
    this.strokeVar(ctx, top, h * 0.45, h * 0.5, h * 0.45);

    // 瞳：目頭寄りの縦長の楕円。上半分はまぶたの影でほぼ黒く、下に明るい三日月
    const iris = state.look.iris;
    const [ix, iy] = P(-0.16 + look[0], -0.04 + look[1]);
    const rx = 0.64 * w, ry = 0.98 * h;
    const g = ctx.createLinearGradient(0, iy + ry, 0, iy - ry);
    g.addColorStop(0, mix(iris, '#000000', 0.9));
    g.addColorStop(0.45, mix(iris, '#000000', 0.75));
    g.addColorStop(0.75, mix(iris, '#000000', 0.2));
    g.addColorStop(1, iris);
    ctx.beginPath();
    ctx.ellipse(ix, iy, rx, ry, 0, 0, Math.PI * 2);
    ctx.fillStyle = g;
    ctx.fill();
    // 下の明るい三日月
    ctx.save();
    ctx.beginPath();
    ctx.ellipse(ix, iy, rx, ry, 0, 0, Math.PI * 2);
    ctx.clip();
    ctx.beginPath();
    ctx.ellipse(ix + s * rx * 0.05, iy - ry * 0.62, rx * 0.78, ry * 0.42, 0, 0, Math.PI * 2);
    ctx.fillStyle = mix(iris, '#ffffff', 0.28);
    ctx.fill();
    ctx.restore();
    // 瞳孔（大きく、明るい三日月の上に重なる）
    ctx.beginPath();
    ctx.ellipse(ix, iy + ry * 0.1, rx * 0.6, ry * 0.62, 0, 0, Math.PI * 2);
    ctx.fillStyle = mix(iris, '#000000', 0.92);
    ctx.fill();
    // 瞳の縁
    ctx.beginPath();
    ctx.ellipse(ix, iy, rx, ry, 0, 0, Math.PI * 2);
    ctx.lineWidth = lw * 1.1;
    ctx.strokeStyle = mix(iris, '#000000', 0.9);
    ctx.stroke();
    // 涙ぐみ：下まぶたに沿って涙がたまる
    if (teary > 0) {
      ctx.fillStyle = `rgba(225, 240, 255, ${0.75 * teary})`;
      this.strokeVar(ctx, this.eyeLine([[0.8, -0.72], [0.2, -0.86], [-0.5, -0.78]], s), h * 0.12, h * 0.28 * teary, h * 0.12);
    }
    // ハイライト：光は見る人から見て左上（左右の目で同じ向き）
    const hx = (dx: number) => ix + dx * rx;
    this.dot(ctx, hx(-0.42), iy + ry * 0.42, w * 0.2, '#ffffff');
    this.dot(ctx, hx(-0.05), iy + ry * 0.12, w * 0.05, '#ffffff');
    this.dot(ctx, hx(0.42), iy - ry * 0.55, w * 0.07, '#ffffff');
    if (teary > 0) {
      this.dot(ctx, hx(0.15), iy - ry * 0.2, w * 0.06, `rgba(255,255,255,${teary})`);
      this.dot(ctx, hx(-0.5), iy - ry * 0.5, w * 0.09, `rgba(255,255,255,${teary})`);
      this.dot(ctx, hx(0.5), iy + ry * 0.2, w * 0.05, `rgba(255,255,255,${teary})`);
    }
    ctx.restore();

    ctx.fillStyle = this.palette.line;
    // 上まぶた：目頭は細く、目尻ほど太い黒い帯。目尻側の辺もそのまま太く下りる
    this.strokeVar(ctx, top, lw * 0.7, lw * 2.6, lw * 3.4);
    this.strokeVar(ctx, outer, lw * 3.4, lw * 2.4, lw * 1.3);
    // 目尻の跳ね：外側やや下へとがる
    const [tx, ty] = outer[0];
    ctx.beginPath();
    ctx.moveTo(tx, ty + lw * 1.6);
    ctx.lineTo(...P(1.32, 0.32));
    ctx.lineTo(tx, ty - lw * 2.2);
    ctx.closePath();
    ctx.fill();
    // 上へ跳ねる短いまつ毛（目尻寄り）
    for (const [t, dx, dy] of [[0.8, 0.08, 0.26], [0.95, 0.2, 0.18]] as const) {
      const [bx, by] = top[Math.round(t * (top.length - 1))];
      this.strokeVar(ctx, [[bx, by + lw], [bx + s * dx * w, by + dy * h]], lw * 1.2, lw * 0.7, lw * 0.12);
    }
    // 下まぶた：目尻側だけ細い線
    this.strokeVar(ctx, bottom.slice(0, Math.round(bottom.length * 0.62)), lw * 1.2, lw * 0.8, lw * 0.25);
    // 目頭の細い線
    this.strokeVar(ctx, this.eyeLine([[-0.88, -0.48], [-0.98, -0.2]], s, 4), lw * 0.6, lw * 0.5, lw * 0.15);
  }

  /** 目の上の皮膚のしわ（閉じた目・つぶった目の上に出る細い線） */
  protected drawLidCrease(ctx: CanvasRenderingContext2D, s: 1 | -1, pts: Pt[]): void {
    ctx.fillStyle = this.palette.crease;
    this.strokeVar(ctx, this.eyeLine(pts, s), this.lineWidth * 0.2, this.lineWidth * 0.75, this.lineWidth * 0.2);
  }

  /**
   * 笑って閉じた目・こらえる目（参考：横倒しの魔理沙）。上へ膨らむ太い弧「⌒」で、
   * 目頭は細く、中ほどから目尻が太い。目尻は少し下へ巻き、上に細いしわ
   */
  protected drawSmileEye(ctx: CanvasRenderingContext2D, s: 1 | -1): void {
    const lw = this.lineWidth;
    const arc = this.eyeLine([[-0.95, -0.12], [-0.5, 0.2], [0.2, 0.32], [0.72, 0.18], [1.0, -0.08]], s);
    ctx.fillStyle = this.palette.line;
    this.strokeVar(ctx, arc, lw * 0.6, lw * 3.2, lw * 2.2);
    // 目尻から下へ伸びる短いまつ毛
    const [ox, oy] = arc[arc.length - 1];
    const { eyeW: w, eyeH: h } = this.layout;
    this.strokeVar(ctx, [[ox, oy], [ox + s * w * 0.14, oy - h * 0.32]], lw * 1.6, lw * 0.9, lw * 0.15);
    this.drawLidCrease(ctx, s, [[-0.45, 0.78], [0.2, 0.9], [0.7, 0.7]]);
  }

  /** 穏やかに閉じた目（眠る）：下へ膨らむ太い弧と、下向きのまつ毛 */
  protected drawClosedEye(ctx: CanvasRenderingContext2D, s: 1 | -1): void {
    const lw = this.lineWidth;
    const { eyeW: w, eyeH: h } = this.layout;
    const arc = this.eyeLine([[-0.95, 0.0], [-0.4, -0.38], [0.3, -0.42], [0.82, -0.12], [1.02, 0.08]], s);
    ctx.fillStyle = this.palette.line;
    this.strokeVar(ctx, arc, lw * 0.5, lw * 2.4, lw * 2.0);
    for (const t of [0.6, 0.8, 0.96]) {
      const [x, y] = arc[Math.round(t * (arc.length - 1))];
      this.strokeVar(ctx, [[x, y], [x + s * w * 0.12 * t, y - h * 0.3]], lw * 1.2, lw * 0.7, lw * 0.15);
    }
  }

  /**
   * ぎゅっとつぶった目（参考：泣き叫ぶ魔理沙・食いしばる霊夢・アリス）。
   * 目尻側が太く、目頭へ向かってとがるくさび形の帯で、わずかに上へ反る。
   * 目尻の端からまつ毛が扇状に広がり、上に細いしわ
   */
  protected drawSqueezeEye(ctx: CanvasRenderingContext2D, s: 1 | -1): void {
    const lw = this.lineWidth;
    const { eyeW: w, eyeH: h } = this.layout;
    const band = this.eyeLine([[-0.8, -0.08], [-0.45, 0.1], [0.1, 0.24], [0.6, 0.24], [1.02, 0.08]], s);
    ctx.fillStyle = this.palette.line;
    this.strokeVar(ctx, band, lw * 0.3, lw * 3.0, lw * 4.4);
    // 目尻のまつ毛（扇状）
    const [ox, oy] = band[band.length - 1];
    for (const [dx, dy] of [[0.22, 0.45], [0.36, 0.22], [0.4, -0.04], [0.3, -0.3]] as const) {
      this.strokeVar(ctx, [[ox - s * w * 0.06, oy], [ox + s * dx * w, oy + dy * h]], lw * 1.8, lw * 1.0, lw * 0.15);
    }
    this.drawLidCrease(ctx, s, [[-0.35, 0.62], [0.25, 0.78], [0.8, 0.62]]);
  }

  // ---- 涙・眉 ----

  /** 頬を伝う涙の筋（大泣きのときだけ）。shut：その側の目が閉じているか */
  protected drawTearStream(ctx: CanvasRenderingContext2D, s: 1 | -1, shut: boolean, stream: number): void {
    const { eyeX, eyeY, eyeW: w, eyeH: h } = this.layout;
    const cx = s * eyeX;
    // 目尻の涙の粒のあたりから垂れる
    if (shut) this.tearStream(ctx, cx + s * w * 1.0, eyeY - 0.35 * h, 0.32 * stream, w * 0.3);
    else this.tearStream(ctx, cx + s * w * 0.85, eyeY - 0.9 * h, 0.55 * stream, w * 0.3);
  }

  /** 目尻・目頭にたまる涙の粒。shut：その側の目が閉じているか */
  protected drawTearPool(ctx: CanvasRenderingContext2D, s: 1 | -1, shut: boolean, pool: number): void {
    const { eyeX, eyeY, eyeW: w, eyeH: h } = this.layout;
    const cx = s * eyeX;
    // 目尻にたまる薄桃色の粒（つぶった目では目尻から、開いた目では下まぶたの目尻寄り）
    if (shut) {
      this.pinkDrop(ctx, cx + s * w * 1.05, eyeY - 0.3 * h, w * 0.5 * pool, w * 0.32 * pool);
    } else {
      this.pinkDrop(ctx, cx + s * w * 0.85, eyeY - 0.85 * h, w * 0.46 * pool, w * 0.3 * pool);
      // 目頭にも小さく
      this.pinkDrop(ctx, cx - s * w * 0.95, eyeY - 0.45 * h, w * 0.26 * pool, w * 0.19 * pool);
    }
  }

  /**
   * 眉（参考画像：前髪の下に見える細く短い焦げ茶の線）。両端が細く、中ほどがわずかに太い。
   * squeezed：その側の目をぎゅっとつぶっているか（眉も下がる）
   */
  protected drawBrow(ctx: CanvasRenderingContext2D, s: 1 | -1, kind: BrowKind, squeezed: boolean): void {
    const { eyeH: h, browGap } = this.layout;
    const lw = this.lineWidth;
    // 目の座標での高さ（目の上端から browGap 上）
    const by = 1 + browGap / h - (squeezed ? 0.35 : 0);
    let pts: Pt[];
    let width = lw * 1.0;
    switch (kind) {
      case 'worried':
        // 困り眉：目頭側が上がり、目尻へなだらかに下がる「ハ」の字（上へ少し膨らむ）
        pts = [[-0.75, by + 0.55], [-0.35, by + 0.5], [0.2, by + 0.22], [0.75, by - 0.12]];
        break;
      case 'angry':
        // しかめ眉：目頭側が下がって寄り、目尻へ上がる。目頭の端は少し下へ巻く
        pts = [[-0.85, by - 0.55], [-0.62, by - 0.38], [-0.15, by - 0.02], [0.4, by + 0.22], [0.85, by + 0.25]];
        width = lw * 1.25;
        break;
      default:
        // 普通：目の上の短くゆるい弧
        pts = [[-0.6, by + 0.02], [-0.15, by + 0.2], [0.35, by + 0.2], [0.75, by + 0.02]];
        width = lw * 0.85;
    }
    ctx.fillStyle = this.palette.brow;
    this.strokeVar(ctx, this.eyeLine(pts, s), width * 0.25, width, width * 0.3);
  }

  /** 力み：眉間と目のまわりのしわ */
  protected drawStrain(ctx: CanvasRenderingContext2D, amount: number): void {
    const { eyeX, eyeY, eyeW: w, eyeH: h, browGap } = this.layout;
    const y = eyeY + h + browGap - 0.1;
    ctx.strokeStyle = withAlpha(this.palette.line, 0.7 * amount);
    ctx.lineWidth = this.lineWidth * 0.8;
    ctx.beginPath();
    for (const s of [1, -1]) {
      // 眉間の縦じわ
      ctx.moveTo(s * 0.04, y + 0.08);
      ctx.quadraticCurveTo(s * 0.015, y + 0.02, s * 0.05, y - 0.05);
      ctx.moveTo(s * 0.1, y + 0.06);
      ctx.quadraticCurveTo(s * 0.08, y + 0.02, s * 0.1, y - 0.02);
      // 目頭の上のしわ
      const cx = s * eyeX;
      ctx.moveTo(cx - s * w * 0.9, eyeY + h * 0.55);
      ctx.quadraticCurveTo(cx - s * w * 0.4, eyeY + h * 0.8, cx + s * w * 0.1, eyeY + h * 0.85);
    }
    ctx.stroke();
    // 鼻筋の斜めのしわ（眉頭から寄る）
    ctx.beginPath();
    for (const s of [1, -1]) {
      ctx.moveTo(s * 0.16, eyeY + h * 0.35);
      ctx.lineTo(s * 0.08, eyeY + h * 0.05);
      ctx.moveTo(s * 0.2, eyeY + h * 0.2);
      ctx.lineTo(s * 0.13, eyeY - h * 0.05);
    }
    ctx.stroke();
  }

  // ---- 口 ----
  //
  // 口の形は参考画像の輪郭をなぞった点列（口の中心が原点、口の半幅を 1 とした座標、y が上）で持つ。
  // 点列は滑らかな曲線（Catmull-Rom）で結び、角を立てたいところは辺を分けている。
  // 線は場所ごとに太さを変える（口角の跳ねは太く、中ほどは細い）。

  /**
   * 口をなぞった参考画像の、顔の傾き（度。見る人から見て右目が上がる向きが +）。
   * なぞった形をこの分だけ逆に回して、正面を向いた顔の口にする
   */
  protected mouthTilt: Partial<Record<MouthKind, number>> = {
    smirk: -6,     // 霊夢（にやり）
    grin: -3.5,    // パチュリー（歯見せ笑い）
    openSmall: -6, // パチュリー（ぽかん）
    sob: -12.7,    // パチュリー（泣き）
    grit: 9,       // 霊夢（食いしばり）
    wail: 0,       // パチュリー（叫び）：なぞる前に 19° 戻してある
  };

  /** 口を描くときに各形が記録する、よだれの垂れ始め（傾きを戻す前の座標） */
  protected droolFrom: Pt | null = null;

  /** 口を描き、よだれの垂れ始めの位置（顔座標）を返す */
  protected drawMouth(ctx: CanvasRenderingContext2D, kind: MouthKind, open: number, width = 1): Pt | null {
    const tilt = this.mouthTilt[kind] ?? 0;
    const my = this.layout.mouthY;
    const a = (-tilt * Math.PI) / 180;
    this.droolFrom = null;
    ctx.save();
    if (tilt) {
      // 口の中心を軸に回す（顔座標は y が上なので、負の角度で時計回り）
      ctx.translate(0, my);
      ctx.rotate(a);
      ctx.translate(0, -my);
    }
    this.drawMouthShape(ctx, kind, open, width);
    ctx.restore();
    // 形を描く間に記録される（TypeScript は呼び出し先での代入を追えないので型を明示）
    const from = this.droolFrom as Pt | null;
    if (!from) return null;
    // 垂れ始めにも同じ回転をかける（よだれ自体は真下へ垂れる）
    const [x, y] = from;
    return [x * Math.cos(a) - (y - my) * Math.sin(a), my + x * Math.sin(a) + (y - my) * Math.cos(a)];
  }

  protected drawMouthShape(ctx: CanvasRenderingContext2D, kind: MouthKind, open: number, width: number): void {
    switch (kind) {
      case 'smirk': this.mouthSmirk(ctx, width); break;
      case 'grin': this.mouthGrin(ctx, width); break;
      case 'smileOpen': this.mouthSmileOpen(ctx, open, width); break;
      case 'openSmall': this.mouthOpenSmall(ctx, open, width); break;
      case 'sob': this.mouthSob(ctx, open, width); break;
      case 'wail': this.mouthWail(ctx, open, width); break;
      case 'grit': this.mouthGrit(ctx, width); break;
      case 'o': this.mouthO(ctx, open); break;
      case 'none': break;
    }
  }

  /**
   * にやっとした閉じた口（参考：霊夢・アリス）。左右非対称の「〜」で、
   * 左端は上へ巻き込み、ゆるく右下がりに伸びて、右端は J 字に跳ね上がる。両端は太く中ほどは細い
   */
  protected mouthSmirk(ctx: CanvasRenderingContext2D, width = 1): void {
    const W = this.layout.mouthW * 2.0 * width;
    const y = this.layout.mouthY;
    this.droolFrom = [0.38 * W, y - 0.16 * W];
    const lw = this.lineWidth;
    const line = this.curve([
      [-0.93, 0.26], [-0.97, 0.15], [-0.9, 0.06], [-0.6, 0.01], [-0.1, -0.08],
      [0.4, -0.16], [0.72, -0.19], [0.9, -0.14], [0.97, -0.02],
    ], W, y);
    // 縁の茶色いにじみ → 黒い線
    ctx.fillStyle = this.palette.lipEdge;
    this.strokeVar(ctx, line, lw * 1.9, lw * 0.9, lw * 1.8);
    ctx.fillStyle = this.palette.line;
    this.strokeVar(ctx, line, lw * 1.5, lw * 0.45, lw * 1.4);
  }

  /**
   * 歯を見せて笑う（参考：パチュリーの強がり）。上の縁はほぼまっすぐで両端が上へ跳ね、
   * 下は浅い器形。歯は縦線を描かず白い塊で、上側に影、右寄りにかすかな上下の境目だけ
   */
  protected mouthGrin(ctx: CanvasRenderingContext2D, width = 1): void {
    const W = this.layout.mouthW * 2.0 * width;
    const y = this.layout.mouthY - 0.01;
    this.droolFrom = [0.2 * W, y - 0.25 * W];
    const lw = this.lineWidth;
    const top = this.curve([[-0.94, 0.19], [-0.6, 0.21], [-0.1, 0.18], [0.5, 0.14], [0.94, 0.11]], W, y);
    const bottom = this.curve([[0.94, 0.11], [0.85, -0.05], [0.6, -0.19], [0.2, -0.26], [-0.4, -0.23], [-0.78, -0.1], [-0.94, 0.19]], W, y);
    const shape = this.closedPath([top, bottom]);
    ctx.fillStyle = this.palette.teeth;
    ctx.fill(shape);
    ctx.save();
    ctx.clip(shape);
    // 上の歯ぐき側の影
    ctx.fillStyle = 'rgba(150, 150, 168, 0.35)';
    this.strokeVar(ctx, top, W * 0.2, W * 0.16, W * 0.2);
    // 上下の歯の境目（右寄りに薄く、少しよれる）
    ctx.fillStyle = 'rgba(80, 80, 92, 0.55)';
    this.strokeVar(ctx, this.curve([[0.1, -0.05], [0.32, -0.07], [0.48, -0.06], [0.53, -0.09], [0.58, -0.06], [0.66, -0.07]], W, y), lw * 0.2, lw * 0.5, lw * 0.25);
    // 左の口角の奥の細い影
    ctx.fillStyle = 'rgba(60, 50, 50, 0.6)';
    this.strokeVar(ctx, this.curve([[-0.86, 0.06], [-0.8, 0.01], [-0.72, 0.0]], W, y), lw * 0.5, lw * 0.4, lw * 0.15);
    ctx.restore();
    ctx.fillStyle = this.palette.line;
    this.strokeVar(ctx, top, lw * 1.5, lw * 1.2, lw * 1.5);
    this.strokeVar(ctx, bottom, lw * 1.5, lw * 1.0, lw * 1.4);
    // 口角の跳ね（上へ巻く）
    this.strokeVar(ctx, this.curve([[-0.94, 0.19], [-1.02, 0.25], [-1.06, 0.36]], W, y), lw * 1.5, lw * 1.1, lw * 0.5);
    this.strokeVar(ctx, this.curve([[0.94, 0.11], [1.04, 0.15], [1.1, 0.24]], W, y), lw * 1.5, lw * 1.1, lw * 0.5);
  }

  /**
   * 口を開けて笑う（参考：草原の魔理沙）。上の縁は口角が上へ跳ねるほぼまっすぐの線で、
   * その下に器形の口の中がぶら下がる。口の中は奥が赤黒く、下半分に舌
   */
  protected mouthSmileOpen(ctx: CanvasRenderingContext2D, open: number, width = 1): void {
    const W = this.layout.mouthW * 1.75 * width;
    const y = this.layout.mouthY;
    this.droolFrom = [0.2 * W, y - 0.8 * Math.max(0.2, open) * W];
    const lw = this.lineWidth;
    const s = Math.max(0.2, open);
    const topLine = this.curve([
      [-1.0, 0.13], [-0.97, 0.03], [-0.86, -0.02], [-0.4, -0.04], [0.4, -0.04], [0.86, -0.02], [0.97, 0.03], [1.0, 0.13],
    ], W, y);
    const inTop = this.curve([[-0.62, -0.035], [0, -0.04], [0.62, -0.035]], W, y);
    const bowl = this.curve([
      [0.62, -0.035], [0.56, -0.3 * s], [0.36, -0.66 * s], [0, -0.86 * s], [-0.36, -0.66 * s], [-0.56, -0.3 * s], [-0.62, -0.035],
    ], W, y);
    const shape = this.closedPath([inTop, bowl]);
    ctx.fillStyle = this.palette.mouthDeep;
    ctx.fill(shape);
    ctx.save();
    ctx.clip(shape);
    // 舌：下半分を覆う、上がゆるく盛り上がった形
    ctx.beginPath();
    ctx.ellipse(0.04 * W, y - 0.92 * s * W, 0.62 * W, 0.5 * s * W, 0, 0, Math.PI * 2);
    ctx.fillStyle = this.palette.tongue;
    ctx.fill();
    ctx.restore();
    ctx.fillStyle = this.palette.line;
    this.strokeVar(ctx, bowl, lw * 1.0, lw * 0.75, lw * 1.0);
    this.strokeVar(ctx, topLine, lw * 1.3, lw * 1.25, lw * 1.3);
  }

  /**
   * 小さく開けた口（参考：きょとんとしたパチュリー）。左上がりに傾いた上の線（両端が跳ねる）の下に、
   * 細いレンズ形の口の中
   */
  protected mouthOpenSmall(ctx: CanvasRenderingContext2D, open: number, width = 1): void {
    const W = this.layout.mouthW * 1.4 * width;
    const y = this.layout.mouthY;
    this.droolFrom = [0.12 * W, y - (0.42 * Math.max(0.3, open) + 0.02) * W];
    const lw = this.lineWidth;
    const s = Math.max(0.3, open);
    const topLine = this.curve([[-1.0, 0.26], [-0.94, 0.15], [-0.7, 0.08], [0, -0.02], [0.6, -0.11], [0.92, -0.12], [1.0, -0.04]], W, y);
    const inTop = this.curve([[-0.72, 0.075], [0, -0.02], [0.82, -0.12]], W, y);
    const lens = this.curve([[0.82, -0.12], [0.55, -0.32 * s - 0.05], [0.1, -0.42 * s - 0.02], [-0.4, -0.25 * s], [-0.72, 0.075]], W, y);
    const shape = this.closedPath([inTop, lens]);
    ctx.fillStyle = this.palette.tongue;
    ctx.fill(shape);
    ctx.save();
    ctx.clip(shape);
    ctx.fillStyle = this.palette.mouth;
    this.strokeVar(ctx, inTop, W * 0.12, W * 0.1, W * 0.08);
    ctx.restore();
    ctx.fillStyle = this.palette.line;
    this.strokeVar(ctx, lens, lw * 0.5, lw * 0.8, lw * 0.6);
    this.strokeVar(ctx, topLine, lw * 1.3, lw * 1.0, lw * 1.3);
  }

  /**
   * 泣いて開けた口（参考：道路で泣くパチュリー）。角ばった斜めの台形で、上の縁は右下がり、
   * 左の辺は外へ開き、右の辺はほぼ垂直。口の中は桃色で、上の縁に沿って赤黒い影
   */
  protected mouthSob(ctx: CanvasRenderingContext2D, open: number, width = 1): void {
    const W = this.layout.mouthW * 1.25 * width;
    const y = this.layout.mouthY - 0.07;
    this.droolFrom = [0.3 * W, y - 0.8 * Math.max(0.3, open) * W];
    const lw = this.lineWidth;
    const s = Math.max(0.3, open);
    const TL: Pt = [-0.84, 0.86 * s], TR: Pt = [0.93, 0.5 * s], BR: Pt = [0.8, -0.86 * s], BL: Pt = [-1.16, -0.43 * s];
    // 上の縁はまっすぐ、下は外へ膨らみ、右下と左上の角は丸い
    const top = this.curve([TL, [-0.6, 0.83 * s], [0.05, 0.7 * s], TR], W, y);
    const right = this.curve([TR, [0.9, -0.2 * s], [0.86, -0.7 * s], BR], W, y);
    const bottom = this.curve([BR, [0.55, -0.92 * s], [-0.2, -0.82 * s], [-0.75, -0.62 * s], BL], W, y);
    const left = this.curve([BL, [-1.04, 0.0], [-1.0, 0.5 * s], [-0.93, 0.8 * s], TL], W, y);
    const shape = this.closedPath([top, right, bottom, left]);
    ctx.fillStyle = this.palette.tongue;
    ctx.fill(shape);
    ctx.save();
    ctx.clip(shape);
    ctx.beginPath();
    ctx.ellipse(0.0, y + 0.92 * s * W, 1.4 * W, 0.4 * s * W, -0.2, 0, Math.PI * 2);
    ctx.fillStyle = this.palette.mouth;
    ctx.fill();
    // 上の縁の影に、縁に沿った細い線を重ねる（左寄りほど多い）
    this.hatch(ctx, top, W * 0.07, 5, 0.04, 0.85);
    ctx.restore();
    ctx.fillStyle = this.palette.line;
    this.strokeVar(ctx, bottom, lw * 0.9, lw * 0.7, lw * 1.0);
    this.strokeVar(ctx, left, lw * 1.0, lw * 1.5, lw * 1.4);
    this.strokeVar(ctx, right, lw * 1.4, lw * 1.7, lw * 1.0);
    this.strokeVar(ctx, top, lw * 1.4, lw * 1.2, lw * 1.4);
    // 右上の口角の小さな跳ね
    this.strokeVar(ctx, this.curve([TR, [1.08, 0.6 * s], [1.16, 0.68 * s]], W, y), lw * 1.3, lw * 0.9, lw * 0.4);
  }

  /**
   * 大きく開けて泣き叫ぶ（参考：目をつぶって泣き叫ぶパチュリー）。縦に大きく開いた台形で、
   * 上の縁は短く右上がり、右の辺は外へ斜めに下り、左の辺はほぼ垂直、下の縁は左下がり。
   * 上の歯は縁に沿った白い帯で、左右に下向きの牙のような出っぱり。下の歯は下の縁に沿った帯で、右端が上へ盛り上がる。
   * 口の中は赤黒く、右側に辺と平行な縦の描き込み。下半分に舌
   */
  protected mouthWail(ctx: CanvasRenderingContext2D, open: number, width = 1): void {
    const W = this.layout.mouthW * 1.35 * width;
    const y = this.layout.mouthY - 0.16;
    const lw = this.lineWidth;
    // 開き具合は上の縁を固定して縦に縮める
    const s = Math.max(0.35, Math.min(1, open));
    const top = y + 1.2 * W;
    this.droolFrom = [0.3 * W, top - (top - (y - 1.0 * W)) * s];
    ctx.save();
    ctx.translate(0, top);
    ctx.scale(1, s);
    ctx.translate(0, -top);
    const c = (pts: Pt[]) => this.curve(pts, W, y);

    const TL: Pt = [-1.03, 1.11], TR: Pt = [0.57, 1.28], BR: Pt = [1.02, -0.85], BL: Pt = [-1.12, -1.12];
    const topEdge = c([TL, [-0.6, 1.13], [-0.1, 1.15], [0.3, 1.21], TR]);
    const right = c([TR, [0.76, 0.6], [0.93, -0.1], [1.03, -0.55], BR]);
    const bottom = c([BR, [0.85, -0.93], [0.3, -1.0], [-0.4, -1.07], BL]);
    const left = c([BL, [-1.19, -0.8], [-1.19, -0.1], [-1.14, 0.55], TL]);
    const shape = this.closedPath([topEdge, right, bottom, left]);

    ctx.fillStyle = this.palette.mouthDark;
    ctx.fill(shape);
    ctx.save();
    ctx.clip(shape);
    // 喉の奥のさらに暗いところ
    ctx.beginPath();
    ctx.ellipse(-0.25 * W, y + 0.45 * W, 0.6 * W, 0.4 * W, 0, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(20, 2, 0, 0.55)';
    ctx.fill();
    // 右側の縦の描き込み（右の辺と平行）
    ctx.fillStyle = 'rgba(12, 0, 0, 0.65)';
    for (let k = 0; k < 11; k++) {
      const x0 = 0.18 + 0.065 * k;
      const len = 0.75 + 0.5 * Math.sin(k * 1.7) * 0.5;
      this.strokeVar(ctx, c([[x0, 0.95 - 0.06 * k], [x0 + 0.24 * len * 0.5, 0.95 - 0.06 * k - len]]), lw * 0.1, lw * 0.35, lw * 0.1);
    }
    // 舌：下半分。上の縁はゆるく波打ち、右へ下がる
    const tongue = this.closedPath([c([[-1.3, -0.3], [-0.75, -0.2], [-0.3, -0.14], [0.0, -0.11], [0.35, -0.16], [0.72, -0.35], [0.95, -0.55], [1.15, -0.95]]), c([[1.15, -1.3], [-1.3, -1.3]])]);
    ctx.fillStyle = this.palette.tongue;
    ctx.fill(tongue);
    const tongueLight = this.closedPath([c([[-1.3, -0.42], [-0.6, -0.33], [0.1, -0.27], [0.55, -0.33], [0.85, -0.55], [1.0, -0.8]]), c([[1.0, -1.3], [-1.3, -1.3]])]);
    ctx.fillStyle = this.palette.tongueLight;
    ctx.fill(tongueLight);

    // 歯：白い帯と、内側の縁の青灰色の影
    const teeth = (outline: Pt[], innerEdge: Pt[]) => {
      ctx.fillStyle = this.palette.teeth;
      ctx.fill(this.closedPath([outline]));
      ctx.fillStyle = this.palette.teethShade;
      this.strokeVar(ctx, innerEdge, W * 0.03, W * 0.07, W * 0.03);
      ctx.fillStyle = withAlpha(this.palette.line, 0.8);
      this.strokeVar(ctx, innerEdge, lw * 0.3, lw * 0.55, lw * 0.3);
    };
    // 上の歯（左右の牙状の出っぱりつき）
    const upperInner = c([[0.62, 1.1], [0.5, 0.95], [0.44, 0.82], [0.3, 0.79], [0.16, 0.85], [0.12, 0.99], [-0.2, 1.02], [-0.7, 1.0], [-0.78, 0.9], [-0.86, 0.76], [-0.98, 0.71], [-1.06, 0.85], [-1.2, 0.92]]);
    teeth([...c([[-1.3, 1.5], [0.8, 1.5]]), ...upperInner], upperInner);
    // 下の歯（右端が盛り上がる）
    const lowerInner = c([[-1.25, -0.66], [-1.05, -0.7], [-0.85, -0.78], [-0.68, -0.84], [0.0, -0.8], [0.55, -0.72], [0.7, -0.52], [0.84, -0.36], [1.0, -0.38], [1.15, -0.44]]);
    teeth([...lowerInner, ...c([[1.3, -1.4], [-1.3, -1.4]])], lowerInner);
    ctx.restore();

    // 輪郭：左と下は太く、上は細め。上の両端は外へ小さく巻く
    ctx.fillStyle = this.palette.line;
    this.strokeVar(ctx, topEdge, lw * 1.0, lw * 0.75, lw * 1.0);
    // 下の縁は歯に重なって太く見えるので、ほかより細くする
    this.strokeVar(ctx, right, lw * 1.0, lw * 1.0, lw * 0.75);
    this.strokeVar(ctx, bottom, lw * 0.75, lw * 0.65, lw * 0.75);
    this.strokeVar(ctx, left, lw * 0.75, lw * 1.1, lw * 1.0);
    this.strokeVar(ctx, c([TL, [-1.1, 1.2], [-1.15, 1.3]]), lw * 0.9, lw * 0.7, lw * 0.25);
    this.strokeVar(ctx, c([TR, [0.6, 1.38], [0.56, 1.47]]), lw * 0.9, lw * 0.7, lw * 0.25);
    // 口角の外の小さなしわと、口の下の唇の陰
    ctx.fillStyle = this.palette.lipEdge;
    this.strokeVar(ctx, c([[-1.3, -1.02], [-1.26, -1.2], [-1.15, -1.36]]), lw * 0.3, lw * 0.9, lw * 0.3);
    this.strokeVar(ctx, c([[1.12, -0.78], [1.18, -0.9], [1.14, -1.04]]), lw * 0.3, lw * 0.9, lw * 0.3);
    ctx.fillStyle = 'rgba(232, 140, 112, 0.6)';
    this.strokeVar(ctx, c([[-0.14, -1.42], [0.2, -1.38], [0.55, -1.36]]), W * 0.04, W * 0.08, W * 0.04);
    ctx.restore();
  }

  /**
   * 歯を食いしばる（参考：霊夢）。左右非対称の台形：左の辺はほぼ垂直で上端が小さく巻き、
   * 上の縁は右へ向かって上がり、右端は下向きに鋭くとがる。
   * 歯は縦線を描かず白い塊で、上下の縁に灰色の影、上下の境目は中央から右へだけ、途中で「ヘ」の字によれる
   */
  protected mouthGrit(ctx: CanvasRenderingContext2D, width = 1): void {
    const W = this.layout.mouthW * 2.2 * width;
    const y = this.layout.mouthY - 0.05;
    this.droolFrom = [0.3 * W, y - 0.2 * W];
    const lw = this.lineWidth;
    const top = this.curve([[-0.98, 0.3], [-0.86, 0.26], [-0.72, 0.29], [-0.45, 0.4], [-0.05, 0.49], [0.32, 0.55], [0.52, 0.53], [0.68, 0.42], [0.82, 0.18], [0.97, -0.2]], W, y);
    const bottom = this.curve([[0.97, -0.2], [0.6, -0.16], [0.25, -0.19], [-0.2, -0.28], [-0.55, -0.38], [-0.94, -0.53]], W, y);
    const left = this.curve([[-0.94, -0.53], [-0.975, -0.12], [-0.98, 0.3]], W, y);
    const shape = this.closedPath([top, bottom, left]);
    ctx.fillStyle = this.palette.teeth;
    ctx.fill(shape);
    ctx.save();
    ctx.clip(shape);
    // 上下の縁と左奥の灰色の影
    ctx.fillStyle = 'rgba(140, 140, 160, 0.38)';
    this.strokeVar(ctx, top, W * 0.2, W * 0.24, W * 0.22);
    ctx.fillStyle = 'rgba(140, 140, 160, 0.28)';
    this.strokeVar(ctx, bottom, W * 0.12, W * 0.14, W * 0.16);
    this.strokeVar(ctx, left, W * 0.18, W * 0.18, W * 0.18);
    // 上下の歯の境目：中央から右へ、途中で「ヘ」の字によれる
    ctx.fillStyle = 'rgba(30, 20, 18, 0.85)';
    this.strokeVar(ctx, this.curve([[-0.02, 0.15], [0.25, 0.17], [0.5, 0.17], [0.565, 0.06]], W, y), lw * 0.2, lw * 0.6, lw * 0.9);
    this.strokeVar(ctx, this.curve([[0.565, 0.06], [0.62, 0.12], [0.7, 0.13], [0.82, 0.11]], W, y), lw * 0.9, lw * 0.5, lw * 0.2);
    // 左側の短い境目
    ctx.fillStyle = 'rgba(90, 85, 95, 0.6)';
    this.strokeVar(ctx, this.curve([[-0.86, -0.07], [-0.78, -0.05], [-0.7, -0.05]], W, y), lw * 0.4, lw * 0.4, lw * 0.15);
    ctx.restore();
    // 輪郭：上の縁の左寄りは細い茶色、右と下と左の辺は太い黒
    ctx.fillStyle = this.palette.lipEdge;
    this.strokeVar(ctx, this.curve([[-0.98, 0.31], [-0.86, 0.275], [-0.72, 0.305], [-0.45, 0.415], [-0.05, 0.505]], W, y), lw * 0.8, lw * 0.7, lw * 0.3);
    ctx.fillStyle = this.palette.line;
    this.strokeVar(ctx, top, lw * 0.3, lw * 0.7, lw * 1.3);
    this.strokeVar(ctx, bottom, lw * 1.3, lw * 0.9, lw * 1.4);
    this.strokeVar(ctx, left, lw * 1.4, lw * 1.2, lw * 0.8);
    // 左上の巻き込み
    this.strokeVar(ctx, this.curve([[-0.98, 0.3], [-1.03, 0.38], [-1.0, 0.46], [-0.94, 0.48]], W, y), lw * 0.9, lw * 0.7, lw * 0.3);
    // 口の下の唇の陰（薄い朱色の短い線）と右下の小さな弧
    ctx.fillStyle = 'rgba(226, 132, 108, 0.6)';
    this.strokeVar(ctx, this.curve([[-0.42, -0.68], [-0.25, -0.65], [-0.08, -0.68]], W, y), lw * 0.4, lw * 1.2, lw * 0.4);
    this.strokeVar(ctx, this.curve([[1.0, -0.24], [1.05, -0.32], [1.0, -0.42]], W, y), lw * 0.3, lw * 0.9, lw * 0.3);
  }

  protected mouthO(ctx: CanvasRenderingContext2D, open: number): void {
    const { mouthY: y } = this.layout;
    const ry = 0.03 + 0.06 * open;
    this.droolFrom = [0.01, y - ry * 1.5];
    const shape = new Path2D();
    shape.ellipse(0, y - ry * 0.5, 0.045 + 0.02 * open, ry, 0, 0, Math.PI * 2);
    ctx.fillStyle = this.palette.mouth;
    ctx.fill(shape);
    ctx.save();
    ctx.clip(shape);
    ctx.beginPath();
    ctx.ellipse(0, y - ry * 1.2, 0.04, ry * 0.64, 0, 0, Math.PI * 2);
    ctx.fillStyle = this.palette.tongue;
    ctx.fill();
    ctx.restore();
    ctx.strokeStyle = this.palette.line;
    ctx.lineWidth = this.lineWidth * 1.15;
    ctx.stroke(shape);
  }

  // ---- 口の描画の補助 ----

  /**
   * 口の座標（口の半幅 W を 1、中心が (0, cy)）の点列を通る滑らかな曲線を、顔座標の折れ線にする
   */
  protected curve(pts: Pt[], W: number, cy: number, steps = 10): Pt[] {
    return this.spline(pts.map(([x, y]): Pt => [x * W, cy + y * W]), steps);
  }

  /** 点列を通る滑らかな曲線（Catmull-Rom）を折れ線にする */
  protected spline(p: Pt[], steps = 10): Pt[] {
    if (p.length < 2) return p.slice();
    const out: Pt[] = [];
    for (let i = 0; i < p.length - 1; i++) {
      const p0 = p[Math.max(0, i - 1)], p1 = p[i], p2 = p[i + 1], p3 = p[Math.min(p.length - 1, i + 2)];
      for (let k = 0; k < steps; k++) {
        const t = k / steps, t2 = t * t, t3 = t2 * t;
        out.push([
          0.5 * (2 * p1[0] + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3),
          0.5 * (2 * p1[1] + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3),
        ]);
      }
    }
    out.push(p[p.length - 1]);
    return out;
  }

  /**
   * 斜線の影（参考画像の口の奥の描き込み）：上の縁 edge に沿った細い線を、内側（下）へ gap ずつずらして count 本引く。
   * 1本目は edge の t0〜t1 の範囲で、奥の線ほど短くなる（端から少しずつ欠ける）
   */
  protected hatch(ctx: CanvasRenderingContext2D, edge: Pt[], gap: number, count: number, t0: number, t1: number): void {
    ctx.fillStyle = this.palette.hatch;
    const n = edge.length - 1;
    for (let i = 0; i < count; i++) {
      const k = i / Math.max(1, count);
      // 奥の線ほど短く、左寄りに残る
      const a = t0 + (t1 - t0) * 0.08 * k;
      const b = t1 - (t1 - t0) * 0.75 * k;
      const seg = edge.slice(Math.round(a * n), Math.round(b * n) + 1).map(([x, y]): Pt => [x, y - gap * (i + 1)]);
      const lw = this.lineWidth * (0.42 - 0.2 * k);
      this.strokeVar(ctx, seg, lw * 0.3, lw, lw * 0.3);
    }
  }

  /** 折れ線をつないだ閉じた形 */
  protected closedPath(parts: Pt[][]): Path2D {
    const path = new Path2D();
    let first = true;
    for (const part of parts) {
      for (const [x, y] of part) {
        if (first) { path.moveTo(x, y); first = false; } else path.lineTo(x, y);
      }
    }
    path.closePath();
    return path;
  }

  /**
   * 太さの変わる線（筆の入り抜き）。始点 w0・中央 w1・終点 w2 の太さを滑らかにつなぐ。
   * 色は fillStyle を使う
   */
  protected strokeVar(ctx: CanvasRenderingContext2D, line: Pt[], w0: number, w1: number, w2: number): void {
    const n = line.length;
    if (n < 2) return;
    const left: Pt[] = [];
    const right: Pt[] = [];
    const widthAt = (u: number) => (u < 0.5 ? w0 + (w1 - w0) * smooth(u * 2) : w1 + (w2 - w1) * smooth((u - 0.5) * 2));
    for (let i = 0; i < n; i++) {
      const a = line[Math.max(0, i - 1)], b = line[Math.min(n - 1, i + 1)];
      let nx = -(b[1] - a[1]), ny = b[0] - a[0];
      const len = Math.hypot(nx, ny) || 1;
      nx /= len; ny /= len;
      const hw = widthAt(i / (n - 1)) * 0.5;
      left.push([line[i][0] + nx * hw, line[i][1] + ny * hw]);
      right.push([line[i][0] - nx * hw, line[i][1] - ny * hw]);
    }
    ctx.beginPath();
    left.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
    for (let i = n - 1; i >= 0; i--) ctx.lineTo(...right[i]);
    ctx.closePath();
    ctx.fill();
    // 両端は丸める
    for (const [i, w] of [[0, w0], [n - 1, w2]] as const) {
      ctx.beginPath();
      ctx.arc(line[i][0], line[i][1], w * 0.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // ---- 頬・汗 ----

  protected drawBlush(ctx: CanvasRenderingContext2D, amount: number): void {
    const { cheekX, cheekY } = this.layout;
    const [r, g, b] = this.palette.blush;
    for (const s of [1, -1]) {
      const x = s * cheekX;
      ctx.save();
      ctx.translate(x, cheekY);
      ctx.scale(1, 0.48);
      const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, 0.24);
      grad.addColorStop(0, `rgba(${r},${g},${b},${0.55 * amount})`);
      grad.addColorStop(0.6, `rgba(${r},${g},${b},${0.3 * amount})`);
      grad.addColorStop(1, `rgba(${r},${g},${b},0)`);
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(0, 0, 0.24, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      // 斜線（右上がり、少しずつ長さを変える）
      ctx.strokeStyle = `rgba(${r - 40},${g - 50},${b - 50},${0.75 * amount})`;
      ctx.lineWidth = this.lineWidth * 0.5;
      ctx.beginPath();
      [0.035, 0.05, 0.055, 0.045, 0.03].forEach((len, i) => {
        const lx = x + (i - 2) * 0.042;
        ctx.moveTo(lx - len * 0.5, cheekY - len);
        ctx.lineTo(lx + len * 0.5, cheekY + len);
      });
      ctx.stroke();
    }
  }

  /** 汗の場所ごとの粒の位置と大きさ（顔座標：x, y, 下の丸の半径） */
  protected sweatSpots: Record<SweatSpot, [number, number, number]> = {
    forehead: [0.15, 0.62, 0.04],
    templeL: [-1.0, 0.25, 0.044],
    templeR: [1.0, 0.2, 0.044],
    cheekL: [-0.75, -0.2, 0.048],
    cheekR: [0.72, -0.22, 0.048],
    mouthL: [-0.36, -0.5, 0.052],
    mouthR: [0.48, -0.6, 0.048],
    bodyL: [-0.62, -0.82, 0.048],
    bodyC: [0.05, -0.9, 0.044],
    bodyR: [0.42, -1.08, 0.04],
  };

  protected drawSweat(ctx: CanvasRenderingContext2D, spots: SweatSpot[]): void {
    for (const id of spots) {
      const p = this.sweatSpots[id];
      if (p) this.sweatDrop(ctx, p[0], p[1], p[2]);
    }
  }

  /**
   * 汗の粒（参考画像）：上が細くとがり、下が丸い縦長のしずく。中は白く、
   * 輪郭は下と右側だけの黒い線（下がいちばん太く、右側を上へ細くなる）。左下に肌が透けた桃色、
   * 右下の肌に朱色の影が落ちる。(x, y) は下の丸の中心、r はその半径
   */
  protected sweatDrop(ctx: CanvasRenderingContext2D, x: number, y: number, r: number): void {
    // 横は細め（参考画像の粒は幅が高さの4割ほど）
    const P = (px: number, py: number): Pt => [x + px * r * 0.75, y + py * r];
    // 輪郭：先端 → 右側 → 下の丸 → 左側 → 先端。先端は細く長く伸びる
    const right = this.spline([P(0.1, 3.6), P(0.22, 2.7), P(0.65, 1.3), P(1.0, 0.25)], 6);
    const bottom: Pt[] = [];
    for (let i = 0; i <= 16; i++) {
      const a = (-0.1 - (i / 16) * 0.8) * Math.PI;
      bottom.push(P(Math.cos(a) * 1.0, Math.sin(a) * 1.0 + 0.1));
    }
    const left = this.spline([P(-1.0, 0.1), P(-0.85, 1.0), P(-0.35, 2.3), P(0.1, 3.6)], 6);
    const shape = this.closedPath([right, bottom, left]);

    // 肌に落ちる影（右下へずらした同じ形）
    ctx.save();
    ctx.translate(r * 0.16, -r * 0.38);
    ctx.fillStyle = this.palette.sweatShadow;
    ctx.fill(shape);
    ctx.restore();
    // 白い粒と、左下に透けた肌の色
    ctx.fillStyle = this.palette.sweat;
    ctx.fill(shape);
    ctx.save();
    ctx.clip(shape);
    ctx.beginPath();
    ctx.ellipse(x - r * 0.18, y - r * 0.05, r * 0.38, r * 0.45, 0.3, 0, Math.PI * 2);
    ctx.fillStyle = this.palette.sweatPink;
    ctx.fill();
    ctx.restore();
    // 輪郭線：右側の中ほどから下の丸を回って左下まで。下がいちばん太い
    ctx.fillStyle = this.palette.line;
    this.strokeVar(ctx, [...right.slice(Math.floor(right.length * 0.45)), ...bottom], r * 0.04, r * 0.16, r * 0.24);
    // 左側はごく細い線を下の方だけ
    this.strokeVar(ctx, left.slice(0, Math.ceil(left.length * 0.5)), r * 0.1, r * 0.05, r * 0.01);
  }


  /**
   * 目尻・目頭にたまる涙の粒（参考画像）：白い横長の粒で、中心に肌が透けた桃色。
   * 下側だけ黒い輪郭線、上側は細い桃色の線
   */
  protected pinkDrop(ctx: CanvasRenderingContext2D, x: number, y: number, rx: number, ry: number): void {
    if (rx < 0.003) return;
    const rot = -0.25;
    const pts: Pt[] = [];
    for (let i = 0; i <= 32; i++) {
      const t = (i / 32) * Math.PI * 2;
      const ex = Math.cos(t) * rx, ey = Math.sin(t) * ry;
      pts.push([x + ex * Math.cos(rot) - ey * Math.sin(rot), y + ex * Math.sin(rot) + ey * Math.cos(rot)]);
    }
    const shape = this.closedPath([pts]);
    ctx.fillStyle = this.palette.sweat;
    ctx.fill(shape);
    ctx.save();
    ctx.clip(shape);
    ctx.beginPath();
    ctx.ellipse(x + rx * 0.08, y - ry * 0.12, rx * 0.55, ry * 0.5, rot, 0, Math.PI * 2);
    ctx.fillStyle = this.palette.sweatPink;
    ctx.fill();
    ctx.restore();
    // 上半分（0〜π）は細い桃色、下半分（π〜2π）は黒
    ctx.fillStyle = this.palette.tearPinkLine;
    this.strokeVar(ctx, pts.slice(0, 17), ry * 0.04, ry * 0.12, ry * 0.04);
    ctx.fillStyle = this.palette.line;
    this.strokeVar(ctx, pts.slice(16), ry * 0.06, ry * 0.26, ry * 0.06);
  }


  /** 頬を伝う涙の筋（参考画像：白い筋で、先が丸くふくらむ） */
  protected tearStream(ctx: CanvasRenderingContext2D, x: number, y: number, length: number, width: number): void {
    this.liquidStrand(ctx, x, y, length, width * 0.7, width * 0.04);
  }

  /**
   * よだれ（参考画像）：口の下の縁から真下へ垂れる白い筋。付け根に小さな粒、先は丸くふくらむ。
   * 量が多いと横にもう1本、短い筋が垂れる。(x, y) は垂れ始め（顔座標）
   */
  protected drawDrool(ctx: CanvasRenderingContext2D, [x, y]: Pt, amount: number): void {
    const wd = 0.032;
    const len = 0.08 + 0.42 * amount;
    // 2本目：口の縁は右へ上がっていくので、1本目より少し上（口の縁の上）から垂らす
    const two = amount >= 0.9;
    const x2 = x + wd * 1.4, y2 = y + wd * 0.3;
    if (two) this.liquidStrand(ctx, x2, y2, len * 0.55 + wd * 0.3, wd * 0.75, -wd * 0.1);
    this.liquidStrand(ctx, x, y, len, wd, wd * 0.15);
    // 付け根の粒（2本のときは両方の付け根をつなぐ）
    const right = two ? x2 + wd * 0.65 : x + wd * 0.9;
    const bead = this.closedPath([this.spline([[x - wd * 0.85, y + wd * 0.2], [x - wd * 0.6, y - wd * 0.5], [x, y - wd * 0.75], [(x + right) * 0.5 + wd * 0.2, (two ? y2 : y) - wd * 0.55], [right, (two ? y2 : y) + wd * 0.2]], 6)]);
    ctx.fillStyle = this.palette.sweat;
    ctx.fill(bead);
  }

  /**
   * 液体の筋（涙・よだれ共通）：上端 (x, y) から下へ len 垂れる、幅 wd の白い筋。
   * 中ほどが少し細く、先は丸くふくらむ。輪郭は左側と先端だけの黒い線で、右下の肌に朱色の影が落ちる。
   * bend：先端が横へずれる量
   */
  protected liquidStrand(ctx: CanvasRenderingContext2D, x: number, y: number, len: number, wd: number, bend = 0): void {
    if (len < 0.01) return;
    const n = 14;
    const half = (t: number) => wd * 0.5 * (1 - 0.18 * Math.sin(Math.PI * t));
    const left: Pt[] = [];
    const right: Pt[] = [];
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const cx = x + bend * t * t, cy = y - len * t;
      left.push([cx - half(t), cy]);
      right.push([cx + half(t), cy]);
    }
    // 先端の丸（左 → 下 → 右）
    const [bx, by] = [x + bend, y - len];
    const br = wd * 0.62;
    const bulb: Pt[] = [];
    for (let k = 0; k <= 12; k++) {
      const a = Math.PI + (Math.PI * k) / 12;
      bulb.push([bx + Math.cos(a) * br, by + Math.sin(a) * br * 1.1]);
    }
    const shape = this.closedPath([left, bulb, right.slice().reverse()]);
    // 肌に落ちる影
    ctx.save();
    ctx.translate(wd * 0.45, -wd * 0.7);
    ctx.fillStyle = this.palette.sweatShadow;
    ctx.fill(shape);
    ctx.restore();
    ctx.fillStyle = this.palette.sweat;
    ctx.fill(shape);
    // 右側に薄い青灰色の陰
    ctx.save();
    ctx.clip(shape);
    ctx.fillStyle = 'rgba(170, 186, 214, 0.55)';
    this.strokeVar(ctx, right.slice(2), wd * 0.15, wd * 0.3, wd * 0.2);
    ctx.restore();
    // 輪郭：左側（下ほど太い）から先端の丸まで
    ctx.fillStyle = this.palette.line;
    this.strokeVar(ctx, [...left.slice(1), ...bulb], wd * 0.06, wd * 0.16, wd * 0.24);
  }


  // ---- 補助 ----

  protected dot(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: string): void {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
  }

}

function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

/** '#rrggbb' 同士を混ぜる */
export function mix(a: string, b: string, t: number): string {
  const pa = parseHex(a), pb = parseHex(b);
  const c = pa.map((v, i) => Math.round(v + (pb[i] - v) * t));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

export function withAlpha(hex: string, alpha: number): string {
  const [r, g, b] = parseHex(hex);
  return `rgba(${r},${g},${b},${alpha})`;
}

function parseHex(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
