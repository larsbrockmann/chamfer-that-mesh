/* ============================================================
   scene.js — Three.js scene, camera, renderer, controls, lights
   ============================================================ */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

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
  renderer.toneMappingExposure = 1.0;

  // Scene
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1a1a2e);

  // Camera
  camera = new THREE.PerspectiveCamera(
    50,
    canvas.clientWidth / canvas.clientHeight,
    0.01,
    10000
  );
  camera.position.set(5, 4, 6);

  // Controls
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.target.set(0, 0, 0);
  controls.update();

  // Lights
  const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
  scene.add(ambientLight);

  const dirLight1 = new THREE.DirectionalLight(0xffffff, 1.0);
  dirLight1.position.set(5, 10, 7);
  scene.add(dirLight1);

  const dirLight2 = new THREE.DirectionalLight(0xffffff, 0.3);
  dirLight2.position.set(-5, -2, -5);
  scene.add(dirLight2);

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
