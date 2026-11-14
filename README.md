# Chamfer That Mesh

[![GitHub Pages](https://img.shields.io/badge/GitHub%20Pages-Live%20Demo-00d4ff?logo=googlechrome&logoColor=white)](https://larsbrockmann.github.io/chamfer-that-mesh/)
[![Wiki](https://img.shields.io/badge/Documentation-Wiki-blue?logo=gitbook&logoColor=white)](https://github.com/larsbrockmann/chamfer-that-mesh/wiki)
[![Deploy Status](https://github.com/larsbrockmann/chamfer-that-mesh/actions/workflows/deploy.yml/badge.svg)](https://github.com/larsbrockmann/chamfer-that-mesh/actions/workflows/deploy.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Formats](https://img.shields.io/badge/Mesh-STL%20%7C%203MF-orange.svg)](#)
[![Three.js](https://img.shields.io/badge/Three.js-r170+-black.svg?logo=three.js)](https://threejs.org/)
[![Client-Side](https://img.shields.io/badge/Execution-100%25%20In--Browser-blueviolet.svg)](#)

A browser-based 3D studio for adding chamfers, fillets, and hybrid bevels to STL and 3MF models. Handy for 3D printing when you only have the mesh without original CAD solids. Everything runs 100% locally in your browser with zero server uploads.

![Chamfer That Mesh Studio](docs/images/ui-overview.png)

> [!NOTE]
> STL and 3MF meshes represent boundary surfaces using discrete triangles. Chamfer That Mesh uses high-performance Constructive Solid Geometry (CSG) booleans with automated mesh self-repair to generate clean, watertight chamfers on sharp feature edges.

## Screenshots

| Interactive Edge Selection & Live Preview | Clean CSG Chamfer Applied |
|:---:|:---:|
| ![Live Bevel Preview Ribbon](docs/images/chamfer-preview-ribbon.png) | ![Applied Bevel Result](docs/images/chamfer-applied.png) |
| *Emerald live ribbon previews cutting envelope before applying* | *Watertight mitered chamfer with clean quad-like bevels* |

| Precision Spur Gear Beveling | Mobile Touch Studio |
|:---:|:---:|
| ![Tooth Gear Watertight Chamfer](docs/images/spur-gear-chamfered.png) | ![Mobile Bottom Sheet Drawer](docs/images/mobile-layout.png) |
| *Complex 12-tooth gear chamfered without corner spikes* | *Full-screen 3D view with draggable mobile settings drawer* |

## Features

- Import and export STL and 3MF (1:1 mm scale)
- Automatic sharp-edge detection by angle with one-click **Auto Angle Threshold** (✨ Auto), plus optional convex-only and tiny-edge filtering
- Click edges in the 3D view to select or deselect them (whole loop or single edge)
- Three bevel profiles: **Chamfer** (flat), **Fillet** (rounded), **Hybrid** (flat with rounded edges)
- Built-in mesh repair and loose-part cleanup with interactive 3D highlight preview
- Undo/redo, reset to original, preview, and basic view controls
- Works on desktop and mobile; the settings panel is resizable on desktop

## Documentation & Wiki

Detailed guides and screenshots for all features are available in the [**Documentation Wiki**](https://github.com/larsbrockmann/chamfer-that-mesh/wiki):

- [**UI Tour & Navigation**](https://github.com/larsbrockmann/chamfer-that-mesh/wiki/UI-Tour-and-Navigation) — CAD orbit camera, desktop resizable sidebar, and mobile drawer.
- [**Edge Detection & Selection**](https://github.com/larsbrockmann/chamfer-that-mesh/wiki/Edge-Detection-and-Selection) — Angle thresholds, loop chaining, and 3D viewport picking.
- [**Bevel Profiles & Engine**](https://github.com/larsbrockmann/chamfer-that-mesh/wiki/Bevel-Profiles-and-Engine) — Chamfer, Fillet, and Hybrid bevels with live 3D preview.
- [**Mesh Repair & Diagnostics**](https://github.com/larsbrockmann/chamfer-that-mesh/wiki/Mesh-Repair-and-Diagnostics) — MeshFixer, watertight repair, and loose-part cleanup.
- [**File Formats & Sample Library**](https://github.com/larsbrockmann/chamfer-that-mesh/wiki/File-Formats-and-Sample-Library) — STL/3MF handling and the 3 built-in demo shapes (Pyramid, Hex Nut, Tooth Gear).

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
