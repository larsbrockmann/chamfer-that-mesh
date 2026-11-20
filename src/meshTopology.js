/* ============================================================
   meshTopology.js — TypedArray spatial welding, edge topology,
   connected components & unoptimized-mesh analysis
   ============================================================ */
import * as THREE from 'three';

const topologyCache = new WeakMap();

/**
 * Invalidate cached topology for a geometry (call before disposing or after in-place mutation).
 * @param {THREE.BufferGeometry|null|undefined} geometry
 */
export function invalidateMeshTopology(geometry) {
  if (geometry && typeof geometry === 'object') {
    topologyCache.delete(geometry);
  }
}

function nextPow2(n) {
  let cap = 16;
  while (cap < n) cap <<= 1;
  return cap;
}

function mixEdgeHash(lo, hi, mask) {
  const h1 = Math.imul(lo ^ (lo >>> 16), 0x45d9f3b);
  const h2 = Math.imul(hi ^ (hi >>> 16), 0x119de1f3);
  return ((h1 ^ h2) >>> 0) & mask;
}

function buildEdgeTable(triCount, triIndices) {
  let validCount = 0;
  for (let f = 0; f < triCount; f++) {
    const base = f * 3;
    const a = triIndices[base];
    const b = triIndices[base + 1];
    const c = triIndices[base + 2];
    if (a !== b && b !== c && c !== a) validCount++;
  }

  const eCap = nextPow2(Math.max(16, Math.ceil(validCount * 3.5)));
  const eMask = eCap - 1;
  const eV1 = new Int32Array(eCap).fill(-1);
  const eV2 = new Int32Array(eCap);
  const eF1 = new Int32Array(eCap).fill(-1);
  const eF2 = new Int32Array(eCap).fill(-1);
  const eCount = new Uint16Array(eCap);
  const eDirMask = new Uint8Array(eCap); // bit 0: lo->hi seen, bit 1: hi->lo seen, bit 2: duplicate directed half-edge

  let uniqueEdges = 0;
  const tempSlots = new Int32Array(Math.max(16, validCount * 3));

  for (let f = 0; f < triCount; f++) {
    const base = f * 3;
    const a = triIndices[base];
    const b = triIndices[base + 1];
    const c = triIndices[base + 2];
    if (a === b || b === c || c === a) continue;

    for (let k = 0; k < 3; k++) {
      const u = k === 0 ? a : k === 1 ? b : c;
      const v = k === 0 ? b : k === 1 ? c : a;
      const forward = u < v;
      const lo = forward ? u : v;
      const hi = forward ? v : u;
      const bit = forward ? 1 : 2;

      let slot = mixEdgeHash(lo, hi, eMask);
      while (true) {
        const cur = eV1[slot];
        if (cur === -1) {
          eV1[slot] = lo;
          eV2[slot] = hi;
          eF1[slot] = f;
          eCount[slot] = 1;
          eDirMask[slot] = bit;
          tempSlots[uniqueEdges++] = slot;
          break;
        }
        if (cur === lo && eV2[slot] === hi) {
          const prevMask = eDirMask[slot];
          if ((prevMask & bit) !== 0) {
            eDirMask[slot] = prevMask | 4;
          } else {
            eDirMask[slot] = prevMask | bit;
          }
          const nextCnt = eCount[slot] < 65535 ? eCount[slot] + 1 : 65535;
          eCount[slot] = nextCnt;
          if (nextCnt === 2) {
            eF2[slot] = f;
          }
          break;
        }
        slot = (slot + 1) & eMask;
      }
    }
  }

  return {
    eV1,
    eV2,
    eF1,
    eF2,
    eCount,
    eDirMask,
    edgeSlots: tempSlots.subarray(0, uniqueEdges),
  };
}

