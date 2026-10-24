import * as THREE from 'three';

/**
 * 床材の絵（canvas に描く）。どれも床全体（横 w × 奥行き d m）に貼る前提。
 *   新聞紙 … 少し傾いた見開きを重ねて敷く。字は灰色の棒だけ（読める字は描かない）
 *   おがくず … 色の違う細かい木くずを散らす（1m 四方の絵をくり返す）
 *   タオル … パイル（輪の粒）と、両端の織りの帯・縁のかがり
 */
export type FloorId = 'newspaper' | 'sawdust' | 'towel';

/** 1m あたりの画素数（新聞紙・タオル。近寄っても字の棒がつぶれない程度） */
const PX_PER_M = 360;

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')!];
}

/** 毎回同じ並びになる乱数（作り直しても模様が変わらない） */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function texture(c: HTMLCanvasElement, repeat?: [number, number]): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  if (repeat) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(repeat[0], repeat[1]);
  }
  return t;
}

export function floorTexture(id: FloorId, w: number, d: number): THREE.CanvasTexture {
  switch (id) {
    case 'newspaper': return newspaper(w, d);
    case 'sawdust': return sawdust(w, d);
    case 'towel': return towel(w, d);
  }
}

/**
 * 新聞紙の大きさ：飼育ケースのゆっくりは普通の 1/4 の大きさという体（指示。見た目の体はそのまま、周りの物を 4 倍に見せる）。
 * 普通のゆっくりの体（胴の直径 1 m）を実物 31 cm とみて、その 1/4。実物 1 cm がこの世界で何 m か
 */
const NEWSPAPER_M_PER_CM = 1 / (31 / 4);
/** 実物の新聞の見開き（cm）：横 81 × 縦 55 */
const SPREAD_CM = [81, 55];

/** 新聞紙：見開きを 3 枚、少し傾けて重ねて敷く（1 枚で床のほとんどを覆う大きさ）。縁から下の床が少しのぞく */
function newspaper(w: number, d: number): THREE.CanvasTexture {
  const [c, g] = canvas(Math.round(w * PX_PER_M), Math.round(d * PX_PER_M));
  const r = rng(7);
  const s = PX_PER_M;
  const cm = NEWSPAPER_M_PER_CM * s; // 実物 1 cm の画素数
  g.fillStyle = '#d6d2c8';
  g.fillRect(0, 0, c.width, c.height);
  // 置く所（床の幅・奥行きに対する割合）と傾き
  const places: [number, number, number][] = [[0.22, 0.4, -0.05], [0.86, 0.62, 0.04], [0.5, 0.52, 0.015]];
  for (const [fx, fz, tilt] of places) {
    g.save();
    g.translate(fx * w * s, fz * d * s);
    g.rotate(tilt);
    sheet(g, cm, r);
    g.restore();
  }
  return texture(c);
}

/**
 * 新聞紙の見開き 1 枚（中心が原点。寸法は実物の cm に cm 画素を掛ける）：左右の面に、記事ごとの見出し（太い棒）・
 * 本文（細い棒の段組み）・写真の四角。真ん中に折り目
 */
