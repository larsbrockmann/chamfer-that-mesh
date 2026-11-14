# Chamfer That Mesh

[![GitHub Pages](https://img.shields.io/badge/GitHub%20Pages-Live%20Demo-00d4ff?logo=googlechrome&logoColor=white)](https://larsbrockmann.github.io/chamfer-that-mesh/)
[![Wiki](https://img.shields.io/badge/Documentation-Wiki-blue?logo=gitbook&logoColor=white)](wiki/Home.md)
[![Deploy Status](https://github.com/larsbrockmann/chamfer-that-mesh/actions/workflows/deploy.yml/badge.svg)](https://github.com/larsbrockmann/chamfer-that-mesh/actions/workflows/deploy.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Formats](https://img.shields.io/badge/Mesh-STL%20%7C%203MF-orange.svg)](#)
[![Three.js](https://img.shields.io/badge/Three.js-r170+-black.svg?logo=three.js)](https://threejs.org/)
[![Client-Side](https://img.shields.io/badge/Execution-100%25%20In--Browser-blueviolet.svg)](#)

A small browser tool for adding chamfers and fillets to the edges of STL and 3MF models. Handy for 3D printing when you only have the mesh and not the original CAD file. Everything runs locally in your browser.

> [!NOTE]
> STL/3MF files are just triangles, so this works on a best-effort basis. Complex corners or large bevel widths can produce holes or artifacts. Check the **Mesh Health** status before exporting. If you have the original CAD file, adding the chamfer there will give a cleaner result.

## Features

- Import and export STL and 3MF (1:1 mm scale)
- Automatic sharp-edge detection by angle with one-click **Auto Angle Threshold** (✨ Auto), plus optional convex-only and tiny-edge filtering
- Click edges in the 3D view to select or deselect them (whole loop or single edge)
- Three bevel profiles: **Chamfer** (flat), **Fillet** (rounded), **Hybrid** (flat with rounded edges)
- Built-in mesh repair and loose-part cleanup with interactive 3D highlight preview
- Undo/redo, reset to original, preview, and basic view controls
- Works on desktop and mobile; the settings panel is resizable on desktop

## Documentation & Wiki

Detailed guides and screenshots for all features are available in the [**Wiki**](wiki/Home.md):

- [**UI Tour & Navigation**](wiki/UI-Tour-and-Navigation.md) — 360° trackball camera, desktop resizable sidebar, and mobile drawer.
- [**Edge Detection & Selection**](wiki/Edge-Detection-and-Selection.md) — Angle thresholds, loop chaining, and 3D viewport picking.
- [**Bevel Profiles & Engine**](wiki/Bevel-Profiles-and-Engine.md) — Chamfer, Fillet, and Hybrid bevels with live 3D preview.
- [**Mesh Repair & Diagnostics**](wiki/Mesh-Repair-and-Diagnostics.md) — MeshFixer, watertight repair, and loose-part cleanup.
- [**File Formats & Sample Library**](wiki/File-Formats-and-Sample-Library.md) — STL/3MF handling and the 3 built-in demo shapes (Pyramid, Hex Nut, Tooth Gear).

## Usage

1. Load a model: pick a sample, click **Import Model**, or drag a file onto the viewport.
2. Adjust the angle threshold and click edges to fine-tune the selection.
3. Choose a profile and width, then click **Apply Chamfer**.
4. Export as STL or 3MF.

| Shortcut | Action |
|---|---|
| `Ctrl+Z` / `Cmd+Z` | Undo |
| `Ctrl+Y` / `Ctrl+Shift+Z` | Redo |
| `Esc` | Stop a running operation |
| `A` / `Ctrl+A` | Select all detected edges |
| `C` | Clear edge selection |
| `I` | Invert edge selection |
| `H` | Select horizontal edges |
| `V` | Select vertical edges |
| `T` | Select top & bottom edges |
| Left-drag / Right-drag / Scroll | Orbit / Pan / Zoom |

## Development

Requires Node.js 18+.

```bash
npm install
npm run dev      # local dev server
npm run build    # static build in dist/
```

## Deploying to GitHub Pages

In your repository go to **Settings → Pages** and set **Source** to **GitHub Actions**. The included [deploy.yml](.github/workflows/deploy.yml) workflow builds and publishes the site on every push to `main`.

## Built with

- [Three.js](https://threejs.org/)
- [three-bvh-csg](https://github.com/gkjohnson/three-bvh-csg)
- [Vite](https://vitejs.dev/)

## License

[MIT](LICENSE)
