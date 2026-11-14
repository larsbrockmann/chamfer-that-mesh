/* ============================================================
   ui.js — Build the sidebar UI panel
   ============================================================ */

/**
 * @typedef {Object} UICallbacks
 * @property {(file: File) => void} onImport
 * @property {() => void} onExport
 * @property {(angle: number) => void} onAngleChange
 * @property {() => void} onDetectEdges
 * @property {(width: number) => void} onWidthChange
 * @property {(segments: number) => void} onSegmentsChange
 * @property {(preview: boolean) => void} onPreviewToggle
 * @property {() => void} onApplyChamfer
 * @property {(wireframe: boolean) => void} onWireframeToggle
 * @property {(grid: boolean) => void} onGridToggle
 * @property {(axes: boolean) => void} onAxesToggle
 * @property {(edges: boolean) => void} onEdgeHighlightToggle
 */

/**
 * Build the sidebar UI.
 * @param {UICallbacks} callbacks
 * @returns {{ updateInfo: (info: {triangles: number, vertices: number, edges: number}) => void, fileInput: HTMLInputElement }}
 */
export function buildUI(callbacks) {
  const sidebar = document.getElementById('sidebar');
  sidebar.innerHTML = '';

  // Hidden file input
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = '.stl,.3mf';
  fileInput.style.display = 'none';
  fileInput.id = 'file-input';
  sidebar.appendChild(fileInput);

  // ---- Title ----
  const title = el('div', 'sidebar-title', '⚡ Chamfer That Mesh');
  const subtitle = el('div', 'sidebar-subtitle', 'Best-Guess STL / 3MF Post-Processor');
  const disclaimer = el(
    'div',
    'sidebar-disclaimer',
    '⚠ Heuristic mesh post-processing: operates on raw STL/3MF triangles. Outcomes may come out imprecise or broken on complex geometry.'
  );
  disclaimer.id = 'sidebar-disclaimer';
  sidebar.appendChild(title);
  sidebar.appendChild(subtitle);
  sidebar.appendChild(disclaimer);

  // ============ FILE section ============
  const fileSection = section('File');
  const importBtn = button('Import Model (STL / 3MF)', 'btn-primary');
  importBtn.addEventListener('click', () => fileInput.click());
  fileSection.appendChild(importBtn);

  // Sample models dropdown
  const sampleRow = controlRow('Sample Models');
  const sampleSelect = document.createElement('select');
  sampleSelect.className = 'sample-select';
  sampleSelect.innerHTML = `
    <option value="" disabled selected>Select a model...</option>
    <optgroup label="CAD & Functional Parts">
      <option value="./models/LBracketRoundedCountersunk_w12_hole32.stl">L-Bracket (Countersunk)</option>
      <option value="./models/anti-rotate-multiconnect-superconnect.stl">Anti-Rotate Multiconnect</option>
      <option value="./models/anti-rotate-multiconnect-superconnect-folded.stl">Anti-Rotate Folded</option>
      <option value="./models/5-letter-word-SCAD.stl">5-Letter Word SCAD</option>
    </optgroup>
    <optgroup label="Basic Shapes">
      <option value="./models/cube.stl">Cube (20mm)</option>
      <option value="./models/cylinder.stl">Cylinder (32 seg)</option>
      <option value="./models/bracket.stl">Basic L-Bracket</option>
      <option value="./models/hex_prism.stl">Hex Prism</option>
      <option value="./models/box.3mf">3MF Box</option>
    </optgroup>
  `;
  sampleSelect.addEventListener('change', (e) => {
    if (e.target.value && callbacks.onLoadSample) {
      callbacks.onLoadSample(e.target.value);
    }
  });
  fileSection.appendChild(sampleRow);
  fileSection.appendChild(sampleSelect);

  // Dual export buttons: STL and 3MF
  const exportRow = el('div', 'selection-btn-row');
  exportRow.style.marginTop = '8px';
  const exportStlBtn = button('Export STL', 'btn-secondary btn-small');
  exportStlBtn.title = 'Export binary STL file for slicing';
  exportStlBtn.addEventListener('click', () => callbacks.onExportSTL && callbacks.onExportSTL());
  const export3mfBtn = button('Export 3MF', 'btn-secondary btn-small');
  export3mfBtn.title = 'Export standard 3MF archive file';
  export3mfBtn.addEventListener('click', () => callbacks.onExport3MF && callbacks.onExport3MF());
  exportRow.appendChild(exportStlBtn);
  exportRow.appendChild(export3mfBtn);
  fileSection.appendChild(exportRow);
  sidebar.appendChild(fileSection);

  // ============ EDGE DETECTION section ============
  const edgeSection = section('Edge Detection & Selection');

  const angleRow = controlRow('Angle Threshold');
  const angleValue = el('span', 'control-value', '30°');
  const angleSlider = slider(0, 180, 30, 1);
  angleSlider.addEventListener('input', () => {
    const v = parseFloat(angleSlider.value);
    angleValue.textContent = `${v}°`;
    callbacks.onAngleChange(v);
  });
  angleRow.appendChild(angleValue);
  edgeSection.appendChild(angleRow);
  edgeSection.appendChild(angleSlider);

  // Convex Edges Only toggle
  const convexRow = toggleRow('Convex Edges Only', false);
  const convexInput = convexRow.querySelector('input');
  convexInput.addEventListener('change', () => {
    if (callbacks.onConvexOnlyToggle) callbacks.onConvexOnlyToggle(convexInput.checked);
  });
  edgeSection.appendChild(convexRow);

  // Tiny Edge Filter toggle (automatic)
  const filterRow = toggleRow('Filter Tiny Edges', false);
  const filterInput = filterRow.querySelector('input');
  edgeSection.appendChild(filterRow);

  // Filter options container (Action mode + Min Length)
  const filterOptionsContainer = el('div', 'filter-options-container');
  filterOptionsContainer.style.display = 'none';

  const filterModeRow = el('div', 'control-row');
  filterModeRow.style.marginTop = '4px';
  const filterModeLbl = el('span', 'control-label', 'Filter Action');
  const filterModeGroup = el('div', 'segmented-control');

  const combineBtn = document.createElement('button');
  combineBtn.textContent = 'Combine';
  combineBtn.className = 'segment-btn';
  combineBtn.title = 'Merge collinear & micro-segments along loops into smooth continuous edges';

  const ignoreBtn = document.createElement('button');
  ignoreBtn.textContent = 'Ignore';
  ignoreBtn.className = 'segment-btn active';
  ignoreBtn.title = 'Discard isolated edges shorter than the min length threshold';

  const bothBtn = document.createElement('button');
  bothBtn.textContent = 'Both';
  bothBtn.className = 'segment-btn';
  bothBtn.title = 'Combine collinear segments and ignore remaining tiny micro-noise';

  const modeBtns = [combineBtn, ignoreBtn, bothBtn];
  const modes = ['combine', 'ignore', 'both'];
  modeBtns.forEach((btn, idx) => {
    btn.addEventListener('click', () => {
      modeBtns.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      if (callbacks.onFilterModeChange) callbacks.onFilterModeChange(modes[idx]);
    });
    filterModeGroup.appendChild(btn);
  });
  filterModeRow.appendChild(filterModeLbl);
  filterModeRow.appendChild(filterModeGroup);
  filterOptionsContainer.appendChild(filterModeRow);

  const minLenRow = controlRow('Min Length (mm)');
  const minLenValue = el('span', 'control-value', '0.20');
  const minLenSlider = slider(0.05, 2.0, 0.20, 0.05);
  minLenSlider.addEventListener('input', () => {
    const v = parseFloat(minLenSlider.value);
    minLenValue.textContent = v.toFixed(2);
    if (callbacks.onMinLengthChange) callbacks.onMinLengthChange(v);
  });
  minLenRow.appendChild(minLenValue);
  filterOptionsContainer.appendChild(minLenRow);
  filterOptionsContainer.appendChild(minLenSlider);

  edgeSection.appendChild(filterOptionsContainer);

  filterInput.addEventListener('change', () => {
    filterOptionsContainer.style.display = filterInput.checked ? 'flex' : 'none';
    if (callbacks.onFilterToggle) callbacks.onFilterToggle(filterInput.checked);
  });

  // Selection counts
  const edgeCountRow = el('div', 'info-row');
  edgeCountRow.innerHTML =
    '<span>Detected edges</span><span class="info-value" id="edge-count">0</span>';
  edgeCountRow.style.marginTop = '8px';
  edgeSection.appendChild(edgeCountRow);

  const selCountRow = el('div', 'info-row');
  selCountRow.innerHTML =
    '<span>Selected for chamfer</span><span class="info-value" id="selected-edge-count" style="color:var(--accent); font-weight:700;">0 / 0</span>';
  edgeSection.appendChild(selCountRow);

  // Selection buttons row
  const btnRow = el('div', 'selection-btn-row');
  const selectAllBtn = button('Select All', 'btn-secondary btn-small');
  selectAllBtn.addEventListener('click', () => callbacks.onSelectAll && callbacks.onSelectAll());
  const selectNoneBtn = button('Clear', 'btn-secondary btn-small');
  selectNoneBtn.addEventListener('click', () => callbacks.onSelectNone && callbacks.onSelectNone());
  const invertBtn = button('Invert', 'btn-secondary btn-small');
  invertBtn.addEventListener('click', () => callbacks.onSelectInvert && callbacks.onSelectInvert());
  btnRow.appendChild(selectAllBtn);
  btnRow.appendChild(selectNoneBtn);
  btnRow.appendChild(invertBtn);
  edgeSection.appendChild(btnRow);

  // Selection mode: Loop vs Single
  const modeRow = el('div', 'control-row');
  modeRow.style.marginTop = '6px';
  const modeLbl = el('span', 'control-label', 'Click Mode');
  const modeGroup = el('div', 'segmented-control');
  const loopRadio = document.createElement('button');
  loopRadio.textContent = 'Chain Loop';
  loopRadio.className = 'segment-btn active';
  const singleRadio = document.createElement('button');
  singleRadio.textContent = 'Single Edge';
  singleRadio.className = 'segment-btn';

  loopRadio.addEventListener('click', () => {
    loopRadio.classList.add('active');
    singleRadio.classList.remove('active');
    if (callbacks.onSelectionModeChange) callbacks.onSelectionModeChange('loop');
  });
  singleRadio.addEventListener('click', () => {
    singleRadio.classList.add('active');
    loopRadio.classList.remove('active');
    if (callbacks.onSelectionModeChange) callbacks.onSelectionModeChange('single');
  });
  modeGroup.appendChild(loopRadio);
  modeGroup.appendChild(singleRadio);
  modeRow.appendChild(modeLbl);
  modeRow.appendChild(modeGroup);
  edgeSection.appendChild(modeRow);

  const helpHint = el(
    'div',
    'selection-hint',
    '💡 Click edges in 3D viewport to toggle. In Loop mode, clicking selects the full contour.'
  );
  edgeSection.appendChild(helpHint);

  // Color legend
  const legend = el('div', 'edge-legend');
  legend.innerHTML = `
    <div class="legend-item"><span class="legend-swatch swatch-selected"></span><span>Selected</span></div>
    <div class="legend-item"><span class="legend-swatch swatch-hovered-sel"></span><span>Hover (Selected)</span></div>
    <div class="legend-item"><span class="legend-swatch swatch-unselected"></span><span>Unselected</span></div>
    <div class="legend-item"><span class="legend-swatch swatch-hovered-unsel"></span><span>Hover (Unselected)</span></div>
  `;
  edgeSection.appendChild(legend);

  sidebar.appendChild(edgeSection);

  // ============ CHAMFER SETTINGS section ============
  const chamferSection = section('Chamfer & Fillet Settings');

  // Profile Type: Chamfer vs Fillet vs Hybrid
  const profileRow = el('div', 'control-row');
  profileRow.style.marginBottom = '6px';
  const profileLbl = el('span', 'control-label', 'Profile');
  const profileGroup = el('div', 'segmented-control');

  const chamferTypeBtn = document.createElement('button');
  chamferTypeBtn.textContent = 'Chamfer';
  chamferTypeBtn.className = 'segment-btn active';
  chamferTypeBtn.title = 'Flat 45° planar bevel';

  const filletTypeBtn = document.createElement('button');
  filletTypeBtn.textContent = 'Fillet';
  filletTypeBtn.className = 'segment-btn';
  filletTypeBtn.title = 'Smooth circular radial arc';

  const hybridTypeBtn = document.createElement('button');
  hybridTypeBtn.textContent = 'Hybrid';
  hybridTypeBtn.className = 'segment-btn';
  hybridTypeBtn.title = 'Chamfer-Fillet Hybrid: Flat bevel with radiused transition shoulders';

  const profileBtns = [chamferTypeBtn, filletTypeBtn, hybridTypeBtn];
  const profileValues = ['chamfer', 'fillet', 'hybrid'];

  profileRow.appendChild(profileLbl);
  profileRow.appendChild(profileGroup);
  chamferSection.appendChild(profileRow);

  const widthRow = controlRow('Width (mm)');
  const widthInput = document.createElement('input');
  widthInput.type = 'number';
  widthInput.id = 'chamfer-width-input';
  widthInput.className = 'control-number-input';
  widthInput.min = '0.01';
  widthInput.max = '100';
  widthInput.step = 'any';
  widthInput.value = '0.5';
  widthInput.title = 'Enter chamfer width in mm (values outside 0.1–1.0 mm automatically extend the slider range)';

  const widthSlider = slider(0.1, 1.0, 0.5, 0.1);
  widthSlider.id = 'chamfer-width-slider';

  function computeSliderStep(minVal, val) {
    const isTenth = (x) => Math.abs(Math.round(x * 10) - x * 10) < 1e-4;
    const isHundredth = (x) => Math.abs(Math.round(x * 100) - x * 100) < 1e-4;
    if (isTenth(minVal) && isTenth(val)) return '0.1';
    if (isHundredth(minVal) && isHundredth(val)) return '0.01';
    return 'any';
  }

  widthSlider.addEventListener('input', () => {
    const v = parseFloat(widthSlider.value);
    widthInput.value = Number(v.toFixed(3)).toString();
    callbacks.onWidthChange(v);
  });

  function syncSliderFromInput(commitFormat = false) {
    const raw = parseFloat(widthInput.value);
    if (isNaN(raw) || raw <= 0) {
      if (commitFormat) {
        widthInput.value = Number(parseFloat(widthSlider.value).toFixed(3)).toString();
      }
      return;
    }
    const v = Math.max(0.01, Math.min(100, raw));
    const curMin = parseFloat(widthSlider.min);
    const curMax = parseFloat(widthSlider.max);
    if (v > curMax) {
      widthSlider.max = Math.max(1.0, v);
    }
    if (v < curMin) {
      widthSlider.min = Math.min(0.1, v);
    }
    widthSlider.step = computeSliderStep(parseFloat(widthSlider.min), v);
    widthSlider.value = v;
    if (commitFormat) {
      widthInput.value = Number(v.toFixed(3)).toString();
    }
    callbacks.onWidthChange(v);
  }

  widthInput.addEventListener('input', () => syncSliderFromInput(false));
  widthInput.addEventListener('change', () => syncSliderFromInput(true));
  widthInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      syncSliderFromInput(true);
      widthInput.blur();
    }
  });

  widthRow.appendChild(widthInput);
  chamferSection.appendChild(widthRow);
  chamferSection.appendChild(widthSlider);

  const segRow = controlRow('Segments');
  const segValue = el('span', 'control-value', '1');
  const segSlider = slider(1, 8, 1, 1);
  segSlider.disabled = true;
  segRow.style.opacity = '0.5';

  segSlider.addEventListener('input', () => {
    const v = parseInt(segSlider.value);
    segValue.textContent = `${v}`;
    callbacks.onSegmentsChange(v);
  });
  segRow.appendChild(segValue);
  chamferSection.appendChild(segRow);
  chamferSection.appendChild(segSlider);

  profileBtns.forEach((btn, idx) => {
    btn.addEventListener('click', () => {
      profileBtns.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      const p = profileValues[idx];
      if (p === 'chamfer') {
        segSlider.value = 1;
        segValue.textContent = '1';
        segSlider.disabled = true;
        segRow.style.opacity = '0.5';
      } else if (p === 'hybrid') {
        segSlider.value = Math.max(3, parseInt(segSlider.value) || 4);
        segValue.textContent = segSlider.value;
        segSlider.disabled = false;
        segRow.style.opacity = '1';
      } else {
        segSlider.value = Math.max(2, parseInt(segSlider.value) || 4);
        segValue.textContent = segSlider.value;
        segSlider.disabled = false;
        segRow.style.opacity = '1';
      }
      if (callbacks.onProfileChange) {
        callbacks.onProfileChange(p, parseInt(segSlider.value));
      }
    });
    profileGroup.appendChild(btn);
  });

  const previewToggleRow = toggleRow('Preview', false);
  previewToggleRow
    .querySelector('input')
    .addEventListener('change', (e) => callbacks.onPreviewToggle(e.target.checked));
  chamferSection.appendChild(previewToggleRow);

  const applyBtn = button('Apply Chamfer', 'btn-success');
  applyBtn.id = 'apply-chamfer-btn';
  applyBtn.style.marginTop = '6px';
  applyBtn.addEventListener('click', () => callbacks.onApplyChamfer());
  chamferSection.appendChild(applyBtn);

  // Undo / Redo history buttons
  const historyRow = el('div', 'selection-btn-row');
  historyRow.style.marginTop = '6px';
  const undoBtn = button('↩ Undo (Ctrl+Z)', 'btn-secondary btn-small');
  undoBtn.id = 'undo-btn';
  undoBtn.disabled = true;
  undoBtn.title = 'Undo last modification (Ctrl+Z)';
  undoBtn.addEventListener('click', () => callbacks.onUndo && callbacks.onUndo());

  const redoBtn = button('↪ Redo (Ctrl+Y)', 'btn-secondary btn-small');
  redoBtn.id = 'redo-btn';
  redoBtn.disabled = true;
  redoBtn.title = 'Redo modification (Ctrl+Y)';
  redoBtn.addEventListener('click', () => callbacks.onRedo && callbacks.onRedo());

  historyRow.appendChild(undoBtn);
  historyRow.appendChild(redoBtn);
  chamferSection.appendChild(historyRow);

  const resetRow = el('div', 'selection-btn-row');
  resetRow.style.marginTop = '5px';
  const resetBtn = button('↺ Reset to Original', 'btn-secondary btn-small');
  resetBtn.id = 'reset-model-btn';
  resetBtn.disabled = true;
  resetBtn.title = 'Revert mesh back to initial imported state (undoable)';
  resetBtn.addEventListener('click', () => callbacks.onReset && callbacks.onReset());
  resetRow.appendChild(resetBtn);
  chamferSection.appendChild(resetRow);

  // Auto-Fix Holes & Issues toggle (runs MeshFixer automatically after chamfering if issues remain)
  const autoFixRow = toggleRow('Auto-Fix Holes & Issues', true);
  autoFixRow.title = 'Automatically run MeshFixer after chamfering when open edges or holes are detected';
  const autoFixInput = autoFixRow.querySelector('input');
  autoFixInput.addEventListener('change', () => {
    if (callbacks.onAutoFixToggle) callbacks.onAutoFixToggle(autoFixInput.checked);
  });
  chamferSection.appendChild(autoFixRow);

  // Remove Unconnected Parts toggle (removes broken shards and loose floating debris)
  const removeUnconnectedRow = toggleRow('Remove Unconnected Parts', true);
  removeUnconnectedRow.title = 'Detect and remove broken shards or small unconnected debris during repair & chamfering';
  const removeUnconnectedInput = removeUnconnectedRow.querySelector('input');
  removeUnconnectedInput.addEventListener('change', () => {
    if (callbacks.onRemoveUnconnectedToggle) callbacks.onRemoveUnconnectedToggle(removeUnconnectedInput.checked);
  });
  chamferSection.appendChild(removeUnconnectedRow);

  const healthBanner = el('div', 'mesh-health-banner');
  healthBanner.id = 'mesh-health-banner';
  healthBanner.textContent = 'Mesh status: -';
  chamferSection.appendChild(healthBanner);

  const fixerRow = el('div', 'selection-btn-row');
  fixerRow.style.marginTop = '5px';
  const meshFixerBtn = button('🔧 Run MeshFixer', 'btn-secondary btn-small');
  meshFixerBtn.id = 'mesh-fixer-btn';
  meshFixerBtn.disabled = true;
  meshFixerBtn.title = 'Seal holes, stitch open seams, remove degenerate triangles & fix normals (undoable)';
  meshFixerBtn.addEventListener('click', () => callbacks.onRunMeshFixer && callbacks.onRunMeshFixer());
  fixerRow.appendChild(meshFixerBtn);

  const cleanPartsBtn = button('🧹 Clean Loose Parts', 'btn-secondary btn-small');
  cleanPartsBtn.id = 'clean-parts-btn';
  cleanPartsBtn.disabled = true;
  cleanPartsBtn.title = 'Remove broken shards and unconnected loose mesh components (undoable)';
  cleanPartsBtn.addEventListener('click', () => callbacks.onCleanUnconnectedParts && callbacks.onCleanUnconnectedParts());
  fixerRow.appendChild(cleanPartsBtn);
  chamferSection.appendChild(fixerRow);

  sidebar.appendChild(chamferSection);

  // ============ VIEW section ============
  const viewSection = section('View & Orientation');

  const wireToggle = toggleRow('Wireframe', false);
  wireToggle
    .querySelector('input')
    .addEventListener('change', (e) => callbacks.onWireframeToggle(e.target.checked));
  viewSection.appendChild(wireToggle);

  const gridToggle = toggleRow('Grid', false);
  gridToggle
    .querySelector('input')
    .addEventListener('change', (e) => callbacks.onGridToggle(e.target.checked));
  viewSection.appendChild(gridToggle);

  const axesToggle = toggleRow('Axes', false);
  axesToggle
    .querySelector('input')
    .addEventListener('change', (e) => callbacks.onAxesToggle(e.target.checked));
  viewSection.appendChild(axesToggle);

  const edgeHighlightToggle = toggleRow('Edge Highlight', true);
  edgeHighlightToggle
    .querySelector('input')
    .addEventListener('change', (e) =>
      callbacks.onEdgeHighlightToggle(e.target.checked)
    );
  viewSection.appendChild(edgeHighlightToggle);

  // Recenter & Rotation Tools
  const alignLabel = el('div', 'section-header', 'Model Transform');
  alignLabel.style.marginTop = '10px';
  alignLabel.style.marginBottom = '6px';
  viewSection.appendChild(alignLabel);

  const recenterBtn = button('Center & Reset View', 'btn-secondary btn-small');
  recenterBtn.addEventListener('click', () => callbacks.onRecenter && callbacks.onRecenter());
  viewSection.appendChild(recenterBtn);

  const rotRow = el('div', 'selection-btn-row');
  rotRow.style.marginTop = '5px';
  const rotXBtn = button('Rot X 90°', 'btn-secondary btn-small');
  rotXBtn.addEventListener('click', () => callbacks.onRotate && callbacks.onRotate('x'));
  const rotYBtn = button('Rot Y 90°', 'btn-secondary btn-small');
  rotYBtn.addEventListener('click', () => callbacks.onRotate && callbacks.onRotate('y'));
  const rotZBtn = button('Rot Z 90°', 'btn-secondary btn-small');
  rotZBtn.addEventListener('click', () => callbacks.onRotate && callbacks.onRotate('z'));
  rotRow.appendChild(rotXBtn);
  rotRow.appendChild(rotYBtn);
  rotRow.appendChild(rotZBtn);
  viewSection.appendChild(rotRow);

  sidebar.appendChild(viewSection);

  // ============ INFO section ============
  const infoSection = section('Info');
  infoSection.innerHTML += `
    <div class="info-row"><span>Dimensions</span><span class="info-value" id="info-dimensions">-</span></div>
    <div class="info-row"><span>Triangles</span><span class="info-value" id="info-triangles">0</span></div>
    <div class="info-row"><span>Vertices</span><span class="info-value" id="info-vertices">0</span></div>
    <div class="info-row"><span>Edges</span><span class="info-value" id="info-edges">0</span></div>
    <div class="info-row"><span>Mesh Health</span><span class="info-value" id="info-mesh-health">-</span></div>
  `;
  sidebar.appendChild(infoSection);

  // ---- Public helpers ----
  function setWidth(val, maxVal = 1.0) {
    const v = parseFloat(val);
    const newMin = Math.min(0.1, v);
    const newMax = Math.max(maxVal, v);
    widthSlider.min = newMin;
    widthSlider.max = newMax;
    widthSlider.step = computeSliderStep(newMin, v);
    widthSlider.value = v;
    widthInput.value = Number(v.toFixed(3)).toString();
  }

  function updateInfo(info) {
    const dimEl = document.getElementById('info-dimensions');
    const triEl = document.getElementById('info-triangles');
    const vertEl = document.getElementById('info-vertices');
    const edgeEl = document.getElementById('info-edges');
    if (dimEl && info.dimensions) dimEl.textContent = info.dimensions;
    if (triEl) triEl.textContent = info.triangles.toLocaleString();
    if (vertEl) vertEl.textContent = info.vertices.toLocaleString();
    if (edgeEl) edgeEl.textContent = info.edges.toLocaleString();
  }

  return { updateInfo, fileInput, setWidth, setUndoRedoState };
}

