/* ============================================================
   main.js — App entry: init scene, UI event wiring, animation loop
   ============================================================ */
import * as THREE from 'three';
import {
  initScene,
  scene,
  camera,
  renderer,
  controls,
  setGridVisible,
  setAxesVisible,
  orbitPivot,
  setOrbitPivot,
  syncTargetDepthToPoint,
} from './scene.js';
import { setupLoaders, loadFromUrl } from './loaders.js';
import { detectEdges, autoDetectAngleThreshold } from './edgeDetector.js';
import { applyChamfer, applyChamferAsync, previewChamfer, ChamferParams } from './chamferEngine.js';
import { analyzeMesh, fixMesh, removeDisconnectedParts, findLooseParts, verifyMeshFixWithBoolDiff } from './meshFixer.js';
import { exportSTL, export3MF } from './meshExporter.js';
import {
  buildUI,
  updateEdgeCount,
  updateMeshHealth,
  setUndoRedoState,
  setProcessingState,
  setLoosePartsPreviewActive,
  setPreviewToggleUI,
  setEdgeHighlightToggleUI,
} from './ui.js';

// ---- App state ----
let currentMesh = null;
let initialGeometry = null;
let currentIsInitial = true;
let currentEdgeData = null;
let edgeLinesObject = null;
let previewGroup = null;
let showLoosePartsPreview = false;
let loosePartsPreviewGroup = null;

// ---- History state (Undo / Redo) ----
const MAX_HISTORY = 20;
let undoStack = [];
let redoStack = [];

function pushUndoState() {
  if (!currentMesh) return;
  undoStack.push({
    geo: currentMesh.geometry.clone(),
    isInitial: currentIsInitial,
  });
  if (undoStack.length > MAX_HISTORY) {
    const oldest = undoStack.shift();
    oldest.geo.dispose();
  }
  for (const entry of redoStack) entry.geo.dispose();
  redoStack = [];
  syncUndoRedoUI();
}

function clearHistory() {
  for (const entry of undoStack) entry.geo.dispose();
  for (const entry of redoStack) entry.geo.dispose();
  undoStack = [];
  redoStack = [];
  syncUndoRedoUI();
}

function syncUndoRedoUI() {
  const canReset = Boolean(initialGeometry && !currentIsInitial);
  setUndoRedoState(
    undoStack.length > 0,
    redoStack.length > 0,
    undoStack.length,
    redoStack.length,
    canReset
  );
}

function showToast(msg, type = 'is-selected') {
  const badge = document.getElementById('edge-hover-badge');
  if (!badge) return;
  badge.className = `edge-hover-badge visible ${type}`;
  badge.innerHTML = `<span class="badge-dot ${type === 'is-selected' ? 'dot-selected' : 'dot-unselected'}"></span><span>${msg}</span>`;
  clearTimeout(badge._toastTimer);
  badge._toastTimer = setTimeout(() => {
    badge.classList.remove('visible');
  }, 2400);
}

function handleUndo() {
  if (!currentMesh || undoStack.length === 0) return;
  hideLoosePartsPreview();

  const prevEntry = undoStack.pop();
  redoStack.push({
    geo: currentMesh.geometry.clone(),
    isInitial: currentIsInitial,
  });

  currentMesh.geometry.dispose();
  currentMesh.geometry = prevEntry.geo;
  currentMesh.geometry.computeVertexNormals();
  currentMesh.geometry.computeBoundingBox();
  currentMesh.geometry.computeBoundingSphere();
  currentIsInitial = prevEntry.isInitial;

  syncUndoRedoUI();
  ensureEdgeHighlightVisible();
  handleDetectEdges();
  showToast('↩ Undone modification (Ctrl+Z)', 'is-selected');
}

function handleRedo() {
  if (!currentMesh || redoStack.length === 0) return;
  hideLoosePartsPreview();

  const nextEntry = redoStack.pop();
  undoStack.push({
    geo: currentMesh.geometry.clone(),
    isInitial: currentIsInitial,
  });

  currentMesh.geometry.dispose();
  currentMesh.geometry = nextEntry.geo;
  currentMesh.geometry.computeVertexNormals();
  currentMesh.geometry.computeBoundingBox();
  currentMesh.geometry.computeBoundingSphere();
  currentIsInitial = nextEntry.isInitial;

  syncUndoRedoUI();
  ensureEdgeHighlightVisible();
  handleDetectEdges();
  showToast('↪ Redone modification (Ctrl+Y)', 'is-selected');
}

function handleResetModel() {
  if (!currentMesh || !initialGeometry || currentIsInitial) return;
  hideLoosePartsPreview();

  pushUndoState();
  currentMesh.geometry.dispose();
  currentMesh.geometry = initialGeometry.clone();
  currentMesh.geometry.computeVertexNormals();
  currentMesh.geometry.computeBoundingBox();
  currentMesh.geometry.computeBoundingSphere();
  currentIsInitial = true;

  syncUndoRedoUI();
  handleDetectEdges();
  showToast('↺ Restored original model (Ctrl+Z to undo)', 'is-selected');
}

let angleThreshold = 30;
let convexOnly = true;
let filterTinyEdges = false;
let filterMode = 'ignore'; // 'combine' | 'ignore' | 'both'
let minEdgeLength = 0.20;
let chamferWidth = 0.5;
let chamferSegments = 1;
let chamferProfile = 'chamfer'; // 'chamfer' | 'fillet' | 'hybrid'
let showPreview = false;
let showEdgeHighlight = true;
let loopSelectionMode = true; // default to loop/chain selection
let autoFixMesh = true;
let removeUnconnectedParts = false;

