/* ============================================================
   scene.js — Three.js scene, camera, renderer, controls, lights
   ============================================================ */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

export let scene, camera, renderer, controls;
export const orbitPivot = new THREE.Vector3(0, 0, 0);
let rotationCenterHelper;

/**
 * Build an overlay-rendered 3D crosshair + gimbal sphere indicating the active rotation center.
 * @returns {THREE.Group}
 */
function createRotationCenterHelper() {
  const group = new THREE.Group();
  group.visible = false;

  const sphere = new THREE.Mesh(
    new THREE.SphereGeometry(0.16, 16, 16),
    new THREE.MeshBasicMaterial({
      color: 0xff9f1c,
      depthTest: false,
      transparent: true,
      opacity: 0.95,
    })
  );
  sphere.renderOrder = 999;
  group.add(sphere);

  // 3D XYZ crosshair spanning [-1, 1] along each axis
  const axisPositions = new Float32Array([
    -1, 0, 0, 1, 0, 0,
    0, -1, 0, 0, 1, 0,
    0, 0, -1, 0, 0, 1,
  ]);
  const cX = new THREE.Color(0xff595e);
  const cY = new THREE.Color(0x8ac926);
  const cZ = new THREE.Color(0x4cc9f0);
  const axisColors = new Float32Array([
    cX.r, cX.g, cX.b, cX.r, cX.g, cX.b,
    cY.r, cY.g, cY.b, cY.r, cY.g, cY.b,
    cZ.r, cZ.g, cZ.b, cZ.r, cZ.g, cZ.b,
  ]);
  const axisGeo = new THREE.BufferGeometry();
  axisGeo.setAttribute('position', new THREE.BufferAttribute(axisPositions, 3));
  axisGeo.setAttribute('color', new THREE.BufferAttribute(axisColors, 3));
  const axesLines = new THREE.LineSegments(
    axisGeo,
    new THREE.LineBasicMaterial({
      vertexColors: true,
      depthTest: false,
      transparent: true,
      opacity: 0.95,
    })
  );
  axesLines.renderOrder = 998;
  group.add(axesLines);

  // 3 orthogonal gimbal rings (XY, YZ, ZX)
  const ringRadius = 0.62;
  const ringSegs = 48;
  const ringPositions = new Float32Array(3 * ringSegs * 6);
  let ptr = 0;
  for (let i = 0; i < ringSegs; i++) {
    const a0 = (i / ringSegs) * Math.PI * 2;
    const a1 = ((i + 1) / ringSegs) * Math.PI * 2;
    const x0 = Math.cos(a0) * ringRadius;
    const y0 = Math.sin(a0) * ringRadius;
    const x1 = Math.cos(a1) * ringRadius;
    const y1 = Math.sin(a1) * ringRadius;

    // XY plane
    ringPositions[ptr++] = x0; ringPositions[ptr++] = y0; ringPositions[ptr++] = 0;
    ringPositions[ptr++] = x1; ringPositions[ptr++] = y1; ringPositions[ptr++] = 0;
    // YZ plane
    ringPositions[ptr++] = 0; ringPositions[ptr++] = x0; ringPositions[ptr++] = y0;
    ringPositions[ptr++] = 0; ringPositions[ptr++] = x1; ringPositions[ptr++] = y1;
    // ZX plane
    ringPositions[ptr++] = y0; ringPositions[ptr++] = 0; ringPositions[ptr++] = x0;
    ringPositions[ptr++] = y1; ringPositions[ptr++] = 0; ringPositions[ptr++] = x1;
  }
  const ringGeo = new THREE.BufferGeometry();
  ringGeo.setAttribute('position', new THREE.BufferAttribute(ringPositions, 3));
  const ringLines = new THREE.LineSegments(
    ringGeo,
    new THREE.LineBasicMaterial({
      color: 0xffbf69,
      depthTest: false,
      transparent: true,
      opacity: 0.5,
    })
  );
  ringLines.renderOrder = 998;
  group.add(ringLines);

  return group;
}

/**
 * Sync the rotation center helper position (locked to orbitPivot) and camera-distance scale.
 */
function updateRotationCenterHelper() {
  if (!camera || !rotationCenterHelper) return;
  rotationCenterHelper.position.copy(orbitPivot);
  const dist = camera.position.distanceTo(orbitPivot);
  rotationCenterHelper.scale.setScalar(Math.max(0.05, dist * 0.055));
}

/**
 * Initialise the Three.js scene and attach it to #canvas.
 * @returns {{ scene, camera, renderer, controls }}
 */