function sheet(g: CanvasRenderingContext2D, cm: number, r: () => number): void {
  const W = SPREAD_CM[0] * cm, H = SPREAD_CM[1] * cm;
  const tone = 232 + Math.floor(r() * 10);
  g.fillStyle = `rgb(${tone},${tone - 3},${tone - 12})`;
  g.fillRect(-W / 2, -H / 2, W, H);
  // 紙の縁の影
  g.strokeStyle = 'rgba(120,110,95,0.4)';
  g.lineWidth = 0.15 * cm;
  g.strokeRect(-W / 2, -H / 2, W, H);
  const m = 2 * cm; // 余白
  const COLS = 8;
  const gap = 0.4 * cm;
  const lh = 0.22 * cm, pitch = 0.45 * cm; // 本文の 1 行の太さと間隔
  for (const side of [-1, 1]) {
    const x0 = side < 0 ? -W / 2 + m : m;
    const pw = W / 2 - m * 2;
    const cw = (pw - gap * (COLS - 1)) / COLS;
    const colX = (k: number) => x0 + k * (cw + gap);
    // 上の題字の帯（左の面だけ）と、ページの上の線
    let top = -H / 2 + m;
    if (side < 0) {
      g.fillStyle = 'rgba(55,52,50,0.55)';
      g.fillRect(x0, top, pw * 0.35, 3 * cm);
      top += 4 * cm;
    }
    g.fillStyle = 'rgba(80,76,72,0.5)';
    g.fillRect(x0, top, pw, 0.1 * cm);
    top += 0.8 * cm;
    const bottom = H / 2 - m;
    // 記事：上から段に分け、段ごとに何列かずつの記事を並べる
    let y = top;
    while (y < bottom - 4 * cm) {
      const bandH = Math.min(bottom - y, (9 + r() * 9) * cm);
      let k = 0;
      while (k < COLS) {
        const span = Math.min(COLS - k, 2 + Math.floor(r() * 3));
        article(g, colX(k), y, cw * span + gap * (span - 1), bandH - 0.8 * cm, cw, gap, lh, pitch, cm, r);
        k += span;
      }
      y += bandH;
      // 段の境の線
      if (y < bottom - 4 * cm) {
        g.fillStyle = 'rgba(80,76,72,0.35)';
        g.fillRect(x0, y - 0.45 * cm, pw, 0.06 * cm);
      }
    }
  }
  // 真ん中の折り目
  g.strokeStyle = 'rgba(150,140,125,0.5)';
  g.lineWidth = 0.12 * cm;
  g.beginPath();
  g.moveTo(0, -H / 2);
  g.lineTo(0, H / 2);
  g.stroke();
}

/** 記事 1 つ（左上 x, y・幅 aw・高さ ah）：見出し・ときどき写真・本文の行（列の幅 cw ごと） */
function article(
  g: CanvasRenderingContext2D, x: number, y: number, aw: number, ah: number,
  cw: number, gap: number, lh: number, pitch: number, cm: number, r: () => number,
): void {
  // 見出し（記事の幅の半分〜ほぼ全部。大きい記事ほど太い）
  const hh = (aw > 15 * cm ? 1.6 : 1.0) * cm;
  g.fillStyle = 'rgba(55,52,50,0.6)';
  g.fillRect(x, y, aw * (0.5 + r() * 0.45), hh);
  let top = y + hh + 0.7 * cm;
  // 写真（記事の上の方、幅は記事の 2/3 ほど）
  if (aw > 10 * cm && ah > 10 * cm && r() < 0.5) {
    const pw = aw * 0.62, ph = Math.min(ah * 0.45, pw * 0.7);
    g.fillStyle = 'rgba(120,118,112,0.42)';
    g.fillRect(x, top, pw, ph);
    g.fillStyle = 'rgba(175,172,165,0.5)';
    g.beginPath();
    g.ellipse(x + pw * (0.3 + r() * 0.4), top + ph * 0.55, pw * 0.22, ph * 0.3, 0, 0, Math.PI * 2);
    g.fill();
    // 写真の横の列は写真の下から
    const cols = Math.round((aw + gap) / (cw + gap));
    const used = Math.ceil((pw + gap) / (cw + gap));
    for (let k = used; k < cols; k++) lines(g, x + k * (cw + gap), top, cw, y + ah, lh, pitch, r);
    for (let k = 0; k < used; k++) lines(g, x + k * (cw + gap), top + ph + 0.6 * cm, cw, y + ah, lh, pitch, r);
    return;
  }
  const cols = Math.round((aw + gap) / (cw + gap));
  for (let k = 0; k < cols; k++) lines(g, x + k * (cw + gap), top, cw, y + ah, lh, pitch, r);
}

