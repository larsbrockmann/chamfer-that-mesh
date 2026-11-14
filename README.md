# Chamfer That Mesh

**Live Demo:** https://larsbrockmann.github.io/chamfer-that-mesh/

An interactive, browser-based **best-guess 3D mesh post-processing tool** for adding edge chamfers, fillets, and hybrid bevels to triangulated **STL** and **3MF** models, built with Three.js and BVH CSG. Designed for quick client-side 3D printing post-processing at 1:1 millimeter scale when original parametric CAD files are unavailable.

> [!WARNING]
> **Best-Guess Mesh Post-Processing — Outcomes May Be Broken or Imprecise**
>
> Unlike parametric CAD software (STEP / B-Rep kernels) that works on exact mathematical surfaces, **STL and 3MF files are raw triangle meshes** with no surface history or topological intent.
>
> **Chamfer That Mesh** is a **heuristic, best-guess implementation** that estimates sharp edges from triangle dihedral angles, sweeps bevel cutters along detected chains, and subtracts them via triangle-mesh CSG booleans (followed by best-effort automated mesh repair). Because of inherent limitations of boolean operations on arbitrary tessellated meshes:
> - **Results may come out broken, non-manifold, have open holes/artifacts, or be geometrically imprecise**, especially on complex multi-edge corners, tight curves, dense/noisy organic meshes, or large bevel widths.
> - Always inspect the modified mesh and **Mesh Health** status before exporting, and verify the sliced toolpath in your 3D printer slicer before printing.
> - Whenever you have access to the original parametric CAD model (Fusion, FreeCAD, OpenSCAD, SolidWorks, Onshape, etc.), prefer applying chamfers/fillets in native CAD first.

## Features

- **Native STL & 3MF Import / Export**
  - Drag-and-drop or browse to import binary/ASCII `.stl` and multi-body `.3mf` archives.
  - Preserves exact **1:1 millimeter scale** for direct slicing in PrusaSlicer, OrcaSlicer, Bambu Studio, or Cura.
  - Export modified meshes cleanly as binary **STL** or OPC-compliant **3MF** archives (powered by `fflate`).
- **Automatic Edge Detection & Cleanup Filtering**
  - Automatically detects sharp edges by dihedral angle threshold with reactive debounced updates.
  - Optional **Convex Edges Only** mode to protect interior fillets or slots.
  - **Filter Tiny Edges** toggle with configurable minimum edge length (`0.05–2.00 mm`) and three actions:
    - **Combine**: Merges adjacent collinear and micro-segments along chains into continuous smooth paths.
    - **Ignore**: Discards isolated micro-edges below the length threshold.
    - **Both**: Combines chains cleanly and drops isolated micro-noise.
- **Interactive 3D Edge Picking**
  - **Chain Loop** or **Single Edge** click mode with depth-prioritized picking (foreground edges win over occluded back edges).
  - Clear 4-state edge coloring and viewport HUD badge:
    - **Neon Cyan**: Selected edge
    - **Luminous White-Cyan**: Hovered selected edge (click to deselect)
    - **Cool Slate**: Unselected edge
    - **Vivid Gold**: Hovered unselected edge (click to select)
- **Chamfer, Fillet & Hybrid Bevel Engine**
  - **Chamfer**: Flat 45° planar bevel (`1` segment).
  - **Fillet**: Smooth circular radial arc (`2–8` segments).
  - **Hybrid**: Flat central bevel flanked by softly radiused transition shoulders (`3–8` segments).
  - Continuous vertex-averaged cross-section frames eliminate sawtooth artifacts around curves and cylinder rims.
  - Live translucent 3D preview ribbon updates in real time.
- **Precision & Coarse Width Controls**
  - Slider covers `0.1–1.0 mm` in coarse `0.1 mm` steps for quick everyday 3D print edge break adjustments.
  - Direct numeric input textbox (`mm`) accepts exact dimensions and **automatically extends the slider range** when values outside `0.1–1.0 mm` are entered.
- **Built-in MeshFixer & Stage Progress**
  - Automatic and on-demand **MeshFixer** (`Auto-Fix Holes & Issues` toggle + `🔧 Run MeshFixer` button) that attempts to weld vertices, stitch T-junction seams, remove degenerate triangles, and fill residual boundary holes after CSG operations.
  - Live **Mesh Health** status indicator and multi-stage viewport loading overlay during heavy CSG and repair passes.
- **Non-Destructive History & Orientation**
  - Up to 20 levels of **Undo / Redo** (`Ctrl+Z` / `Ctrl+Y` / `Ctrl+Shift+Z`, `Cmd` on macOS).
  - One-click **Reset to Original** (also undoable).
  - 90° X/Y/Z model rotation buttons, recenter view, and toggles for Wireframe, Grid, Axes, and Edge Highlights.