let autoDetectTimer = null;
function triggerAutoDetect(delay = 60) {
  clearTimeout(autoDetectTimer);
  if (delay === 0) {
    handleDetectEdges();
  } else {
    autoDetectTimer = setTimeout(() => {
      handleDetectEdges();
    }, delay);
  }
}

// ---- Initialise ----
initScene();

const canvas = document.getElementById('canvas');

const { updateInfo, fileInput, setWidth, setAngle } = buildUI({
  onImport: () => {},
  onLoadSample: (url) => {
    loadFromUrl(url, onModelLoaded, onModelLoadError);
  },
  onAutoAngle: () => handleAutoAngle(false),
  onExportSTL: handleExportSTL,
  onExport3MF: handleExport3MF,
  onAngleChange: (v) => {
    angleThreshold = v;
    triggerAutoDetect(60);
  },
  onConvexOnlyToggle: (v) => {
    convexOnly = v;
    triggerAutoDetect(0);
  },
  onFilterToggle: (v) => {
    filterTinyEdges = v;
    triggerAutoDetect(0);
  },
  onFilterModeChange: (m) => {
    filterMode = m;
    triggerAutoDetect(0);
  },
  onMinLengthChange: (v) => {
    minEdgeLength = v;
    triggerAutoDetect(60);
  },
  onDetectEdges: handleDetectEdges,
  onSelectAll: handleSelectAll,
  onSelectNone: handleSelectNone,
  onSelectInvert: handleSelectInvert,
  onSelectHorizontal: handleSelectHorizontal,
  onSelectVertical: handleSelectVertical,
  onSelectTopBottom: handleSelectTopBottom,
  onSelectionModeChange: (mode) => {
    loopSelectionMode = mode === 'loop';
  },
  onProfileChange: (profile, segments) => {
    chamferProfile = profile;
    chamferSegments = segments;
    if (showPreview) updatePreview();
  },
  onWidthChange: (v) => {
    chamferWidth = v;
    if (showPreview) updatePreview();
  },
  onSegmentsChange: (v) => {
    chamferSegments = v;
    if (showPreview) updatePreview();
  },
  onPreviewToggle: (v) => {
    showPreview = v;
    if (v) {
      ensureEdgeHighlightVisible();
      updatePreview();
    } else {
      removePreview();
    }
  },
  onApplyChamfer: handleApplyChamfer,
  onStopProcessing: handleStopProcessing,
  onUndo: handleUndo,
  onRedo: handleRedo,
  onReset: handleResetModel,
  onAutoFixToggle: (v) => {
    autoFixMesh = v;
  },
  onRemoveUnconnectedToggle: (v) => {
    removeUnconnectedParts = v;
    if (v && currentMesh && !isProcessingMesh) {
      const stats = analyzeMesh(currentMesh.geometry);
      if (stats.disconnectedParts > 0) {
        handleCleanUnconnectedParts();
      }
    }
  },
  onRunMeshFixer: handleRunMeshFixer,
  onToggleLoosePartsPreview: handleToggleLoosePartsPreview,
  onCleanUnconnectedParts: handleCleanUnconnectedParts,
  onWireframeToggle: (v) => {
    if (currentMesh) currentMesh.material.wireframe = v;
  },
  onGridToggle: setGridVisible,
  onAxesToggle: setAxesVisible,
  onRecenter: () => {
    if (!currentMesh) return;
    const box = new THREE.Box3().setFromObject(currentMesh);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z, 1.0);
    controls.target.copy(center);
    setOrbitPivot(center, false);
    camera.position.copy(
      center.clone().add(new THREE.Vector3(maxDim * 1.5, maxDim * 1.1, maxDim * 1.5))
    );
    controls.update();
  },
  onRotate: (axis) => {
    if (!currentMesh) return;
    pushUndoState();
    currentIsInitial = false;
    syncUndoRedoUI();

    const geo = currentMesh.geometry;
    const angle = Math.PI / 2;
    if (axis === 'x') geo.rotateX(angle);
    else if (axis === 'y') geo.rotateY(angle);
    else if (axis === 'z') geo.rotateZ(angle);

    geo.computeVertexNormals();
    geo.computeBoundingBox();
    geo.computeBoundingSphere();

    // Keep model centered at (0, 0, 0) after rotation
    const center = new THREE.Vector3();
    geo.boundingBox.getCenter(center);
    geo.translate(-center.x, -center.y, -center.z);
    geo.computeBoundingBox();
    geo.computeBoundingSphere();

    setOrbitPivot(new THREE.Vector3(0, 0, 0), true);

    // Re-detect sharp edges and update preview
    handleDetectEdges();
  },
  onEdgeHighlightToggle: (v) => {
    showEdgeHighlight = v;
    if (edgeLinesObject) edgeLinesObject.visible = v;
  },
});

// ---- Loaders ----
const viewport = document.getElementById('viewport');
setupLoaders(viewport, fileInput, onModelLoaded, onModelLoadError);

function onModelLoadError(err) {
  showToast(err?.message || 'Failed to load 3D model', 'is-unselected');
}