function stitchBoundaryVertices(vertCoords, vertCount, edgeTable, eps = 1e-5) {
  const { eV1, eV2, eCount, edgeSlots } = edgeTable;
  const isBoundary = new Uint8Array(vertCount);
  const boundaryVerts = [];

  for (let i = 0; i < edgeSlots.length; i++) {
    const slot = edgeSlots[i];
    if (eCount[slot] !== 1) continue;
    const u = eV1[slot];
    const v = eV2[slot];
    if (!isBoundary[u]) {
      isBoundary[u] = 1;
      boundaryVerts.push(u);
    }
    if (!isBoundary[v]) {
      isBoundary[v] = 1;
      boundaryVerts.push(v);
    }
  }

  if (boundaryVerts.length === 0) {
    return null;
  }
  if (boundaryVerts.length > 250000) {
    return undefined;
  }

  // Deterministic canonical index ordering so lowest index becomes representative
  boundaryVerts.sort((a, b) => a - b);

  const cellSize = Math.max(eps * 2.5, 1e-6);
  const epsSq = eps * eps;
  const grid = new Map();
  const cellHash = (cx, cy, cz) =>
    ((Math.imul(cx, 73856093) ^ Math.imul(cy, 19349663) ^ Math.imul(cz, 83492791)) >>> 0);

  const boundaryRemap = new Int32Array(vertCount);
  for (let i = 0; i < vertCount; i++) boundaryRemap[i] = i;

  let mergedCount = 0;
  for (let i = 0; i < boundaryVerts.length; i++) {
    const vi = boundaryVerts[i];
    const vo = vi * 3;
    const x = vertCoords[vo];
    const y = vertCoords[vo + 1];
    const z = vertCoords[vo + 2];

    const cx = Math.floor(x / cellSize);
    const cy = Math.floor(y / cellSize);
    const cz = Math.floor(z / cellSize);

    let found = -1;
    let bestDistSq = epsSq;

    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          const bucket = grid.get(cellHash(cx + dx, cy + dy, cz + dz));
          if (!bucket) continue;
          for (let b = 0; b < bucket.length; b++) {
            const cand = bucket[b];
            const co = cand * 3;
            const ddx = vertCoords[co] - x;
            const ddy = vertCoords[co + 1] - y;
            const ddz = vertCoords[co + 2] - z;
            const dSq = ddx * ddx + ddy * ddy + ddz * ddz;
            if (dSq < bestDistSq) {
              bestDistSq = dSq;
              found = cand;
            }
          }
        }
      }
    }

    if (found >= 0) {
      boundaryRemap[vi] = found;
      mergedCount++;
    } else {
      const h = cellHash(cx, cy, cz);
      let bucket = grid.get(h);
      if (!bucket) {
        bucket = [];
        grid.set(h, bucket);
      }
      bucket.push(vi);
    }
  }

  return mergedCount > 0 ? boundaryRemap : null;
}

