/**
 * 地面（y = 0 の平面）。装飾（髪・帽子・リボンなど）は地面より下に行かないよう、
 * 頂点をこの高さで止める（寝転がったとき地面に押し付けられて平らにつぶれる）。
 * 重なる部品どうしがちらつかないよう、部品ごとに少しずつ高さを変える
 */
export const GROUND_Y = 0;
/** 髪の殻を止める高さ */
export const GROUND_HAIR = GROUND_Y + 0.003;
/** 装飾の輪郭線を止める高さ（髪より上、部品より下。部品の下に隠れる） */
export const GROUND_OUTLINE = GROUND_Y + 0.006;
/** 帽子の円錐と帯を止める高さ（寝転がって折れると、つばの下で地面に押し付けられる） */
export const GROUND_CROWN = GROUND_Y + 0.012;
/** 帽子のつば・フリル・リボン、三つ編みを止める高さ（円錐より上） */
export const GROUND_ACCESSORY = GROUND_Y + 0.02;
/** 帽子のフリルを止める高さ（地面に垂らしたつばの下面より上） */
export const GROUND_FRILL = GROUND_Y + 0.045;

/** GLSL：ワールド座標 wp を地面の上に止める。止めたときは法線 n を上向きにする */
export function groundClampGlsl(height: number): string {
  return /* glsl */ `
  bool clampToGround(inout vec3 wp) {
    if (wp.y >= ${height.toFixed(4)}) return false;
    wp.y = ${height.toFixed(4)};
    return true;
  }
`;
}