function onModelLoaded(mesh) {
  if (initialGeometry) {
    initialGeometry.dispose();
    initialGeometry = null;
  }
  clearHistory();

  // Remove previous model
  if (currentMesh) {
    scene.remove(currentMesh);
    currentMesh.geometry.dispose();
    currentMesh.material.dispose();
  }
  removeEdgeLines();
  removePreview();
  hideLoosePartsPreview();

  currentMesh = mesh;
  initialGeometry = mesh.geometry.clone();
  currentIsInitial = true;
  showEdgeHighlight = true;
  setEdgeHighlightToggleUI(true);
  showPreview = false;
  setPreviewToggleUI(false);
  syncUndoRedoUI();
  scene.add(currentMesh);

  // Focus camera on model
  const box = new THREE.Box3().setFromObject(currentMesh);
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z, 1.0);

  camera.near = Math.max(0.01, maxDim * 0.001);
  camera.far = Math.max(1000, maxDim * 100);
  camera.updateProjectionMatrix();

  controls.minDistance = Math.max(0.02, maxDim * 0.002);
  controls.maxDistance = Math.max(1000, maxDim * 50);

  controls.target.copy(center);
  setOrbitPivot(center, false);
  camera.position.copy(
    center
      .clone()
      .add(new THREE.Vector3(maxDim * 1.5, maxDim * 1.1, maxDim * 1.5))
  );
  controls.update();

  // Smart default chamfer width: 0.2mm for small objects (< 25mm), 0.5mm otherwise
  // Slider range stays 0.1–1.0 mm by default (extends automatically from textbox input)
  const isSmall = maxDim < 25;
  chamferWidth = isSmall ? 0.2 : 0.5;
  setWidth(chamferWidth, 1.0);

  // Auto-detect optimal angle threshold for loaded model
  const optimalAngle = autoDetectAngleThreshold(currentMesh.geometry, { convexOnly });
  if (typeof optimalAngle === 'number' && Number.isFinite(optimalAngle)) {
    angleThreshold = optimalAngle;
    if (setAngle) setAngle(optimalAngle);
  }

  // Auto-detect edges (also refreshes Info panel with accurate edge count)
  handleDetectEdges();
}

function handleAutoAngle(silent = false) {
  if (!currentMesh || !currentMesh.geometry) return;
  const optimalAngle = autoDetectAngleThreshold(currentMesh.geometry, { convexOnly });
  if (typeof optimalAngle === 'number' && Number.isFinite(optimalAngle)) {
    angleThreshold = optimalAngle;
    if (setAngle) setAngle(optimalAngle);
    handleDetectEdges();
    if (!silent) {
      showToast(`✨ Auto angle threshold: ${optimalAngle}°`, 'is-selected');
    }
  }
}

function ensureEdgeHighlightVisible() {
  if (!showEdgeHighlight) {
    showEdgeHighlight = true;
    setEdgeHighlightToggleUI(true);
    if (edgeLinesObject) edgeLinesObject.visible = true;
  }
}

// ---- Edge selection shortcuts ----
function handleSelectAll() {
  if (!currentEdgeData) return;
  ensureEdgeHighlightVisible();
  currentEdgeData.selectAll();
  updateEdgeCount(currentEdgeData.sharpEdges.length, currentEdgeData.getSelectedCount(), currentEdgeData.filteredCount);
  if (showPreview) updatePreview();
}

function handleSelectNone() {
  if (!currentEdgeData) return;
  currentEdgeData.clearSelection();
  updateEdgeCount(currentEdgeData.sharpEdges.length, 0, currentEdgeData.filteredCount);
  if (showPreview) updatePreview();
}

function handleSelectInvert() {
  if (!currentEdgeData) return;
  ensureEdgeHighlightVisible();
  currentEdgeData.invertSelection();
  updateEdgeCount(currentEdgeData.sharpEdges.length, currentEdgeData.getSelectedCount(), currentEdgeData.filteredCount);
  if (showPreview) updatePreview();
}

function handleSelectHorizontal() {
  if (!currentEdgeData) return;
  ensureEdgeHighlightVisible();
  currentEdgeData.selectHorizontal();
  updateEdgeCount(currentEdgeData.sharpEdges.length, currentEdgeData.getSelectedCount(), currentEdgeData.filteredCount);
  if (showPreview) updatePreview();
  showToast(`Selected ${currentEdgeData.getSelectedCount()} horizontal edges`, 'is-selected');
}

function handleSelectVertical() {
  if (!currentEdgeData) return;
  ensureEdgeHighlightVisible();
  currentEdgeData.selectVertical();
  updateEdgeCount(currentEdgeData.sharpEdges.length, currentEdgeData.getSelectedCount(), currentEdgeData.filteredCount);
  if (showPreview) updatePreview();
  showToast(`Selected ${currentEdgeData.getSelectedCount()} vertical edges`, 'is-selected');
}

function handleSelectTopBottom() {
  if (!currentEdgeData) return;
  ensureEdgeHighlightVisible();
  currentEdgeData.selectTopBottom();
  updateEdgeCount(currentEdgeData.sharpEdges.length, currentEdgeData.getSelectedCount(), currentEdgeData.filteredCount);
  if (showPreview) updatePreview();
  showToast(`Selected ${currentEdgeData.getSelectedCount()} top & bottom edges`, 'is-selected');
}

// ---- Edge detection ----
function handleDetectEdges(options = {}) {
  if (!currentMesh) return;

  removeEdgeLines();
  removePreview();
  hideLoosePartsPreview();

  const w = canvas.clientWidth || 1000;
  const h = canvas.clientHeight || 800;

  currentEdgeData = detectEdges(currentMesh.geometry, angleThreshold, {
    width: w,
    height: h,
    filterTiny: filterTinyEdges,
    filterMode,
    minEdgeLength,
    convexOnly,
  });

  if (options.deselectAll && currentEdgeData) {
    currentEdgeData.clearSelection();
  }

  updateEdgeCount(
    currentEdgeData.sharpEdges.length,
    currentEdgeData.getSelectedCount(),
    currentEdgeData.filteredCount
  );

  if (currentEdgeData.lineSegments) {
    edgeLinesObject = currentEdgeData.lineSegments;
    edgeLinesObject.visible = showEdgeHighlight && !options.hideHighlights;
    scene.add(edgeLinesObject);
  }

  refreshInfo();

  if (showPreview) {
    updatePreview();
  }
}