function computeFacesAndBox(vertCoords, triCount, triIndices) {
  const faceNormalCoords = new Float32Array(triCount * 3);
  const validFace = new Uint8Array(triCount);
  let degenerateTriangles = 0;
  let signedVol6 = 0;

  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

  for (let f = 0; f < triCount; f++) {
    const base = f * 3;
    const a = triIndices[base];
    const b = triIndices[base + 1];
    const c = triIndices[base + 2];
    if (a === b || b === c || c === a) {
      degenerateTriangles++;
      continue;
    }

    const ao = a * 3;
    const bo = b * 3;
    const co = c * 3;

    const ax = vertCoords[ao], ay = vertCoords[ao + 1], az = vertCoords[ao + 2];
    const bx = vertCoords[bo], by = vertCoords[bo + 1], bz = vertCoords[bo + 2];
    const cx = vertCoords[co], cy = vertCoords[co + 1], cz = vertCoords[co + 2];

    if (ax < minX) minX = ax; if (ax > maxX) maxX = ax;
    if (ay < minY) minY = ay; if (ay > maxY) maxY = ay;
    if (az < minZ) minZ = az; if (az > maxZ) maxZ = az;
    if (bx < minX) minX = bx; if (bx > maxX) maxX = bx;
    if (by < minY) minY = by; if (by > maxY) maxY = by;
    if (bz < minZ) minZ = bz; if (bz > maxZ) maxZ = bz;
    if (cx < minX) minX = cx; if (cx > maxX) maxX = cx;
    if (cy < minY) minY = cy; if (cy > maxY) maxY = cy;
    if (cz < minZ) minZ = cz; if (cz > maxZ) maxZ = cz;

    const abx = bx - ax, aby = by - ay, abz = bz - az;
    const acx = cx - ax, acy = cy - ay, acz = cz - az;
    const nx = aby * acz - abz * acy;
    const ny = abz * acx - abx * acz;
    const nz = abx * acy - aby * acx;
    const lenSq = nx * nx + ny * ny + nz * nz;
    if (lenSq < 1e-18) {
      degenerateTriangles++;
      continue;
    }

    const inv = 1 / Math.sqrt(lenSq);
    faceNormalCoords[base] = nx * inv;
    faceNormalCoords[base + 1] = ny * inv;
    faceNormalCoords[base + 2] = nz * inv;
    validFace[f] = 1;

    signedVol6 +=
      ax * (by * cz - bz * cy) +
      ay * (bz * cx - bx * cz) +
      az * (bx * cy - by * cx);
  }

  if (minX === Infinity) {
    minX = minY = minZ = maxX = maxY = maxZ = 0;
  }

  const sizeX = maxX - minX;
  const sizeY = maxY - minY;
  const sizeZ = maxZ - minZ;

  return {
    faceNormalCoords,
    validFace,
    degenerateTriangles,
    signedVolume: signedVol6 / 6,
    bbox: {
      minX, minY, minZ,
      maxX, maxY, maxZ,
      sizeX, sizeY, sizeZ,
      centerX: (minX + maxX) * 0.5,
      centerY: (minY + maxY) * 0.5,
      centerZ: (minZ + maxZ) * 0.5,
      maxDim: Math.max(sizeX, sizeY, sizeZ, 1.0),
    },
  };
}

function countOpenEdges(edgeTable) {
  let open = 0;
  const { eCount, edgeSlots } = edgeTable;
  for (let i = 0; i < edgeSlots.length; i++) {
    if (eCount[edgeSlots[i]] === 1) open++;
  }
  return open;
}

function weldPositionsHash(pos, posCount, srcIdx, triCount) {
  let maxAbs = 0;
  for (let i = 0; i < posCount * 3; i++) {
    const a = Math.abs(pos[i]);
    if (a > maxAbs) maxAbs = a;
  }
  const quant = Math.min(1e6, maxAbs > 1000 ? Math.max(100, Math.floor(1e9 / maxAbs)) : 1e6);

  const cap = nextPow2(posCount * 2);
  const mask = cap - 1;
  const table = new Int32Array(cap).fill(-1);
  const uniqQ = new Int32Array(posCount * 3);
  const uniqPos = new Float32Array(posCount * 3);
  const remap = new Uint32Array(posCount);
  let vertCount = 0;

  for (let i = 0; i < posCount; i++) {
    const o = i * 3;
    const x = pos[o];
    const y = pos[o + 1];
    const z = pos[o + 2];
    const qx = Math.round(x * quant) | 0;
    const qy = Math.round(y * quant) | 0;
    const qz = Math.round(z * quant) | 0;

    let slot = (Math.imul(qx, 73856093) ^ Math.imul(qy, 19349663) ^ Math.imul(qz, 83492791)) & mask;
    let found = -1;
    while (true) {
      const idx = table[slot];
      if (idx === -1) break;
      const uo = idx * 3;
      if (uniqQ[uo] === qx && uniqQ[uo + 1] === qy && uniqQ[uo + 2] === qz) {
        found = idx;
        break;
      }
      slot = (slot + 1) & mask;
    }

    if (found >= 0) {
      remap[i] = found;
    } else {
      const idx = vertCount++;
      const uo = idx * 3;
      uniqQ[uo] = qx;
      uniqQ[uo + 1] = qy;
      uniqQ[uo + 2] = qz;
      uniqPos[uo] = x;
      uniqPos[uo + 1] = y;
      uniqPos[uo + 2] = z;
      table[slot] = idx;
      remap[i] = idx;
    }
  }

  // Copy compacted slice when significant duplicate compression occurred so scratch memory frees cleanly
  const vertCoords =
    vertCount * 3 < uniqPos.length * 0.85
      ? uniqPos.slice(0, vertCount * 3)
      : uniqPos.subarray(0, vertCount * 3);

  const triIndices = new Uint32Array(triCount * 3);
  if (srcIdx) {
    for (let i = 0; i < triCount * 3; i++) {
      triIndices[i] = remap[srcIdx[i]];
    }
  } else {
    for (let i = 0; i < triCount * 3; i++) {
      triIndices[i] = remap[i];
    }
  }

  return { vertCoords, vertCount, triIndices };
}

