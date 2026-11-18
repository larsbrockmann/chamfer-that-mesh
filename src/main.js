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
  setOrbitPivot,
  setRotationCenterVisible,
} from './scene.js';
import { setupLoaders, loadFromUrl } from './loaders.js';
import { detectEdges, autoDetectAngleThreshold } from './edgeDetector.js';
import { applyChamfer, applyChamferAsync, previewChamfer, ChamferParams } from './chamferEngine.js';
import {
  analyzeMesh,
  fixMesh,
  fixMeshAsync,
  removeDisconnectedParts,
  findLooseParts,
  verifyMeshFixWithBoolDiff,
} from './meshFixer.js';
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
let faceHighlightMesh = null;
let highlightedSurfaceId = -1;
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
let selectionMode = 'smart'; // 'smart' | 'single'
let loopSelectionMode = true; // synced: true when selectionMode === 'smart'
let autoFixMesh = false;
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

const { updateInfo, fileInput, setWidth, setAngle, setSelectionMode, toggleShortcutsPopover } = buildUI({
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
    selectionMode = mode === 'single' ? 'single' : 'smart';
    loopSelectionMode = selectionMode === 'smart';
    clearHoverState();
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
  onRotationCenterToggle: setRotationCenterVisible,
  onRecenter: () => {
    if (!currentMesh) return;
    const box = new THREE.Box3().setFromObject(currentMesh);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z, 1.0);
    camera.up.set(0, 1, 0);
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

    controls.target.set(0, 0, 0);
    setOrbitPivot(new THREE.Vector3(0, 0, 0), false);

    // Re-detect sharp edges and update preview
    handleDetectEdges();
  },
  onEdgeHighlightToggle: (v) => setOverlaysVisible(v, false),
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

  // Focus camera on object geometric center
  const box = new THREE.Box3().setFromObject(currentMesh);
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z, 1.0);

  camera.near = Math.max(0.01, maxDim * 0.001);
  camera.far = Math.max(1000, maxDim * 100);
  camera.updateProjectionMatrix();

  controls.minDistance = Math.max(0.02, maxDim * 0.002);
  controls.maxDistance = Math.max(1000, maxDim * 50);

  camera.up.set(0, 1, 0);
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

function setOverlaysVisible(visible, announce = false) {
  const next = !!visible;
  showEdgeHighlight = next;
  setEdgeHighlightToggleUI(next);
  if (edgeLinesObject) edgeLinesObject.visible = next;
  if (previewGroup) previewGroup.visible = next && showPreview;
  if (!next) clearHoverState();
  if (announce) {
    showToast(next ? 'Overlays visible (O)' : 'Overlays hidden (O)', next ? 'is-selected' : 'is-unselected');
  }
}

function ensureEdgeHighlightVisible() {
  if (!showEdgeHighlight) {
    setOverlaysVisible(true, false);
  }
}

// ---- Edge selection shortcuts ----
function syncActiveFaceHighlight() {
  if (highlightedSurfaceId >= 0) {
    updateFaceHighlight(highlightedSurfaceId, false);
  }
}

function handleSelectAll() {
  if (!currentEdgeData) return;
  ensureEdgeHighlightVisible();
  currentEdgeData.selectAll();
  updateEdgeCount(currentEdgeData.sharpEdges.length, currentEdgeData.getSelectedCount(), currentEdgeData.filteredCount);
  syncActiveFaceHighlight();
  if (showPreview) updatePreview();
}

function handleSelectNone() {
  if (!currentEdgeData) return;
  currentEdgeData.clearSelection();
  updateEdgeCount(currentEdgeData.sharpEdges.length, 0, currentEdgeData.filteredCount);
  syncActiveFaceHighlight();
  if (showPreview) updatePreview();
}

function handleSelectInvert() {
  if (!currentEdgeData) return;
  ensureEdgeHighlightVisible();
  currentEdgeData.invertSelection();
  updateEdgeCount(currentEdgeData.sharpEdges.length, currentEdgeData.getSelectedCount(), currentEdgeData.filteredCount);
  syncActiveFaceHighlight();
  if (showPreview) updatePreview();
}

