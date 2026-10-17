import * as THREE from 'three';
import { GROUND_OUTLINE, groundClampGlsl } from './ground';

/**
 * 背面法（inverted hull）による輪郭線。
 * 法線方向にクリップ空間で押し出すので、距離によらず画面上で一定の太さになる。
 */
const vertexShader = /* glsl */ `
  uniform float uWidth;      // 画面上の太さ(px)
  uniform vec2 uResolution;  // 描画バッファの解像度(px)

  void main() {
    vec4 clip = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    vec3 nView = normalMatrix * normal;
    vec2 dir = (projectionMatrix * vec4(nView, 0.0)).xy;
    float len = length(dir);
    if (len > 1e-5) {
      clip.xy += (dir / len) * uWidth * 2.0 / uResolution * clip.w;
    }
    gl_Position = clip;
  }
`;

const fragmentShader = /* glsl */ `
  uniform vec3 uColor;
  void main() {
    gl_FragColor = vec4(uColor, 1.0);
    #include <colorspace_fragment>
  }
`;

/** 装飾用の輪郭線：体の輪郭線と同じ太さ・色で、地面より下に行かない */
const accessoryVertexShader = /* glsl */ `
  ${groundClampGlsl(GROUND_OUTLINE)}
  uniform float uWidth;
  uniform float uWidthScale; // この部品だけの太さの倍率（1 で体と同じ）
  uniform vec2 uResolution;

  void main() {
    vec3 wp = (modelMatrix * vec4(position, 1.0)).xyz;
    vec3 nW = normalize(mat3(modelMatrix) * normal);
    if (clampToGround(wp)) nW = vec3(0.0, 1.0, 0.0);
    vec4 clip = projectionMatrix * viewMatrix * vec4(wp, 1.0);
    vec2 dir = (projectionMatrix * vec4(mat3(viewMatrix) * nW, 0.0)).xy;
    float len = length(dir);
    if (len > 1e-5) {
      clip.xy += (dir / len) * uWidth * uWidthScale * 2.0 / uResolution * clip.w;
    }
    gl_Position = clip;
  }
`;

/**
 * 体の輪郭線の材質 body と太さ・色を共有する（uniform の入れ物は同じものを使うので、体の側を変えれば一緒に変わる）。
 * uWidthScale だけはこの材質のもの（出し入れする部品などで、この部品の線だけ細くする）
 */
export function createAccessoryOutlineMaterial(body: THREE.ShaderMaterial): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { ...body.uniforms, uWidthScale: { value: 1 } },
    vertexShader: accessoryVertexShader,
    fragmentShader,
    side: THREE.BackSide,
  });
}

export function createOutlineMaterial(color = '#3b2618', widthPx = 2.2): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(color) },
      uWidth: { value: widthPx },
      uResolution: { value: new THREE.Vector2(1, 1) },
    },
    vertexShader,
    fragmentShader,
    side: THREE.BackSide,
  });
}