/**
 * Compute (or retrieve cached) TypedArray mesh topology & diagnostics for a BufferGeometry.
 * Performs fast open-addressing integer spatial hashing without per-vertex objects or string Maps.
 *
 * @param {THREE.BufferGeometry} geometry
 */
export function getFastMeshTopology(geometry) {
  if (!geometry) return null;
  const cached = topologyCache.get(geometry);
  if (cached) return cached;

  const posAttr = geometry.getAttribute('position');
  if (!posAttr || posAttr.count < 3) {
    const empty = {
      vertCount: 0,
      triCount: 0,
      vertCoords: new Float32Array(0),
      triIndices: new Uint32Array(0),
      faceNormalCoords: new Float32Array(0),
      validFace: new Uint8Array(0),
      degenerateTriangles: 0,
      signedVolume: 0,
      bbox: {
        minX: 0, minY: 0, minZ: 0,
        maxX: 0, maxY: 0, maxZ: 0,
        sizeX: 0, sizeY: 0, sizeZ: 0,
        centerX: 0, centerY: 0, centerZ: 0,
        maxDim: 1.0,
      },
      eV1: new Int32Array(0),
      eV2: new Int32Array(0),
      eF1: new Int32Array(0),
      eF2: new Int32Array(0),
      eCount: new Uint16Array(0),
      eDirMask: new Uint8Array(0),
      edgeSlots: new Int32Array(0),
      openEdges: 0,
      nonManifoldEdges: 0,
      totalManifoldEdges: 0,
      coplanarEdges: 0,
      nearFlatEdges: 0,
    };
    topologyCache.set(geometry, empty);
    return empty;
  }

  const pos = posAttr.array;
  const posCount = posAttr.count;
  const idxAttr = geometry.index;
  const srcIdx = idxAttr ? idxAttr.array : null;
  const triCount = Math.floor((srcIdx ? srcIdx.length : posCount) / 3);

  let vertCoords;
  let vertCount;
  let triIndices;
  let faceData;
  let edgeTable;

  if (srcIdx) {
    // Preserve already-indexed topology directly (avoids collapsing intentional Manifold pinch vertices)
    vertCount = posCount;
    vertCoords =
      pos instanceof Float32Array
        ? pos.subarray(0, posCount * 3)
        : new Float32Array(pos.subarray ? pos.subarray(0, posCount * 3) : pos);
    triIndices = new Uint32Array(triCount * 3);
    for (let i = 0; i < triCount * 3; i++) {
      triIndices[i] = srcIdx[i];
    }
    faceData = computeFacesAndBox(vertCoords, triCount, triIndices);
    edgeTable = buildEdgeTable(triCount, triIndices);

    const initialOpenCount = countOpenEdges(edgeTable);
    if (initialOpenCount > 0) {
      const boundaryRemap = stitchBoundaryVertices(vertCoords, vertCount, edgeTable, 1e-5);
      if (boundaryRemap) {
        for (let i = 0; i < triIndices.length; i++) {
          triIndices[i] = boundaryRemap[triIndices[i]];
        }
        faceData = computeFacesAndBox(vertCoords, triCount, triIndices);
        edgeTable = buildEdgeTable(triCount, triIndices);
      } else if (boundaryRemap === undefined) {
        // Overflowed boundary cap (>250k boundary verts): fall back to full spatial-hash weld
        ({ vertCoords, vertCount, triIndices } = weldPositionsHash(pos, posCount, srcIdx, triCount));
        faceData = computeFacesAndBox(vertCoords, triCount, triIndices);
        edgeTable = buildEdgeTable(triCount, triIndices);
        if (countOpenEdges(edgeTable) > 0) {
          const fallbackRemap = stitchBoundaryVertices(vertCoords, vertCount, edgeTable, 1e-5);
          if (fallbackRemap) {
            for (let i = 0; i < triIndices.length; i++) {
              triIndices[i] = fallbackRemap[triIndices[i]];
            }
            faceData = computeFacesAndBox(vertCoords, triCount, triIndices);
            edgeTable = buildEdgeTable(triCount, triIndices);
          }
        }
      }
    }
  } else {
    ({ vertCoords, vertCount, triIndices } = weldPositionsHash(pos, posCount, null, triCount));
    faceData = computeFacesAndBox(vertCoords, triCount, triIndices);
    edgeTable = buildEdgeTable(triCount, triIndices);

    // Boundary-safe epsilon pass to merge float-straddling seams without paying global 27-neighbor cost
    if (countOpenEdges(edgeTable) > 0) {
      const boundaryRemap = stitchBoundaryVertices(vertCoords, vertCount, edgeTable, 1e-5);
      if (boundaryRemap) {
        for (let i = 0; i < triIndices.length; i++) {
          triIndices[i] = boundaryRemap[triIndices[i]];
        }
        faceData = computeFacesAndBox(vertCoords, triCount, triIndices);
        edgeTable = buildEdgeTable(triCount, triIndices);
      }
    }
  }

  let openEdges = 0;
  let nonManifoldEdges = 0;
  let totalManifoldEdges = 0;
  let coplanarEdges = 0;
  let nearFlatEdges = 0;

  const { eF1, eF2, eCount, eDirMask, edgeSlots } = edgeTable;
  const fn = faceData.faceNormalCoords;
  const validFace = faceData.validFace;

  for (let i = 0; i < edgeSlots.length; i++) {
    const slot = edgeSlots[i];
    const cnt = eCount[slot];
    if (cnt === 1) {
      openEdges++;
    } else if (cnt > 2 || (eDirMask[slot] & 4) !== 0) {
      nonManifoldEdges++;
    } else {
      totalManifoldEdges++;
      const f1Idx = eF1[slot];
      const f2Idx = eF2[slot];
      if (!validFace[f1Idx] || !validFace[f2Idx]) continue;
      const f1 = f1Idx * 3;
      const f2 = f2Idx * 3;
      const dot =
        fn[f1] * fn[f2] +
        fn[f1 + 1] * fn[f2 + 1] +
        fn[f1 + 2] * fn[f2 + 2];
      if (dot > 0.99996) coplanarEdges++;
      if (dot > 0.99905) nearFlatEdges++;
    }
  }

  const topology = {
    vertCount,
    triCount,
    vertCoords,
    triIndices,
    faceNormalCoords: faceData.faceNormalCoords,
    validFace: faceData.validFace,
    degenerateTriangles: faceData.degenerateTriangles,
    signedVolume: faceData.signedVolume,
    bbox: faceData.bbox,
    eV1: edgeTable.eV1,
    eV2: edgeTable.eV2,
    eF1: edgeTable.eF1,
    eF2: edgeTable.eF2,
    eCount: edgeTable.eCount,
    eDirMask: edgeTable.eDirMask,
    edgeSlots: edgeTable.edgeSlots,
    openEdges,
    nonManifoldEdges,
    totalManifoldEdges,
    coplanarEdges,
    nearFlatEdges,
  };

  topologyCache.set(geometry, topology);
  return topology;
}