function handleSelectHorizontal() {
  if (!currentEdgeData) return;
  ensureEdgeHighlightVisible();
  currentEdgeData.selectHorizontal();
  updateEdgeCount(currentEdgeData.sharpEdges.length, currentEdgeData.getSelectedCount(), currentEdgeData.filteredCount);
  syncActiveFaceHighlight();
  if (showPreview) updatePreview();
  showToast(`Selected ${currentEdgeData.getSelectedCount()} horizontal edges`, 'is-selected');
}

function handleSelectVertical() {
  if (!currentEdgeData) return;
  ensureEdgeHighlightVisible();
  currentEdgeData.selectVertical();
  updateEdgeCount(currentEdgeData.sharpEdges.length, currentEdgeData.getSelectedCount(), currentEdgeData.filteredCount);
  syncActiveFaceHighlight();
  if (showPreview) updatePreview();
  showToast(`Selected ${currentEdgeData.getSelectedCount()} vertical edges`, 'is-selected');
}

function handleSelectTopBottom() {
  if (!currentEdgeData) return;
  ensureEdgeHighlightVisible();
  currentEdgeData.selectTopBottom();
  updateEdgeCount(currentEdgeData.sharpEdges.length, currentEdgeData.getSelectedCount(), currentEdgeData.filteredCount);
  syncActiveFaceHighlight();
  if (showPreview) updatePreview();
  showToast(`Selected ${currentEdgeData.getSelectedCount()} top & bottom edges`, 'is-selected');
}

// ---- Edge detection ----
function handleDetectEdges(options = {}) {
  if (!currentMesh) return;

  removeEdgeLines();
  clearFaceHighlight();
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
    edgeLinesObject.visible = showEdgeHighlight;
    scene.add(edgeLinesObject);
  }

  refreshInfo();

  if (showPreview) {
    updatePreview();
  }
}

// ---- Interactive 3D Edge & Face Hover & Selection ----
let pointerDownPos = { x: 0, y: 0 };
let postClickOrigin = null;
const hoverBadge = document.getElementById('edge-hover-badge');

function clearFaceHighlight() {
  if (faceHighlightMesh) {
    scene.remove(faceHighlightMesh);
    faceHighlightMesh.geometry?.dispose();
    faceHighlightMesh.material?.dispose();
    faceHighlightMesh = null;
  }
  highlightedSurfaceId = -1;
}

function clearHoverState() {
  postClickOrigin = null;
  clearFaceHighlight();
  if (currentEdgeData) {
    currentEdgeData.setHovered(-1);
  }
  if (hoverBadge) {
    hoverBadge.classList.remove('visible');
  }
  canvas.style.cursor = 'default';
}

function updateFaceHighlight(surfaceId, forceRebuild = false) {
  if (
    surfaceId < 0 ||
    !currentEdgeData ||
    !currentEdgeData.surfaces[surfaceId] ||
    !showEdgeHighlight
  ) {
    clearFaceHighlight();
    return;
  }

  const surf = currentEdgeData.surfaces[surfaceId];
  const { allSelected } = currentEdgeData.getSurfaceSelectionState(surfaceId);
  const color = allSelected ? 0xff6b38 : 0x1ff08f;
  const opacity = allSelected ? 0.28 : 0.26;

  if (!faceHighlightMesh || surfaceId !== highlightedSurfaceId || forceRebuild) {
    const faceCount = surf.faceIndices.length;
    const positions = new Float32Array(faceCount * 9);
    const { faces, vertices } = currentEdgeData;
    for (let i = 0; i < faceCount; i++) {
      const tri = faces[surf.faceIndices[i]];
      if (!tri) continue;
      const v0 = vertices[tri[0]];
      const v1 = vertices[tri[1]];
      const v2 = vertices[tri[2]];
      if (!v0 || !v1 || !v2) continue;
      const off = i * 9;
      positions[off] = v0.x;
      positions[off + 1] = v0.y;
      positions[off + 2] = v0.z;
      positions[off + 3] = v1.x;
      positions[off + 4] = v1.y;
      positions[off + 5] = v1.z;
      positions[off + 6] = v2.x;
      positions[off + 7] = v2.y;
      positions[off + 8] = v2.z;
    }

    if (!faceHighlightMesh) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      const mat = new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity,
        side: THREE.DoubleSide,
        depthTest: true,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -1.5,
        polygonOffsetUnits: -3.0,
      });
      faceHighlightMesh = new THREE.Mesh(geo, mat);
      faceHighlightMesh.name = 'faceHighlight';
      faceHighlightMesh.renderOrder = 5;
      scene.add(faceHighlightMesh);
    } else {
      faceHighlightMesh.geometry.dispose();
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      faceHighlightMesh.geometry = geo;
    }

    if (currentMesh) {
      faceHighlightMesh.position.copy(currentMesh.position);
      faceHighlightMesh.quaternion.copy(currentMesh.quaternion);
      faceHighlightMesh.scale.copy(currentMesh.scale);
    }
    highlightedSurfaceId = surfaceId;
  }

  faceHighlightMesh.material.color.setHex(color);
  faceHighlightMesh.material.opacity = opacity;
}

