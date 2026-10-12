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
  uniform vec2 uResolution;

  void main() {
    vec3 wp = (modelMatrix * vec4(position, 1.0)).xyz;
    vec3 nW = normalize(mat3(modelMatrix) * normal);
    if (clampToGround(wp)) nW = vec3(0.0, 1.0, 0.0);
    vec4 clip = projectionMatrix * viewMatrix * vec4(wp, 1.0);
    vec2 dir = (projectionMatrix * vec4(mat3(viewMatrix) * nW, 0.0)).xy;
    float len = length(dir);
    if (len > 1e-5) {
      clip.xy += (dir / len) * uWidth * 2.0 / uResolution * clip.w;
    }
    gl_Position = clip;
  }
`;

export function createAccessoryOutlineMaterial(body: THREE.ShaderMaterial): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: body.uniforms,
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