/**
 * Construct a compact indexed THREE.BufferGeometry from cached TypedArray topology.
 *
 * @param {ReturnType<typeof getFastMeshTopology>} topology
 * @param {object} [options]
 * @param {boolean} [options.flipWinding=false]
 * @param {boolean} [options.center=false]
 * @returns {THREE.BufferGeometry}
 */
export function buildIndexedGeometryFromTopology(topology, options = {}) {
  const { flipWinding = false, center = false } = options;
  const geo = new THREE.BufferGeometry();
  if (!topology || topology.vertCount === 0 || topology.triCount === 0) {
    return geo;
  }

  const posOut = new Float32Array(topology.vertCoords);
  if (center) {
    const { centerX, centerY, centerZ } = topology.bbox;
    for (let i = 0; i < posOut.length; i += 3) {
      posOut[i] -= centerX;
      posOut[i + 1] -= centerY;
      posOut[i + 2] -= centerZ;
    }
  }

  let validTriCount = 0;
  const srcTris = topology.triIndices;
  for (let f = 0; f < topology.triCount; f++) {
    const a = srcTris[f * 3];
    const b = srcTris[f * 3 + 1];
    const c = srcTris[f * 3 + 2];
    if (a !== b && b !== c && c !== a) validTriCount++;
  }

  const IndexArray = topology.vertCount > 65535 ? Uint32Array : Uint16Array;
  const idxOut = new IndexArray(validTriCount * 3);
  let ptr = 0;
  for (let f = 0; f < topology.triCount; f++) {
    const a = srcTris[f * 3];
    const b = srcTris[f * 3 + 1];
    const c = srcTris[f * 3 + 2];
    if (a === b || b === c || c === a) continue;
    idxOut[ptr++] = a;
    if (flipWinding) {
      idxOut[ptr++] = c;
      idxOut[ptr++] = b;
    } else {
      idxOut[ptr++] = b;
      idxOut[ptr++] = c;
    }
  }

  geo.setAttribute('position', new THREE.BufferAttribute(posOut, 3));
  geo.setIndex(new THREE.BufferAttribute(idxOut, 1));
  geo.computeVertexNormals();
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return geo;
}