function updateHoverBadge(edgeIdx) {
  if (!hoverBadge) return;
  if (edgeIdx < 0 || !currentEdgeData || !currentEdgeData.sharpEdges[edgeIdx]) {
    hoverBadge.classList.remove('visible');
    return;
  }

  const edge = currentEdgeData.sharpEdges[edgeIdx];
  const isSel = edge.selected;
  const isHoverPreview = postClickOrigin === null;
  const count = loopSelectionMode && edge.chainId !== undefined && currentEdgeData.chains[edge.chainId]
    ? currentEdgeData.chains[edge.chainId].length
    : 1;
  const loopLabel = loopSelectionMode ? `Loop (${count} segments)` : 'Edge';

  if (isSel) {
    const stateCls = isHoverPreview ? 'is-hover-deselect' : 'is-selected';
    const dotCls = isHoverPreview ? 'dot-hover-deselect' : 'dot-selected';
    hoverBadge.className = `edge-hover-badge visible ${stateCls}`;
    hoverBadge.innerHTML = `<span class="badge-dot ${dotCls}"></span><span>Selected ${loopLabel}</span><span class="badge-action">Click to deselect (−)</span>`;
  } else {
    const stateCls = isHoverPreview ? 'is-hover-select' : 'is-unselected';
    const dotCls = isHoverPreview ? 'dot-hover-select' : 'dot-unselected';
    hoverBadge.className = `edge-hover-badge visible ${stateCls}`;
    hoverBadge.innerHTML = `<span class="badge-dot ${dotCls}"></span><span>Unselected ${loopLabel}</span><span class="badge-action">Click to select (+)</span>`;
  }
}

function updateFaceHoverBadge(surfaceId) {
  if (!hoverBadge) return;
  if (surfaceId < 0 || !currentEdgeData || !currentEdgeData.surfaces[surfaceId]) {
    hoverBadge.classList.remove('visible');
    return;
  }

  const { total, selectedCount, allSelected, noneSelected } =
    currentEdgeData.getSurfaceSelectionState(surfaceId);
  if (total === 0) {
    hoverBadge.classList.remove('visible');
    return;
  }

  const isHoverPreview = postClickOrigin === null;
  const edgeWord = total === 1 ? 'edge' : 'edges';
  if (allSelected) {
    const stateCls = isHoverPreview ? 'is-hover-deselect' : 'is-selected';
    const dotCls = isHoverPreview ? 'dot-hover-deselect' : 'dot-selected';
    hoverBadge.className = `edge-hover-badge visible ${stateCls}`;
    hoverBadge.innerHTML = `<span class="badge-dot ${dotCls}"></span><span>Selected Face (${total} ${edgeWord})</span><span class="badge-action">Click to deselect (−)</span>`;
  } else {
    const stateCls = isHoverPreview ? 'is-hover-select' : 'is-unselected';
    const dotCls = isHoverPreview ? 'dot-hover-select' : 'dot-unselected';
    const label = noneSelected
      ? `Unselected Face (${total} ${edgeWord})`
      : `Face (${selectedCount}/${total} ${edgeWord} selected)`;
    const action = noneSelected ? 'Click to select (+)' : 'Click to select all (+)';
    hoverBadge.className = `edge-hover-badge visible ${stateCls}`;
    hoverBadge.innerHTML = `<span class="badge-dot ${dotCls}"></span><span>${label}</span><span class="badge-action">${action}</span>`;
  }
}

const raycaster = new THREE.Raycaster();
const pointerNDC = new THREE.Vector2();
const _edgeClosestPt = new THREE.Vector3();

