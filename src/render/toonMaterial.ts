import * as THREE from 'three';

export interface ToonColors {
  lit: string;
  shade: string;
  deep: string;
  rim: string;
}

export const DEFAULT_SKIN: ToonColors = {
  lit: '#f6cfa3',
  shade: '#ecb98d',
  deep: '#d99e78',
  rim: '#fff1de',
};

const vertexShader = /* glsl */ `
  uniform float uBodyHeight;
  attribute vec3 aRest;
  varying vec3 vRest;
  varying vec3 vNormalW;
  varying vec3 vPosW;
  varying float vHeight;

  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vPosW = wp.xyz;
    vNormalW = normalize(mat3(modelMatrix) * normal);
    vHeight = position.y / uBodyHeight;
    vRest = aRest;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const fragmentShader = /* glsl */ `
  uniform vec3 uLit;
  uniform vec3 uShade;
  uniform vec3 uDeep;
  uniform vec3 uRimColor;
  uniform vec3 uLightDir;
  uniform float uThreshold;
  uniform float uThreshold2;
  uniform float uSoftness;
  uniform float uRim;
  uniform float uContactShade;
  uniform float uFace;
  // 顔：頭の中心から見た方向を、表面に沿った長さ（頭の半径単位）の顔座標にして絵を貼る
  uniform sampler2D uFaceTex;
  uniform vec3 uHeadC;     // 頭の中心（静止形状の座標）
  uniform float uHeadR;    // 頭の半径
  uniform vec4 uFaceRect;  // 絵の範囲 (xMin, yMin, xMax, yMax)
  varying vec3 vRest;
  varying vec3 vNormalW;
  varying vec3 vPosW;
  varying float vHeight;

  void main() {
    vec3 n = normalize(vNormalW);
    float h = dot(n, normalize(uLightDir)) * 0.5 + 0.5;   // half-lambert

    // 3段のトゥーン階調（境界は少しだけぼかす）
    float tDeep = smoothstep(uThreshold2 - uSoftness, uThreshold2 + uSoftness, h);
    float tLit  = smoothstep(uThreshold  - uSoftness, uThreshold  + uSoftness, h);
    vec3 col = mix(uDeep, uShade, tDeep);
    col = mix(col, uLit, tLit);

    // 接地付近をわずかに暗く（重みの表現）
    col *= mix(1.0 - uContactShade, 1.0, smoothstep(0.0, 0.2, vHeight));

    // 縁を明るく（柔らかい皮の透け感）
    vec3 v = normalize(cameraPosition - vPosW);
    float rim = pow(1.0 - max(dot(n, v), 0.0), 3.0);
    col = mix(col, uRimColor, rim * uRim);

    // 顔（静止形状の座標で貼るので、体の変形に合わせて歪む）。前方はローカル +Z
    if (uFace > 0.5) {
      vec3 d = vRest - uHeadC;
      float rxz = length(d.xz);
      float az = atan(d.x, d.z);
      float el = atan(d.y, rxz);
      vec2 f = vec2(az * rxz, el * length(d)) / uHeadR;
      vec2 uv = (f - uFaceRect.xy) / (uFaceRect.zw - uFaceRect.xy);
      vec4 t = texture2D(uFaceTex, uv);
      // 絵の範囲外と背中側には貼らない
      float inside = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0) * step(abs(az), 1.6);
      col = col * (1.0 - t.a * inside) + t.rgb * inside;  // 乗算済みアルファ
    }

    gl_FragColor = vec4(col, 1.0);
    #include <colorspace_fragment>
  }
`;

export function createToonMaterial(colors: ToonColors = DEFAULT_SKIN): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uLit: { value: new THREE.Color(colors.lit) },
      uShade: { value: new THREE.Color(colors.shade) },
      uDeep: { value: new THREE.Color(colors.deep) },
      uRimColor: { value: new THREE.Color(colors.rim) },
      uLightDir: { value: new THREE.Vector3(-0.5, 0.9, 0.6).normalize() },
      uThreshold: { value: 0.62 },
      uThreshold2: { value: 0.32 },
      uSoftness: { value: 0.06 },
      uRim: { value: 0.18 },
      uContactShade: { value: 0.08 },
      uBodyHeight: { value: 1 },
      uFace: { value: 1 },
      uFaceTex: { value: null },
      uHeadC: { value: new THREE.Vector3() },
      uHeadR: { value: 0.3 },
      uFaceRect: { value: new THREE.Vector4(-1, -1, 1, 1) },
    },
    vertexShader,
    fragmentShader,
  });
}
