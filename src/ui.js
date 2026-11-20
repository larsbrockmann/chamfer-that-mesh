/* ============================================================
   ui.js — Build the sidebar UI panel
   ============================================================ */
import { SIMPLIFY_PRESETS } from './meshSimplifier.js';

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
 * @property {() => void} onRunMeshFixer
 * @property {() => void} onCleanUnconnectedParts
 * @property {() => void} onToggleLoosePartsPreview
 * @property {() => void} onSimplifyMesh
 * @property {(mode: 'solid' | 'mesh' | 'wire') => void} onShadingModeChange
 * @property {(rotationCenter: boolean) => void} onRotationCenterToggle
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

  // ---- Mobile sheet handle & Title ----
  const sheetHandle = document.createElement('button');
  sheetHandle.type = 'button';
  sheetHandle.id = 'mobile-sheet-handle';
  sheetHandle.className = 'mobile-sheet-handle';
  sheetHandle.setAttribute('aria-label', 'Toggle controls panel');
  sheetHandle.setAttribute('aria-expanded', 'true');
  sheetHandle.setAttribute('aria-controls', 'sidebar');
  sidebar.appendChild(sheetHandle);

  const headerRow = el('div', 'sidebar-header-row');
  const brand = el('div', 'sidebar-brand');
  const title = el('div', 'sidebar-title', '⚡ Chamfer That Mesh');
  const subtitle = el('div', 'sidebar-subtitle', 'Best-Guess STL / 3MF Post-Processor');
  brand.appendChild(title);
  brand.appendChild(subtitle);
  headerRow.appendChild(brand);

  const sheetToggleBtn = document.createElement('button');
  sheetToggleBtn.type = 'button';
  sheetToggleBtn.id = 'mobile-sheet-toggle-btn';
  sheetToggleBtn.className = 'mobile-sheet-toggle-btn';
  sheetToggleBtn.textContent = '✕ Hide';
  sheetToggleBtn.title = 'Hide controls panel to view 3D model full-screen';
  sheetToggleBtn.setAttribute('aria-expanded', 'true');
  sheetToggleBtn.setAttribute('aria-controls', 'sidebar');
  headerRow.appendChild(sheetToggleBtn);

  const disclaimer = el(
    'div',
    'sidebar-disclaimer',
    '⚠ Mesh post-processing: operates on raw STL/3MF triangles. Outcomes may come out imprecise or broken on complex geometry.'
  );
  disclaimer.id = 'sidebar-disclaimer';
  sidebar.appendChild(headerRow);
  sidebar.appendChild(disclaimer);

  const appEl = document.getElementById('app');
  const viewportEl = document.getElementById('viewport');
  let mobilePanelToggle = document.getElementById('mobile-panel-toggle');
  if (!mobilePanelToggle && viewportEl) {
    mobilePanelToggle = document.createElement('button');
    mobilePanelToggle.type = 'button';
    mobilePanelToggle.id = 'mobile-panel-toggle';
    mobilePanelToggle.className = 'mobile-panel-toggle';
    mobilePanelToggle.setAttribute('aria-controls', 'sidebar');
    viewportEl.appendChild(mobilePanelToggle);
  }

  function setSidebarCollapsed(collapsed) {
    if (appEl) {
      appEl.classList.toggle('sidebar-collapsed', collapsed);
    }
    const expandedStr = collapsed ? 'false' : 'true';
    sheetHandle.setAttribute('aria-expanded', expandedStr);
    sheetToggleBtn.setAttribute('aria-expanded', expandedStr);
    if (mobilePanelToggle) {
      mobilePanelToggle.setAttribute('aria-expanded', expandedStr);
      mobilePanelToggle.textContent = collapsed ? '⚙ Controls' : '▼ Hide Controls';
      mobilePanelToggle.classList.toggle('is-collapsed', collapsed);
    }
  }

  setSidebarCollapsed(Boolean(appEl && appEl.classList.contains('sidebar-collapsed')));

  const toggleSidebar = () => {
    const isCollapsed = appEl ? appEl.classList.contains('sidebar-collapsed') : false;
    setSidebarCollapsed(!isCollapsed);
  };

  sheetHandle.addEventListener('click', toggleSidebar);
  sheetToggleBtn.addEventListener('click', toggleSidebar);
  if (mobilePanelToggle) {
    mobilePanelToggle.onclick = toggleSidebar;
  }

  // ---- Desktop Sidebar Resizer ----
  const SIDEBAR_WIDTH_STORAGE_KEY = 'chamfer_sidebar_width';
  let resizer = document.getElementById('sidebar-resizer');
  if (!resizer && appEl && sidebar) {
    resizer = document.createElement('div');
    resizer.id = 'sidebar-resizer';
    resizer.className = 'sidebar-resizer';
    resizer.setAttribute('role', 'separator');
    resizer.setAttribute('aria-orientation', 'vertical');
    resizer.setAttribute('aria-label', 'Resize settings panel');
    resizer.tabIndex = 0;
    resizer.title = 'Drag to resize settings panel (double-click to reset)';
    sidebar.insertAdjacentElement('afterend', resizer);
  }

  const getMaxSidebarWidth = () =>
    Math.max(320, Math.min(720, Math.floor(window.innerWidth * 0.6)));
  const clampSidebarWidth = (w) =>
    Math.max(240, Math.min(getMaxSidebarWidth(), Math.round(w)));

  const applySidebarWidth = (w) => {
    const clamped = clampSidebarWidth(w);
    document.documentElement.style.setProperty('--sidebar-width', `${clamped}px`);
    if (resizer) {
      resizer.setAttribute('aria-valuemin', '240');
      resizer.setAttribute('aria-valuemax', String(getMaxSidebarWidth()));
      resizer.setAttribute('aria-valuenow', String(clamped));
    }
    return clamped;
  };

  try {
    const savedWidth = parseFloat(localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY));
    if (Number.isFinite(savedWidth) && savedWidth > 0) {
      applySidebarWidth(savedWidth);
    }
  } catch {
    // Ignore storage errors in restricted environments
  }

  if (resizer) {
    let activePointerId = null;

    const finishResize = (saveWidth) => {
      if (activePointerId === null) return;
      if (resizer.hasPointerCapture && resizer.hasPointerCapture(activePointerId)) {
        resizer.releasePointerCapture(activePointerId);
      }
      activePointerId = null;
      resizer.classList.remove('is-resizing');
      document.body.classList.remove('is-resizing-sidebar');
      if (saveWidth) {
        const currentWidth = Math.round(sidebar.getBoundingClientRect().width);
        try {
          localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(clampSidebarWidth(currentWidth)));
        } catch {
          // Ignore storage errors
        }
      }
    };

    resizer.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      e.preventDefault();
      activePointerId = e.pointerId;
      if (resizer.setPointerCapture) {
        resizer.setPointerCapture(e.pointerId);
      }
      resizer.classList.add('is-resizing');
      document.body.classList.add('is-resizing-sidebar');
    });

    resizer.addEventListener('pointermove', (e) => {
      if (activePointerId === null || e.pointerId !== activePointerId) return;
      const sidebarLeft = sidebar.getBoundingClientRect().left;
      applySidebarWidth(e.clientX - sidebarLeft);
    });

    resizer.addEventListener('pointerup', (e) => {
      if (e.pointerId !== activePointerId) return;
      finishResize(true);
    });

    resizer.addEventListener('pointercancel', (e) => {
      if (e.pointerId !== activePointerId) return;
      finishResize(false);
    });

    resizer.addEventListener('dblclick', () => {
      document.documentElement.style.removeProperty('--sidebar-width');
      resizer.removeAttribute('aria-valuenow');
      try {
        localStorage.removeItem(SIDEBAR_WIDTH_STORAGE_KEY);
      } catch {
        // Ignore storage errors
      }
    });

    resizer.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      const delta = e.key === 'ArrowRight' ? 16 : -16;
      const currentWidth = sidebar.getBoundingClientRect().width;
      const nextWidth = applySidebarWidth(currentWidth + delta);
      try {
        localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(nextWidth));
      } catch {
        // Ignore storage errors
      }
    });
  }

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
    <option value="" disabled>Select a demo or test model...</option>
    <optgroup label="Built-in Demo Shapes">
      <option value="./models/stepped_pyramid.stl">Pyramid (Stepped)</option>
      <option value="./models/hex_nut.stl" selected>Hex Nut</option>
      <option value="./models/spur_gear.stl">Tooth Gear</option>
    </optgroup>
    <optgroup label="Test Library">
      <option value="./models/test-library/metabo_base.3mf">Metabo Base (Complex 3MF)</option>
      <option value="./models/test-library/pcb_mount.stl">PCB Mount</option>
      <option value="./models/test-library/microfit_panel_mount.stl">MicroFit 3.0 Panel Mount</option>
      <option value="./models/test-library/klipper_expander_2020_mount.stl">Klipper Expander 2020 Mount</option>
      <option value="./models/test-library/iec320_c14_panel_insert.stl">IEC320 C14 Panel Insert</option>
      <option value="./models/test-library/parametric_cable_clip.stl">Parametric Cable Clip</option>
      <option value="./models/test-library/nail_cable_clip.stl">Nail Cable Clip (4mm)</option>
      <option value="./models/test-library/desk_cable_clip.stl">Desk Cable Clip</option>
      <option value="./models/test-library/remote_wall_mount.stl">Remote Wall Mount</option>
      <option value="./models/test-library/parametric_washer_spacer.stl">Washer / Spacer (16x6x3)</option>
      <option value="./models/test-library/jointmaster_spacer.stl">JointMaster 5/16 Spacer</option>
      <option value="./models/test-library/s_hook.stl">S-Hook</option>
      <option value="./models/test-library/skadis_t_nut_m3.stl">Skadis M3 T-Nut Insert</option>
      <option value="./models/test-library/hsw_box_holder_frame.stl">HSW Box Holder Frame</option>
      <option value="./models/test-library/gridfinity_ruler_holder.stl">Gridfinity Ruler Holder</option>
      <option value="./models/test-library/l_bracket_extension.stl">L-Bracket Extension</option>
      <option value="./models/test-library/spanner_wrench_rail.stl">Spanner Wrench Rail</option>
      <option value="./models/test-library/parametric_wrench.stl">Parametric Box Wrench</option>
      <option value="./models/test-library/french_cleat_clamp.stl">French Cleat Clamp Hanger</option>
      <option value="./models/test-library/din_rail_35mm.stl">DIN Rail (35mm)</option>
      <option value="./models/test-library/box_clip_clamp.stl">Vegetable Box Clip Clamp</option>
      <option value="./models/test-library/rod_clamp_m3.stl">RepRack M3 Rod Clamp</option>
      <option value="./models/test-library/box_lid_clamp.stl">Box Lid Clamp</option>
      <option value="./models/test-library/snap_clamp_connector.stl">Snap Clamp Connector</option>
      <option value="./models/test-library/dowel_drill_jig.stl">2x4 Dowel Drill Jig</option>
      <option value="./models/test-library/router_slot_jig.stl">Router Slot Copy Ring Jig</option>
      <option value="./models/test-library/melzi_adapter_plate.stl">Melzi Controller Adapter Plate</option>
      <option value="./models/test-library/riser_stand_foot.stl">Square Riser Stand Foot</option>
      <option value="./models/test-library/lcd2004_desk_stand.stl">LCD2004 Desk Stand</option>
      <option value="./models/test-library/mini_floor_stand.stl">Mini Floor Stand</option>
      <option value="./models/test-library/gridfinity_open_bin_1x1.stl">Gridfinity Open-End Bin (1x1x3)</option>
      <option value="./models/test-library/proto_board_corner_connector.stl">Prototyping Board Corner Connector</option>
      <option value="./models/test-library/corner_cable_clip.stl">Corner Cable Clip</option>
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
  const angleActions = el('div', 'control-row-actions');

  const autoAngleBtn = document.createElement('button');
  autoAngleBtn.type = 'button';
  autoAngleBtn.id = 'btn-auto-angle';
  autoAngleBtn.className = 'btn-auto-angle';
  autoAngleBtn.innerHTML = '✨ Auto';
  autoAngleBtn.title = 'Auto-detect optimal angle threshold for this model';
  autoAngleBtn.setAttribute('aria-label', 'Auto-detect optimal angle threshold');
  autoAngleBtn.addEventListener('click', () => {
    if (callbacks.onAutoAngle) callbacks.onAutoAngle();
  });

  const angleValue = el('span', 'control-value', '30°');
  angleValue.id = 'angle-value';

  angleActions.appendChild(autoAngleBtn);
  angleActions.appendChild(angleValue);
  angleRow.appendChild(angleActions);

  const angleSlider = slider(0, 180, 30, 1);
  angleSlider.id = 'angle-slider';
  angleSlider.addEventListener('input', () => {
    const v = parseFloat(angleSlider.value);
    angleValue.textContent = `${v}°`;
    callbacks.onAngleChange(v);
  });
  edgeSection.appendChild(angleRow);
  edgeSection.appendChild(angleSlider);

  // Convex Edges Only toggle
  const convexRow = toggleRow('Convex Edges Only', true);
  const convexInput = convexRow.querySelector('input');
  convexInput.addEventListener('change', () => {
    if (callbacks.onConvexOnlyToggle) callbacks.onConvexOnlyToggle(convexInput.checked);
  });
  edgeSection.appendChild(convexRow);

  // Tiny Edge Filter toggle (automatic)
  const filterRow = toggleRow('Filter Tiny Edges', false, 'Experimental');
  filterRow.title = 'Experimental edge simplification: filters micro-segments on noisy or faceted meshes';
  const filterInput = filterRow.querySelector('input');
  edgeSection.appendChild(filterRow);

  // Filter options container (Action mode + Min Length)
  const filterOptionsContainer = el('div', 'filter-options-container');
  filterOptionsContainer.style.display = 'none';

  const filterNote = el(
    'div',
    'experimental-note',
    '⚠ <strong>Experimental:</strong> Simplifies micro-segments on noisy or faceted meshes. May break continuous loops on clean CAD models.'
  );
  filterOptionsContainer.appendChild(filterNote);

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

  // Selection buttons row 1: All / Clear / Invert
  const btnRow = el('div', 'selection-btn-row');
  const selectAllBtn = button('Select All', 'btn-secondary btn-small');
  selectAllBtn.title = 'Select all detected edges (Shortcut: A or Ctrl+A)';
  selectAllBtn.addEventListener('click', () => callbacks.onSelectAll && callbacks.onSelectAll());
  const selectNoneBtn = button('Clear', 'btn-secondary btn-small');
  selectNoneBtn.title = 'Deselect all edges (Shortcut: C)';
  selectNoneBtn.addEventListener('click', () => callbacks.onSelectNone && callbacks.onSelectNone());
  const invertBtn = button('Invert', 'btn-secondary btn-small');
  invertBtn.title = 'Invert selection state (Shortcut: I)';
  invertBtn.addEventListener('click', () => callbacks.onSelectInvert && callbacks.onSelectInvert());
  btnRow.appendChild(selectAllBtn);
  btnRow.appendChild(selectNoneBtn);
  btnRow.appendChild(invertBtn);
  edgeSection.appendChild(btnRow);

  // Selection shortcuts row 2: Horizontal / Vertical / Top & Bottom
  const shortcutRow = el('div', 'selection-btn-row');
  shortcutRow.style.marginTop = '4px';
  const horizontalBtn = button('Horizontal', 'btn-secondary btn-small');
  horizontalBtn.title = 'Select horizontal edges parallel to ground';
  horizontalBtn.addEventListener('click', () => callbacks.onSelectHorizontal && callbacks.onSelectHorizontal());
  const verticalBtn = button('Vertical', 'btn-secondary btn-small');
  verticalBtn.title = 'Select vertical edges perpendicular to ground';
  verticalBtn.addEventListener('click', () => callbacks.onSelectVertical && callbacks.onSelectVertical());
  const topBottomBtn = button('Top / Bottom', 'btn-secondary btn-small');
  topBottomBtn.title = 'Select topmost and bottommost edges';
  topBottomBtn.addEventListener('click', () => callbacks.onSelectTopBottom && callbacks.onSelectTopBottom());
  shortcutRow.appendChild(horizontalBtn);
  shortcutRow.appendChild(verticalBtn);
  shortcutRow.appendChild(topBottomBtn);
  edgeSection.appendChild(shortcutRow);

  // Selection mode: Smart (Edge Loop + Face) vs Single Edge
  const modeRow = el('div', 'control-row');
  modeRow.style.marginTop = '6px';
  const modeLbl = el('span', 'control-label', 'Click Mode');
  const modeGroup = el('div', 'segmented-control click-mode-group');
  modeGroup.id = 'click-mode-group';

  const smartRadio = document.createElement('button');
  smartRadio.textContent = 'Smart';
  smartRadio.className = 'segment-btn active';
  smartRadio.title = 'Click an edge for its chain loop, or click a face for all adjacent edges (Shortcut: M)';

  const singleRadio = document.createElement('button');
  singleRadio.textContent = 'Single Edge';
  singleRadio.className = 'segment-btn';
  singleRadio.title = 'Precision mode: click individual edge segments only; face picking is off (Shortcut: M)';

  const selectionModeBtns = {
    smart: smartRadio,
    single: singleRadio,
  };

  function setSelectionMode(mode) {
    const normalized = selectionModeBtns[mode] ? mode : 'smart';
    for (const [key, btn] of Object.entries(selectionModeBtns)) {
      btn.classList.toggle('active', key === normalized);
    }
    if (callbacks.onSelectionModeChange) {
      callbacks.onSelectionModeChange(normalized);
    }
  }

  smartRadio.addEventListener('click', () => setSelectionMode('smart'));
  singleRadio.addEventListener('click', () => setSelectionMode('single'));

  modeGroup.appendChild(smartRadio);
  modeGroup.appendChild(singleRadio);
  modeRow.appendChild(modeLbl);
  modeRow.appendChild(modeGroup);
  edgeSection.appendChild(modeRow);

  const helpHint = el('div', 'selection-hint');
  helpHint.innerHTML =
    '💡 <strong>Smart</strong>: click an edge for its loop, or a face for all its edges. Press <kbd>M</kbd> for Single Edge, <kbd>O</kbd> to toggle overlays.';
  edgeSection.appendChild(helpHint);

  // Color legend
  const legend = el('div', 'edge-legend');
  legend.innerHTML = `
    <div class="legend-item"><span class="legend-swatch swatch-selected"></span><span>Selected</span></div>
    <div class="legend-item"><span class="legend-swatch swatch-hovered-sel"></span><span>Hover (Deselect)</span></div>
    <div class="legend-item"><span class="legend-swatch swatch-unselected"></span><span>Unselected</span></div>
    <div class="legend-item"><span class="legend-swatch swatch-hovered-unsel"></span><span>Hover (Select)</span></div>
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
  hybridTypeBtn.title = 'Chamfer-Fillet Hybrid (Specialized): Flat 50% bevel flanked by tangent curved transition shoulders';

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
  const segSlider = slider(1, 12, 1, 1);
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
        const curSeg = parseInt(segSlider.value) || 1;
        segSlider.value = curSeg <= 2 ? 5 : Math.max(3, curSeg);
        segValue.textContent = segSlider.value;
        segSlider.disabled = false;
        segRow.style.opacity = '1';
      } else {
        const curSeg = parseInt(segSlider.value) || 1;
        segSlider.value = curSeg <= 2 ? 6 : Math.max(2, curSeg);
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
  const previewInput = previewToggleRow.querySelector('input');
  previewInput.id = 'preview-checkbox';
  previewInput.addEventListener('change', (e) => callbacks.onPreviewToggle(e.target.checked));
  chamferSection.appendChild(previewToggleRow);

  const applyBtn = button('Apply Chamfer', 'btn-success');
  applyBtn.id = 'apply-chamfer-btn';
  applyBtn.style.marginTop = '6px';
  applyBtn.addEventListener('click', () => callbacks.onApplyChamfer());
  chamferSection.appendChild(applyBtn);

  const stopBtn = button('⏹ Stop Operation (Esc)', 'btn-danger');
  stopBtn.id = 'stop-chamfer-btn';
  stopBtn.style.marginTop = '6px';
  stopBtn.style.display = 'none';
  stopBtn.title = 'Abort the running chamfer operation (Esc)';
  stopBtn.addEventListener('click', () => callbacks.onStopProcessing && callbacks.onStopProcessing());
  chamferSection.appendChild(stopBtn);

  const overlayStopBtn = document.getElementById('processing-stop-btn');
  if (overlayStopBtn) {
    overlayStopBtn.onclick = () => callbacks.onStopProcessing && callbacks.onStopProcessing();
  }

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
  const autoFixRow = toggleRow('Auto-Fix Holes & Issues', false);
  autoFixRow.title = 'Automatically run MeshFixer after chamfering when open edges or holes are detected';
  const autoFixInput = autoFixRow.querySelector('input');
  autoFixInput.addEventListener('change', () => {
    if (callbacks.onAutoFixToggle) callbacks.onAutoFixToggle(autoFixInput.checked);
  });
  chamferSection.appendChild(autoFixRow);

  // Remove Unconnected Parts toggle (removes broken shards and loose floating debris)
  const removeUnconnectedRow = toggleRow('Remove Unconnected Parts', false, 'Experimental');
  removeUnconnectedRow.title = 'Detect and remove broken shards or small unconnected debris during repair & chamfering';
  const removeUnconnectedInput = removeUnconnectedRow.querySelector('input');
  removeUnconnectedInput.addEventListener('change', () => {
    if (callbacks.onRemoveUnconnectedToggle) callbacks.onRemoveUnconnectedToggle(removeUnconnectedInput.checked);
  });
  chamferSection.appendChild(removeUnconnectedRow);

  const removeUnconnectedNote = el(
    'div',
    'experimental-note',
    '⚠ <strong>Experimental:</strong> Deletes floating debris during chamfering. May strip thin inner shells or sub-assemblies. Keep off for multi-part models.'
  );
  chamferSection.appendChild(removeUnconnectedNote);

  const healthBanner = el('div', 'mesh-health-banner');
  healthBanner.id = 'mesh-health-banner';
  healthBanner.textContent = 'Mesh status: -';
  chamferSection.appendChild(healthBanner);

  const fixerRow = el('div', 'selection-btn-row');
  fixerRow.style.marginTop = '5px';
  const meshFixerBtn = button('🔧 Run MeshFixer', 'btn-secondary btn-small');
  meshFixerBtn.id = 'mesh-fixer-btn';
  meshFixerBtn.disabled = true;
  meshFixerBtn.title = 'Heuristic mesh repair: seals holes, stitches open seams, removes degenerate triangles (undoable)';
  meshFixerBtn.addEventListener('click', () => callbacks.onRunMeshFixer && callbacks.onRunMeshFixer());
  fixerRow.appendChild(meshFixerBtn);

  // Combined Clean Parts & Preview Loose split button
  const cleanGroup = el('div', 'split-btn-group');

  const cleanPartsBtn = button('🧹 Clean Parts', 'btn-secondary btn-small');
  cleanPartsBtn.id = 'clean-parts-btn';
  cleanPartsBtn.disabled = true;
  cleanPartsBtn.title = 'Heuristic debris cleanup: removes disconnected islands < 5% mesh area (undoable)';
  cleanPartsBtn.addEventListener('click', () => callbacks.onCleanUnconnectedParts && callbacks.onCleanUnconnectedParts());
  cleanGroup.appendChild(cleanPartsBtn);

  const previewPartsBtn = button('👁', 'btn-secondary btn-small split-btn-addon');
  previewPartsBtn.id = 'preview-parts-btn';
  previewPartsBtn.disabled = true;
  previewPartsBtn.title = 'Toggle 3D preview of loose or unconnected parts';
  previewPartsBtn.setAttribute('aria-label', 'Toggle 3D preview of loose parts');
  previewPartsBtn.addEventListener('click', () => callbacks.onToggleLoosePartsPreview && callbacks.onToggleLoosePartsPreview());
  cleanGroup.appendChild(previewPartsBtn);

  fixerRow.appendChild(cleanGroup);
  chamferSection.appendChild(fixerRow);

  const optRow = el('div', 'selection-btn-row');
  optRow.style.marginTop = '5px';
  const simplifyBtn = button('⚡ Simplify Mesh', 'btn-secondary btn-small');
  simplifyBtn.id = 'simplify-mesh-btn';
  simplifyBtn.disabled = true;
  simplifyBtn.title = 'Reduce redundant triangles while preserving sharp edges and CAD precision (undoable)';
  simplifyBtn.addEventListener('click', () => callbacks.onSimplifyMesh && callbacks.onSimplifyMesh());
  optRow.appendChild(simplifyBtn);
  chamferSection.appendChild(optRow);

  sidebar.appendChild(chamferSection);

  // ============ VIEW section ============
  const viewSection = section('View & Orientation');

  const shadingRow = el('div', 'control-row');
  const shadingLbl = el('span', 'control-label', 'Shading');
  const shadingGroup = el('div', 'segmented-control');
  shadingGroup.id = 'shading-mode-group';

  const solidBtn = document.createElement('button');
  solidBtn.type = 'button';
  solidBtn.textContent = 'Solid';
  solidBtn.className = 'segment-btn';
  solidBtn.title = 'Clean shaded solid without base mesh lines';

  const meshBtn = document.createElement('button');
  meshBtn.type = 'button';
  meshBtn.textContent = 'Mesh';
  meshBtn.className = 'segment-btn active';
  meshBtn.title = 'Shaded solid with subtle mesh base wireframe and crease edges';

  const wireBtn = document.createElement('button');
  wireBtn.type = 'button';
  wireBtn.textContent = 'Wire';
  wireBtn.className = 'segment-btn';
  wireBtn.title = 'Full wireframe view';

  const shadingModeBtns = {
    solid: solidBtn,
    mesh: meshBtn,
    wire: wireBtn,
  };

  function setShadingMode(mode) {
    const normalized = shadingModeBtns[mode] ? mode : 'mesh';
    for (const [key, btn] of Object.entries(shadingModeBtns)) {
      btn.classList.toggle('active', key === normalized);
    }
    callbacks.onShadingModeChange?.(normalized);
  }

  solidBtn.addEventListener('click', () => setShadingMode('solid'));
  meshBtn.addEventListener('click', () => setShadingMode('mesh'));
  wireBtn.addEventListener('click', () => setShadingMode('wire'));

  shadingGroup.appendChild(solidBtn);
  shadingGroup.appendChild(meshBtn);
  shadingGroup.appendChild(wireBtn);
  shadingRow.appendChild(shadingLbl);
  shadingRow.appendChild(shadingGroup);
  viewSection.appendChild(shadingRow);

  const rotCenterToggle = toggleRow('Rotation Center', false);
  rotCenterToggle
    .querySelector('input')
    .addEventListener('change', (e) =>
      callbacks.onRotationCenterToggle && callbacks.onRotationCenterToggle(e.target.checked)
    );
  viewSection.appendChild(rotCenterToggle);

  const edgeHighlightToggle = toggleRow('Overlays (O)', true);
  edgeHighlightToggle.title = 'Toggle edge, face, and preview overlays (Shortcut: O)';
  const edgeHighlightInput = edgeHighlightToggle.querySelector('input');
  edgeHighlightInput.id = 'edge-highlight-checkbox';
  edgeHighlightInput.addEventListener('change', (e) =>
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

  // ============ KEYBOARD & MOUSE SHORTCUTS section ============
  const SHORTCUT_ENTRIES = [
    ['<kbd>M</kbd>', 'Mode: Smart / Single Edge'],
    ['<kbd>O</kbd>', 'Toggle Viewport Overlays'],
    ['<kbd>A</kbd> <kbd>C</kbd> <kbd>I</kbd>', 'Select All / Clear / Invert'],
    ['<kbd>Ctrl+Z</kbd> <kbd>Y</kbd>', 'Undo / Redo'],
    ['<kbd>L-Drag</kbd> / <kbd>R-Drag</kbd>', 'Orbit / Pan (Scroll Zoom)'],
    ['<kbd>Esc</kbd> / <kbd>?</kbd>', 'Stop / Shortcuts Help'],
  ];

  function createShortcutsGrid() {
    const grid = el('div', 'shortcuts-grid');
    grid.innerHTML = SHORTCUT_ENTRIES.map(
      ([keys, desc]) =>
        `<div class="shortcut-item"><div class="shortcut-keys">${keys}</div><div class="shortcut-desc">${desc}</div></div>`
    ).join('');
    return grid;
  }

  const shortcutsSection = section('Keyboard & Mouse Shortcuts');
  shortcutsSection.appendChild(createShortcutsGrid());
  sidebar.appendChild(shortcutsSection);

  // Floating viewport shortcut pill + expandable cheatsheet popover
  let shortcutsPopover = document.getElementById('viewport-shortcuts-popover');
  let shortcutsBar = document.getElementById('viewport-shortcuts-bar');
  const viewportHost = document.getElementById('viewport');
  if (viewportHost && !document.getElementById('viewport-shortcuts-widget')) {
    const widget = el('div', 'viewport-shortcuts-widget');
    widget.id = 'viewport-shortcuts-widget';

    shortcutsPopover = el('div', 'viewport-shortcuts-popover');
    shortcutsPopover.id = 'viewport-shortcuts-popover';
    shortcutsPopover.setAttribute('role', 'dialog');
    shortcutsPopover.setAttribute('aria-label', 'Keyboard and mouse shortcuts');

    const popHeader = el('div', 'viewport-shortcuts-header');
    popHeader.appendChild(el('span', '', 'Keyboard & Mouse Shortcuts'));
    const closeBtn = button('×', 'viewport-shortcuts-close');
    closeBtn.setAttribute('aria-label', 'Close shortcuts');
    closeBtn.addEventListener('click', () => toggleShortcutsPopover(false));
    popHeader.appendChild(closeBtn);
    shortcutsPopover.appendChild(popHeader);
    shortcutsPopover.appendChild(createShortcutsGrid());

    shortcutsBar = document.createElement('button');
    shortcutsBar.type = 'button';
    shortcutsBar.id = 'viewport-shortcuts-bar';
    shortcutsBar.className = 'viewport-shortcuts-bar';
    shortcutsBar.setAttribute('aria-expanded', 'false');
    shortcutsBar.setAttribute('aria-controls', 'viewport-shortcuts-popover');
    shortcutsBar.title = 'Click or press ? to view all keyboard and mouse shortcuts';
    shortcutsBar.innerHTML =
      '⌨ <kbd>M</kbd> Mode · <kbd>O</kbd> Overlays · <kbd>A</kbd><kbd>C</kbd><kbd>I</kbd> Select · <kbd>Ctrl+Z</kbd> Undo · <kbd>?</kbd>';
    shortcutsBar.addEventListener('click', () => toggleShortcutsPopover());

    widget.appendChild(shortcutsPopover);
    widget.appendChild(shortcutsBar);
    viewportHost.appendChild(widget);
  }

  function toggleShortcutsPopover(forceOpen) {
    if (!shortcutsPopover) return false;
    const isOpen =
      typeof forceOpen === 'boolean'
        ? forceOpen
        : !shortcutsPopover.classList.contains('open');
    shortcutsPopover.classList.toggle('open', isOpen);
    if (shortcutsBar) {
      shortcutsBar.setAttribute('aria-expanded', String(isOpen));
    }
    return isOpen;
  }

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

  function setAngle(angle) {
    const val = Math.round(angle);
    angleSlider.value = val;
    angleValue.textContent = `${val}°`;
  }

  return {
    updateInfo,
    fileInput,
    setWidth,
    setUndoRedoState,
    setAngle,
    setSelectionMode,
    setShadingMode,
    toggleShortcutsPopover,
  };
}

/**
 * Update angle threshold slider and display value in UI.
 */
export function setAngleThresholdUI(angle) {
  const sliderEl = document.getElementById('angle-slider');
  const valEl = document.getElementById('angle-value');
  const val = Math.round(angle);
  if (sliderEl) sliderEl.value = val;
  if (valEl) valEl.textContent = `${val}°`;
}

/**
 * Update the Preview toggle switch state in the UI.
 * @param {boolean} enabled
 */
export function setPreviewToggleUI(enabled) {
  const input = document.getElementById('preview-checkbox');
  if (input) input.checked = !!enabled;
}

/**
 * Update the Edge Highlight toggle switch state in the UI.
 * @param {boolean} enabled
 */
export function setEdgeHighlightToggleUI(enabled) {
  const input = document.getElementById('edge-highlight-checkbox');
  if (input) input.checked = !!enabled;
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

/**
 * Update the active toggle state of the Preview Loose Parts button.
 */
export function setLoosePartsPreviewActive(active) {
  const btn = document.getElementById('preview-parts-btn');
  if (!btn) return;
  if (active) {
    btn.classList.add('active');
    btn.title = 'Hide loose parts 3D preview';
  } else {
    btn.classList.remove('active');
    btn.title = 'Toggle 3D preview of loose or unconnected parts';
  }
}

/**
 * Update a secondary action button's enabled state and label without being
 * overwritten when an active `setProcessingState(true)` block ends.
 */
function applySecondaryBtnState(btn, disabled, label) {
  if (!btn) return;
  if (btn.dataset.prevDisabled !== undefined) {
    btn.dataset.prevDisabled = disabled ? '1' : '0';
    if (label !== undefined) {
      btn.dataset.prevLabel = label;
    }
  } else {
    btn.disabled = disabled;
    if (label !== undefined) {
      btn.textContent = label;
    }
  }
}

export function updateMeshHealth(stats) {
  const infoEl = document.getElementById('info-mesh-health');
  const bannerEl = document.getElementById('mesh-health-banner');
  const btnEl = document.getElementById('mesh-fixer-btn');
  const cleanBtnEl = document.getElementById('clean-parts-btn');
  const previewBtnEl = document.getElementById('preview-parts-btn');

  if (!stats) {
    if (infoEl) {
      infoEl.textContent = '-';
      infoEl.style.color = '';
    }
    if (bannerEl) {
      bannerEl.classList.remove('health-ok', 'health-warn');
      bannerEl.textContent = 'Mesh status: -';
    }
    for (const b of [btnEl, cleanBtnEl, previewBtnEl]) {
      if (b) {
        applySecondaryBtnState(b, true);
        b.classList.remove('btn-warning');
        b.classList.add('btn-secondary');
      }
    }
    return;
  }

  applySecondaryBtnState(btnEl, false);
  applySecondaryBtnState(cleanBtnEl, false);
  applySecondaryBtnState(previewBtnEl, false);

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
 * Update the sidebar Optimize / Simplify Mesh button state and badge.
 * @param {object|null} optInfo
 */
export function updateOptimizationBanner(optInfo) {
  const btn = document.getElementById('simplify-mesh-btn');
  if (!btn) return;
  if (!optInfo || optInfo.triCount < 12) {
    applySecondaryBtnState(btn, true, '⚡ Simplify Mesh');
    btn.classList.remove('btn-optimize-suggested');
    btn.classList.add('btn-secondary');
    btn.title = 'Reduce redundant triangles while preserving sharp edges and CAD precision (undoable)';
    return;
  }
  if (optInfo.isUnoptimized) {
    btn.classList.remove('btn-secondary');
    btn.classList.add('btn-optimize-suggested');
    applySecondaryBtnState(btn, false, `⚡ Simplify Mesh (~${optInfo.estimatedReductionPct}% lighter)`);
    btn.title = `${optInfo.reason} — Click to simplify cleanly`;
  } else {
    btn.classList.remove('btn-optimize-suggested');
    btn.classList.add('btn-secondary');
    applySecondaryBtnState(btn, false, '⚡ Simplify Mesh');
    btn.title = `${optInfo.triCount.toLocaleString()} tris (${optInfo.coplanarPct.toFixed(1)}% flat) — Click to simplify cleanly`;
  }
}

/**
 * Show the interactive Unoptimized Mesh / Simplify modal and resolve with user choice.
 *
 * @param {object} info
 * @param {object} [options]
 * @param {'import'|'manual'} [options.mode='import']
 * @returns {Promise<{ action: 'simplify' | 'keep', presetId: string, tolerance: number }>}
 */
export function showSimplifyModal(info, options = {}) {
  const modal = document.getElementById('simplify-modal');
  const titleEl = document.getElementById('simplify-modal-title');
  const subtitleEl = document.getElementById('simplify-modal-subtitle');
  const statsEl = document.getElementById('simplify-modal-stats');
  const presetListEl = document.getElementById('simplify-preset-list');
  const noteEl = document.getElementById('simplify-modal-note');
  const keepBtn = document.getElementById('simplify-keep-btn');
  const confirmBtn = document.getElementById('simplify-confirm-btn');

  if (!modal || !presetListEl || !keepBtn || !confirmBtn) {
    return Promise.resolve({
      action: 'keep',
      presetId: 'high',
      tolerance: SIMPLIFY_PRESETS.high.tolerance,
    });
  }

  const mode = options.mode === 'manual' ? 'manual' : 'import';
  const fileName = info?.fileName ? `"${info.fileName}" ` : '';
  const triCount = info?.triCount || 0;
  const coplanarPct = typeof info?.coplanarPct === 'number' ? info.coplanarPct : 0;
  const nearFlatPct = typeof info?.nearFlatPct === 'number' ? info.nearFlatPct : 0;
  const estPct = info?.estimatedReductionPct || 0;
  const isManifold = info?.isManifold !== false;

  if (titleEl) {
    titleEl.textContent = mode === 'import' ? 'Unoptimized Mesh Detected' : 'Simplify Mesh';
  }
  if (subtitleEl) {
    subtitleEl.textContent =
      mode === 'import'
        ? `${fileName}has dense or redundant flat triangulation (${info?.reason || `${triCount.toLocaleString()} triangles`}).`
        : `Reduce triangle count cleanly on the active model (${triCount.toLocaleString()} triangles) while preserving sharp edges.`;
  }

  if (statsEl) {
    statsEl.innerHTML = `
      <div class="simplify-stat-pill">
        <span class="simplify-stat-label">Triangles</span>
        <span class="simplify-stat-val">${triCount.toLocaleString()}</span>
      </div>
      <div class="simplify-stat-pill">
        <span class="simplify-stat-label">Coplanar Flat</span>
        <span class="simplify-stat-val">${coplanarPct.toFixed(1)}% <small style="color:var(--text-secondary);font-weight:400">(${nearFlatPct.toFixed(1)}% &lt;2.5°)</small></span>
      </div>
      <div class="simplify-stat-pill">
        <span class="simplify-stat-label">Est. Savings</span>
        <span class="simplify-stat-val" style="color:var(--accent)">~${estPct}%</span>
      </div>
    `;
  }

  if (noteEl) {
    noteEl.textContent = isManifold
      ? 'Manifold WASM merges redundant flat faces within strict tolerance and preserves watertight edges & outward normals.'
      : 'Open/non-manifold mesh: uses bounded C++ PMP decimation to keep sharp edges & geometry intact.';
  }

  let selectedPresetId = 'high';
  const presetOrder = ['high', 'lossless', 'balanced'];
  presetListEl.innerHTML = '';

  const presetCards = {};
  for (const id of presetOrder) {
    const preset = SIMPLIFY_PRESETS[id];
    const card = document.createElement('button');
    card.type = 'button';
    card.className = `simplify-preset-card${id === selectedPresetId ? ' active' : ''}`;
    card.setAttribute('role', 'radio');
    card.setAttribute('aria-checked', id === selectedPresetId ? 'true' : 'false');
    card.dataset.presetId = id;
    card.innerHTML = `
      <div class="simplify-preset-head">
        <span class="simplify-preset-title">${preset.label}</span>
        ${id === 'high' ? '<span class="simplify-preset-badge">Recommended</span>' : ''}
      </div>
      <div class="simplify-preset-desc">${preset.desc}</div>
    `;
    card.addEventListener('click', () => {
      selectedPresetId = id;
      for (const [pid, btnCard] of Object.entries(presetCards)) {
        const isAct = pid === id;
        btnCard.classList.toggle('active', isAct);
        btnCard.setAttribute('aria-checked', String(isAct));
      }
    });
    presetCards[id] = card;
    presetListEl.appendChild(card);
  }

  keepBtn.textContent = mode === 'import' ? 'Keep Original' : 'Cancel';
  confirmBtn.textContent = mode === 'import' ? '✨ Simplify & Load' : '✨ Simplify Mesh';
  modal.hidden = false;

  return new Promise((resolve) => {
    let settled = false;
    const cleanup = () => {
      keepBtn.removeEventListener('click', onKeep);
      confirmBtn.removeEventListener('click', onConfirm);
      modal.removeEventListener('click', onBackdrop);
      window.removeEventListener('keydown', onKeyDown, true);
      modal.hidden = true;
    };
    const finish = (action) => {
      if (settled) return;
      settled = true;
      const preset = SIMPLIFY_PRESETS[selectedPresetId] || SIMPLIFY_PRESETS.high;
      cleanup();
      resolve({
        action,
        presetId: preset.id,
        tolerance: preset.tolerance,
      });
    };
    const onKeep = () => finish('keep');
    const onConfirm = () => finish('simplify');
    const onBackdrop = (e) => {
      if (e.target === modal) finish('keep');
    };
    const onKeyDown = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        finish('keep');
      }
    };

    keepBtn.addEventListener('click', onKeep);
    confirmBtn.addEventListener('click', onConfirm);
    modal.addEventListener('click', onBackdrop);
    window.addEventListener('keydown', onKeyDown, true);
    confirmBtn.focus();
  });
}

/**
 * Toggle the viewport processing overlay and button busy states.
 * @param {boolean} active
 * @param {string} [title]
 * @param {string} [detail]
 * @param {string} [activeBtnId] - 'apply-chamfer-btn' | 'mesh-fixer-btn' | 'simplify-mesh-btn'
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
  const stopBtn = document.getElementById('stop-chamfer-btn');
  const overlayStopBtn = document.getElementById('processing-stop-btn');
  const secondaryBtns = [
    { id: 'mesh-fixer-btn', busyLabel: 'Fixing Mesh...', defaultLabel: '🔧 Run MeshFixer' },
    { id: 'clean-parts-btn', busyLabel: 'Cleaning...', defaultLabel: '🧹 Clean Parts' },
    { id: 'preview-parts-btn', busyLabel: '...', defaultLabel: '👁' },
    { id: 'simplify-mesh-btn', busyLabel: 'Simplifying...', defaultLabel: '⚡ Simplify Mesh' },
  ];

  if (active) {
    if (applyBtn) {
      applyBtn.disabled = true;
      if (activeBtnId === 'apply-chamfer-btn') {
        applyBtn.classList.add('is-busy');
        applyBtn.innerHTML = '<span class="btn-spinner" aria-hidden="true"></span>Applying...';
      }
    }
    if (stopBtn) {
      stopBtn.style.display = '';
      stopBtn.disabled = false;
      stopBtn.textContent = '⏹ Stop Operation (Esc)';
    }
    if (overlayStopBtn) {
      overlayStopBtn.disabled = false;
      overlayStopBtn.textContent = '⏹ Stop Operation (Esc)';
    }
    for (const item of secondaryBtns) {
      const btn = document.getElementById(item.id);
      if (!btn) continue;
      if (btn.dataset.prevDisabled === undefined) {
        btn.dataset.prevDisabled = btn.disabled ? '1' : '0';
      }
      if (btn.dataset.prevLabel === undefined) {
        btn.dataset.prevLabel = btn.textContent;
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
    if (stopBtn) {
      stopBtn.style.display = 'none';
      stopBtn.disabled = false;
      stopBtn.textContent = '⏹ Stop Operation (Esc)';
    }
    if (overlayStopBtn) {
      overlayStopBtn.disabled = false;
      overlayStopBtn.textContent = '⏹ Stop Operation (Esc)';
    }
    for (const item of secondaryBtns) {
      const btn = document.getElementById(item.id);
      if (!btn) continue;
      btn.classList.remove('is-busy');
      if (btn.dataset.prevDisabled !== undefined) {
        btn.disabled = btn.dataset.prevDisabled === '1';
        delete btn.dataset.prevDisabled;
      }
      if (btn.dataset.prevLabel !== undefined) {
        btn.textContent = btn.dataset.prevLabel;
        delete btn.dataset.prevLabel;
      } else if (!btn.textContent.includes(item.defaultLabel.slice(2).trim())) {
        btn.textContent = item.defaultLabel;
      }
    }
  }
}

// ---- DOM helpers ----

function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text) {
    if (typeof text === 'string' && text.includes('<') && text.includes('>')) {
      e.innerHTML = text;
    } else {
      e.textContent = text;
    }
  }
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

function toggleRow(label, checked, badge = null) {
  const row = el('div', 'toggle-row');
  const lbl = el('span', 'control-label', label);
  if (badge) {
    const badgeEl = el('span', 'badge-experimental', badge);
    lbl.appendChild(badgeEl);
  }
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
