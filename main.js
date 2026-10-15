import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';

// ------------------------------------------------------------------ 常量
const EYE = 1.66;          // 眼高
const RADIUS = 0.44;       // 身体半径
const WALK = 4.6;
const RUN = 9.2;
const STEP_MAX = 0.62;     // 单帧最大爬升，超过就挡住（台阶能上，台基侧面上不去）
const GRAVITY_SMOOTH = 13;

// ------------------------------------------------------------------ 渲染器
const stage = document.getElementById('stage');
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.outputColorSpace = THREE.SRGBColorSpace;
stage.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0xbfd0dd, 70, 340);

const camera = new THREE.PerspectiveCamera(74, innerWidth / innerHeight, 0.1, 1200);

// ------------------------------------------------------------------ 天空
const skyMat = new THREE.ShaderMaterial({
  side: THREE.BackSide,
  depthWrite: false,
  uniforms: {
    cTop: { value: new THREE.Color(0x2f6fb5) },
    cMid: { value: new THREE.Color(0xb9d3ea) },
    cLow: { value: new THREE.Color(0xd9d2c4) }
  },
  vertexShader: `varying vec3 vP;
    void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
  fragmentShader: `uniform vec3 cTop,cMid,cLow; varying vec3 vP;
    void main(){
      float h = normalize(vP).y;
      vec3 c = mix(cLow, cMid, smoothstep(-0.05, 0.28, h));
      c = mix(c, cTop, smoothstep(0.16, 0.82, h));
      gl_FragColor = vec4(c, 1.0);
    }`
});
scene.add(new THREE.Mesh(new THREE.SphereGeometry(700, 32, 18), skyMat));

// ------------------------------------------------------------------ 环境反射
(function buildEnv() {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 128;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, 128);
  grad.addColorStop(0.00, '#3a76bb');
  grad.addColorStop(0.42, '#cfe0ef');
  grad.addColorStop(0.50, '#d3ccbd');
  grad.addColorStop(1.00, '#6c665c');
  g.fillStyle = grad; g.fillRect(0, 0, 256, 128);
  const tex = new THREE.CanvasTexture(c);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  const pm = new THREE.PMREMGenerator(renderer);
  scene.environment = pm.fromEquirectangular(tex).texture;
  scene.environmentIntensity = 1.12;
  pm.dispose(); tex.dispose();
})();

// ------------------------------------------------------------------ 光照
scene.add(new THREE.HemisphereLight(0xd6e6f2, 0x8a7f6c, 0.38));

const sun = new THREE.DirectionalLight(0xfff3e0, 1.85);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
const SD = 62;
Object.assign(sun.shadow.camera, { left: -SD, right: SD, top: SD, bottom: -SD, near: 1, far: 420 });
sun.shadow.bias = -0.0005;
sun.shadow.normalBias = 0.06;
scene.add(sun, sun.target);
const SUN_OFF = new THREE.Vector3(78, 118, 62);

// 殿内补光（不投影，纯照亮内部）
[[0, 7.5, -11, 70, 78], [0, 5.0, 33, 42, 52], [0, 5.5, 66, 34, 48],
 [0, 6.5, -73, 42, 56], [30, 4.5, 16, 24, 40], [-30, 4.5, 16, 24, 40],
 [54, 5.0, -22, 28, 46]].forEach(([x, y, z, i, d]) => {
  const pl = new THREE.PointLight(0xffdcae, i, d, 1.5);
  pl.position.set(x, y, z);
  scene.add(pl);
});

// ------------------------------------------------------------------ 控制
const controls = new PointerLockControls(camera, renderer.domElement);
const keys = Object.create(null);
let locked = false;

const overlay = document.getElementById('overlay');
const loading = document.getElementById('loading');

document.getElementById('enter').addEventListener('click', () => controls.lock());
controls.addEventListener('lock', () => {
  locked = true;
  overlay.classList.add('hide');
  document.body.classList.add('playing');
});
controls.addEventListener('unlock', () => {
  locked = false;
  overlay.classList.remove('hide');
  document.body.classList.remove('playing');
});

addEventListener('keydown', (e) => {
  keys[e.code] = true;
  if (e.code === 'Space') e.preventDefault();
});
addEventListener('keyup', (e) => { keys[e.code] = false; });
addEventListener('blur', () => { for (const k in keys) keys[k] = false; });

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// ------------------------------------------------------------------ 碰撞 / 地形数据
let COLLIDERS = [];
let PLATFORMS = [];
let RAMPS = [];
let curGround = 0;

function toXZ(o) {
  // Blender(X 东, Y 北) -> three(X 东, Z 南)；z = -y
  return { x0: o.x0, x1: o.x1, z0: -o.y1, z1: -o.y0 };
}

function groundAt(x, z) {
  const by = -z;
  let h = 0;
  for (let i = 0; i < RAMPS.length; i++) {
    const r = RAMPS[i];
    if (x < r.x0 || x > r.x1 || by < r.y0 || by > r.y1) continue;
    let t;
    if (r.axis === 'arch') {
      t = (by - r.y0) / (r.y1 - r.y0);
      if (t >= 0 && t <= 1) h = Math.max(h, r.rise * Math.sin(Math.PI * t));
    } else {
      t = (by - r.y_start) / (r.y_end - r.y_start);
      if (t >= 0 && t <= 1) h = Math.max(h, r.z0 + (r.z1 - r.z0) * t);
    }
  }
  for (let i = 0; i < PLATFORMS.length; i++) {
    const p = PLATFORMS[i];
    if (x >= p.x0 && x <= p.x1 && z >= p.z0 && z <= p.z1 && p.h > h) h = p.h;
  }
  return h;
}

function blocked(p) {
  for (let i = 0; i < COLLIDERS.length; i++) {
    const c = COLLIDERS[i];
    if (p.x > c.x0 - RADIUS && p.x < c.x1 + RADIUS &&
        p.z > c.z0 - RADIUS && p.z < c.z1 + RADIUS) return true;
  }
  return false;
}

function canStand(p) {
  if (blocked(p)) return false;
  return groundAt(p.x, p.z) - curGround <= STEP_MAX;
}

// ------------------------------------------------------------------ 加载场景
const bar = document.getElementById('barfill');
const loadtxt = document.getElementById('loadtxt');
const loader = new GLTFLoader();

Promise.all([
  new Promise((res, rej) => loader.load('./assets/temple.glb', res,
    (e) => { if (e.total) bar.style.width = (e.loaded / e.total * 88).toFixed(0) + '%'; }, rej)),
  fetch('./assets/temple_data.json').then(r => r.json())
]).then(([gltf, data]) => {
  const root = gltf.scene;
  root.traverse(o => {
    if (o.isMesh) {
      o.castShadow = true;
      o.receiveShadow = true;
      o.material.envMapIntensity = 0.85;
      o.frustumCulled = true;
    }
  });
  scene.add(root);

  COLLIDERS = (data.colliders || []).map(toXZ);
  PLATFORMS = (data.platforms || []).map(p => ({
    x0: p.x0, x1: p.x1, z0: -p.y1, z1: -p.y0, h: p.z
  }));
  RAMPS = data.ramps || [];

  // 起始：山门外广场，面朝寺内
  camera.position.set(0, EYE, 86);
  curGround = groundAt(0, 86);
  camera.position.y = curGround + EYE;
  sun.target.position.set(0, 0, 40);

  bar.style.width = '100%';
  loadtxt.textContent = '已就绪';
  loading.classList.add('hide');
  window.__templeReady = true;
}).catch(err => {
  loadtxt.textContent = '加载失败：' + err;
  console.error(err);
});

// ------------------------------------------------------------------ 主循环
const clock = new THREE.Clock();
const tmp = new THREE.Vector3();

function tick() {
  requestAnimationFrame(tick);
  const dt = Math.min(clock.getDelta(), 0.05);

  if (locked) {
    const f = (keys.KeyW ? 1 : 0) - (keys.KeyS ? 1 : 0);
    const r = (keys.KeyD ? 1 : 0) - (keys.KeyA ? 1 : 0);
    if (f || r) {
      const len = Math.hypot(f, r);
      const dist = (keys.ShiftLeft || keys.ShiftRight ? RUN : WALK) * dt;

      tmp.copy(camera.position);
      controls.moveForward(f / len * dist);
      if (!canStand(camera.position)) camera.position.copy(tmp);

      tmp.copy(camera.position);
      controls.moveRight(r / len * dist);
      if (!canStand(camera.position)) camera.position.copy(tmp);

      curGround = groundAt(camera.position.x, camera.position.z);
    }
  }

  // 平滑贴地（上台阶不跳）
  const targetY = curGround + EYE;
  camera.position.y += (targetY - camera.position.y) * Math.min(1, dt * GRAVITY_SMOOTH);

  // 阴影相机跟随
  sun.position.copy(camera.position).add(SUN_OFF);
  sun.target.position.set(camera.position.x, 0, camera.position.z);
  sun.target.updateMatrixWorld();

  renderer.render(scene, camera);
}
tick();

// 供自动化测试调用
window.__temple = {
  camera, controls,
  groundAt: (x, z) => groundAt(x, z),
  press: (code, on) => { keys[code] = on; },
  setLocked: (v) => {
    locked = v;
    document.body.classList.toggle('playing', v);
  },
  teleport: (x, z, yaw, pitch) => {
    curGround = groundAt(x, z);
    camera.position.set(x, curGround + EYE, z);
    camera.rotation.order = 'YXZ';
    if (yaw !== undefined) camera.rotation.y = yaw;
    if (pitch !== undefined) camera.rotation.x = pitch;
  },
  info: () => ({
    pos: camera.position.toArray().map(v => +v.toFixed(2)),
    ground: +curGround.toFixed(2),
    rot: [+camera.rotation.y.toFixed(2), +camera.rotation.x.toFixed(2)],
    colliders: COLLIDERS.length, platforms: PLATFORMS.length, ramps: RAMPS.length
  })
};
