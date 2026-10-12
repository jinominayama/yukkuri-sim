import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { Yukkuri } from './yukkuri/Yukkuri';
import { createDebugGui, type ViewSettings } from './debug/gui';

const BG = '#f7f4ef';
/** シミュレーションの固定時間刻み */
const FIXED_DT = 1 / 60;
/** 1フレームで追いつく最大ステップ数（処理落ち時の暴走防止） */
const MAX_STEPS_PER_FRAME = 4;

const container = document.getElementById('app')!;
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
container.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(BG);
scene.fog = new THREE.Fog(BG, 8, 20);

const camera = new THREE.PerspectiveCamera(35, 1, 0.05, 100);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.maxPolarAngle = Math.PI * 0.49; // 地面の下に回り込まない
controls.minDistance = 1;
controls.maxDistance = 12;

// 地面
const ground = new THREE.Mesh(
  new THREE.CircleGeometry(20, 64).rotateX(-Math.PI / 2),
  new THREE.MeshBasicMaterial({ color: '#ece4d8' }),
);
scene.add(ground);

// 目的地の目印
const marker = new THREE.Mesh(
  new THREE.RingGeometry(0.07, 0.1, 32).rotateX(-Math.PI / 2),
  new THREE.MeshBasicMaterial({ color: '#c98f5a', transparent: true, opacity: 0.8 }),
);
marker.position.y = 0.003;
marker.visible = false;
scene.add(marker);

const yukkuri = new Yukkuri();
scene.add(yukkuri.root);
yukkuri.drop(0.6);
// 帽子の先まで入るよう、少し上を見て少し引く
controls.target.set(0, yukkuri.height * 0.7, 0);
camera.position.set(0, yukkuri.height * 0.85, 4.6);

const view: ViewSettings = { timeScale: 1, paused: false, followCamera: true, pokeStrength: 3 };
// 開発中はコンソールから触れるようにする
if (import.meta.env.DEV) {
  /** 描画ループと無関係に seconds 秒ぶん進めて1枚描く（検証用） */
  const advance = (seconds: number) => {
    for (let t = 0; t < seconds; t += FIXED_DT) yukkuri.step(FIXED_DT);
    yukkuri.sync();
    renderer.render(scene, camera);
  };
  /** 今の画面を描いて screenshots/<name>.png に保存する（検証用。画面が非表示でも撮れる） */
  const snap = async (name: string) => {
    yukkuri.sync();
    renderer.render(scene, camera);
    const blob = await new Promise<Blob | null>((r) => renderer.domElement.toBlob(r));
    if (!blob) return 'failed';
    await fetch(`/__debug/screenshot?name=${encodeURIComponent(name)}`, { method: 'POST', body: blob });
    return `saved ${name}.png`;
  };
  Object.assign(window, { yukkuri, view, camera, controls, advance, snap, scene, THREE });
}
createDebugGui(yukkuri, view);

// クリック（ドラッグではない）：体ならつつく、地面なら目的地にする
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
let downX = 0, downY = 0;
renderer.domElement.addEventListener('pointerdown', (e) => {
  downX = e.clientX;
  downY = e.clientY;
});
renderer.domElement.addEventListener('pointerup', (e) => {
  if (e.button !== 0 || Math.hypot(e.clientX - downX, e.clientY - downY) > 4) return;
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
  raycaster.setFromCamera(pointer, camera);
  const hit = raycaster.intersectObject(yukkuri.bodyMesh, false)[0];
  if (hit) {
    yukkuri.poke(hit.point, raycaster.ray.direction, view.pokeStrength);
    return;
  }
  const g = raycaster.intersectObject(ground, false)[0];
  if (g) yukkuri.locomotion.moveTo(g.point.x, g.point.z);
});

const drawSize = new THREE.Vector2();
function resize(): void {
  const w = container.clientWidth;
  const h = container.clientHeight;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.getDrawingBufferSize(drawSize);
  yukkuri.outlineMaterial.uniforms.uResolution.value.copy(drawSize);
}
window.addEventListener('resize', resize);
resize();

const clock = new THREE.Clock();
const followTarget = new THREE.Vector3();
let accumulator = 0;
renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.1);
  if (!view.paused) {
    accumulator += dt * view.timeScale;
    let steps = 0;
    while (accumulator >= FIXED_DT && steps < MAX_STEPS_PER_FRAME) {
      yukkuri.step(FIXED_DT);
      accumulator -= FIXED_DT;
      steps++;
    }
    if (steps === MAX_STEPS_PER_FRAME) accumulator = 0;
  }
  yukkuri.sync();
  marker.visible = yukkuri.locomotion.hasTarget;
  marker.position.x = yukkuri.locomotion.target.x;
  marker.position.z = yukkuri.locomotion.target.z;

  if (view.followCamera) {
    // 注視点を水平方向だけゆっくり追従させ、カメラも同じだけ動かす
    const c = yukkuri.center;
    followTarget.set(c.x, controls.target.y, c.z);
    const delta = followTarget.sub(controls.target).multiplyScalar(0.05);
    controls.target.add(delta);
    camera.position.add(delta);
  }
  controls.update();
  renderer.render(scene, camera);
});