/**
 * Update the Undo/Redo button states.
 */
export function setUndoRedoState(canUndo, canRedo, undoCount = 0, redoCount = 0, canReset = false) {
  const undoBtn = document.getElementById('undo-btn');
  const redoBtn = document.getElementById('redo-btn');
  const resetBtn = document.getElementById('reset-model-btn');
  if (undoBtn) {
    undoBtn.disabled = !canUndo;
    undoBtn.textContent = undoCount > 0 ? `↩ Undo (${undoCount})` : '↩ Undo (Ctrl+Z)';
    undoBtn.title = canUndo ? `Undo last modification (Ctrl+Z) [${undoCount} available]` : 'Undo (Ctrl+Z)';
  }
  if (redoBtn) {
    redoBtn.disabled = !canRedo;
    redoBtn.textContent = redoCount > 0 ? `↪ Redo (${redoCount})` : '↪ Redo (Ctrl+Y)';
    redoBtn.title = canRedo ? `Redo modification (Ctrl+Y) [${redoCount} available]` : 'Redo (Ctrl+Y)';
  }
  if (resetBtn) {
    resetBtn.disabled = !canReset;
  }
}

/**
 * Update the detected and selected edge count display, including filtered edge status.
 */
export function updateEdgeCount(detected, selected, filteredCount = 0) {
  const el = document.getElementById('edge-count');
  if (el) {
    if (filteredCount > 0) {
      el.innerHTML = `${(detected || 0).toLocaleString()} <span class="filter-count-badge" title="${filteredCount.toLocaleString()} tiny/collinear edges filtered or combined">(-${filteredCount.toLocaleString()})</span>`;
    } else {
      el.textContent = (detected || 0).toLocaleString();
    }
  }
  const selEl = document.getElementById('selected-edge-count');
  if (selEl) {
    const selCount = selected !== undefined ? selected : detected;
    selEl.textContent = `${(selCount || 0).toLocaleString()} / ${(detected || 0).toLocaleString()}`;
  }
}