/**
 * Extract sharp crease & boundary line segments straight from cached topology
 * (~15 ms on 2M triangles vs multi-second THREE.EdgesGeometry string-keyed allocation).
 *
 * @param {ReturnType<typeof getFastMeshTopology>} topology
 * @param {number} [thresholdDeg=14]
 * @returns {THREE.BufferGeometry}
 */
export function buildCreaseGeometryFromTopology(topology, thresholdDeg = 14) {
  const geo = new THREE.BufferGeometry();
  if (!topology || topology.edgeSlots.length === 0) {
    geo.setAttribute('position', new THREE.Float32BufferAttribute([], 3));
    return geo;
  }

  const thresholdCos = Math.cos((thresholdDeg * Math.PI) / 180) + 1e-6;
  const { vertCoords, faceNormalCoords, validFace, eV1, eV2, eF1, eF2, eCount, edgeSlots } = topology;
  const slotCount = edgeSlots.length;

  let creaseCount = 0;
  for (let i = 0; i < slotCount; i++) {
    const slot = edgeSlots[i];
    const cnt = eCount[slot];
    if (cnt === 1) {
      creaseCount++;
    } else if (cnt >= 2) {
      const f1Idx = eF1[slot];
      const f2Idx = eF2[slot];
      if (!validFace[f1Idx] || !validFace[f2Idx]) continue;
      const f1 = f1Idx * 3;
      const f2 = f2Idx * 3;
      const dot =
        faceNormalCoords[f1] * faceNormalCoords[f2] +
        faceNormalCoords[f1 + 1] * faceNormalCoords[f2 + 1] +
        faceNormalCoords[f1 + 2] * faceNormalCoords[f2 + 2];
      if (dot <= thresholdCos) {
        creaseCount++;
      }
    }
  }

  const positions = new Float32Array(creaseCount * 6);
  let ptr = 0;
  for (let i = 0; i < slotCount; i++) {
    const slot = edgeSlots[i];
    const cnt = eCount[slot];
    let isCrease = cnt === 1;
    if (!isCrease && cnt >= 2) {
      const f1Idx = eF1[slot];
      const f2Idx = eF2[slot];
      if (!validFace[f1Idx] || !validFace[f2Idx]) continue;
      const f1 = f1Idx * 3;
      const f2 = f2Idx * 3;
      const dot =
        faceNormalCoords[f1] * faceNormalCoords[f2] +
        faceNormalCoords[f1 + 1] * faceNormalCoords[f2 + 1] +
        faceNormalCoords[f1 + 2] * faceNormalCoords[f2 + 2];
      isCrease = dot <= thresholdCos;
    }
    if (!isCrease) continue;

    const v1o = eV1[slot] * 3;
    const v2o = eV2[slot] * 3;
    positions[ptr++] = vertCoords[v1o];
    positions[ptr++] = vertCoords[v1o + 1];
    positions[ptr++] = vertCoords[v1o + 2];
    positions[ptr++] = vertCoords[v2o];
    positions[ptr++] = vertCoords[v2o + 1];
    positions[ptr++] = vertCoords[v2o + 2];
  }

  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.computeBoundingSphere();
  return geo;
}

