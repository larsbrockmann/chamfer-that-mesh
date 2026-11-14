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
  renderer.toneMappingExposure = 1.15;

  // Scene
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1a1a2e);

  // Studio environment reflection dome for bevel/surface sheen
  const pmremGenerator = new THREE.PMREMGenerator(renderer);
  scene.environment = pmremGenerator.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.55;
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

  // 8-Light Multi-Directional Studio CAD Array + Hemisphere Dome
  const hemiLight = new THREE.HemisphereLight(0xeef6ff, 0x2a3045, 0.5);
  scene.add(hemiLight);

  // 4 World-space compass & under-fill lights covering all axes (±X, ±Y, ±Z)
  const worldLights = [
    [0xffffff, 0.70, [8, 14, 10]],    // worldTopNE
    [0xdbeafe, 0.50, [-12, 6, 8]],    // worldFrontNW
    [0xfef3c7, 0.45, [10, 4, -12]],   // worldBackSE
    [0x93c5fd, 0.40, [-6, -12, -6]],  // worldBottomUnder
  ];
  for (const [color, intensity, pos] of worldLights) {
    const light = new THREE.DirectionalLight(color, intensity);
    light.position.set(...pos);
    scene.add(light);
  }

  // 4 Camera-attached inspection lights (scale- & pan-invariant)
  const cameraLights = [
    [0xfffbeb, 1.25, [7, 9, 6]],      // camKey (Top-Right)
    [0x93c5fd, 0.65, [-9, 2, 5]],     // camLeftFill (Mid-Left)
    [0xc7d2fe, 0.45, [2, -8, 6]],     // camBottomFill (Low-Front)
    [0xfde68a, 0.55, [-3, 8, -7]],    // camRim (High-Back)
  ];
  for (const [color, intensity, pos] of cameraLights) {
    const light = new THREE.DirectionalLight(color, intensity);
    light.position.set(...pos);
    camera.add(light);
    camera.add(light.target);
  }

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