/** 本文の行：列の幅 cw の細い棒を、y から bottom まで。段落の終わりは短く、ときどき小見出し */
function lines(
  g: CanvasRenderingContext2D, x: number, y: number, cw: number, bottom: number,
  lh: number, pitch: number, r: () => number,
): void {
  for (let yy = y; yy < bottom - lh; yy += pitch) {
    if (r() < 0.012) {
      g.fillStyle = 'rgba(60,58,55,0.5)';
      g.fillRect(x, yy, cw * (0.4 + r() * 0.5), lh * 1.8);
      yy += pitch * 0.8;
      continue;
    }
    const len = r() < 0.07 ? cw * (0.15 + r() * 0.6) : cw;
    g.fillStyle = 'rgba(95,92,88,0.34)';
    g.fillRect(x, yy, len, lh);
  }
}

/** おがくず：1m 四方の絵を床の大きさだけくり返す */
function sawdust(w: number, d: number): THREE.CanvasTexture {
  const N = 1024;
  const [c, g] = canvas(N, N);
  const r = rng(11);
  g.fillStyle = '#d4b07a';
  g.fillRect(0, 0, N, N);
  const colors = ['#e6c993', '#c79f63', '#b88a50', '#efdcb2', '#a77a42', '#dcbd86'];
  // 下の層ほど暗く・小さく、上ほど明るく大きい木くず（くり返しの継ぎ目が出ないよう端は反対側にも描く）
  for (let layer = 0; layer < 3; layer++) {
    const count = [9000, 5000, 1800][layer];
    const size = [3, 5, 8][layer];
    for (let k = 0; k < count; k++) {
      const x = r() * N, y = r() * N;
      const a = r() * Math.PI;
      const L = size * (0.6 + r() * 1.2), T = L * (0.3 + r() * 0.3);
      g.fillStyle = colors[Math.floor(r() * colors.length)];
      g.globalAlpha = 0.55 + layer * 0.15 + r() * 0.2;
      for (const ox of [-N, 0, N]) {
        for (const oy of [-N, 0, N]) {
          if (x + ox < -L || x + ox > N + L || y + oy < -L || y + oy > N + L) continue;
          g.beginPath();
          g.ellipse(x + ox, y + oy, L, T, a, 0, Math.PI * 2);
          g.fill();
        }
      }
    }
  }
  g.globalAlpha = 1;
  return texture(c, [w, d]);
}

/** タオル：横に長い 1 枚。パイルの粒・両端の織りの帯・縁のかがり */
function towel(w: number, d: number): THREE.CanvasTexture {
  const [c, g] = canvas(Math.round(w * PX_PER_M), Math.round(d * PX_PER_M));
  const r = rng(23);
  const s = PX_PER_M;
  g.fillStyle = '#f2c6cd';
  g.fillRect(0, 0, c.width, c.height);
  // パイル：細かい粒を一面に（明るい粒と暗い粒）
  const step = 7;
  for (let y = 0; y < c.height; y += step) {
    for (let x = (y / step) % 2 ? step / 2 : 0; x < c.width; x += step) {
      const v = r();
      g.fillStyle = v < 0.5 ? 'rgba(255,236,240,0.55)' : 'rgba(205,140,152,0.35)';
      g.beginPath();
      g.arc(x + (r() - 0.5) * 3, y + (r() - 0.5) * 3, 2.2 + r() * 1.3, 0, Math.PI * 2);
      g.fill();
    }
  }
  // 両端の織りの帯（白地に細い線）
  for (const x0 of [0.55 * s, c.width - 0.55 * s - 0.5 * s]) {
    g.fillStyle = '#fbe9ec';
    g.fillRect(x0, 0, 0.5 * s, c.height);
    g.fillStyle = 'rgba(214,138,153,0.8)';
    for (const f of [0.12, 0.2, 0.8, 0.88]) g.fillRect(x0 + f * 0.5 * s, 0, 0.012 * s, c.height);
    g.fillStyle = 'rgba(214,138,153,0.45)';
    for (let k = 0; k < 6; k++) g.fillRect(x0 + (0.3 + k * 0.08) * 0.5 * s, 0, 0.005 * s, c.height);
  }
  // 縁のかがり
  g.strokeStyle = '#e4a9b4';
  g.lineWidth = 0.05 * s;
  g.strokeRect(0.025 * s, 0.025 * s, c.width - 0.05 * s, c.height - 0.05 * s);
  return texture(c);
}