/**
 * Pure TypedArray union-find connected-components analyzer matching meshFixer.js debris thresholds.
 *
 * @param {ReturnType<typeof getFastMeshTopology>} topology
 * @param {number} [maxAreaRatio=0.05]
 * @returns {{ componentCount: number, disconnectedParts: number, disconnectedTriangles: number }}
 */
export function analyzeConnectedComponentsFast(topology, maxAreaRatio = 0.05) {
  if (!topology || topology.triCount === 0 || topology.vertCount === 0) {
    return { componentCount: 0, disconnectedParts: 0, disconnectedTriangles: 0 };
  }

  const { vertCount, triCount, vertCoords, triIndices } = topology;
  const parent = new Int32Array(vertCount);
  for (let i = 0; i < vertCount; i++) parent[i] = i;

  const find = (x) => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };

  const union = (x, y) => {
    const rx = find(x);
    const ry = find(y);
    if (rx !== ry) parent[ry] = rx;
  };

  for (let f = 0; f < triCount; f++) {
    const o = f * 3;
    const a = triIndices[o];
    const b = triIndices[o + 1];
    const c = triIndices[o + 2];
    if (a === b || b === c || c === a) continue;
    union(a, b);
    union(a, c);
  }

  const byRoot = new Map();
  for (let f = 0; f < triCount; f++) {
    const o = f * 3;
    const a = triIndices[o];
    const b = triIndices[o + 1];
    const c = triIndices[o + 2];
    if (a === b || b === c || c === a) continue;

    const root = find(a);
    let comp = byRoot.get(root);
    if (!comp) {
      comp = {
        triCount: 0,
        area: 0,
        minX: Infinity, minY: Infinity, minZ: Infinity,
        maxX: -Infinity, maxY: -Infinity, maxZ: -Infinity,
      };
      byRoot.set(root, comp);
    }

    const ao = a * 3, bo = b * 3, co = c * 3;
    const ax = vertCoords[ao], ay = vertCoords[ao + 1], az = vertCoords[ao + 2];
    const bx = vertCoords[bo], by = vertCoords[bo + 1], bz = vertCoords[bo + 2];
    const cx = vertCoords[co], cy = vertCoords[co + 1], cz = vertCoords[co + 2];

    const abx = bx - ax, aby = by - ay, abz = bz - az;
    const acx = cx - ax, acy = cy - ay, acz = cz - az;
    const nx = aby * acz - abz * acy;
    const ny = abz * acx - abx * acz;
    const nz = abx * acy - aby * acx;

    comp.triCount++;
    comp.area += 0.5 * Math.hypot(nx, ny, nz);

    if (ax < comp.minX) comp.minX = ax; if (ax > comp.maxX) comp.maxX = ax;
    if (ay < comp.minY) comp.minY = ay; if (ay > comp.maxY) comp.maxY = ay;
    if (az < comp.minZ) comp.minZ = az; if (az > comp.maxZ) comp.maxZ = az;
    if (bx < comp.minX) comp.minX = bx; if (bx > comp.maxX) comp.maxX = bx;
    if (by < comp.minY) comp.minY = by; if (by > comp.maxY) comp.maxY = by;
    if (bz < comp.minZ) comp.minZ = bz; if (bz > comp.maxZ) comp.maxZ = bz;
    if (cx < comp.minX) comp.minX = cx; if (cx > comp.maxX) comp.maxX = cx;
    if (cy < comp.minY) comp.minY = cy; if (cy > comp.maxY) comp.maxY = cy;
    if (cz < comp.minZ) comp.minZ = cz; if (cz > comp.maxZ) comp.maxZ = cz;
  }

  const components = Array.from(byRoot.values());
  if (components.length <= 1) {
    return {
      componentCount: components.length,
      disconnectedParts: 0,
      disconnectedTriangles: 0,
    };
  }

  components.sort((a, b) => b.area - a.area);
  const main = components[0];
  const mainDiag = Math.hypot(main.maxX - main.minX, main.maxY - main.minY, main.maxZ - main.minZ);
  let disconnectedParts = 0;
  let disconnectedTriangles = 0;

  for (let i = 1; i < components.length; i++) {
    const c = components[i];
    const diag = Math.hypot(c.maxX - c.minX, c.maxY - c.minY, c.maxZ - c.minZ);
    if (c.area < main.area * maxAreaRatio && diag < mainDiag * 0.5) {
      disconnectedParts++;
      disconnectedTriangles += c.triCount;
    }
  }

  return {
    componentCount: components.length,
    disconnectedParts,
    disconnectedTriangles,
  };
}