function getSurfaceHitAtClientPos(clientX, clientY) {
  if (!currentMesh || !currentEdgeData || currentEdgeData.surfaces.length === 0) {
    return null;
  }
  const rect = canvas.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;

  pointerNDC.set(
    ((clientX - rect.left) / rect.width) * 2 - 1,
    -((clientY - rect.top) / rect.height) * 2 + 1
  );
  raycaster.setFromCamera(pointerNDC, camera);

  const hits = raycaster.intersectObject(currentMesh, false);
  if (hits.length === 0) return null;

  const hit = hits[0];
  if (hit.faceIndex === undefined || hit.faceIndex < 0) return null;
  if (hit.faceIndex >= currentEdgeData.faceToSurface.length) return null;

  const surfaceId = currentEdgeData.faceToSurface[hit.faceIndex];
  if (
    surfaceId < 0 ||
    !currentEdgeData.surfaces[surfaceId] ||
    currentEdgeData.surfaces[surfaceId].edgeIndices.length === 0
  ) {
    return null;
  }

  return {
    surfaceId,
    distance: hit.distance,
    point: hit.point,
    faceIndex: hit.faceIndex,
  };
}

function getClosestEdge(clientX, clientY, isTouch = false, maxFrontDist = Infinity) {
  if (!currentEdgeData || currentEdgeData.sharpEdges.length === 0) return -1;
  const rect = canvas.getBoundingClientRect();
  const mx = clientX - rect.left;
  const my = clientY - rect.top;
  const w = rect.width;
  const h = rect.height;
  if (w <= 0 || h <= 0) return -1;

  if (maxFrontDist < Infinity) {
    pointerNDC.set((mx / w) * 2 - 1, -(my / h) * 2 + 1);
    raycaster.setFromCamera(pointerNDC, camera);
  }

  const occlusionTol = Math.max(0.4, maxFrontDist * 0.02);
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
      if (maxFrontDist < Infinity) {
        raycaster.ray.distanceSqToSegment(edge.v1, edge.v2, undefined, _edgeClosestPt);
        const camDist = camera.position.distanceTo(_edgeClosestPt);
        if (camDist > maxFrontDist + occlusionTol) continue;
      }
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

function resolveViewportTarget(clientX, clientY, isTouch = false) {
  const surfaceHit = getSurfaceHitAtClientPos(clientX, clientY);
  const edgeIdx = getClosestEdge(
    clientX,
    clientY,
    isTouch,
    surfaceHit ? surfaceHit.distance : Infinity
  );

  if (edgeIdx >= 0) {
    return { type: 'edge', edgeIdx };
  }
  if (selectionMode === 'smart' && surfaceHit) {
    return { type: 'face', surfaceId: surfaceHit.surfaceId };
  }
  return { type: 'none' };
}

canvas.addEventListener('pointermove', (e) => {
  if (e.pointerType === 'touch') return;
  if (!currentEdgeData || controls.state !== -1) return;
  if (!showEdgeHighlight) {
    clearHoverState();
    return;
  }
  if (postClickOrigin) {
    const moveDist = Math.hypot(e.clientX - postClickOrigin.x, e.clientY - postClickOrigin.y);
    if (moveDist < 4) return;
    postClickOrigin = null;
  }
  const target = resolveViewportTarget(e.clientX, e.clientY, false);
  if (target.type === 'edge') {
    clearFaceHighlight();
    currentEdgeData.setHovered(target.edgeIdx, loopSelectionMode);
    updateHoverBadge(target.edgeIdx);
    canvas.style.cursor = 'pointer';
  } else if (target.type === 'face') {
    currentEdgeData.setHoveredSurface(target.surfaceId);
    updateFaceHighlight(target.surfaceId);
    updateFaceHoverBadge(target.surfaceId);
    canvas.style.cursor = 'pointer';
  } else {
    clearFaceHighlight();
    currentEdgeData.setHovered(-1);
    updateHoverBadge(-1);
    canvas.style.cursor = 'default';
  }
});

canvas.addEventListener('pointerdown', (e) => {
  if (e.pointerType === 'touch' && !e.isPrimary) return;
  pointerDownPos = { x: e.clientX, y: e.clientY };
});

canvas.addEventListener('pointerup', (e) => {
  const isTouch = e.pointerType === 'touch';
  if (isTouch && !e.isPrimary) return;
  if (!isTouch && e.button !== 0) return;
  const tapThreshold = isTouch ? 14 : 6;
  const dist = Math.hypot(e.clientX - pointerDownPos.x, e.clientY - pointerDownPos.y);
  if (dist < tapThreshold && currentEdgeData && showEdgeHighlight) {
    const target = resolveViewportTarget(e.clientX, e.clientY, isTouch);
    if (target.type === 'edge') {
      currentEdgeData.toggleEdge(target.edgeIdx, loopSelectionMode);
      postClickOrigin = { x: e.clientX, y: e.clientY };
      clearFaceHighlight();
      currentEdgeData.setHovered(-1);
      updateEdgeCount(
        currentEdgeData.sharpEdges.length,
        currentEdgeData.getSelectedCount(),
        currentEdgeData.filteredCount
      );
      if (isTouch) {
        updateHoverBadge(-1);
      } else {
        updateHoverBadge(target.edgeIdx);
      }
      if (showPreview) updatePreview();
    } else if (target.type === 'face') {
      const toggled = currentEdgeData.toggleSurface(target.surfaceId);
      if (toggled) {
        postClickOrigin = { x: e.clientX, y: e.clientY };
        clearFaceHighlight();
        currentEdgeData.setHovered(-1);
        updateEdgeCount(
          currentEdgeData.sharpEdges.length,
          currentEdgeData.getSelectedCount(),
          currentEdgeData.filteredCount
        );
        if (isTouch) {
          updateHoverBadge(-1);
        } else {
          updateFaceHoverBadge(target.surfaceId);
        }
        if (showPreview) updatePreview();
      }
    }
  }
});

canvas.addEventListener('pointerleave', () => {
  clearHoverState();
});

// Update LineMaterial screen resolution on viewport/canvas resize
const viewportEl = document.getElementById('viewport') || canvas;
const resizeObserver = new ResizeObserver(() => {
  const w = viewportEl.clientWidth;
  const h = viewportEl.clientHeight;
  if (w <= 0 || h <= 0) return;
  if (currentEdgeData?.setResolution) {
    currentEdgeData.setResolution(w, h);
  }
});
resizeObserver.observe(viewportEl);

// ---- Chamfer preview ----
function updatePreview() {
  removePreview();
  if (!currentEdgeData || currentEdgeData.sharpEdges.length === 0) return;

  const params = new ChamferParams(chamferWidth, chamferSegments, chamferProfile);
  previewGroup = previewChamfer(currentEdgeData, params);
  if (previewGroup) {
    previewGroup.visible = showEdgeHighlight && showPreview;
    scene.add(previewGroup);
  }
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
  if (fixRes.engine === 'wasm-pmp') parts.push('C++ WASM');
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
  }

  // Keep edge highlight always visible
  ensureEdgeHighlightVisible();
  handleDetectEdges();
}

