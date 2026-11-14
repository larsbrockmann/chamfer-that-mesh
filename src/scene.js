/* ============================================================
   scene.js — Three.js scene, camera, renderer, controls, lights
   ============================================================ */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

export let scene, camera, renderer, controls;
let gridHelper, axesHelper;

/**
 * Initialise the Three.js scene and attach it to #canvas.
 * @returns {{ scene, camera, renderer, controls }}
 */
export function initScene() {
  const canvas = document.getElementById('canvas');

  // Renderer
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(canvas.clientWidth, canvas.clientHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.12;

  // Scene
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1a1a2e);

  // Subtle studio environment reflection map for bevel/surface sheen
  const pmremGenerator = new THREE.PMREMGenerator(renderer);
  scene.environment = pmremGenerator.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.4;
  pmremGenerator.dispose();

  // Camera
  camera = new THREE.PerspectiveCamera(
    50,
    canvas.clientWidth / canvas.clientHeight,
    0.01,
    10000
  );
  camera.position.set(5, 4, 6);
  scene.add(camera);

  // Controls
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.target.set(0, 0, 0);
  controls.update();

  // Studio CAD Lighting Rig
  // 1. World-space sky/ground bounce for clear top vs bottom face contrast
  const hemiLight = new THREE.HemisphereLight(0xe2eeff, 0x222236, 0.45);
  scene.add(hemiLight);

  // 2. World-space overhead anchor light for orientation cues as model spins
  const overheadLight = new THREE.DirectionalLight(0xffffff, 0.45);
  overheadLight.position.set(4, 12, 6);
  scene.add(overheadLight);

  // 3. Camera-attached 3-point CAD headlight rig (scale- & pan-invariant)
  const keyLight = new THREE.DirectionalLight(0xfffcf5, 1.35);
  keyLight.position.set(6, 8, 6);
  camera.add(keyLight);
  camera.add(keyLight.target);

  const fillLight = new THREE.DirectionalLight(0x99bbff, 0.55);
  fillLight.position.set(-7, -3, 5);
  camera.add(fillLight);
  camera.add(fillLight.target);

  const rimLight = new THREE.DirectionalLight(0xffeedd, 0.45);
  rimLight.position.set(0, 6, -8);
  camera.add(rimLight);
  camera.add(rimLight.target);

  // Grid (default OFF)
  gridHelper = new THREE.GridHelper(20, 40, 0x3a3a5c, 0x2a2a44);
  gridHelper.visible = false;
  scene.add(gridHelper);

  // Axes (default OFF)
  axesHelper = new THREE.AxesHelper(3);
  axesHelper.visible = false;
  scene.add(axesHelper);

  // Resize
  const resizeObserver = new ResizeObserver(() => {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  });
  resizeObserver.observe(canvas);

  return { scene, camera, renderer, controls };
}

/** Toggle the grid helper visibility */
export function setGridVisible(visible) {
  if (gridHelper) gridHelper.visible = visible;
}

/** Toggle the axes helper visibility */
export function setAxesVisible(visible) {
  if (axesHelper) axesHelper.visible = visible;
}