---

## Quick Start

### Prerequisites
- Node.js 18+ and npm

### Installation & Local Development

```bash
npm install
npm run dev
```

Open the URL printed by Vite (typically `http://localhost:5173/`) in a modern WebGL-capable browser.

### Production Build

```bash
npm run build
npm run preview
```

Outputs a static production bundle to `dist/`. Everything executes locally in the browser with no backend server required.

---

## Deploying to GitHub Pages

The repository is configured with a relative Vite base path (`base: './'`), relative sample model URLs (`./models/...`), `public/.nojekyll`, and an automated GitHub Actions workflow so it works under both root custom domains and repository subpaths (`https://<username>.github.io/<repo>/`).

### Option 1: Automatic Deployment via GitHub Actions (Recommended)

1. Push the repository to GitHub with `main` as your default branch.
2. Open **Settings → Pages** in your GitHub repository and set **Build and deployment → Source** to **GitHub Actions**.
3. The included [deploy.yml](.github/workflows/deploy.yml) workflow will automatically build `dist/` and publish the site on every push to `main` (or manually via **Actions → Deploy to GitHub Pages → Run workflow**).

### Option 2: Manual Static Deployment

```bash
npm install
npm run build
```

Upload the entire contents of `dist/` (including `.nojekyll`, `index.html`, `assets/`, and `models/`) to your `gh-pages` branch or static host.

---

## Usage Workflow & Keyboard Shortcuts

1. **Load a model**: Pick a sample model from the sidebar dropdown, click **Import Model (STL / 3MF)**, or drag-and-drop a `.stl` or `.3mf` file onto the 3D viewport.
2. **Refine edge selection**: Adjust **Angle Threshold**, **Convex Edges Only**, or **Filter Tiny Edges**. Click edges directly in the 3D viewport (in **Chain Loop** or **Single Edge** mode), or use **Select All / Clear / Invert**.
3. **Configure bevel**: Choose **Chamfer**, **Fillet**, or **Hybrid**, adjust **Width (mm)** via the slider or numeric input field, and set **Segments** if rounding.
4. **Apply & Export**: Click **Apply Chamfer** to perform CSG solid subtraction, inspect the live triangle/edge info, undo/iterate if needed, and export via **Export STL** or **Export 3MF**.

### Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl+Z` / `Cmd+Z` | Undo last geometry modification or 90° rotation |
| `Ctrl+Y` / `Ctrl+Shift+Z` / `Cmd+Shift+Z` | Redo modification |
| Left-drag (Viewport) | Orbit camera |
| Right-drag (Viewport) | Pan camera |
| Scroll wheel | Zoom |

---

## Project Architecture

```text
├── .github/workflows/deploy.yml  # GitHub Actions workflow for GitHub Pages
├── index.html                    # Application layout, canvas, HUD pill, and drop overlay
├── vite.config.js                # Vite bundler configuration (relative base './' for GitHub Pages)
├── src/
│   ├── main.js                   # Scene lifecycle, interaction picking, undo/redo/reset stack, UI wiring
│   ├── edgeDetector.js           # Vertex welding, half-edge dihedral analysis, chain simplifier & LineSegments2 renderer
│   ├── chamferEngine.js          # Vertex-averaged profile frames, preview mesh generator & three-bvh-csg subtraction
│   ├── meshFixer.js              # Manifold analyzer, T-junction seam stitcher, hole filler & normal harmonizer
│   ├── loaders.js                # STL & 3MF file/URL importers with 1:1 millimeter normalization
│   ├── meshExporter.js           # Binary STL exporter and OPC-compliant 3MF ZIP generator
│   ├── scene.js                  # Three.js WebGLRenderer, camera, OrbitControls, lighting, grid & axes helpers
│   ├── ui.js                     # Sidebar DOM builder, dynamic width controls, and live edge stats
│   └── styles.css                # Dark studio theme styling
└── public/
    ├── .nojekyll                 # Bypass Jekyll processing on GitHub Pages
    └── models/                   # Built-in STL and 3MF sample geometries
```

---

## Open Source Dependencies

- [Three.js](https://threejs.org/) (MIT) — WebGL rendering, `STLLoader`, `ThreeMFLoader`, `STLExporter`, `LineSegments2`, `fflate`
- [three-bvh-csg](https://github.com/gkjohnson/three-bvh-csg) (MIT) — Fast BVH-accelerated solid boolean CSG operations
- [Vite](https://vitejs.dev/) (MIT) — Development server and production bundler

---

## License

Licensed under the [MIT License](LICENSE).