let isProcessingMesh = false;
let activeAbortController = null;

function handleStopProcessing() {
  if (!isProcessingMesh || !activeAbortController) return;
  activeAbortController.abort();
  const detailEl = document.getElementById('processing-detail');
  if (detailEl) detailEl.textContent = 'Stopping operation...';
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
          const fixRes = await fixMeshAsync(newGeometry, {
            removeUnconnected: removeUnconnectedParts,
            signal,
            onProgress: (msg) => {
              const detailEl = document.getElementById('processing-detail');
              if (detailEl) detailEl.textContent = msg;
            },
          });
          newGeometry.dispose();
          newGeometry = fixRes.geometry;
          const detail = formatMeshFixSummary(fixRes);
          if (detail) fixedNotice = ` · MeshFixer: ${detail}`;
          remainingIssues = fixRes.afterStats.issueCount;
        } catch (fixErr) {
          if (fixErr?.name === 'AbortError' || signal.aborted) {
            abortOperation();
            return;
          }
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
  if (
    before.isWatertight &&
    before.openEdges === 0 &&
    before.nonManifoldEdges === 0 &&
    (!removeUnconnectedParts || before.disconnectedParts === 0)
  ) {
    showToast('✓ Mesh is already 100% watertight — no repair needed', 'is-selected');
    return;
  }

  isProcessingMesh = true;
  activeAbortController = new AbortController();
  const signal = activeAbortController.signal;

  setProcessingState(
    true,
    'Running MeshFixer...',
    'Welding vertices, stitching seams & filling holes...',
    'mesh-fixer-btn'
  );

  const abortOperation = () => {
    const popped = undoStack.pop();
    popped?.geo?.dispose();
    syncUndoRedoUI();
    setProcessingState(false);
    refreshInfo();
    showToast('⏹ MeshFixer stopped — mesh unchanged', 'is-unselected');
  };

  try {
    await waitForNextPaint();
    if (signal.aborted) {
      abortOperation();
      return;
    }

    pushUndoState();

    let fixRes;
    try {
      fixRes = await fixMeshAsync(currentMesh.geometry, {
        removeUnconnected: removeUnconnectedParts,
        verifyBoolDiff: true,
        signal,
        onProgress: (msg) => {
          const detailEl = document.getElementById('processing-detail');
          if (detailEl) detailEl.textContent = msg;
        },
      });
    } catch (err) {
      if (err?.name === 'AbortError' || signal.aborted) {
        abortOperation();
        return;
      }
      console.error('MeshFixer failed:', err);
      const popped = undoStack.pop();
      popped?.geo?.dispose();
      syncUndoRedoUI();
      showToast('MeshFixer failed on current geometry', 'is-unselected');
      return;
    }

    if (signal.aborted) {
      abortOperation();
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

    const improved =
      (!before.isWatertight && fixRes.afterStats.isWatertight) ||
      (fixRes.afterStats.issueCount < before.issueCount && (!before.isWatertight || fixRes.afterStats.isWatertight)) ||
      (before.isWatertight && fixRes.afterStats.isWatertight && (fixRes.partsRemoved || 0) > 0);

    if (!improved || fixRes.verification?.rejected || (before.isWatertight && !fixRes.afterStats.isWatertight)) {
      fixRes.geometry.dispose();
      const popped = undoStack.pop();
      popped?.geo?.dispose();
      syncUndoRedoUI();
      setProcessingState(false);
      refreshInfo();
      showToast(
        before.isWatertight
          ? '✓ Mesh is already watertight — mesh unchanged'
          : `No repair applied (${fixRes.afterStats.issueCount} issue(s) remain)`,
        before.isWatertight ? 'is-selected' : 'is-unselected'
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
    if (signal.aborted) {
      abortOperation();
      return;
    }

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
    activeAbortController = null;
    isProcessingMesh = false;
    setProcessingState(false);
  }
}

// ---- Remove Broken / Unconnected Mesh Parts ----
async function handleCleanUnconnectedParts() {
  if (isProcessingMesh || !currentMesh) return;
  hideLoosePartsPreview();

  isProcessingMesh = true;
  activeAbortController = new AbortController();
  const signal = activeAbortController.signal;

  setProcessingState(
    true,
    'Cleaning Loose Parts...',
    'Detecting disconnected shells & broken shards...',
    'clean-parts-btn'
  );

  try {
    await waitForNextPaint();
    if (signal.aborted) {
      isProcessingMesh = false;
      setProcessingState(false);
      showToast('⏹ Clean operation stopped', 'is-unselected');
      return;
    }

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
    activeAbortController = null;
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
  clearFaceHighlight();
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
  if (e.key === 'Escape') {
    if (isProcessingMesh) {
      e.preventDefault();
      handleStopProcessing();
      return;
    }
    toggleShortcutsPopover(false);
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
    if (e.key === '?') {
      e.preventDefault();
      toggleShortcutsPopover();
    } else if (k === 'm') {
      e.preventDefault();
      const nextMode = selectionMode === 'smart' ? 'single' : 'smart';
      setSelectionMode(nextMode);
      showToast(
        nextMode === 'smart'
          ? 'Mode: Smart — Edges & Faces (M)'
          : 'Mode: Single Edge only (M)',
        'is-selected'
      );
    } else if (k === 'o') {
      e.preventDefault();
      setOverlaysVisible(!showEdgeHighlight, true);
    } else if (k === 'a') {
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
    }
  }
});

// Auto-load starter demo model (Hex Nut) so user immediately sees chamfer in action
loadFromUrl('./models/hex_nut.stl', onModelLoaded, onModelLoadError);