// ---- Interactive 3D Edge Hover & Selection ----
let pointerDownPos = { x: 0, y: 0 };
const hoverBadge = document.getElementById('edge-hover-badge');

function updateHoverBadge(edgeIdx) {
  if (!hoverBadge) return;
  if (edgeIdx < 0 || !currentEdgeData || !currentEdgeData.sharpEdges[edgeIdx]) {
    hoverBadge.classList.remove('visible');
    return;
  }

  const edge = currentEdgeData.sharpEdges[edgeIdx];
  const isSel = edge.selected;
  const count = loopSelectionMode && edge.chainId !== undefined && currentEdgeData.chains[edge.chainId]
    ? currentEdgeData.chains[edge.chainId].length
    : 1;
  const loopLabel = loopSelectionMode ? `Loop (${count} segments)` : 'Edge';

  if (isSel) {
    hoverBadge.className = 'edge-hover-badge visible is-selected';
    hoverBadge.innerHTML = `<span class="badge-dot dot-selected"></span><span>Selected ${loopLabel}</span><span class="badge-action">Click to deselect</span>`;
  } else {
    hoverBadge.className = 'edge-hover-badge visible is-unselected';
    hoverBadge.innerHTML = `<span class="badge-dot dot-unselected"></span><span>Unselected ${loopLabel}</span><span class="badge-action">Click to select</span>`;
  }
}

function getClosestEdge(clientX, clientY, isTouch = false) {
  if (!currentEdgeData || currentEdgeData.sharpEdges.length === 0) return -1;
  const rect = canvas.getBoundingClientRect();
  const mx = clientX - rect.left;
  const my = clientY - rect.top;
  const w = rect.width;
  const h = rect.height;

  const maxTolerance = isTouch ? 28 : 18;
  const maxToleranceSq = maxTolerance * maxTolerance;

  const p1Proj = new THREE.Vector3();
  const p2Proj = new THREE.Vector3();
  const candidates = [];

  for (let i = 0; i < currentEdgeData.sharpEdges.length; i++) {
    const edge = currentEdgeData.sharpEdges[i];

    p1Proj.copy(edge.v1).project(camera);
    p2Proj.copy(edge.v2).project(camera);

    if (p1Proj.z > 1 || p2Proj.z > 1) continue; // Behind camera

    const x1 = ((p1Proj.x + 1) * w) / 2;
    const y1 = ((-p1Proj.y + 1) * h) / 2;
    const x2 = ((p2Proj.x + 1) * w) / 2;
    const y2 = ((-p2Proj.y + 1) * h) / 2;

    const dx = x2 - x1;
    const dy = y2 - y1;
    const lenSq = dx * dx + dy * dy;
    let distSq;
    if (lenSq === 0) {
      distSq = (mx - x1) ** 2 + (my - y1) ** 2;
    } else {
      const t = Math.max(0, Math.min(1, ((mx - x1) * dx + (my - y1) * dy) / lenSq));
      const qx = x1 + t * dx;
      const qy = y1 + t * dy;
      distSq = (mx - qx) ** 2 + (my - qy) ** 2;
    }

    if (distSq <= maxToleranceSq) {
      const midZ = (p1Proj.z + p2Proj.z) * 0.5;
      candidates.push({ idx: i, dist: Math.sqrt(distSq), midZ });
    }
  }

  if (candidates.length === 0) return -1;

  // Depth-first candidate prioritization:
  // Visible front edges (lower midZ) beat occluded back edges
  candidates.sort((a, b) => {
    const dz = a.midZ - b.midZ;
    if (Math.abs(dz) > 0.02) {
      return dz; // Foreground edge wins
    }
    return a.dist - b.dist; // Closer screen distance wins for coplanar edges
  });

  return candidates[0].idx;
}

const raycaster = new THREE.Raycaster();
const pointerNDC = new THREE.Vector2();
const _pivotProj = new THREE.Vector3();
const _fallbackBox = new THREE.Box3();

/**
 * Raycast the current mesh (and visible preview meshes) or sharp edges at client coordinates.
 */
function getMeshPointAtClientPos(clientX, clientY, isTouch = false) {
  if (!currentMesh) return null;
  const rect = canvas.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;

  pointerNDC.set(
    ((clientX - rect.left) / rect.width) * 2 - 1,
    -((clientY - rect.top) / rect.height) * 2 + 1
  );
  raycaster.setFromCamera(pointerNDC, camera);

  const targets = [currentMesh];
  if (previewGroup && previewGroup.visible) {
    targets.push(previewGroup);
  }

  const hits = raycaster
    .intersectObjects(targets, true)
    .filter((hit) => hit.object?.isMesh)
    .sort((a, b) => a.distance - b.distance);

  if (hits.length > 0) {
    return hits[0].point.clone();
  }

  const edgeIdx = getClosestEdge(clientX, clientY, isTouch);
  if (edgeIdx >= 0 && currentEdgeData?.sharpEdges[edgeIdx]) {
    const edge = currentEdgeData.sharpEdges[edgeIdx];
    const ptOnEdge = new THREE.Vector3();
    raycaster.ray.distanceSqToSegment(edge.v1, edge.v2, undefined, ptOnEdge);
    return ptOnEdge;
  }

  return null;
}

/**
 * Choose a fallback orbit pivot when dragging on empty background space.
 */
function getFallbackPivotPoint() {
  if (!currentMesh) return new THREE.Vector3(0, 0, 0);

  _pivotProj.copy(orbitPivot).project(camera);
  if (
    _pivotProj.z >= -1 &&
    _pivotProj.z <= 1 &&
    Math.abs(_pivotProj.x) <= 1.05 &&
    Math.abs(_pivotProj.y) <= 1.05
  ) {
    return orbitPivot.clone();
  }

  pointerNDC.set(0, 0);
  raycaster.setFromCamera(pointerNDC, camera);
  const hits = raycaster.intersectObject(currentMesh, true);
  if (hits.length > 0) {
    return hits[0].point.clone();
  }

  _fallbackBox.setFromObject(currentMesh);
  return _fallbackBox.getCenter(new THREE.Vector3());
}

