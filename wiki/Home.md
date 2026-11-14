# Chamfer That Mesh — Documentation Wiki

Welcome to the **Chamfer That Mesh** documentation wiki. This guide covers every feature of the studio, from basic file loading to advanced 3D edge selection, CSG beveling algorithms, mesh repair diagnostics, and responsive desktop/mobile workflows.

---

## Wiki Chapters

1. **[UI Tour & Navigation](UI-Tour-and-Navigation.md)**  
   Learn the studio layout, 360° trackball camera navigation, desktop resizable sidebar, mobile bottom-sheet drawer, and viewport display helpers (wireframe, grid, axes).

2. **[Edge Detection & Selection](Edge-Detection-and-Selection.md)**  
   Master sharp edge detection by dihedral angle threshold, convex-only filtering, tiny/collinear edge merging, chain loop selection, and interactive 3D viewport picking.

3. **[Bevel Profiles & Engine](Bevel-Profiles-and-Engine.md)**  
   Detailed guide to **Chamfer** (flat 45°), **Fillet** (circular radial arc), and **Hybrid** (flat center with rounded transition shoulders), plus width controls, live 3D preview ribbons, and aborting long operations.

4. **[Mesh Repair & Diagnostics](Mesh-Repair-and-Diagnostics.md)**  
   Understand mesh health metrics (manifoldness, hole loops, open seams), automated and manual **MeshFixer** repair tools, non-destructive **Clean Loose Parts**, and the 20-level undo/redo history stack.

5. **[File Formats & Sample Library](File-Formats-and-Sample-Library.md)**  
   Importing and exporting binary/ASCII STL and OPC-compliant 3MF archives at exact 1:1 millimeter scale, plus descriptions of the built-in demo shapes (Pyramid, Hex Nut, and Tooth Gear).

---

## Quick Reference & Workflow

```
[1. Import Model] ──▶ [2. Edge Detection] ──▶ [3. Pick Edges] ──▶ [4. Set Bevel] ──▶ [5. Apply & Repair] ──▶ [6. Export]
  STL or 3MF             Angle Threshold          Chain Loop / Single    Chamfer / Fillet /     Auto-Fix Holes        Binary STL
  1:1 mm scale           Filter Tiny Edges        Select All / Invert    Hybrid (Width & Segs)  MeshFixer Diagnostics OPC 3MF
```

### Essential Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl+Z` / `Cmd+Z` | Undo last bevel, repair, or 90° model rotation (up to 20 levels) |
| `Ctrl+Y` / `Ctrl+Shift+Z` | Redo previously undone action |
| `Esc` | Stop and abort an in-progress CSG chamfer operation |
| `A` / `Ctrl+A` | Select all detected edges |
| `C` | Clear / deselect all edges |
| `I` | Invert edge selection state |
| `H` | Select only horizontal edges (parallel to ground) |
| `V` | Select only vertical edges (perpendicular to ground) |
| `T` | Select topmost and bottommost perimeter edges |
| `Left-Click Drag` | Unrestricted 360° trackball camera orbit (pivots around clicked mesh point) |
| `Right-Click Drag` | Pan camera across view plane |
| `Scroll Wheel` | Zoom in and out toward cursor |
| `ArrowLeft` / `ArrowRight` | Adjust desktop settings panel width in 16px increments (when resizer is focused) |
| `Double-Click Resizer` | Reset desktop settings panel to default responsive width |

---

## Technology Stack

- **[Three.js (r170+)](https://threejs.org/):** WebGL rendering engine, TrackballControls, LineSegments2 screen-space antialiased edges, STLLoader, ThreeMFLoader, and RoomEnvironment PBR studio lighting.
- **[three-bvh-csg](https://github.com/gkjohnson/three-bvh-csg):** Bounding Volume Hierarchy accelerated Constructive Solid Geometry booleans for fast triangle mesh subtraction.
- **[fflate](https://github.com/101arrowz/fflate):** High-performance client-side ZIP compression for unpacking and generating compliant 3MF packages.
- **[Vite 6](https://vitejs.dev/):** Fast ESM development server and static production packager. Everything runs 100% client-side in the browser with no server uploads.