/**
 * Inspect mesh topology to detect over-tessellated or redundant flat triangulation.
 *
 * @param {ReturnType<typeof getFastMeshTopology>} topology
 */
export function detectUnoptimizedMesh(topology) {
  if (!topology || topology.triCount === 0) {
    return {
      triCount: 0,
      vertCount: 0,
      coplanarRatio: 0,
      nearFlatRatio: 0,
      coplanarPct: 0,
      nearFlatPct: 0,
      isManifold: true,
      isUnoptimized: false,
      estimatedReductionPct: 0,
      reason: 'Empty mesh',
    };
  }

  const denom = Math.max(1, topology.totalManifoldEdges);
  const coplanarRatio = topology.coplanarEdges / denom;
  const nearFlatRatio = topology.nearFlatEdges / denom;
  const coplanarPct = Math.round(coplanarRatio * 1000) / 10;
  const nearFlatPct = Math.round(nearFlatRatio * 1000) / 10;
  const isManifold = topology.openEdges === 0 && topology.nonManifoldEdges === 0;

  const isUnoptimized =
    (topology.triCount >= 25000 && (coplanarRatio >= 0.60 || nearFlatRatio >= 0.78)) ||
    topology.triCount >= 100000;

  const flatEstimate = Math.round(Math.min(97, Math.max(coplanarRatio, nearFlatRatio * 0.95) * 100));
  const estimatedReductionPct =
    topology.triCount >= 100000 ? Math.max(70, flatEstimate) : flatEstimate;

  let reason = 'Cleanly tessellated CAD mesh';
  if (isUnoptimized) {
    if (coplanarRatio >= 0.60) {
      reason = `${coplanarPct.toFixed(1)}% of shared edges are redundant coplanar flat faces`;
    } else if (nearFlatRatio >= 0.78) {
      reason = `${nearFlatPct.toFixed(1)}% of shared edges are near-flat micro-facets`;
    } else {
      reason = `Very high polygon density (${topology.triCount.toLocaleString()} triangles)`;
    }
  }

  return {
    triCount: topology.triCount,
    vertCount: topology.vertCount,
    coplanarRatio,
    nearFlatRatio,
    coplanarPct,
    nearFlatPct,
    isManifold,
    isUnoptimized,
    estimatedReductionPct,
    reason,
  };
}
