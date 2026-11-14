# Mesh Repair & Diagnostics

Raw polygon meshes exported from CAD packages or 3D scanners frequently contain zero-area facets, unstitched seams, and disconnected debris that interfere with CSG booleans and 3D printing slicers. **Chamfer That Mesh** includes an integrated diagnostic and repair suite.

---

## 1. Mesh Health Diagnostics

The studio continuously monitors geometry buffers and surfaces health metrics in the status panel:

```
┌───────────────────────────────────────────────────────────┐
│ Dimensions: 20.0 × 20.0 × 20.0 mm                         │
│ Triangles: 12      Vertices: 36      Edges: 18            │
│ Mesh Health: Watertight (0 holes, 0 degenerate)           │
└───────────────────────────────────────────────────────────┘
```

### Monitored Conditions
- **Watertight Manifoldness:** Every interior edge of a solid 3D body must be shared by exactly two triangles with opposite winding directions.
- **Hole Loops / Open Seams:** Edges connected to only a single triangle indicate an open surface hole that prevents volumetric slicing in slicers like PrusaSlicer, Bambu Studio, or Cura.
- **Degenerate Triangles:** Triangles with zero area or collinear vertices that produce zero-length normal vectors and divide-by-zero errors in CSG intersection trees.
- **Disconnected Components:** Isolated vertex clusters not topologically attached to the main solid body.

---

## 2. Automated & Manual MeshFixer

The studio provides both automated and on-demand repair tools:

### Auto-Fix Holes & Issues Checkbox
- When enabled in the sidebar, a sanitization pass runs immediately following every CSG chamfer operation.
- It detects and seals any micro-holes created at complex multi-edge corner miters, keeping the model slicer-ready without manual intervention.

### Run MeshFixer Button (`#btn-mesh-fixer`)
For models imported with pre-existing defects, click **Run MeshFixer** to execute a comprehensive repair sequence:
1. **Weld Duplicate Vertices:** Merges coincident vertices within a distance threshold ($\epsilon = 10^{-5}\text{ mm}$), reconstructing unified manifold edge topology.
2. **Cull Degenerates:** Removes zero-area faces and flips inverted normals to align with adjacent surfaces.
3. **Loop Sealing:** Identifies closed 1-manifold boundary loops and triangulates them to close open holes.

---

## 3. Non-Destructive Clean Loose Parts

Many 3D models contain floating stray polygons or support fragments left behind by CAD booleans.

```
       ┌────────────────────────┐
       │                        │      . <── Stray fragment (<5% area)
       │    Main Body Solid     │            [Removed]
       │   (Preserved >95%)     │
       │                        │      ┌─────┐
       └────────────────────────┘      │     │ <── Sub-assembly (>5% area)
                                       └─────┘     [Preserved]
```

Clicking **Clean Loose Parts** (`#btn-clean-loose`) uses a conservative, non-destructive heuristic:
- **Graph Traversal:** The mesh is decomposed into connected geometric components via vertex adjacency.
- **Safety Filters:** A component is removed **only** if it meets both strict criteria:
  1. Its surface area is less than **$5\%$** of total mesh surface area.
  2. Its bounding box dimension is less than **$50\%$** of the overall model size.
- **Protection for Multi-Part Meshes:** Valid multi-body assemblies, hollowed inner cavities, and dual-shell designs are preserved intact.

---

## 4. Undo / Redo & State History

All operations—including edge chamfers, fillets, MeshFixer repairs, loose part culling, and 90° axial rotations—are tracked in an in-memory history stack:

| Action | Shortcut | Description |
|---|---|---|
| **Undo** | `Ctrl+Z` / `Cmd+Z` | Rolls back the geometry buffer to the previous state (up to 20 levels). |
| **Redo** | `Ctrl+Y` / `Ctrl+Shift+Z` | Re-applies the most recently undone operation. |
| **Reset to Original** | `↺ Reset` Button | Instantly discards all modifications and restores the virgin imported geometry. |

> [!NOTE]
> History buffers store full vertex attribute arrays in browser memory. Even if an experimental large bevel produces an undesirable shape, you can instantly revert to the prior state with a single `Ctrl+Z`.
