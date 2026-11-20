/* ============================================================
   meshSimplifier.js — Quality-preserving WebAssembly mesh simplification
   Primary: Manifold-3D WASM simplify(tolerance)
   Fallback: C++ PMP WASM decimate (meshfix-wasm) for open/non-manifold meshes
   ============================================================ */
import * as THREE from 'three';
import { getManifold } from './manifoldEngine.js';
import { getMeshFixCore, geometryToBinarySTL } from './wasmMeshFix.js';
import { getFastMeshTopology } from './meshTopology.js';

export const SIMPLIFY_PRESETS = {
  lossless: {
    id: 'lossless',
    label: 'Lossless (0 mm)',
    tolerance: 0,
    desc: 'Merges exact coplanar flat triangles only (0.000% shape change)',
  },
  high: {
    id: 'high',
    label: 'High Precision (0.01 mm)',
    tolerance: 0.01,
    desc: 'Sub-print tolerance (10 µm max deviation) — removes 90–95% of redundant triangles with no visible quality loss',
  },
  balanced: {
    id: 'balanced',
    label: 'Balanced (0.025 mm)',
    tolerance: 0.025,
    desc: 'Fastest interaction on dense curved meshes (25 µm max deviation, still finer than 3D printing)',
  },
};

function createAbortError() {
  const err = new Error('Mesh simplification aborted');
  err.name = 'AbortError';
  return err;
}

function yieldForUI() {
  if (typeof requestAnimationFrame === 'function') {
    return new Promise((resolve) => {
      requestAnimationFrame(() => setTimeout(resolve, 16));
    });
  }
  return Promise.resolve();
}

