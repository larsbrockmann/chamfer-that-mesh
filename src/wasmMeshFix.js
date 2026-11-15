/* ============================================================
   wasmMeshFix.js — High-performance C++ PMP WebAssembly Mesh Repair
   Industrial polygon mesh repairing (hole filling, vertex welding,
   non-manifold splitting, degenerate collapse, normal orientation)
   ============================================================ */
import * as THREE from 'three';

let wasmModulePromise = null;
let wasmInitFailed = false;

/**
 * Check if WebAssembly is supported in the current environment.
 */
export function isWasmMeshFixSupported() {
  return typeof WebAssembly !== 'undefined' && !wasmInitFailed;
}

/**
 * Lazy-load the compiled C++ Polygon Mesh Processing (PMP) WebAssembly core.
 */
export async function getMeshFixCore() {
  if (wasmInitFailed) return null;
  if (!wasmModulePromise) {
    wasmModulePromise = (async () => {
      try {
        let createMeshFixCore = typeof window !== 'undefined' ? window.createMeshFixCore : null;

        if (!createMeshFixCore && typeof document !== 'undefined') {
          try {
            await new Promise((resolve, reject) => {
              const script = document.createElement('script');
              script.src = new URL('meshfix-core.js', window.location.href).href;
              script.onload = () => resolve();
              script.onerror = () => reject(new Error('Failed to load meshfix-core.js script tag'));
              document.head.appendChild(script);
            });
            createMeshFixCore = window.createMeshFixCore;
          } catch (_) {
            // Script tag injection failed, try module import
          }
        }

        if (!createMeshFixCore) {
          // Dynamic import of the core loader
          const mod = await import('meshfix-wasm/dist/meshfix-core.js');
          createMeshFixCore = mod.default || mod;
        }

        const wasmModule = await createMeshFixCore({
          locateFile: (path) => {
            if (path.endsWith('.wasm')) {
              if (typeof window === 'undefined') {
                return new URL('../public/meshfix-core.wasm', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
              }
              try {
                return new URL('meshfix-core.wasm', window.location.href).href;
              } catch (_) {
                return './meshfix-core.wasm';
              }
            }
            return path;
          },
        });
        return wasmModule;
      } catch (err) {
        console.warn('Failed to initialize C++ MeshFix WebAssembly module, falling back to JS stitcher:', err);
        wasmInitFailed = true;
        return null;
      }
    })();
  }
  return wasmModulePromise;
}

/**
 * Convert THREE.BufferGeometry directly into a binary STL ArrayBuffer.
 * Runs in ~2-4ms for 50,000 triangles.
 *
 * @param {THREE.BufferGeometry} geometry
 * @returns {ArrayBuffer}
 */
export function geometryToBinarySTL(geometry) {
  const geo = geometry.index ? geometry.toNonIndexed() : geometry;
  const posAttr = geo.getAttribute('position');
  if (!posAttr || posAttr.count === 0) {
    if (geo !== geometry) geo.dispose();
    return new ArrayBuffer(84);
  }

  const pos = posAttr.array;
  const triCount = Math.floor(posAttr.count / 3);

  const buffer = new ArrayBuffer(84 + triCount * 50);
  const view = new DataView(buffer);
  view.setUint32(80, triCount, true);

  let byteOffset = 84;
  for (let f = 0; f < triCount; f++) {
    const o = f * 9;

    // Normal (0 is standard in STL readers when computing geometric normals)
    view.setFloat32(byteOffset, 0, true);
    view.setFloat32(byteOffset + 4, 0, true);
    view.setFloat32(byteOffset + 8, 0, true);

    // Vertex 1
    view.setFloat32(byteOffset + 12, pos[o], true);
    view.setFloat32(byteOffset + 16, pos[o + 1], true);
    view.setFloat32(byteOffset + 20, pos[o + 2], true);

    // Vertex 2
    view.setFloat32(byteOffset + 24, pos[o + 3], true);
    view.setFloat32(byteOffset + 28, pos[o + 4], true);
    view.setFloat32(byteOffset + 32, pos[o + 5], true);

    // Vertex 3
    view.setFloat32(byteOffset + 36, pos[o + 6], true);
    view.setFloat32(byteOffset + 40, pos[o + 7], true);
    view.setFloat32(byteOffset + 44, pos[o + 8], true);

    // Attribute byte count (0)
    view.setUint16(byteOffset + 48, 0, true);
    byteOffset += 50;
  }

  if (geo !== geometry) geo.dispose();
  return buffer;
}

let tempFileCounter = 0;

/**
 * Repair a 3D geometry using the native C++ PMP WebAssembly engine.
 *
 * @param {THREE.BufferGeometry} geometry
 * @param {object} [options]
 * @param {number} [options.weldEpsilon=1e-4]
 * @param {number} [options.maxHoleEdges=150]
 * @param {number} [options.minArea=1e-8]
 * @param {AbortSignal} [options.signal]
 * @param {(msg: string) => void} [options.onProgress]
 * @returns {Promise<{ geometry: THREE.BufferGeometry, holesFilled: number, verticesBefore: number, verticesAfter: number, facesBefore: number, facesAfter: number, success: boolean } | null>}
 */
export async function repairMeshWasm(geometry, options = {}) {
  const {
    weldEpsilon = 1e-4,
    maxHoleEdges = 0,
    minArea = 1e-8,
    signal,
    onProgress,
  } = options;

  if (signal?.aborted) throw new Error('Operation aborted');

  const wasm = await getMeshFixCore();
  if (!wasm) return null;

  onProgress?.('WASM: Preparing binary STL...');
  const stlBuffer = geometryToBinarySTL(geometry);

  const fileId = ++tempFileCounter;
  const inPath = `/tmp/mesh_in_${fileId}.stl`;
  const renderPath = `/tmp/render_${fileId}.bin`;

  let analyzer = null;
  try {
    wasm.FS.writeFile(inPath, new Uint8Array(stlBuffer));
    analyzer = new wasm.MeshAnalyzer();

    const loaded = analyzer.loadFromFile(inPath);
    if (!loaded) {
      console.warn('WASM MeshAnalyzer loadFromFile returned false:', analyzer.getLastError());
      return null;
    }

    const verticesBefore = analyzer.getVertexCount();
    const facesBefore = analyzer.getFaceCount();

    if (signal?.aborted) throw new Error('Operation aborted');

    // 1. Weld micro-gaps
    onProgress?.('WASM: Welding vertices...');
    analyzer.weldVertices(weldEpsilon);

    // 2. Split non-manifold singular vertices
    onProgress?.('WASM: Splitting non-manifold singular vertices...');
    analyzer.splitVertices();

    if (signal?.aborted) throw new Error('Operation aborted');

    // 3. Fill boundary damage holes only when explicitly requested (PMP has no spatial distance guard,
    // so maxHoleEdges defaults to 0 to prevent skinning across 3D voids between CAD extrusions)
    let holesFilled = 0;
    if (maxHoleEdges > 0) {
      onProgress?.('WASM: Triangulating damaged hole boundaries...');
      if (typeof analyzer.fillHolesEx === 'function') {
        const fillResult = analyzer.fillHolesEx(maxHoleEdges, false);
        holesFilled = typeof fillResult === 'number' ? fillResult : (fillResult?.holesFilled || 0);
      } else {
        const fillResult = analyzer.fillHoles(Math.min(maxHoleEdges, 12));
        holesFilled = typeof fillResult === 'number' ? fillResult : (fillResult?.holesFilled || 0);
      }
    }

    // 4. Collapse degenerate / zero-area sliver triangles
    onProgress?.('WASM: Collapsing degenerate slivers...');
    analyzer.removeDegenerates(minArea);

    // 5. Harmonize surface normals
    onProgress?.('WASM: Harmonizing surface normals...');
    analyzer.fixNormals();

    const verticesAfter = analyzer.getVertexCount();
    const facesAfter = analyzer.getFaceCount();

    // 6. Write fast binary render buffer
    onProgress?.('WASM: Building Three.js geometry...');
    const written = analyzer.writeRenderData(renderPath);
    if (!written) {
      console.warn('WASM writeRenderData returned false:', analyzer.getLastError());
      return null;
    }

    const binData = wasm.FS.readFile(renderPath);
    const bufCopy = binData.buffer.slice(binData.byteOffset, binData.byteOffset + binData.byteLength);
    const dv = new DataView(bufCopy);
    const vertexCount = dv.getUint32(0, true);
    const indexCount = dv.getUint32(4, true);

    const posArray = new Float32Array(bufCopy, 8, vertexCount * 3);
    const idxArray = new Uint32Array(bufCopy, 8 + vertexCount * 24, indexCount);

    const indexedGeo = new THREE.BufferGeometry();
    indexedGeo.setAttribute('position', new THREE.BufferAttribute(posArray, 3));
    indexedGeo.setIndex(new THREE.BufferAttribute(idxArray, 1));
    const fixedGeo = indexedGeo.toNonIndexed();
    fixedGeo.computeVertexNormals();
    indexedGeo.dispose();

    return {
      geometry: fixedGeo,
      holesFilled,
      verticesBefore,
      verticesAfter,
      facesBefore,
      facesAfter,
      success: true,
    };
  } catch (err) {
    if (err?.message === 'Operation aborted') throw err;
    console.warn('WASM mesh repair encountered an error, falling back:', err);
    return null;
  } finally {
    if (analyzer) {
      try { analyzer.delete(); } catch (_) {}
    }
    try { wasm.FS.unlink(inPath); } catch (_) {}
    try { wasm.FS.unlink(renderPath); } catch (_) {}
  }
}
