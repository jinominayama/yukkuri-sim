import type { FaceState } from '../types';
import { AnimeStyle } from './anime';

/**
 * シンプルな絵柄：黒い楕円の目と細い線。
 * 絵柄を足すときの見本として、アニメ調から目の描き方と線の太さ・配置だけを変えている
 */
export class SimpleStyle extends AnimeStyle {
  override id = 'simple';
  override name = 'シンプル';

  constructor() {
    super();
    this.lineWidth = 0.014;
    this.layout = { ...this.layout, eyeX: 0.36, eyeW: 0.1, eyeH: 0.16 };
  }

  protected override drawOpenEye(ctx: CanvasRenderingContext2D, s: 1 | -1, open: number, state: FaceState): void {
    const { eyeX, eyeY, eyeW: w, eyeH: h } = this.layout;
    const look = state.expression.eyes.look ?? [0, 0];
    const x = s * eyeX + look[0] * w;
    // まばたきは下端を残して縦に縮める
    const ry = h * open;
    const y = eyeY - h + ry + look[1] * h;
    ctx.beginPath();
    ctx.ellipse(x, y, w, ry, 0, 0, Math.PI * 2);
    ctx.fillStyle = '#0b0604';
    ctx.fill();
    if (open > 0.5) this.dot(ctx, x - w * 0.3, y + ry * 0.4, w * 0.3, '#ffffff');
    const teary = state.expression.eyes.teary ?? 0;
    if (teary > 0) this.dot(ctx, x + w * 0.3, y - ry * 0.35, w * 0.16 * teary, '#ffffff');
  }
}