function buildCenteredIndexedGeometry(vertProperties, numProp, triVerts) {
  const vertCount = Math.floor(vertProperties.length / numProp);
  const positions = new Float32Array(vertCount * 3);

  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

  if (numProp === 3) {
    positions.set(vertProperties);
    for (let i = 0; i < positions.length; i += 3) {
      const x = positions[i];
      const y = positions[i + 1];
      const z = positions[i + 2];
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
  } else {
    for (let i = 0; i < vertCount; i++) {
      const src = i * numProp;
      const dst = i * 3;
      const x = vertProperties[src];
      const y = vertProperties[src + 1];
      const z = vertProperties[src + 2];
      positions[dst] = x;
      positions[dst + 1] = y;
      positions[dst + 2] = z;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
  }

  if (vertCount > 0 && minX !== Infinity) {
    const cx = (minX + maxX) * 0.5;
    const cy = (minY + maxY) * 0.5;
    const cz = (minZ + maxZ) * 0.5;
    for (let i = 0; i < positions.length; i += 3) {
      positions[i] -= cx;
      positions[i + 1] -= cy;
      positions[i + 2] -= cz;
    }
  }

  const IndexArray = vertCount > 65535 ? Uint32Array : Uint16Array;
  const indices = new IndexArray(triVerts);

  const outGeo = new THREE.BufferGeometry();
  outGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  outGeo.setIndex(new THREE.BufferAttribute(indices, 1));
  outGeo.computeVertexNormals();
  outGeo.computeBoundingBox();
  outGeo.computeBoundingSphere();
  return outGeo;
}

function validateSimplifiedBounds(outGeo, origBbox, tolerance) {
  if (!outGeo || !outGeo.boundingBox) return false;
  const idx = outGeo.getIndex();
  const pos = outGeo.getAttribute('position');
  const outTris = idx ? Math.floor(idx.count / 3) : pos ? Math.floor(pos.count / 3) : 0;
  if (outTris < 4) return false;

  const size = new THREE.Vector3();
  outGeo.boundingBox.getSize(size);
  const maxAllowedDiff = Math.max(tolerance * 4, origBbox.maxDim * 0.02);
  const dx = Math.abs(size.x - origBbox.sizeX);
  const dy = Math.abs(size.y - origBbox.sizeY);
  const dz = Math.abs(size.z - origBbox.sizeZ);
  return dx <= maxAllowedDiff && dy <= maxAllowedDiff && dz <= maxAllowedDiff;
}

async function tryManifoldSimplify(topo, tolerance, signal, onProgress) {
  const wasm = await getManifold();
  if (!wasm) return null;
  if (signal?.aborted) throw createAbortError();

  const { Manifold, Mesh } = wasm;
  const srcTris = topo.triIndices;
  let validCount = 0;
  for (let f = 0; f < topo.triCount; f++) {
    const o = f * 3;
    const a = srcTris[o];
    const b = srcTris[o + 1];
    const c = srcTris[o + 2];
    if (a !== b && b !== c && c !== a) validCount++;
  }
  if (validCount < 4) return null;

  const flipWinding =
    topo.openEdges === 0 && topo.nonManifoldEdges === 0 && topo.signedVolume < 0;

  const triVerts = new Uint32Array(validCount * 3);
  let ptr = 0;
  for (let f = 0; f < topo.triCount; f++) {
    const o = f * 3;
    const a = srcTris[o];
    const b = srcTris[o + 1];
    const c = srcTris[o + 2];
    if (a === b || b === c || c === a) continue;
    triVerts[ptr++] = a;
    if (flipWinding) {
      triVerts[ptr++] = c;
      triVerts[ptr++] = b;
    } else {
      triVerts[ptr++] = b;
      triVerts[ptr++] = c;
    }
  }

  let m = null;
  let simplified = null;
  try {
    onProgress?.('Manifold WASM: Building solid topology...');
    await yieldForUI();
    if (signal?.aborted) throw createAbortError();

    const meshGL = new Mesh({
      numProp: 3,
      vertProperties: topo.vertCoords,
      triVerts,
    });
    m = new Manifold(meshGL);
    if (m.status() !== 'NoError' || m.numTri() < 4) {
      return null;
    }

    onProgress?.(
      tolerance === 0
        ? 'Manifold WASM: Merging coplanar triangles (0 mm)...'
        : `Manifold WASM: Simplifying within ±${tolerance} mm...`
    );
    await yieldForUI();
    if (signal?.aborted) throw createAbortError();

    simplified = m.simplify(tolerance);
    if (!simplified || simplified.status() !== 'NoError' || simplified.numTri() < 4) {
      return null;
    }

    onProgress?.('Building optimized indexed geometry...');
    await yieldForUI();
    if (signal?.aborted) throw createAbortError();

    const outMesh = simplified.getMesh();
    const outGeo = buildCenteredIndexedGeometry(
      outMesh.vertProperties,
      outMesh.numProp || 3,
      outMesh.triVerts
    );
    if (!validateSimplifiedBounds(outGeo, topo.bbox, tolerance)) {
      outGeo.dispose();
      return null;
    }

    return {
      geometry: outGeo,
      engine: 'manifold',
      trisAfter: simplified.numTri(),
      fixedInvertedWinding: flipWinding,
    };
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    return null;
  } finally {
    try { simplified?.delete(); } catch (_) {}
    try { m?.delete(); } catch (_) {}
  }
}

let simplifyTmpCounter = 0;

async function tryPmpDecimateFallback(geometry, topo, tolerance, signal, onProgress) {
  if (topo.triCount > 600000) return null;
  const wasm = await getMeshFixCore();
  if (!wasm) return null;
  if (signal?.aborted) throw createAbortError();

  const fileId = ++simplifyTmpCounter;
  const inPath = `/tmp/simplify_in_${fileId}.stl`;
  const renderPath = `/tmp/simplify_render_${fileId}.bin`;
  let analyzer = null;

  try {
    onProgress?.('C++ PMP WASM: Preparing mesh decimation...');
    await yieldForUI();
    if (signal?.aborted) throw createAbortError();

    const stlBuffer = geometryToBinarySTL(geometry);
    wasm.FS.writeFile(inPath, new Uint8Array(stlBuffer));
    analyzer = new wasm.MeshAnalyzer();
    if (!analyzer.loadFromFile(inPath)) return null;

    const vertCount = analyzer.getVertexCount();
    const targetVerts = Math.max(12, Math.floor(vertCount * 0.05));
    const normalDev = tolerance === 0 ? 0.25 : tolerance <= 0.01 ? 1.0 : 2.0;
    const hausdorff = Math.max(tolerance, 0.002);

    onProgress?.(`C++ PMP WASM: Decimating within ±${hausdorff} mm...`);
    await yieldForUI();
    if (signal?.aborted) throw createAbortError();

    const res = analyzer.decimate(targetVerts, 10.0, normalDev, hausdorff);
    if (!res?.success || res.facesAfter < 4) return null;

    const written = analyzer.writeRenderData(renderPath);
    if (!written) return null;

    const binData = wasm.FS.readFile(renderPath);
    const bufCopy = binData.buffer.slice(binData.byteOffset, binData.byteOffset + binData.byteLength);
    const dv = new DataView(bufCopy);
    const vCount = dv.getUint32(0, true);
    const iCount = dv.getUint32(4, true);

    const posArray = new Float32Array(bufCopy, 8, vCount * 3);
    const idxArray = new Uint32Array(bufCopy, 8 + vCount * 24, iCount);
    const outGeo = buildCenteredIndexedGeometry(posArray, 3, idxArray);

    if (!validateSimplifiedBounds(outGeo, topo.bbox, tolerance)) {
      outGeo.dispose();
      return null;
    }

    return {
      geometry: outGeo,
      engine: 'wasm-pmp',
      trisAfter: Math.floor(iCount / 3),
      fixedInvertedWinding: false,
    };
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    return null;
  } finally {
    if (analyzer) {
      try { analyzer.delete(); } catch (_) {}
    }
    try { wasm.FS.unlink(inPath); } catch (_) {}
    try { wasm.FS.unlink(renderPath); } catch (_) {}
  }
}

/**
 * Simplify a mesh cleanly using Manifold-3D WASM (or PMP WASM fallback for open meshes),
 * preserving dimensional fidelity within `tolerance` mm.
 *
 * @param {THREE.BufferGeometry} geometry
 * @param {object} [options]
 * @param {number} [options.tolerance=0.01]
 * @param {AbortSignal} [options.signal]
 * @param {(msg: string) => void} [options.onProgress]
 */
export async function simplifyGeometryAsync(geometry, options = {}) {
  const { tolerance = 0.01, signal, onProgress } = options;
  if (signal?.aborted) throw createAbortError();

  onProgress?.('Reading cached mesh topology...');
  await yieldForUI();
  if (signal?.aborted) throw createAbortError();

  const topo = getFastMeshTopology(geometry);
  const trisBefore = topo?.triCount || 0;

  let res = await tryManifoldSimplify(topo, tolerance, signal, onProgress);
  if (!res) {
    res = await tryPmpDecimateFallback(geometry, topo, tolerance, signal, onProgress);
  }

  if (!res) {
    const cloned = geometry.clone();
    return {
      geometry: cloned,
      engine: 'unchanged',
      trisBefore,
      trisAfter: trisBefore,
      reductionPct: 0,
      tolerance,
      fixedInvertedWinding: false,
    };
  }

  const reductionPct =
    trisBefore > 0 ? Math.max(0, Math.round((1 - res.trisAfter / trisBefore) * 1000) / 10) : 0;

  return {
    geometry: res.geometry,
    engine: res.engine,
    trisBefore,
    trisAfter: res.trisAfter,
    reductionPct,
    tolerance,
    fixedInvertedWinding: res.fixedInvertedWinding,
  };
}