export function initScene() {
  const canvas = document.getElementById('canvas');
  const viewport = canvas.parentElement || document.getElementById('viewport') || canvas;

  // Renderer
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  const initialWidth = viewport.clientWidth || canvas.clientWidth || window.innerWidth;
  const initialHeight = viewport.clientHeight || canvas.clientHeight || window.innerHeight;
  renderer.setSize(initialWidth, initialHeight, false);
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
    initialWidth / Math.max(1, initialHeight),
    0.01,
    10000
  );
  camera.position.set(5, 4, 6);
  scene.add(camera);

  // Controls — centered OrbitControls turntable with seamless 360° pole-crossing
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.zoomToCursor = false;
  controls.minDistance = 0.05;
  controls.target.set(0, 0, 0);
  controls.update();

  const POLE_EPS = 1e-4;
  const baseRotateLeft = controls._rotateLeft.bind(controls);
  const baseRotateUp = controls._rotateUp.bind(controls);
  const baseUpdate = controls.update.bind(controls);
  const _poleOffset = new THREE.Vector3();
  const _poleSpherical = new THREE.Spherical();
  const prevQuat = new THREE.Quaternion();
  const prevTarget = new THREE.Vector3();
  const deltaQuat = new THREE.Quaternion();
  const targetOffset = new THREE.Vector3();
  const deltaTarget = new THREE.Vector3();

  function applyOrbitPivotRotation() {
    if (1 - Math.abs(prevQuat.dot(camera.quaternion)) > 1e-12) {
      deltaQuat.copy(camera.quaternion).multiply(prevQuat.invert());
      targetOffset.subVectors(prevTarget, orbitPivot).applyQuaternion(deltaQuat);
      deltaTarget.addVectors(orbitPivot, targetOffset).sub(prevTarget);
      controls.target.add(deltaTarget);
      camera.position.add(deltaTarget);
    }
    updateRotationCenterHelper();
  }

  controls._rotateLeft = function (angle) {
    const sign = Math.sign(camera.up.y || 1);
    return baseRotateLeft(angle * sign);
  };

  controls._rotateUp = function (angle) {
    const sign = Math.sign(camera.up.y || 1);
    return baseRotateUp(angle * sign);
  };

  controls.update = function (deltaTime) {
    prevQuat.copy(camera.quaternion);
    prevTarget.copy(controls.target);

    _poleOffset.subVectors(camera.position, controls.target);
    _poleSpherical.setFromVector3(_poleOffset);

    if (_poleSpherical.radius > 1e-10) {
      const dPhi = controls.enableDamping
        ? controls._sphericalDelta.phi * controls.dampingFactor
        : controls._sphericalDelta.phi;
      const nextPhi = _poleSpherical.phi + dPhi;
      const crossingTop = dPhi < 0 && nextPhi <= POLE_EPS;
      const crossingBottom = dPhi > 0 && nextPhi >= Math.PI - POLE_EPS;

      if (crossingTop || crossingBottom) {
        const reflectedPhi = crossingTop ? -nextPhi : 2 * Math.PI - nextPhi;
        _poleSpherical.phi = Math.max(POLE_EPS, Math.min(Math.PI - POLE_EPS, reflectedPhi));
        _poleSpherical.theta += Math.PI;
        _poleOffset.setFromSpherical(_poleSpherical);
        camera.position.copy(controls.target).add(_poleOffset);
        camera.up.y = -(camera.up.y || 1);

        const nextDeltaPhi = controls.enableDamping
          ? -controls._sphericalDelta.phi * (1 - controls.dampingFactor)
          : 0;
        controls._sphericalDelta.phi = 0;

        const result = baseUpdate(deltaTime);
        controls._sphericalDelta.phi = nextDeltaPhi;
        applyOrbitPivotRotation();
        return result;
      }
    }

    const result = baseUpdate(deltaTime);
    applyOrbitPivotRotation();
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

  // Rotation Center marker (default OFF)
  rotationCenterHelper = createRotationCenterHelper();
  scene.add(rotationCenterHelper);
  updateRotationCenterHelper();

  // Resize
  const resizeObserver = new ResizeObserver(() => {
    const w = viewport.clientWidth;
    const h = viewport.clientHeight;
    if (w <= 0 || h <= 0) return;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  });
  resizeObserver.observe(viewport);

  return { scene, camera, renderer, controls };
}

/** Toggle the 3D rotation center visualizer visibility */
export function setRotationCenterVisible(visible) {
  if (rotationCenterHelper) {
    rotationCenterHelper.visible = visible;
    if (visible) updateRotationCenterHelper();
  }
}

/**
 * Set controls.target and orbitPivot to `point`.
 */
export function syncTargetDepthToPoint(point) {
  if (!point) return;
  orbitPivot.copy(point);
  if (controls) {
    controls.target.copy(point);
  }
  updateRotationCenterHelper();
}

/**
 * Set the active orbit pivot point and optionally sync controls.target.
 */
export function setOrbitPivot(point, syncTarget = true) {
  if (!point) return;
  orbitPivot.copy(point);
  if (syncTarget && controls) {
    controls.target.copy(point);
  }
  updateRotationCenterHelper();
}
