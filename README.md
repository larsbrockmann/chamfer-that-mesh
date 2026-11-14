# Chamfer That Mesh

**Live demo:** https://larsbrockmann.github.io/chamfer-that-mesh/

A small browser tool for adding chamfers and fillets to the edges of STL and 3MF models. Handy for 3D printing when you only have the mesh and not the original CAD file. Everything runs locally in your browser.

> [!NOTE]
> STL/3MF files are just triangles, so this works on a best-effort basis. Complex corners or large bevel widths can produce holes or artifacts. Check the **Mesh Health** status before exporting. If you have the original CAD file, adding the chamfer there will give a cleaner result.

## Features

- Import and export STL and 3MF (1:1 mm scale)
- Automatic sharp-edge detection by angle, with optional convex-only and tiny-edge filtering
- Click edges in the 3D view to select or deselect them (whole loop or single edge)
- Three bevel profiles: **Chamfer** (flat), **Fillet** (rounded), **Hybrid** (flat with rounded edges)
- Built-in mesh repair and loose-part cleanup
- Undo/redo, reset to original, preview, and basic view controls
- Works on desktop and mobile; the settings panel is resizable on desktop

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