canvas.addEventListener(
  'pointerdown',
  (e) => {
    if (!currentMesh) return;
    const isTouch = e.pointerType === 'touch';
    const hitPoint = getMeshPointAtClientPos(e.clientX, e.clientY, isTouch);
    if (e.button === 0 || (isTouch && e.isPrimary)) {
      const pivot = hitPoint || getFallbackPivotPoint();
      setOrbitPivot(pivot, true, false);
    } else if (e.button === 1 || e.button === 2) {
      syncTargetDepthToPoint(hitPoint || orbitPivot, false);
    }
  },
  { capture: true }
);

canvas.addEventListener(
  'wheel',
  (e) => {
    if (!currentMesh) return;
    const hitPoint = getMeshPointAtClientPos(e.clientX, e.clientY);
    if (hitPoint) {
      setOrbitPivot(hitPoint, true, true);
    } else {
      syncTargetDepthToPoint(orbitPivot, false);
    }
  },
  { capture: true, passive: true }
);

canvas.addEventListener('pointermove', (e) => {
  if (e.pointerType === 'touch') return;
  if (!currentEdgeData || controls.state !== -1) return;
  if (!showEdgeHighlight) {
    if (hoverBadge) hoverBadge.classList.remove('visible');
    canvas.style.cursor = 'default';
    return;
  }
  const idx = getClosestEdge(e.clientX, e.clientY, false);
  currentEdgeData.setHovered(idx, loopSelectionMode);
  updateHoverBadge(idx);
  canvas.style.cursor = idx >= 0 ? 'pointer' : 'default';
});

canvas.addEventListener('pointerdown', (e) => {
  if (e.pointerType === 'touch' && !e.isPrimary) return;
  pointerDownPos = { x: e.clientX, y: e.clientY };
});

canvas.addEventListener('pointerup', (e) => {
  const isTouch = e.pointerType === 'touch';
  if (isTouch && !e.isPrimary) return;
  const tapThreshold = isTouch ? 14 : 6;
  const dist = Math.hypot(e.clientX - pointerDownPos.x, e.clientY - pointerDownPos.y);
  if (dist < tapThreshold && currentEdgeData && showEdgeHighlight) {
    const idx = getClosestEdge(e.clientX, e.clientY, isTouch);
    if (idx >= 0) {
      currentEdgeData.toggleEdge(idx, loopSelectionMode);
      updateEdgeCount(
        currentEdgeData.sharpEdges.length,
        currentEdgeData.getSelectedCount(),
        currentEdgeData.filteredCount
      );
      if (isTouch) {
        currentEdgeData.setHovered(-1);
        updateHoverBadge(-1);
      } else {
        updateHoverBadge(idx);
      }
      if (showPreview) updatePreview();
    }
  }
});

canvas.addEventListener('pointerleave', () => {
  if (currentEdgeData) {
    currentEdgeData.setHovered(-1);
    updateHoverBadge(-1);
    canvas.style.cursor = 'default';
  }
});

// Update LineMaterial screen resolution on canvas resize
const resizeObserver = new ResizeObserver(() => {
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (w <= 0 || h <= 0) return;
  if (currentEdgeData?.setResolution) {
    currentEdgeData.setResolution(w, h);
  }
});
resizeObserver.observe(canvas);

// ---- Chamfer preview ----
function updatePreview() {
  removePreview();
  if (!currentEdgeData || currentEdgeData.sharpEdges.length === 0) return;

  const params = new ChamferParams(chamferWidth, chamferSegments, chamferProfile);
  previewGroup = previewChamfer(currentEdgeData, params);
  scene.add(previewGroup);
}

function removePreview() {
  if (previewGroup) {
    scene.remove(previewGroup);
    previewGroup.traverse((child) => {
      if (child.isMesh || child.isLineSegments) {
        child.geometry.dispose();
        child.material.dispose();
      }
    });
    previewGroup = null;
  }
}

function removeLoosePartsPreview() {
  if (loosePartsPreviewGroup) {
    scene.remove(loosePartsPreviewGroup);
    loosePartsPreviewGroup.traverse((child) => {
      if (child.isMesh || child.isLineSegments) {
        child.geometry?.dispose();
        child.material?.dispose();
      }
    });
    loosePartsPreviewGroup = null;
  }
}

function hideLoosePartsPreview() {
  if (showLoosePartsPreview) {
    showLoosePartsPreview = false;
    setLoosePartsPreviewActive(false);
  }
  removeLoosePartsPreview();
}

