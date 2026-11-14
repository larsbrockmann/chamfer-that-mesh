/* ============================================================
   scene.js — Three.js scene, camera, renderer, controls, lights
   ============================================================ */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

export let scene, camera, renderer, controls;
export const orbitPivot = new THREE.Vector3(0, 0, 0);
let gridHelper, axesHelper;
const _forward = new THREE.Vector3();
const _tempVec = new THREE.Vector3();

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

  // Studio environment reflection dome for bevel/surface sheen
  const pmremGenerator = new THREE.PMREMGenerator(renderer);
  scene.environment = pmremGenerator.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.42;
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
  controls.zoomToCursor = true;
  controls.minDistance = 0.05;
  controls.target.set(0, 0, 0);
  controls.update();

  // Wrap controls.update so rotation (including damping) pivots around orbitPivot
  // without moving the camera on pointerdown or breaking OrbitControls's spherical state.
  const baseUpdate = controls.update.bind(controls);
  const prevQuat = new THREE.Quaternion();
  const prevTarget = new THREE.Vector3();
  const deltaQuat = new THREE.Quaternion();
  const targetOffset = new THREE.Vector3();
  const deltaTarget = new THREE.Vector3();

  controls.update = function (deltaTime) {
    prevQuat.copy(camera.quaternion);
    prevTarget.copy(controls.target);

    const result = baseUpdate(deltaTime);

    if (1 - Math.abs(prevQuat.dot(camera.quaternion)) > 1e-12) {
      deltaQuat.copy(camera.quaternion).multiply(prevQuat.invert());
      targetOffset.subVectors(prevTarget, orbitPivot).applyQuaternion(deltaQuat);
      deltaTarget.addVectors(orbitPivot, targetOffset).sub(prevTarget);
      controls.target.add(deltaTarget);
      camera.position.add(deltaTarget);
    }

    return result;
  };

  // 14-Light Omnidirectional CAD Inspection Array + Hemisphere Dome
  const hemiLight = new THREE.HemisphereLight(0xeef6ff, 0x38425e, 0.38);
  scene.add(hemiLight);

  // 8 World-space octant lights covering all 8 octants (±X, ±Y, ±Z)
  const worldLights = [
    [0xffffff, 0.52, [10, 16, 12]],    // Top-Front-Right (+X, +Y, +Z)
    [0xdbeafe, 0.34, [-14, 10, 10]],   // Top-Front-Left (-X, +Y, +Z)
    [0xfef3c7, 0.30, [12, 10, -14]],   // Top-Back-Right (+X, +Y, -Z)
    [0xe0e7ff, 0.24, [-12, 12, -12]],  // Top-Back-Left (-X, +Y, -Z)
    [0xbae6fd, 0.28, [10, -12, 10]],   // Bottom-Front-Right (+X, -Y, +Z)
    [0xc7d2fe, 0.22, [-12, -10, 12]],  // Bottom-Front-Left (-X, -Y, +Z)
    [0xfde68a, 0.24, [10, -12, -12]],  // Bottom-Back-Right (+X, -Y, -Z)
    [0x93c5fd, 0.28, [-10, -14, -10]], // Bottom-Back-Left (-X, -Y, -Z)
  ];
  for (const [color, intensity, pos] of worldLights) {
    const light = new THREE.DirectionalLight(color, intensity);
    light.position.set(...pos);
    scene.add(light);
  }

  // 5 Camera-attached inspection lights (scale- & orbit-invariant)
  const cameraLights = [
    [0xffffff, 0.32, [0, 1, 12]],      // camHeadlamp (On-axis bore/hole illuminator)
    [0xfffbeb, 0.88, [8, 10, 9]],      // camKey (Top-Right primary key)
    [0x93c5fd, 0.48, [-11, 2, 7]],     // camLeftFill (Mid-Left cool contrast fill)
    [0xc7d2fe, 0.36, [1, -10, 7]],     // camBottomFill (Low-Front underside fill)
    [0xfde68a, 0.38, [-5, 11, 3]],     // camTopRim (High-Grazing bevel highlight)
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

/**
 * Adjust controls.target along the current view ray to match the distance to `point`
 * without changing camera position or orientation.
 */
export function syncTargetDepthToPoint(point, useRadialDistance = false) {
  if (!camera || !controls || !point) return;

  _forward.subVectors(controls.target, camera.position);
  if (_forward.lengthSq() <= 1e-10) {
    camera.getWorldDirection(_forward);
  } else {
    _forward.normalize();
  }

  const dist = useRadialDistance
    ? camera.position.distanceTo(point)
    : _tempVec.subVectors(point, camera.position).dot(_forward);

  if (dist > controls.minDistance) {
    controls.target.copy(camera.position).addScaledVector(_forward, dist);
  }
}

/**
 * Set the active orbit pivot point and optionally sync controls.target depth.
 */
export function setOrbitPivot(point, syncTargetDepth = true, useRadialDistance = false) {
  if (!point) return;
  orbitPivot.copy(point);
  if (syncTargetDepth) {
    syncTargetDepthToPoint(point, useRadialDistance);
  }
}