export function updateMeshHealth(stats) {
  const infoEl = document.getElementById('info-mesh-health');
  const bannerEl = document.getElementById('mesh-health-banner');
  const btnEl = document.getElementById('mesh-fixer-btn');
  const cleanBtnEl = document.getElementById('clean-parts-btn');

  if (!stats) {
    if (infoEl) {
      infoEl.textContent = '-';
      infoEl.style.color = '';
    }
    if (bannerEl) {
      bannerEl.classList.remove('health-ok', 'health-warn');
      bannerEl.textContent = 'Mesh status: -';
    }
    for (const b of [btnEl, cleanBtnEl]) {
      if (b) {
        b.disabled = true;
        b.classList.remove('btn-warning');
        b.classList.add('btn-secondary');
      }
    }
    return;
  }

  if (btnEl) btnEl.disabled = false;
  if (cleanBtnEl) cleanBtnEl.disabled = false;

  if (stats.isWatertight) {
    if (infoEl) {
      infoEl.textContent = 'Watertight ✓';
      infoEl.style.color = 'var(--success)';
    }
    if (bannerEl) {
      bannerEl.classList.remove('health-warn');
      bannerEl.classList.add('health-ok');
      bannerEl.textContent = '✓ Watertight manifold mesh (0 issues)';
    }
    for (const b of [btnEl, cleanBtnEl]) {
      if (b) {
        b.classList.remove('btn-warning');
        b.classList.add('btn-secondary');
      }
    }
    return;
  }

  const shortParts = [];
  const detailParts = [];
  if (stats.holeLoops > 0) {
    shortParts.push(`${stats.holeLoops} ${stats.holeLoops === 1 ? 'hole' : 'holes'}`);
    detailParts.push(`${stats.holeLoops} hole loop${stats.holeLoops > 1 ? 's' : ''}`);
  } else if (stats.openEdges > 0) {
    shortParts.push(`${stats.openEdges} open`);
  }
  if (stats.openEdges > 0) {
    detailParts.push(`${stats.openEdges} open edge${stats.openEdges > 1 ? 's' : ''}`);
  }
  if (stats.nonManifoldEdges > 0) {
    shortParts.push(`${stats.nonManifoldEdges} non-man.`);
    detailParts.push(`${stats.nonManifoldEdges} non-manifold`);
  }
  if (stats.degenerateTriangles > 0) {
    shortParts.push(`${stats.degenerateTriangles} deg.`);
    detailParts.push(`${stats.degenerateTriangles} degenerate`);
  }
  if (stats.disconnectedParts > 0) {
    shortParts.push(`${stats.disconnectedParts} loose`);
    detailParts.push(
      `${stats.disconnectedParts} unconnected part${stats.disconnectedParts > 1 ? 's' : ''}`
    );
  }

  if (infoEl) {
    infoEl.textContent = shortParts.join(', ') || `${stats.issueCount} issues`;
    infoEl.style.color = 'var(--accent-orange)';
  }
  if (bannerEl) {
    bannerEl.classList.remove('health-ok');
    bannerEl.classList.add('health-warn');
    bannerEl.textContent = `⚠ Issues: ${detailParts.join(' · ') || `${stats.issueCount} found`}`;
  }
  if (btnEl) {
    btnEl.classList.remove('btn-secondary');
    btnEl.classList.add('btn-warning');
  }
  if (cleanBtnEl) {
    const hasLoose = (stats.disconnectedParts || 0) > 0;
    cleanBtnEl.classList.toggle('btn-warning', hasLoose);
    cleanBtnEl.classList.toggle('btn-secondary', !hasLoose);
  }
}