function handleToggleLoosePartsPreview() {
  if (isProcessingMesh || !currentMesh || !currentMesh.geometry) return;

  if (showLoosePartsPreview) {
    hideLoosePartsPreview();
    showToast('Loose parts preview hidden', 'is-unselected');
    return;
  }

  const looseInfo = findLooseParts(currentMesh.geometry);
  if (!looseInfo || looseInfo.count === 0 || !looseInfo.geometry) {
    showToast('✓ No loose or unconnected parts detected (1 solid body)', 'is-selected');
    hideLoosePartsPreview();
    return;
  }

  showLoosePartsPreview = true;
  setLoosePartsPreviewActive(true);

  removeLoosePartsPreview();
  loosePartsPreviewGroup = new THREE.Group();
  loosePartsPreviewGroup.name = 'loosePartsPreview';

  // Semi-translucent glowing crimson fill
  const looseMat = new THREE.MeshStandardMaterial({
    color: 0xff1744,
    emissive: 0x990022,
    emissiveIntensity: 0.8,
    roughness: 0.25,
    metalness: 0.1,
    transparent: true,
    opacity: 0.88,
    side: THREE.DoubleSide,
    depthTest: true,
    polygonOffset: true,
    polygonOffsetFactor: -3,
    polygonOffsetUnits: -6,
  });
  const looseMesh = new THREE.Mesh(looseInfo.geometry, looseMat);
  looseMesh.raycast = () => {};
  loosePartsPreviewGroup.add(looseMesh);

  // White wireframe edge overlay for crisp visibility
  const wireGeo = new THREE.WireframeGeometry(looseInfo.geometry);
  const wireMat = new THREE.LineBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.95,
  });
  const wire = new THREE.LineSegments(wireGeo, wireMat);
  wire.raycast = () => {};
  loosePartsPreviewGroup.add(wire);

  // Bright yellow BoxHelper around the loose components
  const boxHelper = new THREE.BoxHelper(looseMesh, 0xffea00);
  boxHelper.raycast = () => {};
  loosePartsPreviewGroup.add(boxHelper);

  scene.add(loosePartsPreviewGroup);

  showToast(
    `👁 Highlighting ${looseInfo.count} loose part${looseInfo.count > 1 ? 's' : ''} (${looseInfo.triangles} tris) in glowing red`,
    'is-selected'
  );
}

function formatMeshFixSummary(fixRes) {
  const parts = [];
  if (fixRes.holesFilled > 0) parts.push(`${fixRes.holesFilled} hole${fixRes.holesFilled > 1 ? 's' : ''} filled`);
  if (fixRes.edgesStitched > 0) parts.push(`${fixRes.edgesStitched} edge${fixRes.edgesStitched > 1 ? 's' : ''} stitched`);
  if (fixRes.partsRemoved > 0) parts.push(`${fixRes.partsRemoved} loose part${fixRes.partsRemoved > 1 ? 's' : ''} removed`);
  if (fixRes.degeneratesRemoved > 0) parts.push(`${fixRes.degeneratesRemoved} degenerate removed`);
  return parts.join(', ');
}

function finalizeReplacedGeometry(nextGeometry, options = {}) {
  const { isChamferApply = false } = options;
  currentIsInitial = false;
  syncUndoRedoUI();

  currentMesh.geometry.dispose();
  currentMesh.geometry = nextGeometry;
  currentMesh.geometry.computeVertexNormals();
  currentMesh.geometry.computeBoundingBox();
  currentMesh.geometry.computeBoundingSphere();

  removeEdgeLines();
  removePreview();
  hideLoosePartsPreview();
  currentEdgeData = null;

  setProcessingState(false);

  if (isChamferApply) {
    // Disable preview so the user isn't immediately shown the next bevel preview
    showPreview = false;
    setPreviewToggleUI(false);

    // Disable edge highlight overlay so user sees their clean finished part
    showEdgeHighlight = false;
    setEdgeHighlightToggleUI(false);

    // Detect edges on the new geometry, but deselect all and hide highlights for a clean inspection view
    handleDetectEdges({ deselectAll: true, hideHighlights: true });
  } else {
    handleDetectEdges();
  }
}

let isProcessingMesh = false;
let activeAbortController = null;

function handleStopProcessing() {
  if (!isProcessingMesh || !activeAbortController) return;
  activeAbortController.abort();
  const detailEl = document.getElementById('processing-detail');
  if (detailEl) detailEl.textContent = 'Aborting after current CSG batch...';
  for (const id of ['processing-stop-btn', 'stop-chamfer-btn']) {
    const btn = document.getElementById(id);
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Stopping...';
    }
  }
}

/**
 * Yield to the browser so DOM updates (loading overlay & spinner) paint
 * before heavy synchronous geometry computation blocks the main thread.
 */
function waitForNextPaint() {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      setTimeout(resolve, 16);
    });
  });
}