/**
 * Toggle the viewport processing overlay and button busy states.
 * @param {boolean} active
 * @param {string} [title]
 * @param {string} [detail]
 * @param {string} [activeBtnId] - 'apply-chamfer-btn' | 'mesh-fixer-btn'
 */
export function setProcessingState(
  active,
  title = 'Processing Mesh...',
  detail = 'Computing geometry...',
  activeBtnId = ''
) {
  const overlay = document.getElementById('processing-overlay');
  const titleEl = document.getElementById('processing-title');
  const detailEl = document.getElementById('processing-detail');

  if (overlay) {
    overlay.classList.toggle('visible', Boolean(active));
    overlay.setAttribute('aria-busy', active ? 'true' : 'false');
  }
  if (titleEl && title) titleEl.textContent = title;
  if (detailEl && detail !== undefined) detailEl.textContent = detail;

  const applyBtn = document.getElementById('apply-chamfer-btn');
  const secondaryBtns = [
    { id: 'mesh-fixer-btn', busyLabel: 'Fixing Mesh...', defaultLabel: '🔧 Run MeshFixer' },
    { id: 'clean-parts-btn', busyLabel: 'Cleaning...', defaultLabel: '🧹 Clean Loose Parts' },
  ];

  if (active) {
    if (applyBtn) {
      applyBtn.disabled = true;
      if (activeBtnId === 'apply-chamfer-btn') {
        applyBtn.classList.add('is-busy');
        applyBtn.innerHTML = '<span class="btn-spinner" aria-hidden="true"></span>Applying...';
      }
    }
    for (const item of secondaryBtns) {
      const btn = document.getElementById(item.id);
      if (!btn) continue;
      if (btn.dataset.prevDisabled === undefined) {
        btn.dataset.prevDisabled = btn.disabled ? '1' : '0';
      }
      btn.disabled = true;
      if (activeBtnId === item.id) {
        btn.classList.add('is-busy');
        btn.innerHTML = `<span class="btn-spinner" aria-hidden="true"></span>${item.busyLabel}`;
      }
    }
  } else {
    if (applyBtn) {
      applyBtn.disabled = false;
      applyBtn.classList.remove('is-busy');
      applyBtn.textContent = 'Apply Chamfer';
    }
    for (const item of secondaryBtns) {
      const btn = document.getElementById(item.id);
      if (!btn) continue;
      btn.classList.remove('is-busy');
      if (btn.dataset.prevDisabled !== undefined) {
        btn.disabled = btn.dataset.prevDisabled === '1';
        delete btn.dataset.prevDisabled;
      }
      if (!btn.textContent.includes(item.defaultLabel.slice(2).trim())) {
        btn.textContent = item.defaultLabel;
      }
    }
  }
}

// ---- DOM helpers ----

function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text) e.textContent = text;
  return e;
}

function section(title) {
  const div = el('div', 'section');
  const header = el('div', 'section-header', title);
  div.appendChild(header);
  return div;
}

function controlRow(label) {
  const row = el('div', 'control-row');
  const lbl = el('span', 'control-label', label);
  row.appendChild(lbl);
  return row;
}

function slider(min, max, value, step) {
  const input = document.createElement('input');
  input.type = 'range';
  input.min = min;
  input.max = max;
  input.value = value;
  input.step = step;
  return input;
}

function button(text, className) {
  const btn = document.createElement('button');
  btn.textContent = text;
  btn.className = className || '';
  return btn;
}

function toggleRow(label, checked) {
  const row = el('div', 'toggle-row');
  const lbl = el('span', 'control-label', label);
  row.appendChild(lbl);

  const sw = el('label', 'toggle-switch');
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = checked;
  const sliderDiv = el('span', 'toggle-slider');
  sw.appendChild(input);
  sw.appendChild(sliderDiv);
  row.appendChild(sw);

  return row;
}