// ---- Apply chamfer ----
async function handleApplyChamfer() {
  if (isProcessingMesh || !currentMesh || !currentEdgeData) return;

  const selectedCount = currentEdgeData.getSelectedCount();
  if (selectedCount === 0) {
    showToast('No edges selected — click edges or Select All first', 'is-unselected');
    return;
  }

  const label = chamferProfile === 'hybrid' ? 'Hybrid bevel' : (chamferProfile === 'fillet' ? 'Fillet' : 'Chamfer');

  activeAbortController = new AbortController();
  const { signal } = activeAbortController;
  isProcessingMesh = true;
  setProcessingState(
    true,
    `Applying ${label}...`,
    `Preparing ${selectedCount} edge cutter${selectedCount === 1 ? '' : 's'} (CSG)...`,
    'apply-chamfer-btn'
  );

  let newGeometry = null;
  const abortOperation = () => {
    if (newGeometry) {
      newGeometry.dispose();
      newGeometry = null;
    }
    const popped = undoStack.pop();
    popped?.geo?.dispose();
    syncUndoRedoUI();
    showToast('⏹ Operation aborted — mesh unchanged', 'is-unselected');
  };

  try {
    await waitForNextPaint();
    if (signal.aborted) {
      showToast('⏹ Operation aborted — mesh unchanged', 'is-unselected');
      return;
    }

    // Save state before modifying geometry
    pushUndoState();

    const params = new ChamferParams(chamferWidth, chamferSegments, chamferProfile);
    try {
      newGeometry = await applyChamferAsync(
        currentMesh.geometry,
        currentEdgeData,
        params,
        {
          signal,
          onProgress: ({ current, total, edgeCount }) => {
            const detailEl = document.getElementById('processing-detail');
            if (detailEl) {
              detailEl.textContent = `CSG pass ${current} / ${total} (${edgeCount} edge${edgeCount === 1 ? '' : 's'})...`;
            }
          },
        }
      );
    } catch (err) {
      if (err?.name === 'AbortError' || signal.aborted) {
        abortOperation();
        return;
      }
      console.error('Chamfer operation failed:', err);
      const popped = undoStack.pop();
      popped?.geo?.dispose();
      syncUndoRedoUI();
      showToast('Chamfer failed on non-manifold edge', 'is-unselected');
      return;
    }

    if (signal.aborted) {
      abortOperation();
      return;
    }

    let fixedNotice = '';
    let remainingIssues = 0;
    let manualFixHint = false;
    const postStats = analyzeMesh(newGeometry);
    if (!postStats.isWatertight) {
      if (autoFixMesh) {
        setProcessingState(
          true,
          'Running MeshFixer...',
          'Stitching open seams & filling holes...',
          'apply-chamfer-btn'
        );
        await waitForNextPaint();
        if (signal.aborted) {
          abortOperation();
          return;
        }

        try {
          const fixRes = fixMesh(newGeometry, { removeUnconnected: removeUnconnectedParts });
          newGeometry.dispose();
          newGeometry = fixRes.geometry;
          const detail = formatMeshFixSummary(fixRes);
          if (detail) fixedNotice = ` · MeshFixer: ${detail}`;
          remainingIssues = fixRes.afterStats.issueCount;
        } catch (fixErr) {
          console.warn('Auto MeshFixer failed after chamfer:', fixErr);
          remainingIssues = postStats.issueCount;
        }
      } else if (removeUnconnectedParts && postStats.disconnectedParts > 0) {
        const cleanRes = removeDisconnectedParts(newGeometry);
        newGeometry.dispose();
        newGeometry = cleanRes.geometry;
        if (cleanRes.partsRemoved > 0) {
          fixedNotice = ` · ${cleanRes.partsRemoved} loose part${cleanRes.partsRemoved > 1 ? 's' : ''} removed`;
        }
        remainingIssues = cleanRes.afterStats.issueCount;
        manualFixHint = remainingIssues > 0;
      } else {
        remainingIssues = postStats.issueCount;
        manualFixHint = true;
      }
    }

    setProcessingState(
      true,
      'Finalizing Mesh...',
      'Re-detecting sharp edges...',
      'apply-chamfer-btn'
    );
    await waitForNextPaint();
    if (signal.aborted) {
      abortOperation();
      return;
    }

    finalizeReplacedGeometry(newGeometry, { isChamferApply: true });
    newGeometry = null;
    if (manualFixHint) {
      showToast(
        `${label} applied${fixedNotice} with ${remainingIssues} issue(s) — click 🔧 Run MeshFixer to repair`,
        'is-unselected'
      );
    } else if (remainingIssues > 0) {
      showToast(
        `${label} applied${fixedNotice} (${remainingIssues} issue(s) remain)`,
        'is-unselected'
      );
    } else {
      showToast(`${label} applied${fixedNotice}! Clean view active (press 'A' or toggle Highlight to edit further)`, 'is-selected');
    }
  } finally {
    activeAbortController = null;
    isProcessingMesh = false;
    setProcessingState(false);
  }
}

// ---- Manual / On-demand MeshFixer ----
async function handleRunMeshFixer() {
  if (isProcessingMesh || !currentMesh) return;

  const before = analyzeMesh(currentMesh.geometry);
  if (before.isWatertight && before.issueCount === 0) {
    refreshInfo();
    showToast('Mesh is already watertight with 0 issues', 'is-selected');
    return;
  }

  isProcessingMesh = true;
  setProcessingState(
    true,
    'Running MeshFixer...',
    'Welding vertices, stitching seams & filling holes...',
    'mesh-fixer-btn'
  );

  try {
    await waitForNextPaint();

    pushUndoState();

    let fixRes;
    try {
      fixRes = fixMesh(currentMesh.geometry, { removeUnconnected: removeUnconnectedParts, verifyBoolDiff: true });
    } catch (err) {
      console.error('MeshFixer failed:', err);
      const popped = undoStack.pop();
      popped?.geo?.dispose();
      syncUndoRedoUI();
      showToast('MeshFixer failed on current geometry', 'is-unselected');
      return;
    }

    if (fixRes.verification?.rejected) {
      fixRes.geometry.dispose();
      const popped = undoStack.pop();
      popped?.geo?.dispose();
      syncUndoRedoUI();
      setProcessingState(false);
      refreshInfo();
      showToast(
        `MeshFixer rejected: ${fixRes.verification.reason || 'large unexpected parts detected'}`,
        'is-unselected'
      );
      return;
    }

    const fixedCount =
      fixRes.holesFilled +
      fixRes.edgesStitched +
      fixRes.degeneratesRemoved +
      (fixRes.partsRemoved || 0);
    const improved = fixedCount > 0 || fixRes.afterStats.issueCount < before.issueCount;
    if (!improved) {
      fixRes.geometry.dispose();
      const popped = undoStack.pop();
      popped?.geo?.dispose();
      syncUndoRedoUI();
      setProcessingState(false);
      refreshInfo();
      showToast(
        fixRes.afterStats.isWatertight
          ? 'Mesh is already watertight'
          : `No automatic fix applied (${fixRes.afterStats.issueCount} issue(s) remain)`,
        fixRes.afterStats.isWatertight ? 'is-selected' : 'is-unselected'
      );
      return;
    }

    setProcessingState(
      true,
      'Finalizing Mesh...',
      'Re-detecting sharp edges...',
      'mesh-fixer-btn'
    );
    await waitForNextPaint();

    finalizeReplacedGeometry(fixRes.geometry);
    const verifiedText = fixRes.verification?.verified ? ' · verified clean ✓' : '';
    const detailText = (formatMeshFixSummary(fixRes) || 'vertices/normals cleaned') + verifiedText;
    if (fixRes.afterStats.isWatertight) {
      showToast(`MeshFixer: watertight ✓ (${detailText})`, 'is-selected');
    } else {
      showToast(
        `MeshFixer: ${detailText} (${fixRes.afterStats.issueCount} issue(s) remain)`,
        'is-unselected'
      );
    }
  } finally {
    isProcessingMesh = false;
    setProcessingState(false);
  }
}

// ---- Remove Broken / Unconnected Mesh Parts ----
async function handleCleanUnconnectedParts() {
  if (isProcessingMesh || !currentMesh) return;
  hideLoosePartsPreview();

  isProcessingMesh = true;
  setProcessingState(
    true,
    'Cleaning Loose Parts...',
    'Detecting disconnected shells & broken shards...',
    'clean-parts-btn'
  );

  try {
    await waitForNextPaint();

    pushUndoState();

    let res;
    try {
      res = removeDisconnectedParts(currentMesh.geometry);
    } catch (err) {
      console.error('Clean loose parts failed:', err);
      const popped = undoStack.pop();
      popped?.geo?.dispose();
      syncUndoRedoUI();
      showToast('Failed to clean loose mesh parts', 'is-unselected');
      return;
    }

    if (res.partsRemoved === 0 && res.trianglesRemoved === 0) {
      res.geometry.dispose();
      const popped = undoStack.pop();
      popped?.geo?.dispose();
      syncUndoRedoUI();
      setProcessingState(false);
      refreshInfo();
      showToast('No broken or unconnected mesh parts found', 'is-selected');
      return;
    }

    finalizeReplacedGeometry(res.geometry);
    const msg = res.partsRemoved > 0
      ? `Removed ${res.partsRemoved} loose part${res.partsRemoved > 1 ? 's' : ''} (${res.trianglesRemoved} tris) (Ctrl+Z to undo)`
      : `Removed ${res.trianglesRemoved} broken sliver triangle${res.trianglesRemoved > 1 ? 's' : ''} (Ctrl+Z to undo)`;
    showToast(msg, 'is-selected');
  } finally {
    isProcessingMesh = false;
    setProcessingState(false);
  }
}

// ---- Export ----
function handleExportSTL() {
  if (!currentMesh) return;
  exportSTL(currentMesh, 'beveled_model.stl');
  showToast('Exported STL successfully', 'is-selected');
}

function handleExport3MF() {
  if (!currentMesh) return;
  export3MF(currentMesh, 'beveled_model.3mf');
  showToast('Exported 3MF successfully', 'is-selected');
}

// ---- Helpers ----
function removeEdgeLines() {
  if (edgeLinesObject) {
    scene.remove(edgeLinesObject);
    if (currentEdgeData?.dispose) {
      currentEdgeData.dispose();
    }
    edgeLinesObject = null;
  }
}

function refreshInfo() {
  if (!currentMesh) {
    updateInfo({ triangles: 0, vertices: 0, edges: 0, dimensions: '-' });
    updateMeshHealth(null);
    return;
  }
  const geo = currentMesh.geometry;
  const posAttr = geo.getAttribute('position');
  const triCount = geo.index
    ? geo.index.count / 3
    : posAttr.count / 3;

  geo.computeBoundingBox();
  const size = new THREE.Vector3();
  geo.boundingBox.getSize(size);
  const dimStr = `${size.x.toFixed(1)} × ${size.y.toFixed(1)} × ${size.z.toFixed(1)} mm`;

  updateInfo({
    triangles: Math.floor(triCount),
    vertices: posAttr.count,
    edges: currentEdgeData ? currentEdgeData.sharpEdges.length : 0,
    dimensions: dimStr,
  });
  updateMeshHealth(analyzeMesh(geo));
}

// ---- Animation loop ----
function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
}

animate();

// ---- Keyboard shortcuts (Esc: Stop, Ctrl+Z: Undo, Ctrl+Y / Ctrl+Shift+Z: Redo) ----
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && isProcessingMesh) {
    e.preventDefault();
    handleStopProcessing();
    return;
  }

  if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT')) {
    return;
  }

  const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
  const modifier = isMac ? e.metaKey : e.ctrlKey;

  if (modifier && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    if (e.shiftKey) {
      handleRedo();
    } else {
      handleUndo();
    }
  } else if (modifier && e.key.toLowerCase() === 'y') {
    e.preventDefault();
    handleRedo();
  } else if (modifier && e.key.toLowerCase() === 'a') {
    e.preventDefault();
    handleSelectAll();
    showToast('Selected all edges (Ctrl+A)', 'is-selected');
  } else if (!modifier && !e.altKey) {
    const k = e.key.toLowerCase();
    if (k === 'a') {
      e.preventDefault();
      handleSelectAll();
      showToast('Selected all edges (A)', 'is-selected');
    } else if (k === 'c') {
      e.preventDefault();
      handleSelectNone();
      showToast('Cleared edge selection (C)', 'is-unselected');
    } else if (k === 'i') {
      e.preventDefault();
      handleSelectInvert();
      showToast('Inverted edge selection (I)', 'is-selected');
    } else if (k === 'h') {
      e.preventDefault();
      handleSelectHorizontal();
    } else if (k === 'v') {
      e.preventDefault();
      handleSelectVertical();
    } else if (k === 't') {
      e.preventDefault();
      handleSelectTopBottom();
    }
  }
});

// Auto-load starter demo model (Hex Nut) so user immediately sees chamfer in action
loadFromUrl('./models/hex_nut.stl', onModelLoaded, onModelLoadError);
