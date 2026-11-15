/* ============================================================
   meshFixer.js — Mesh diagnostics, seam stitching, T-junction
   repair, ear-clipping hole filling & normal orientation
   ============================================================ */
import * as THREE from 'three';
import { Brush, Evaluator, SUBTRACTION } from 'three-bvh-csg';
import { repairMeshWasm, isWasmMeshFixSupported } from './wasmMeshFix.js';

/**
 * Extract raw vertex array and triangle index triples via boundary-safe
 * 27-neighbor spatial hashing within `eps`.
 */
function extractWeldedMesh(geometry, eps = 1e-5) {
  const posAttr = geometry.getAttribute('position');
  if (!posAttr || posAttr.count < 3) {
    return { vertices: [], tris: [] };
  }

  const posArray = posAttr.array;
  const indexed = !!geometry.index;
  const indices = indexed ? geometry.index.array : null;
  const triCount = Math.floor(indexed ? geometry.index.count / 3 : posAttr.count / 3);

  if (indexed) {
    const vCount = posAttr.count;
    const vertices = new Array(vCount);
    for (let i = 0; i < vCount; i++) {
      vertices[i] = new THREE.Vector3(posArray[i * 3], posArray[i * 3 + 1], posArray[i * 3 + 2]);
    }
    const tris = new Array(triCount);
    for (let f = 0; f < triCount; f++) {
      tris[f] = [indices[f * 3], indices[f * 3 + 1], indices[f * 3 + 2]];
    }
    return { vertices, tris };
  }

  const cellSize = Math.max(eps * 2.5, 1e-6);
  const epsSq = eps * eps;
  const grid = new Map();
  const vertices = [];
  const remap = new Int32Array(posAttr.count);

  const cellHash = (cx, cy, cz) => (((cx * 73856093) ^ (cy * 19349663) ^ (cz * 83492791)) >>> 0);

  for (let i = 0; i < posAttr.count; i++) {
    const x = posArray[i * 3];
    const y = posArray[i * 3 + 1];
    const z = posArray[i * 3 + 2];

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
          for (const vIdx of bucket) {
            const v = vertices[vIdx];
            const dSq = (v.x - x) ** 2 + (v.y - y) ** 2 + (v.z - z) ** 2;
            if (dSq < bestDistSq) {
              bestDistSq = dSq;
              found = vIdx;
            }
          }
        }
      }
    }

    if (found >= 0) {
      remap[i] = found;
    } else {
      const idx = vertices.length;
      vertices.push(new THREE.Vector3(x, y, z));
      remap[i] = idx;
      const h = cellHash(cx, cy, cz);
      let bucket = grid.get(h);
      if (!bucket) { bucket = []; grid.set(h, bucket); }
      bucket.push(idx);
    }
  }

  const tris = [];
  for (let f = 0; f < triCount; f++) {
    const a = remap[indexed ? indices[f * 3] : f * 3];
    const b = remap[indexed ? indices[f * 3 + 1] : f * 3 + 1];
    const c = remap[indexed ? indices[f * 3 + 2] : f * 3 + 2];
    tris.push([a, b, c]);
  }

  return { vertices, tris };
}

function isDegenerateTri(vertices, a, b, c, areaEpsSq = 1e-18) {
  if (a === b || b === c || c === a) return true;
  const va = vertices[a];
  const vb = vertices[b];
  const vc = vertices[c];
  const abx = vb.x - va.x, aby = vb.y - va.y, abz = vb.z - va.z;
  const acx = vc.x - va.x, acy = vc.y - va.y, acz = vc.z - va.z;
  const cx = aby * acz - abz * acy;
  const cy = abz * acx - abx * acz;
  const cz = abx * acy - aby * acx;
  const crossSq = cx * cx + cy * cy + cz * cz;
  return crossSq < areaEpsSq;
}

function canonicalTriKey(a, b, c) {
  const arr = [a, b, c].sort((x, y) => x - y);
  return `${arr[0]}_${arr[1]}_${arr[2]}`;
}

function edgeKey(a, b) {
  return a < b ? `${a}_${b}` : `${b}_${a}`;
}

/**
 * Compute edge adjacency counts and directed half-edges across valid triangles.
 */
function buildTopology(vertices, tris) {
  const undirectedCounts = new Map();
  const undirectedTris = new Map();
  const halfEdgeCounts = new Map();
  let degenerateTriangles = 0;

  for (let f = 0; f < tris.length; f++) {
    const [a, b, c] = tris[f];
    if (isDegenerateTri(vertices, a, b, c)) {
      degenerateTriangles++;
      continue;
    }

    for (const [u, v] of [[a, b], [b, c], [c, a]]) {
      const ek = edgeKey(u, v);
      undirectedCounts.set(ek, (undirectedCounts.get(ek) || 0) + 1);
      if (!undirectedTris.has(ek)) undirectedTris.set(ek, []);
      undirectedTris.get(ek).push(f);

      const hk = `${u}->${v}`;
      halfEdgeCounts.set(hk, (halfEdgeCounts.get(hk) || 0) + 1);
    }
  }

  let openEdges = 0;
  let nonManifoldEdges = 0;
  const openHalfEdges = []; // boundary directed half-edge (u, v) on existing tri

  for (const [ek, count] of undirectedCounts) {
    const [s0, s1] = ek.split('_');
    const a = parseInt(s0, 10);
    const b = parseInt(s1, 10);
    if (count === 1) {
      openEdges++;
      if ((halfEdgeCounts.get(`${a}->${b}`) || 0) > 0) {
        openHalfEdges.push([a, b, undirectedTris.get(ek)[0]]);
      } else {
        openHalfEdges.push([b, a, undirectedTris.get(ek)[0]]);
      }
    } else if (count > 2) {
      nonManifoldEdges++;
    } else {
      // Check if two adjacent triangles share the SAME half-edge orientation
      if (
        (halfEdgeCounts.get(`${a}->${b}`) || 0) > 1 ||
        (halfEdgeCounts.get(`${b}->${a}`) || 0) > 1
      ) {
        nonManifoldEdges++;
      }
    }
  }

  return {
    degenerateTriangles,
    openEdges,
    nonManifoldEdges,
    openHalfEdges,
    undirectedTris,
    halfEdgeCounts,
  };
}

/**
 * Trace distinct closed hole boundary loops from open half-edges.
 * Each existing open half-edge (u -> v) induces a hole perimeter edge (v -> u).
 */
function traceHoleLoops(vertices, openHalfEdges) {
  const adj = new Map();
  const used = new Set();

  // Reverse direction (v -> u) traces the perimeter of the missing cap
  const dirEdges = openHalfEdges.map(([u, v], idx) => ({ from: v, to: u, idx }));
  for (const e of dirEdges) {
    if (!adj.has(e.from)) adj.set(e.from, []);
    adj.get(e.from).push(e);
  }

  const loops = [];

  for (let i = 0; i < dirEdges.length; i++) {
    if (used.has(i)) continue;
    const startE = dirEdges[i];
    used.add(i);

    const loop = [startE.from];
    let curr = startE.to;
    let prevPos = vertices[startE.from];
    let guard = dirEdges.length + 2;

    while (curr !== startE.from && guard-- > 0) {
      loop.push(curr);
      const candidates = (adj.get(curr) || []).filter((e) => !used.has(e.idx));
      if (candidates.length === 0) break;

      let chosen = candidates[0];
      if (candidates.length > 1) {
        // Prefer tightest turn to keep pinched figure-8 holes separated
        const inDir = new THREE.Vector3().subVectors(vertices[curr], prevPos).normalize();
        let bestScore = -Infinity;
        for (const c of candidates) {
          const outDir = new THREE.Vector3().subVectors(vertices[c.to], vertices[curr]).normalize();
          const score = inDir.dot(outDir);
          if (score > bestScore) {
            bestScore = score;
            chosen = c;
          }
        }
      }

      used.add(chosen.idx);
      prevPos = vertices[curr];
      curr = chosen.to;
    }

    if (curr === startE.from && loop.length >= 3) {
      loops.push({ vertices: loop, closed: true });
    } else if (loop.length >= 3) {
      loops.push({ vertices: loop, closed: false });
    }
  }

  return loops;
}

/**
 * Analyze a BufferGeometry for open boundary holes, non-manifold edges,
 * degenerate triangles, and broken or unconnected mesh parts.
 *
 * @param {THREE.BufferGeometry} geometry
 * @returns {{ openEdges: number, holeLoops: number, nonManifoldEdges: number, degenerateTriangles: number, disconnectedParts: number, disconnectedTriangles: number, isWatertight: boolean, issueCount: number }}
 */
export function analyzeMesh(geometry) {
  if (!geometry || !geometry.getAttribute('position')) {
    return {
      openEdges: 0,
      holeLoops: 0,
      nonManifoldEdges: 0,
      degenerateTriangles: 0,
      disconnectedParts: 0,
      disconnectedTriangles: 0,
      isWatertight: true,
      issueCount: 0,
    };
  }

  const { vertices, tris } = extractWeldedMesh(geometry, 1e-5);
  const topo = buildTopology(vertices, tris);
  const loops = traceHoleLoops(vertices, topo.openHalfEdges);
  const closedLoops = loops.filter((l) => l.closed).length;
  const holeLoops = closedLoops > 0 ? closedLoops : (topo.openEdges > 0 ? loops.length : 0);
  const components = findConnectedComponents(vertices, tris);
  const removable = components.filter((c) => c.isRemovable);
  const disconnectedParts = removable.length;
  let disconnectedTriangles = 0;
  for (const c of removable) disconnectedTriangles += c.triCount;
  const issueCount =
    topo.openEdges +
    topo.nonManifoldEdges +
    topo.degenerateTriangles +
    disconnectedParts;

  return {
    openEdges: topo.openEdges,
    holeLoops,
    nonManifoldEdges: topo.nonManifoldEdges,
    degenerateTriangles: topo.degenerateTriangles,
    disconnectedParts,
    disconnectedTriangles,
    isWatertight: issueCount === 0,
    issueCount,
  };
}

/**
 * Compute Newell best-fit polygon normal for a closed loop of 3D vertices.
 */
function computeNewellNormal(pts) {
  const n = new THREE.Vector3();
  for (let i = 0; i < pts.length; i++) {
    const p1 = pts[i];
    const p2 = pts[(i + 1) % pts.length];
    n.x += (p1.y - p2.y) * (p1.z + p2.z);
    n.y += (p1.z - p2.z) * (p1.x + p2.x);
    n.z += (p1.x - p2.x) * (p1.y + p2.y);
  }
  if (n.lengthSq() < 1e-16) {
    // Fallback to cross of first valid pair
    for (let i = 1; i < pts.length - 1; i++) {
      const a = new THREE.Vector3().subVectors(pts[i], pts[0]);
      const b = new THREE.Vector3().subVectors(pts[i + 1], pts[0]);
      const c = new THREE.Vector3().crossVectors(a, b);
      if (c.lengthSq() > 1e-16) return c.normalize();
    }
    return new THREE.Vector3(0, 1, 0);
  }
  return n.normalize();
}

function pointInTri2D(px, py, ax, ay, bx, by, cx, cy) {
  const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by);
  const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy);
  const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay);
  const hasNeg = d1 < -1e-9 || d2 < -1e-9 || d3 < -1e-9;
  const hasPos = d1 > 1e-9 || d2 > 1e-9 || d3 > 1e-9;
  return !(hasNeg && hasPos);
}

/**
 * Triangulate a closed 3D hole loop using projected 2D ear-clipping.
 * Returns array of [vi0, vi1, vi2] triangles wound consistently with `loop`.
 */
function triangulateHoleLoop(vertices, loop) {
  if (loop.length < 3) return [];
  if (loop.length === 3) {
    return [[loop[0], loop[1], loop[2]]];
  }

  const pts = loop.map((idx) => vertices[idx]);
  const normal = computeNewellNormal(pts);

  // Build orthonormal basis (U, V) on Newell plane
  const up = Math.abs(normal.z) < 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0);
  const uAxis = new THREE.Vector3().crossVectors(up, normal).normalize();
  const vAxis = new THREE.Vector3().crossVectors(normal, uAxis).normalize();

  const origin = pts[0];
  const proj2D = pts.map((p) => {
    const rel = new THREE.Vector3().subVectors(p, origin);
    return { x: rel.dot(uAxis), y: rel.dot(vAxis) };
  });

  // Verify signed area in 2D matches +1 CCW wrt normal
  let area2 = 0;
  for (let i = 0; i < proj2D.length; i++) {
    const p1 = proj2D[i];
    const p2 = proj2D[(i + 1) % proj2D.length];
    area2 += p1.x * p2.y - p2.x * p1.y;
  }
  const orient = area2 >= 0 ? 1 : -1;

  const remaining = loop.map((vi, idx) => ({ vi, p: proj2D[idx] }));
  const result = [];
  let guard = loop.length * loop.length + 10;

  while (remaining.length > 3 && guard-- > 0) {
    let earFound = false;

    for (let i = 0; i < remaining.length; i++) {
      const n = remaining.length;
      const prev = remaining[(i - 1 + n) % n];
      const curr = remaining[i];
      const next = remaining[(i + 1) % n];

      const cross =
        ((curr.p.x - prev.p.x) * (next.p.y - prev.p.y) -
          (curr.p.y - prev.p.y) * (next.p.x - prev.p.x)) *
        orient;

      if (cross <= 1e-10) continue; // Reflex or collinear

      let containsOther = false;
      for (let j = 0; j < n; j++) {
        if (j === (i - 1 + n) % n || j === i || j === (i + 1) % n) continue;
        const pt = remaining[j].p;
        if (
          pointInTri2D(
            pt.x, pt.y,
            prev.p.x, prev.p.y,
            curr.p.x, curr.p.y,
            next.p.x, next.p.y
          )
        ) {
          containsOther = true;
          break;
        }
      }

      if (!containsOther) {
        result.push([prev.vi, curr.vi, next.vi]);
        remaining.splice(i, 1);
        earFound = true;
        break;
      }
    }

    if (!earFound) {
      // Degenerate/twisted loop fallback: clip shortest perimeter corner ear
      let bestIdx = 0;
      let bestPerim = Infinity;
      const n = remaining.length;
      for (let i = 0; i < n; i++) {
        const a = vertices[remaining[(i - 1 + n) % n].vi];
        const b = vertices[remaining[i].vi];
        const c = vertices[remaining[(i + 1) % n].vi];
        const perim = a.distanceTo(c) + a.distanceTo(b) + b.distanceTo(c);
        if (perim < bestPerim) {
          bestPerim = perim;
          bestIdx = i;
        }
      }
      const prev = remaining[(bestIdx - 1 + n) % n];
      const curr = remaining[bestIdx];
      const next = remaining[(bestIdx + 1) % n];
      result.push([prev.vi, curr.vi, next.vi]);
      remaining.splice(bestIdx, 1);
    }
  }

  if (remaining.length === 3) {
    result.push([remaining[0].vi, remaining[1].vi, remaining[2].vi]);
  }

  return result;
}

/**
 * Re-index/remap triangles, dropping degenerates and duplicates.
 */
function pruneTriangles(vertices, tris, remap = null) {
  const seen = new Set();
  const clean = [];
  let removed = 0;

  for (const tri of tris) {
    const a = remap ? remap[tri[0]] : tri[0];
    const b = remap ? remap[tri[1]] : tri[1];
    const c = remap ? remap[tri[2]] : tri[2];

    if (isDegenerateTri(vertices, a, b, c)) {
      removed++;
      continue;
    }

    const key = canonicalTriKey(a, b, c);
    if (seen.has(key)) {
      removed++;
      continue;
    }
    seen.add(key);
    clean.push([a, b, c]);
  }

  return { tris: clean, removed };
}

function buildManifoldMaps(tris) {
  const ec = new Map();
  const hc = new Map();
  const triSet = new Set();
  for (const [a, b, c] of tris) {
    triSet.add(canonicalTriKey(a, b, c));
    for (const [u, v] of [[a, b], [b, c], [c, a]]) {
      const ek = edgeKey(u, v);
      ec.set(ek, (ec.get(ek) || 0) + 1);
      const hk = `${u}->${v}`;
      hc.set(hk, (hc.get(hk) || 0) + 1);
    }
  }
  return { ec, hc, triSet };
}

function computeTriArea(vertices, a, b, c) {
  const va = vertices[a];
  const vb = vertices[b];
  const vc = vertices[c];
  const abx = vb.x - va.x, aby = vb.y - va.y, abz = vb.z - va.z;
  const acx = vc.x - va.x, acy = vc.y - va.y, acz = vc.z - va.z;
  const cx = aby * acz - abz * acy;
  const cy = abz * acx - abx * acz;
  const cz = abx * acy - aby * acx;
  return 0.5 * Math.sqrt(cx * cx + cy * cy + cz * cz);
}

/**
 * Identify truly unconnected mesh components (islands that share no vertex with
 * each other) and mark only small, isolated leftovers as removable.
 *
 * Connectivity is vertex-based on purpose: a main body that has holes, flipped
 * triangles or non-manifold seams must stay one component, otherwise the
 * cleanup would shred and delete parts of the actual model.
 */
function findConnectedComponents(vertices, tris, maxAreaRatio = 0.05) {
  if (!tris || tris.length === 0) return [];

  // Union-find over welded vertex indices
  const parent = new Int32Array(vertices.length);
  for (let i = 0; i < parent.length; i++) parent[i] = i;
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

  const valid = new Uint8Array(tris.length);
  for (let f = 0; f < tris.length; f++) {
    const [a, b, c] = tris[f];
    if (a === b || b === c || c === a) continue;
    valid[f] = 1;
    union(a, b);
    union(a, c);
  }

  const byRoot = new Map();
  for (let f = 0; f < tris.length; f++) {
    if (!valid[f]) continue;
    const root = find(tris[f][0]);
    let comp = byRoot.get(root);
    if (!comp) {
      comp = {
        triIndices: [],
        area: 0,
        minX: Infinity, minY: Infinity, minZ: Infinity,
        maxX: -Infinity, maxY: -Infinity, maxZ: -Infinity,
      };
      byRoot.set(root, comp);
    }
    const [a, b, c] = tris[f];
    comp.triIndices.push(f);
    comp.area += computeTriArea(vertices, a, b, c);
    for (const vi of [a, b, c]) {
      const p = vertices[vi];
      if (p.x < comp.minX) comp.minX = p.x;
      if (p.y < comp.minY) comp.minY = p.y;
      if (p.z < comp.minZ) comp.minZ = p.z;
      if (p.x > comp.maxX) comp.maxX = p.x;
      if (p.y > comp.maxY) comp.maxY = p.y;
      if (p.z > comp.maxZ) comp.maxZ = p.z;
    }
  }

  const components = [];
  for (const comp of byRoot.values()) {
    components.push({
      triIndices: comp.triIndices,
      triCount: comp.triIndices.length,
      area: comp.area,
      minX: comp.minX,
      maxX: comp.maxX,
      minY: comp.minY,
      maxY: comp.maxY,
      minZ: comp.minZ,
      maxZ: comp.maxZ,
      diag: Math.hypot(comp.maxX - comp.minX, comp.maxY - comp.minY, comp.maxZ - comp.minZ),
      isRemovable: false,
    });
  }

  components.sort((a, b) => b.area - a.area);
  if (components.length > 1) {
    const main = components[0];
    for (let idx = 1; idx < components.length; idx++) {
      const comp = components[idx];
      // Only remove small debris: tiny surface area AND small extent compared to the main body.
      // Large separate bodies (e.g. multi-part 3MF plates) are always kept.
      comp.isRemovable =
        comp.area < main.area * maxAreaRatio &&
        comp.diag < main.diag * 0.5;
    }
  }

  return components;
}

/**
 * Remove broken or unconnected secondary components from `tris`.
 */
function pruneDisconnectedParts(vertices, tris, options = {}) {
  const { maxAreaRatio = 0.05, keepOnlyLargest = false } = options;
  const components = findConnectedComponents(vertices, tris, maxAreaRatio);
  if (components.length <= 1) {
    return { tris, partsRemoved: 0, trianglesRemoved: 0 };
  }

  const removeSet = new Uint8Array(tris.length);
  let partsRemoved = 0;
  let trianglesRemoved = 0;

  for (let i = 1; i < components.length; i++) {
    const comp = components[i];
    if (keepOnlyLargest || comp.isRemovable) {
      partsRemoved++;
      trianglesRemoved += comp.triCount;
      for (const f of comp.triIndices) {
        removeSet[f] = 1;
      }
    }
  }

  if (partsRemoved === 0) {
    return { tris, partsRemoved: 0, trianglesRemoved: 0 };
  }

  const next = [];
  for (let f = 0; f < tris.length; f++) {
    if (!removeSet[f]) next.push(tris[f]);
  }
  return { tris: next, partsRemoved, trianglesRemoved };
}

function buildGeometryFromTris(vertices, tris) {
  const positions = new Float32Array(tris.length * 9);
  for (let f = 0; f < tris.length; f++) {
    const [a, b, c] = tris[f];
    const va = vertices[a];
    const vb = vertices[b];
    const vc = vertices[c];
    const off = f * 9;
    positions[off] = va.x; positions[off + 1] = va.y; positions[off + 2] = va.z;
    positions[off + 3] = vb.x; positions[off + 4] = vb.y; positions[off + 5] = vb.z;
    positions[off + 6] = vc.x; positions[off + 7] = vc.y; positions[off + 8] = vc.z;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.computeVertexNormals();
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return geo;
}

/**
 * Remove stray CSG fin/sliver triangles and duplicate half-edge micro-slivers
 * attached to non-manifold edges.
 */
function pruneNonManifoldFins(vertices, tris) {
  let current = tris;
  let totalRemoved = 0;

  // Stage A: remove fins with non-manifold edges that have no manifold neighbors,
  // border an open boundary edge, or touch multiple non-manifold edges.
  for (let pass = 0; pass < 8; pass++) {
    const { ec, hc } = buildManifoldMaps(current);
    const next = [];
    let removed = 0;

    for (const tri of current) {
      const [a, b, c] = tri;
      let nmCount = 0;
      let openCount = 0;
      let manifoldCount = 0;

      for (const [u, v] of [[a, b], [b, c], [c, a]]) {
        const uCount = ec.get(edgeKey(u, v)) || 0;
        const fCount = hc.get(`${u}->${v}`) || 0;
        const rCount = hc.get(`${v}->${u}`) || 0;
        if (uCount > 2 || fCount > 1 || rCount > 1) {
          nmCount++;
        } else if (uCount === 1) {
          openCount++;
        } else if (uCount === 2 && fCount === 1 && rCount === 1) {
          manifoldCount++;
        }
      }

      if (nmCount > 0 && (manifoldCount === 0 || openCount > 0 || nmCount >= 2)) {
        for (const [u, v] of [[a, b], [b, c], [c, a]]) {
          const ek = edgeKey(u, v);
          ec.set(ek, Math.max(0, (ec.get(ek) || 1) - 1));
          const hk = `${u}->${v}`;
          hc.set(hk, Math.max(0, (hc.get(hk) || 1) - 1));
        }
        removed++;
        totalRemoved++;
      } else {
        next.push(tri);
      }
    }

    current = next;
    if (removed === 0) break;
  }

  // Stage B: remove smallest-area duplicate half-edge or non-manifold pocket slivers
  for (let pass = 0; pass < 6; pass++) {
    const { ec, hc } = buildManifoldMaps(current);
    const edgeToTris = new Map();
    for (let f = 0; f < current.length; f++) {
      const [a, b, c] = current[f];
      for (const [u, v] of [[a, b], [b, c], [c, a]]) {
        const ek = edgeKey(u, v);
        if (!edgeToTris.has(ek)) edgeToTris.set(ek, []);
        edgeToTris.get(ek).push({ f, u, v });
      }
    }

    const toDrop = new Set();
    for (const [ek, entries] of edgeToTris) {
      const uCount = ec.get(ek) || 0;
      const [s0, s1] = ek.split('_');
      const a = parseInt(s0, 10);
      const b = parseInt(s1, 10);
      const fAB = hc.get(`${a}->${b}`) || 0;
      const fBA = hc.get(`${b}->${a}`) || 0;
      if (uCount <= 2 && fAB <= 1 && fBA <= 1) continue;

      let candidates = entries;
      if (fAB > 1 || fBA > 1) {
        const dupEntries = entries.filter(({ u, v }) => (hc.get(`${u}->${v}`) || 0) > 1);
        if (dupEntries.length > 0) candidates = dupEntries;
      }

      let smallestF = -1;
      let smallestArea = Infinity;
      for (const { f } of candidates) {
        const [ta, tb, tc] = current[f];
        const area = computeTriArea(vertices, ta, tb, tc);
        if (area < smallestArea) {
          smallestArea = area;
          smallestF = f;
        }
      }
      if (smallestF >= 0) toDrop.add(smallestF);
    }

    if (toDrop.size === 0) break;
    current = current.filter((_, idx) => !toDrop.has(idx));
    totalRemoved += toDrop.size;
  }

  return { tris: current, removed: totalRemoved };
}

/**
 * Attempt bidirectional manifold-safe edge/vertex collapses on candidate open-boundary
 * pairs `[a, b]`, choosing the direction (a->b or b->a) that reduces open edges without
 * creating degenerate triangles, duplicate faces, non-manifold edges, or same-direction foldovers.
 */
function tryCollapseOpenVertices(vertices, tris, pairs) {
  if (!pairs || pairs.length === 0) return { tris, collapsedCount: 0 };

  const curTris = tris.map((t) => [...t]);
  const { ec, hc, triSet } = buildManifoldMaps(curTris);
  const vToTris = new Map();
  for (let f = 0; f < curTris.length; f++) {
    for (const v of curTris[f]) {
      if (!vToTris.has(v)) vToTris.set(v, new Set());
      vToTris.get(v).add(f);
    }
  }

  function hasOpenEdgeAt(v) {
    const fSet = vToTris.get(v);
    if (!fSet) return false;
    for (const f of fSet) {
      const t = curTris[f];
      if (!t) continue;
      if (
        (ec.get(edgeKey(t[0], t[1])) || 0) === 1 ||
        (ec.get(edgeKey(t[1], t[2])) || 0) === 1 ||
        (ec.get(edgeKey(t[2], t[0])) || 0) === 1
      ) {
        return true;
      }
    }
    return false;
  }

  function evaluateCollapse(from, to) {
    const fSet = vToTris.get(from);
    if (!fSet || fSet.size === 0) return null;

    const eDeltas = new Map();
    const hDeltas = new Map();
    const seenNewKeys = new Set();
    const updates = [];

    for (const f of fSet) {
      const t = curTris[f];
      if (!t) continue;

      for (const [u, v] of [[t[0], t[1]], [t[1], t[2]], [t[2], t[0]]]) {
        const ek = edgeKey(u, v);
        eDeltas.set(ek, (eDeltas.get(ek) || 0) - 1);
        const hk = `${u}->${v}`;
        hDeltas.set(hk, (hDeltas.get(hk) || 0) - 1);
      }

      const nt = [
        t[0] === from ? to : t[0],
        t[1] === from ? to : t[1],
        t[2] === from ? to : t[2],
      ];

      const collapsedTri = nt[0] === nt[1] || nt[1] === nt[2] || nt[2] === nt[0];
      if (collapsedTri) {
        updates.push({ f, oldTri: t, oldKey: canonicalTriKey(t[0], t[1], t[2]), newTri: null, newKey: null });
        continue;
      }

      if (isDegenerateTri(vertices, nt[0], nt[1], nt[2])) return null;

      const nk = canonicalTriKey(nt[0], nt[1], nt[2]);
      if (triSet.has(nk) || seenNewKeys.has(nk)) return null;
      seenNewKeys.add(nk);

      for (const [u, v] of [[nt[0], nt[1]], [nt[1], nt[2]], [nt[2], nt[0]]]) {
        const ek = edgeKey(u, v);
        eDeltas.set(ek, (eDeltas.get(ek) || 0) + 1);
        const hk = `${u}->${v}`;
        hDeltas.set(hk, (hDeltas.get(hk) || 0) + 1);
      }

      updates.push({ f, oldTri: t, oldKey: canonicalTriKey(t[0], t[1], t[2]), newTri: nt, newKey: nk });
    }

    if (updates.length === 0) return null;

    let openDelta = 0;
    for (const [ek, d] of eDeltas) {
      const oldC = ec.get(ek) || 0;
      const newC = oldC + d;
      if (newC > 2 || newC < 0) return null;
      if (oldC === 1) openDelta--;
      if (newC === 1) openDelta++;
    }
    for (const [hk, d] of hDeltas) {
      const newH = (hc.get(hk) || 0) + d;
      if (newH > 1 || newH < 0) return null;
    }
    if (openDelta > 0) return null;

    return { openDelta, eDeltas, hDeltas, updates };
  }

  let collapsedCount = 0;
  for (const [a, b] of pairs) {
    if (a === b) continue;
    if (!hasOpenEdgeAt(a) && !hasOpenEdgeAt(b)) continue;

    const candA = evaluateCollapse(a, b);
    const candB = evaluateCollapse(b, a);
    let chosen = null;
    if (candA && candB) {
      chosen = candA.openDelta <= candB.openDelta ? candA : candB;
    } else {
      chosen = candA || candB;
    }
    if (!chosen) continue;

    for (const [ek, d] of chosen.eDeltas) ec.set(ek, (ec.get(ek) || 0) + d);
    for (const [hk, d] of chosen.hDeltas) hc.set(hk, (hc.get(hk) || 0) + d);

    for (const { f, oldTri, oldKey, newTri, newKey } of chosen.updates) {
      for (const v of oldTri) vToTris.get(v)?.delete(f);
      triSet.delete(oldKey);
      if (newTri) {
        curTris[f] = newTri;
        triSet.add(newKey);
        for (const v of newTri) {
          if (!vToTris.has(v)) vToTris.set(v, new Set());
          vToTris.get(v).add(f);
        }
      } else {
        curTris[f] = null;
      }
    }
    collapsedCount++;
  }

  if (collapsedCount === 0) return { tris, collapsedCount: 0 };
  const surviving = curTris.filter((t) => t !== null);
  return { tris: pruneTriangles(vertices, surviving).tris, collapsedCount };
}

/**
 * Snap pairs of nearby open boundary vertices within `snapEps`,
 * rejecting snaps that would increase non-manifold edges.
 */
function snapOpenBoundarySeams(vertices, tris, snapEps = 2.5e-4) {
  const beforeTopo = buildTopology(vertices, tris);
  if (beforeTopo.openHalfEdges.length === 0) return { tris, snappedCount: 0 };

  const boundarySet = new Set();
  for (const [u, v] of beforeTopo.openHalfEdges) {
    boundarySet.add(u);
    boundarySet.add(v);
  }
  const bVerts = Array.from(boundarySet);

  const cellSize = Math.max(snapEps * 2.5, 1e-5);
  const snapSq = snapEps * snapEps;
  const grid = new Map();
  const parent = new Int32Array(vertices.length);
  for (let i = 0; i < vertices.length; i++) parent[i] = i;

  const findRoot = (x) => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };

  let snappedCount = 0;
  const cellHash = (cx, cy, cz) => (((cx * 73856093) ^ (cy * 19349663) ^ (cz * 83492791)) >>> 0);

  for (const vIdx of bVerts) {
    const p = vertices[vIdx];
    const cx = Math.floor(p.x / cellSize);
    const cy = Math.floor(p.y / cellSize);
    const cz = Math.floor(p.z / cellSize);

    let target = -1;
    let bestSq = snapSq;

    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          const bucket = grid.get(cellHash(cx + dx, cy + dy, cz + dz));
          if (!bucket) continue;
          for (const other of bucket) {
            const root = findRoot(other);
            const q = vertices[root];
            const dSq = p.distanceToSquared(q);
            if (dSq < bestSq) {
              bestSq = dSq;
              target = root;
            }
          }
        }
      }
    }

    if (target >= 0 && target !== vIdx) {
      parent[vIdx] = target;
      snappedCount++;
    } else {
      const h = cellHash(cx, cy, cz);
      let bucket = grid.get(h);
      if (!bucket) { bucket = []; grid.set(h, bucket); }
      bucket.push(vIdx);
    }
  }

  if (snappedCount === 0) return { tris, snappedCount: 0 };

  const remap = new Int32Array(vertices.length);
  for (let i = 0; i < vertices.length; i++) remap[i] = findRoot(i);

  const pruned = pruneTriangles(vertices, tris, remap);
  const afterTopo = buildTopology(vertices, pruned.tris);
  if (
    afterTopo.nonManifoldEdges <= beforeTopo.nonManifoldEdges &&
    afterTopo.openEdges <= beforeTopo.openEdges
  ) {
    return { tris: pruned.tris, snappedCount };
  }

  // Fallback: per-pair bidirectional manifold-guarded vertex collapse
  const pairs = [];
  for (const vIdx of bVerts) {
    const target = remap[vIdx];
    if (target !== vIdx) pairs.push([vIdx, target]);
  }
  const safe = tryCollapseOpenVertices(vertices, tris, pairs);
  return { tris: safe.tris, snappedCount: safe.collapsedCount };
}

function computeUnitNormal(va, vb, vc) {
  const abx = vb.x - va.x;
  const aby = vb.y - va.y;
  const abz = vb.z - va.z;
  const acx = vc.x - va.x;
  const acy = vc.y - va.y;
  const acz = vc.z - va.z;
  const nx = aby * acz - abz * acy;
  const ny = abz * acx - abx * acz;
  const nz = abx * acy - aby * acx;
  const lenSq = nx * nx + ny * ny + nz * nz;
  if (lenSq < 1e-16) return null;
  const invLen = 1 / Math.sqrt(lenSq);
  return new THREE.Vector3(nx * invLen, ny * invLen, nz * invLen);
}

/**
 * Split open boundary edges wherever open boundary vertices lie collinearly
 * along the edge interior (multi-vertex T-junction repair), guarded by exact
 * net edge-count deltas and normal preservation so neither non-manifold edges
 * nor out-of-plane folded slivers are introduced.
 */
function stitchTJunctions(vertices, tris, tJuncEps = 8e-4) {
  let stitched = 0;
  let currentTris = tris;
  const epsSq = tJuncEps * tJuncEps;

  for (let pass = 0; pass < 8; pass++) {
    const { ec, hc, triSet } = buildManifoldMaps(currentTris);
    const openSet = new Set();
    const bSet = new Set();

    for (const [ek, count] of ec) {
      if (count !== 1) continue;
      openSet.add(ek);
      const [s0, s1] = ek.split('_');
      bSet.add(parseInt(s0, 10));
      bSet.add(parseInt(s1, 10));
    }
    if (bSet.size === 0) break;
    const bVerts = Array.from(bSet);

    // Spatial hash grid for boundary vertices to turn O(E_open * V_boundary) into O(E_open)
    const cellSize = Math.max(tJuncEps * 20, 1.0);
    const bGrid = new Map();
    for (const pIdx of bVerts) {
      const p = vertices[pIdx];
      const gx = Math.floor(p.x / cellSize);
      const gy = Math.floor(p.y / cellSize);
      const gz = Math.floor(p.z / cellSize);
      const key = `${gx},${gy},${gz}`;
      let cell = bGrid.get(key);
      if (!cell) { cell = []; bGrid.set(key, cell); }
      cell.push(pIdx);
    }

    let passSplits = 0;
    const nextTris = [];

    for (const tri of currentTris) {
      const [a, b, c] = tri;
      const nOrig = computeUnitNormal(vertices[a], vertices[b], vertices[c]);
      if (!nOrig) {
        nextTris.push(tri);
        continue;
      }
      let splitDone = false;

      for (const [u, v, w] of [[a, b, c], [b, c, a], [c, a, b]]) {
        if (!openSet.has(edgeKey(u, v))) continue;

        const pu = vertices[u];
        const pv = vertices[v];
        const ux = pv.x - pu.x;
        const uy = pv.y - pu.y;
        const uz = pv.z - pu.z;
        const lenSq = ux * ux + uy * uy + uz * uz;
        if (lenSq < 1e-12) continue;

        const minX = Math.min(pu.x, pv.x) - tJuncEps;
        const maxX = Math.max(pu.x, pv.x) + tJuncEps;
        const minY = Math.min(pu.y, pv.y) - tJuncEps;
        const maxY = Math.max(pu.y, pv.y) + tJuncEps;
        const minZ = Math.min(pu.z, pv.z) - tJuncEps;
        const maxZ = Math.max(pu.z, pv.z) + tJuncEps;

        const minGx = Math.floor(minX / cellSize);
        const maxGx = Math.floor(maxX / cellSize);
        const minGy = Math.floor(minY / cellSize);
        const maxGy = Math.floor(maxY / cellSize);
        const minGz = Math.floor(minZ / cellSize);
        const maxGz = Math.floor(maxZ / cellSize);

        const onEdge = [];
        const totalCells = (maxGx - minGx + 1) * (maxGy - minGy + 1) * (maxGz - minGz + 1);

        if (totalCells <= 125) {
          const seenPIdx = new Set();
          for (let gx = minGx; gx <= maxGx; gx++) {
            for (let gy = minGy; gy <= maxGy; gy++) {
              for (let gz = minGz; gz <= maxGz; gz++) {
                const bucket = bGrid.get(`${gx},${gy},${gz}`);
                if (!bucket) continue;
                for (const pIdx of bucket) {
                  if (pIdx === u || pIdx === v || pIdx === w || seenPIdx.has(pIdx)) continue;
                  seenPIdx.add(pIdx);
                  const p = vertices[pIdx];
                  if (
                    p.x < minX || p.x > maxX ||
                    p.y < minY || p.y > maxY ||
                    p.z < minZ || p.z > maxZ
                  ) {
                    continue;
                  }

                  const t = ((p.x - pu.x) * ux + (p.y - pu.y) * uy + (p.z - pu.z) * uz) / lenSq;
                  if (t <= 1e-5 || t >= 1 - 1e-5) continue;

                  const dx = pu.x + t * ux - p.x;
                  const dy = pu.y + t * uy - p.y;
                  const dz = pu.z + t * uz - p.z;
                  if (dx * dx + dy * dy + dz * dz <= epsSq) {
                    onEdge.push({ pIdx, t });
                  }
                }
              }
            }
          }
        } else {
          // Fallback for unusually long edges spanning many cells
          for (const pIdx of bVerts) {
            if (pIdx === u || pIdx === v || pIdx === w) continue;
            const p = vertices[pIdx];
            if (
              p.x < minX || p.x > maxX ||
              p.y < minY || p.y > maxY ||
              p.z < minZ || p.z > maxZ
            ) {
              continue;
            }

            const t = ((p.x - pu.x) * ux + (p.y - pu.y) * uy + (p.z - pu.z) * uz) / lenSq;
            if (t <= 1e-5 || t >= 1 - 1e-5) continue;

            const dx = pu.x + t * ux - p.x;
            const dy = pu.y + t * uy - p.y;
            const dz = pu.z + t * uz - p.z;
            if (dx * dx + dy * dy + dz * dz <= epsSq) {
              onEdge.push({ pIdx, t });
            }
          }
        }

        if (onEdge.length === 0) continue;
        onEdge.sort((x, y) => x.t - y.t);

        const uniq = [onEdge[0].pIdx];
        for (let k = 1; k < onEdge.length; k++) {
          if (onEdge[k].pIdx !== uniq[uniq.length - 1]) {
            uniq.push(onEdge[k].pIdx);
          }
        }
        const chain = [u, ...uniq, v];

        const eDeltas = new Map();
        const hDeltas = new Map();
        const addEdgeDelta = (x, y, d) => {
          const ek = edgeKey(x, y);
          eDeltas.set(ek, (eDeltas.get(ek) || 0) + d);
          const hk = `${x}->${y}`;
          hDeltas.set(hk, (hDeltas.get(hk) || 0) + d);
        };
        addEdgeDelta(u, v, -1);
        addEdgeDelta(v, w, -1);
        addEdgeDelta(w, u, -1);

        const newSubTris = [];
        let valid = true;
        for (let i = 0; i < chain.length - 1; i++) {
          const x = chain[i];
          const y = chain[i + 1];
          if (x === y || x === w || y === w) continue;
          const nSub = computeUnitNormal(vertices[x], vertices[y], vertices[w]);
          if (!nSub || isDegenerateTri(vertices, x, y, w) || nSub.dot(nOrig) < 0.2) {
            valid = false;
            break;
          }
          const tk = canonicalTriKey(x, y, w);
          if (!triSet.has(tk)) {
            newSubTris.push([x, y, w, tk]);
            addEdgeDelta(x, y, 1);
            addEdgeDelta(y, w, 1);
            addEdgeDelta(w, x, 1);
          }
        }
        if (!valid || newSubTris.length === 0) continue;

        for (const [ek, d] of eDeltas) {
          if (d > 0 && (ec.get(ek) || 0) + d > 2) {
            valid = false;
            break;
          }
        }
        if (valid) {
          for (const [hk, d] of hDeltas) {
            if (d > 0 && (hc.get(hk) || 0) + d > 1) {
              valid = false;
              break;
            }
          }
        }
        if (!valid) continue;

        triSet.delete(canonicalTriKey(u, v, w));
        for (const [ek, d] of eDeltas) ec.set(ek, (ec.get(ek) || 0) + d);
        for (const [hk, d] of hDeltas) hc.set(hk, (hc.get(hk) || 0) + d);
        for (const [x, y, z, tk] of newSubTris) {
          triSet.add(tk);
          nextTris.push([x, y, z]);
        }
        stitched += uniq.length;
        passSplits += uniq.length;
        splitDone = true;
        break;
      }

      if (!splitDone) nextTris.push(tri);
    }

    currentTris = pruneTriangles(vertices, nextTris).tris;
    if (passSplits === 0) break;
  }

  return { tris: currentTris, stitched };
}

/**
 * Flood-fill connected components over manifold edges to enforce consistent
 * triangle winding and outward-facing normals (positive signed volume).
 */
function harmonizeNormals(vertices, tris) {
  if (tris.length === 0) return tris;
  const edgeMap = new Map();

  for (let f = 0; f < tris.length; f++) {
    const [a, b, c] = tris[f];
    for (const [u, v] of [[a, b], [b, c], [c, a]]) {
      const ek = edgeKey(u, v);
      if (!edgeMap.has(ek)) edgeMap.set(ek, []);
      edgeMap.get(ek).push({ f, u, v });
    }
  }

  const visited = new Uint8Array(tris.length);
  const out = tris.map((t) => [...t]);

  for (let seed = 0; seed < out.length; seed++) {
    if (visited[seed]) continue;
    visited[seed] = 1;

    const comp = [seed];
    const queue = [seed];

    while (queue.length > 0) {
      const f = queue.shift();
      const [a, b, c] = out[f];
      for (const [u, v] of [[a, b], [b, c], [c, a]]) {
        const list = edgeMap.get(edgeKey(u, v));
        if (!list || list.length !== 2) continue;
        for (const entry of list) {
          if (entry.f === f || visited[entry.f]) continue;
          visited[entry.f] = 1;
          const nt = out[entry.f];
          // Two adjacent triangles must traverse the shared edge in OPPOSITE directions
          const sameDir =
            (nt[0] === u && nt[1] === v) ||
            (nt[1] === u && nt[2] === v) ||
            (nt[2] === u && nt[0] === v);
          if (sameDir) {
            const tmp = nt[1];
            nt[1] = nt[2];
            nt[2] = tmp;
          }
          comp.push(entry.f);
          queue.push(entry.f);
        }
      }
    }

    // Check signed volume of component; flip if negative
    let signedVol6 = 0;
    for (const fIdx of comp) {
      const p0 = vertices[out[fIdx][0]];
      const p1 = vertices[out[fIdx][1]];
      const p2 = vertices[out[fIdx][2]];
      signedVol6 +=
        p0.x * (p1.y * p2.z - p1.z * p2.y) +
        p0.y * (p1.z * p2.x - p1.x * p2.z) +
        p0.z * (p1.x * p2.y - p1.y * p2.x);
    }

    if (signedVol6 < -1e-7) {
      for (const fIdx of comp) {
        const tmp = out[fIdx][1];
        out[fIdx][1] = out[fIdx][2];
        out[fIdx][2] = tmp;
      }
    }
  }

  return out;
}

export function createAbortError() {
  const err = new Error('MeshFixer operation aborted by user');
  err.name = 'AbortError';
  return err;
}

/**
 * Async version of fixMesh that yields to the browser event loop between passes and hole loop
 * triangulations, honoring an AbortSignal so the Stop button or Esc key remains responsive.
 *
 * @param {THREE.BufferGeometry} geometry
 * @param {object} [options]
 * @returns {Promise<{ geometry: THREE.BufferGeometry, beforeStats: object, afterStats: object, holesFilled: number, edgesStitched: number, degeneratesRemoved: number, partsRemoved: number, verification: object }>}
 */
export async function fixMeshAsync(geometry, options = {}) {
  const {
    weldEps = 1e-4,
    snapEps = 1e-2,
    tJuncEps = 1e-4,
    maxHoleVertices = 20,
    maxHoleSpan = 0.2,
    removeUnconnected = false,
    useWasm = true,
    _retried = false,
    _pass2 = false,
    signal,
    onProgress,
  } = options;

  if (signal?.aborted) throw createAbortError();

  const yieldPoint = async (msg) => {
    if (signal?.aborted) throw createAbortError();
    if (msg && onProgress) onProgress(msg);
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (signal?.aborted) throw createAbortError();
  };

  const beforeStats = analyzeMesh(geometry);

  // ---- 0. Industrial C++ WebAssembly Engine (PMP) ----
  if (useWasm && isWasmMeshFixSupported() && !_pass2 && !_retried) {
    try {
      await yieldPoint('WASM: Running C++ PMP mesh repair engine...');
      const wasmRes = await repairMeshWasm(geometry, {
        weldEpsilon: weldEps,
        maxHoleEdges: 0,
        minArea: 1e-8,
        signal,
        onProgress: (msg) => onProgress?.(msg),
      });

      if (wasmRes && wasmRes.geometry) {
        let candidateGeo = wasmRes.geometry;
        let candidateStats = analyzeMesh(candidateGeo);

        let partsRemoved = 0;
        let degenRemoved = 0;
        if (removeUnconnected) {
          const pruned = removeDisconnectedParts(candidateGeo);
          candidateGeo.dispose();
          candidateGeo = pruned.geometry;
          candidateStats = pruned.afterStats;
          partsRemoved += pruned.partsRemoved;
          degenRemoved += pruned.trianglesRemoved;
        }

        let verification = null;
        if (options.verifyBoolDiff !== false) {
          await yieldPoint('Verifying repaired geometry against original body...');
          verification = verifyMeshFixWithBoolDiff(geometry, candidateGeo, options);
        }

        if (!verification || !verification.hasLargeNewParts) {
          return {
            geometry: candidateGeo,
            beforeStats,
            afterStats: candidateStats,
            holesFilled: wasmRes.holesFilled,
            edgesStitched: Math.max(0, wasmRes.verticesBefore - wasmRes.verticesAfter),
            degeneratesRemoved: degenRemoved,
            partsRemoved,
            verification,
            engine: 'wasm-pmp',
          };
        } else {
          console.warn('WASM repair produced unexpected extra volume; falling back to topological stitcher');
          candidateGeo.dispose();
        }
      }
    } catch (err) {
      if (err?.name === 'AbortError' || err?.message === 'Operation aborted') throw err;
      console.warn('WASM repair bypassed, falling back to JS topological stitcher:', err);
    }
  }

  await yieldPoint('Pass 1: Welding vertices & pruning degenerates...');

  // Pass 1: Vertex welding + degenerate/duplicate, stray non-manifold fin & loose part pruning
  const { vertices, tris: rawTris } = extractWeldedMesh(geometry, weldEps);
  const pruned1 = pruneTriangles(vertices, rawTris);
  const finPruned = pruneNonManifoldFins(vertices, pruned1.tris);
  let tris = finPruned.tris;
  let degeneratesRemoved = pruned1.removed + finPruned.removed;
  let partsRemoved = 0;

  if (removeUnconnected) {
    const prunedParts1 = pruneDisconnectedParts(vertices, tris);
    tris = prunedParts1.tris;
    partsRemoved += prunedParts1.partsRemoved;
    degeneratesRemoved += prunedParts1.trianglesRemoved;
  }

  await yieldPoint('Pass 2: Stitching T-junctions & aligning edge splits...');

  // Pass 2: Manifold-guarded multi-vertex T-junction stitching FIRST
  const tJunc1 = stitchTJunctions(vertices, tris, tJuncEps);
  tris = tJunc1.tris;
  let edgesStitched = tJunc1.stitched;

  await yieldPoint('Pass 3: Snapping open boundary seams...');

  // Pass 3: Cautious boundary seam snapping (never increases non-manifold edges) + cleanup
  const snapped = snapOpenBoundarySeams(vertices, tris, snapEps);
  tris = snapped.tris;
  edgesStitched += snapped.snappedCount;

  const pruned2 = pruneTriangles(vertices, tris);
  tris = pruned2.tris;
  degeneratesRemoved += pruned2.removed;

  // Follow-up T-junction pass after any seam snaps
  const tJunc2 = stitchTJunctions(vertices, tris, tJuncEps);
  tris = tJunc2.tris;
  edgesStitched += tJunc2.stitched;

  await yieldPoint('Pass 4: Tracing and triangulating hole loops...');

  // Pass 4: Manifold-guarded hole boundary loop triangulation
  let holesFilled = 0;
  const topo = buildTopology(vertices, tris);
  if (topo.openHalfEdges.length > 0) {
    const loops = traceHoleLoops(vertices, topo.openHalfEdges);
    const { ec, hc, triSet } = buildManifoldMaps(tris);
    const addedTris = [];
    const degenPairs = [];

    for (let loopIdx = 0; loopIdx < loops.length; loopIdx++) {
      if (loopIdx % 3 === 0) {
        await yieldPoint(`Pass 4: Triangulating holes (${loopIdx + 1} / ${loops.length})...`);
      }
      const loopInfo = loops[loopIdx];
      if (loopInfo.closed && loopInfo.vertices.length >= 3 && loopInfo.vertices.length <= maxHoleVertices) {
        let minX = Infinity, minY = Infinity, minZ = Infinity;
        let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
        let maxEdgeLenSq = 0;
        const nVerts = loopInfo.vertices.length;

        for (let i = 0; i < nVerts; i++) {
          const vi = loopInfo.vertices[i];
          const vNext = vertices[loopInfo.vertices[(i + 1) % nVerts]];
          const v = vertices[vi];
          if (v.x < minX) minX = v.x;
          if (v.y < minY) minY = v.y;
          if (v.z < minZ) minZ = v.z;
          if (v.x > maxX) maxX = v.x;
          if (v.y > maxY) maxY = v.y;
          if (v.z > maxZ) maxZ = v.z;

          const edSq = (v.x - vNext.x) ** 2 + (v.y - vNext.y) ** 2 + (v.z - vNext.z) ** 2;
          if (edSq > maxEdgeLenSq) maxEdgeLenSq = edSq;
        }
        const loopDiag = Math.hypot(maxX - minX, maxY - minY, maxZ - minZ);

        // Strict CAD micro-gap policy:
        // Only fill micro-cracks where diagonal <= maxHoleSpan (0.2 mm) AND no individual edge spans > maxHoleSpan.
        // Never skin across 3D empty space between separate extrusions or fill intentional CAD holes/bores!
        if (loopDiag > maxHoleSpan || maxEdgeLenSq > maxHoleSpan * maxHoleSpan) {
          continue;
        }

        // Also ensure the micro-loop is substantially planar (not a 3D saddle across features)
        const pts = loopInfo.vertices.map((idx) => vertices[idx]);
        const newell = computeNewellNormal(pts);
        let maxPlaneDist = 0;
        const origin = pts[0];
        for (let i = 1; i < pts.length; i++) {
          const d = Math.abs((pts[i].x - origin.x) * newell.x + (pts[i].y - origin.y) * newell.y + (pts[i].z - origin.z) * newell.z);
          if (d > maxPlaneDist) maxPlaneDist = d;
        }
        if (maxPlaneDist > Math.max(maxHoleSpan * 0.4, 0.05)) {
          continue; // Non-planar 3D loop - never skin across curved/stepped features
        }

        const patch = triangulateHoleLoop(vertices, loopInfo.vertices);
        const loopNormal = loopInfo.vertices.length > 4
          ? computeNewellNormal(loopInfo.vertices.map((idx) => vertices[idx]))
          : null;
        let addedForLoop = 0;

        for (const tri of patch) {
          const [pa, pb, pc] = tri;
          if (isDegenerateTri(vertices, pa, pb, pc)) {
            const triEdges = [
              [pa, pb, vertices[pa].distanceToSquared(vertices[pb])],
              [pb, pc, vertices[pb].distanceToSquared(vertices[pc])],
              [pc, pa, vertices[pc].distanceToSquared(vertices[pa])],
            ].sort((e1, e2) => e1[2] - e2[2]);
            degenPairs.push([triEdges[0][0], triEdges[0][1]], [triEdges[1][0], triEdges[1][1]]);
            continue;
          }
          if (loopNormal) {
            const nCap = computeUnitNormal(vertices[pa], vertices[pb], vertices[pc]);
            if (!nCap || nCap.dot(loopNormal) < 0.85) continue;
          }
          const tk = canonicalTriKey(pa, pb, pc);
          if (triSet.has(tk)) continue;

          let safe = true;
          for (const [pu, pv] of [[pa, pb], [pb, pc], [pc, pa]]) {
            if ((ec.get(edgeKey(pu, pv)) || 0) + 1 > 2 || (hc.get(`${pu}->${pv}`) || 0) > 0) {
              safe = false;
              break;
            }
          }
          if (!safe) continue;

          triSet.add(tk);
          for (const [pu, pv] of [[pa, pb], [pb, pc], [pc, pa]]) {
            const ek = edgeKey(pu, pv);
            ec.set(ek, (ec.get(ek) || 0) + 1);
            const hk = `${pu}->${pv}`;
            hc.set(hk, (hc.get(hk) || 0) + 1);
          }
          addedTris.push(tri);
          addedForLoop++;
        }

        if (addedForLoop > 0) holesFilled++;
      }
    }

    if (addedTris.length > 0) {
      tris = tris.concat(addedTris);
    }
    if (degenPairs.length > 0) {
      const collapsed = tryCollapseOpenVertices(vertices, tris, degenPairs);
      tris = collapsed.tris;
      edgesStitched += collapsed.collapsedCount;
      if (collapsed.collapsedCount > 0) holesFilled += collapsed.collapsedCount;
    }
  }

  // Post-hole-fill cleanup for any newly exposed degenerate, non-manifold slivers, or loose shards
  const postHolePruned = pruneTriangles(vertices, tris);
  const postHoleFins = pruneNonManifoldFins(vertices, postHolePruned.tris);
  tris = postHoleFins.tris;
  degeneratesRemoved += postHolePruned.removed + postHoleFins.removed;
  if (removeUnconnected) {
    const prunedParts2 = pruneDisconnectedParts(vertices, tris);
    tris = prunedParts2.tris;
    partsRemoved += prunedParts2.partsRemoved;
    degeneratesRemoved += prunedParts2.trianglesRemoved;
  }

  await yieldPoint('Pass 5: Harmonizing outward surface normals...');

  // Pass 5: Consistent outward normal winding (guard against increasing non-manifold edges)
  const preHarmTopo = buildTopology(vertices, tris);
  const harmonized = harmonizeNormals(vertices, tris);
  const postHarmTopo = buildTopology(vertices, harmonized);
  if (postHarmTopo.nonManifoldEdges <= preHarmTopo.nonManifoldEdges) {
    tris = harmonized;
  }

  // Build non-indexed BufferGeometry
  const fixedGeo = buildGeometryFromTris(vertices, tris);
  const afterStats = analyzeMesh(fixedGeo);

  // If coarse initial weld introduced extra non-manifold edges, retry once at tighter weldEps
  if (afterStats.nonManifoldEdges > beforeStats.nonManifoldEdges && !_retried && weldEps > 1e-5) {
    fixedGeo.dispose();
    return fixMeshAsync(geometry, { ...options, weldEps: 1e-5, snapEps: 1e-5, tJuncEps: 5e-5, _retried: true, signal, onProgress });
  }

  let finalGeo = fixedGeo;
  let finalStats = afterStats;
  let finalHoles = holesFilled;
  let finalStitched = edgesStitched;
  let finalDegen = degeneratesRemoved;
  let finalParts = partsRemoved;

  // Run one follow-up pass when holes closed by Pass 4 unlock remaining T-junctions
  if (!afterStats.isWatertight && afterStats.issueCount < beforeStats.issueCount && !_pass2) {
    await yieldPoint('Follow-up pass: Healing residual seams...');
    const pass2 = await fixMeshAsync(fixedGeo, { ...options, _pass2: true, verifyBoolDiff: false, signal, onProgress });
    if (
      pass2.afterStats.nonManifoldEdges <= afterStats.nonManifoldEdges &&
      pass2.afterStats.issueCount <= afterStats.issueCount
    ) {
      finalGeo = pass2.geometry;
      finalStats = pass2.afterStats;
      finalHoles += pass2.holesFilled;
      finalStitched += pass2.edgesStitched;
      finalDegen += pass2.degeneratesRemoved;
      finalParts += (pass2.partsRemoved || 0);
      fixedGeo.dispose();
    } else {
      pass2.geometry.dispose();
    }
  }

  // Pass 6: Boolean Difference Verification against original body
  let verification = null;
  if (options.verifyBoolDiff !== false && !_pass2 && !_retried) {
    await yieldPoint('Pass 6: Verifying manifold geometry against original body...');
    verification = verifyMeshFixWithBoolDiff(geometry, finalGeo, options);
    if (verification.hasLargeNewParts && options.rejectOnLargeParts !== false) {
      console.warn('MeshFixer generated large new parts that were not in original body! Rejecting fix:', verification.reason);
      finalGeo.dispose();
      return {
        geometry: geometry.clone(),
        beforeStats,
        afterStats: beforeStats,
        holesFilled: 0,
        edgesStitched: 0,
        degeneratesRemoved: 0,
        partsRemoved: 0,
        verification: {
          ...verification,
          rejected: true,
        },
      };
    }
  }

  return {
    geometry: finalGeo,
    beforeStats,
    afterStats: finalStats,
    holesFilled: finalHoles,
    edgesStitched: finalStitched,
    degeneratesRemoved: finalDegen,
    partsRemoved: finalParts,
    verification,
  };
}

/**
 * Repair holes, T-junctions, micro-seams, degenerate faces, broken shards, and winding issues
 * in a BufferGeometry.
 *
 * @param {THREE.BufferGeometry} geometry
 * @param {object} [options]
 * @returns {{ geometry: THREE.BufferGeometry, beforeStats: object, afterStats: object, holesFilled: number, edgesStitched: number, degeneratesRemoved: number, partsRemoved: number, verification?: object }}
 */
export function fixMesh(geometry, options = {}) {
  const {
    weldEps = 1e-4,
    snapEps = 1e-2,
    tJuncEps = 1e-4,
    maxHoleVertices = 20,
    maxHoleSpan = 0.2,
    removeUnconnected = false,
    _retried = false,
    _pass2 = false,
  } = options;

  const beforeStats = analyzeMesh(geometry);

  // Pass 1: Vertex welding + degenerate/duplicate, stray non-manifold fin & loose part pruning
  const { vertices, tris: rawTris } = extractWeldedMesh(geometry, weldEps);
  const pruned1 = pruneTriangles(vertices, rawTris);
  const finPruned = pruneNonManifoldFins(vertices, pruned1.tris);
  let tris = finPruned.tris;
  let degeneratesRemoved = pruned1.removed + finPruned.removed;
  let partsRemoved = 0;

  if (removeUnconnected) {
    const prunedParts1 = pruneDisconnectedParts(vertices, tris);
    tris = prunedParts1.tris;
    partsRemoved += prunedParts1.partsRemoved;
    degeneratesRemoved += prunedParts1.trianglesRemoved;
  }

  // Pass 2: Manifold-guarded multi-vertex T-junction stitching FIRST
  const tJunc1 = stitchTJunctions(vertices, tris, tJuncEps);
  tris = tJunc1.tris;
  let edgesStitched = tJunc1.stitched;

  // Pass 3: Cautious boundary seam snapping (never increases non-manifold edges) + cleanup
  const snapped = snapOpenBoundarySeams(vertices, tris, snapEps);
  tris = snapped.tris;
  edgesStitched += snapped.snappedCount;

  const pruned2 = pruneTriangles(vertices, tris);
  tris = pruned2.tris;
  degeneratesRemoved += pruned2.removed;

  // Follow-up T-junction pass after any seam snaps
  const tJunc2 = stitchTJunctions(vertices, tris, tJuncEps);
  tris = tJunc2.tris;
  edgesStitched += tJunc2.stitched;

  // Pass 4: Manifold-guarded hole boundary loop triangulation
  let holesFilled = 0;
  const topo = buildTopology(vertices, tris);
  if (topo.openHalfEdges.length > 0) {
    const loops = traceHoleLoops(vertices, topo.openHalfEdges);
    const { ec, hc, triSet } = buildManifoldMaps(tris);
    const addedTris = [];
    const degenPairs = [];

    for (const loopInfo of loops) {
      if (loopInfo.closed && loopInfo.vertices.length >= 3 && loopInfo.vertices.length <= maxHoleVertices) {
        let minX = Infinity, minY = Infinity, minZ = Infinity;
        let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
        let maxEdgeLenSq = 0;
        const nVerts = loopInfo.vertices.length;

        for (let i = 0; i < nVerts; i++) {
          const vi = loopInfo.vertices[i];
          const vNext = vertices[loopInfo.vertices[(i + 1) % nVerts]];
          const v = vertices[vi];
          if (v.x < minX) minX = v.x;
          if (v.y < minY) minY = v.y;
          if (v.z < minZ) minZ = v.z;
          if (v.x > maxX) maxX = v.x;
          if (v.y > maxY) maxY = v.y;
          if (v.z > maxZ) maxZ = v.z;

          const edSq = (v.x - vNext.x) ** 2 + (v.y - vNext.y) ** 2 + (v.z - vNext.z) ** 2;
          if (edSq > maxEdgeLenSq) maxEdgeLenSq = edSq;
        }
        const loopDiag = Math.hypot(maxX - minX, maxY - minY, maxZ - minZ);

        // Strict CAD micro-gap policy:
        // Only fill micro-cracks where diagonal <= maxHoleSpan (0.2 mm) AND no individual edge spans > maxHoleSpan.
        // Never skin across 3D empty space between separate extrusions or fill intentional CAD holes/bores!
        if (loopDiag > maxHoleSpan || maxEdgeLenSq > maxHoleSpan * maxHoleSpan) {
          continue;
        }

        // Also ensure the micro-loop is substantially planar (not a 3D saddle across features)
        const pts = loopInfo.vertices.map((idx) => vertices[idx]);
        const newell = computeNewellNormal(pts);
        let maxPlaneDist = 0;
        const origin = pts[0];
        for (let i = 1; i < pts.length; i++) {
          const d = Math.abs((pts[i].x - origin.x) * newell.x + (pts[i].y - origin.y) * newell.y + (pts[i].z - origin.z) * newell.z);
          if (d > maxPlaneDist) maxPlaneDist = d;
        }
        if (maxPlaneDist > Math.max(maxHoleSpan * 0.4, 0.05)) {
          continue; // Non-planar 3D loop - never skin across curved/stepped features
        }

        const patch = triangulateHoleLoop(vertices, loopInfo.vertices);
        const loopNormal = loopInfo.vertices.length > 4
          ? computeNewellNormal(loopInfo.vertices.map((idx) => vertices[idx]))
          : null;
        let addedForLoop = 0;

        for (const tri of patch) {
          const [pa, pb, pc] = tri;
          if (isDegenerateTri(vertices, pa, pb, pc)) {
            const triEdges = [
              [pa, pb, vertices[pa].distanceToSquared(vertices[pb])],
              [pb, pc, vertices[pb].distanceToSquared(vertices[pc])],
              [pc, pa, vertices[pc].distanceToSquared(vertices[pa])],
            ].sort((e1, e2) => e1[2] - e2[2]);
            degenPairs.push([triEdges[0][0], triEdges[0][1]], [triEdges[1][0], triEdges[1][1]]);
            continue;
          }
          if (loopNormal) {
            const nCap = computeUnitNormal(vertices[pa], vertices[pb], vertices[pc]);
            if (!nCap || nCap.dot(loopNormal) < 0.85) continue;
          }
          const tk = canonicalTriKey(pa, pb, pc);
          if (triSet.has(tk)) continue;

          let safe = true;
          for (const [pu, pv] of [[pa, pb], [pb, pc], [pc, pa]]) {
            if ((ec.get(edgeKey(pu, pv)) || 0) + 1 > 2 || (hc.get(`${pu}->${pv}`) || 0) > 0) {
              safe = false;
              break;
            }
          }
          if (!safe) continue;

          triSet.add(tk);
          for (const [pu, pv] of [[pa, pb], [pb, pc], [pc, pa]]) {
            const ek = edgeKey(pu, pv);
            ec.set(ek, (ec.get(ek) || 0) + 1);
            const hk = `${pu}->${pv}`;
            hc.set(hk, (hc.get(hk) || 0) + 1);
          }
          addedTris.push(tri);
          addedForLoop++;
        }

        if (addedForLoop > 0) holesFilled++;
      }
    }

    if (addedTris.length > 0) {
      tris = tris.concat(addedTris);
    }
    if (degenPairs.length > 0) {
      const collapsed = tryCollapseOpenVertices(vertices, tris, degenPairs);
      tris = collapsed.tris;
      edgesStitched += collapsed.collapsedCount;
      if (collapsed.collapsedCount > 0) holesFilled += collapsed.collapsedCount;
    }
  }

  // Post-hole-fill cleanup for any newly exposed degenerate, non-manifold slivers, or loose shards
  const postHolePruned = pruneTriangles(vertices, tris);
  const postHoleFins = pruneNonManifoldFins(vertices, postHolePruned.tris);
  tris = postHoleFins.tris;
  degeneratesRemoved += postHolePruned.removed + postHoleFins.removed;
  if (removeUnconnected) {
    const prunedParts2 = pruneDisconnectedParts(vertices, tris);
    tris = prunedParts2.tris;
    partsRemoved += prunedParts2.partsRemoved;
    degeneratesRemoved += prunedParts2.trianglesRemoved;
  }

  // Pass 5: Consistent outward normal winding (guard against increasing non-manifold edges)
  const preHarmTopo = buildTopology(vertices, tris);
  const harmonized = harmonizeNormals(vertices, tris);
  const postHarmTopo = buildTopology(vertices, harmonized);
  if (postHarmTopo.nonManifoldEdges <= preHarmTopo.nonManifoldEdges) {
    tris = harmonized;
  }

  // Build non-indexed BufferGeometry
  const fixedGeo = buildGeometryFromTris(vertices, tris);

  const afterStats = analyzeMesh(fixedGeo);

  // If coarse initial weld introduced extra non-manifold edges, retry once at tighter weldEps
  if (afterStats.nonManifoldEdges > beforeStats.nonManifoldEdges && !_retried && weldEps > 1e-5) {
    fixedGeo.dispose();
    return fixMesh(geometry, { ...options, weldEps: 1e-5, snapEps: 1e-5, tJuncEps: 5e-5, _retried: true });
  }

  let finalGeo = fixedGeo;
  let finalStats = afterStats;
  let finalHoles = holesFilled;
  let finalStitched = edgesStitched;
  let finalDegen = degeneratesRemoved;
  let finalParts = partsRemoved;

  // Run one follow-up pass when holes closed by Pass 4 unlock remaining T-junctions
  if (!afterStats.isWatertight && afterStats.issueCount < beforeStats.issueCount && !_pass2) {
    const pass2 = fixMesh(fixedGeo, { ...options, _pass2: true, verifyBoolDiff: false });
    if (
      pass2.afterStats.nonManifoldEdges <= afterStats.nonManifoldEdges &&
      pass2.afterStats.issueCount <= afterStats.issueCount
    ) {
      finalGeo = pass2.geometry;
      finalStats = pass2.afterStats;
      finalHoles += pass2.holesFilled;
      finalStitched += pass2.edgesStitched;
      finalDegen += pass2.degeneratesRemoved;
      finalParts += (pass2.partsRemoved || 0);
      fixedGeo.dispose();
    } else {
      pass2.geometry.dispose();
    }
  }

  // Pass 6: Boolean Difference Verification against original body
  let verification = null;
  if (options.verifyBoolDiff !== false && !_pass2 && !_retried) {
    verification = verifyMeshFixWithBoolDiff(geometry, finalGeo, options);
    if (verification.hasLargeNewParts && options.rejectOnLargeParts !== false) {
      console.warn('MeshFixer generated large new parts that were not in original body! Rejecting fix:', verification.reason);
      finalGeo.dispose();
      return {
        geometry: geometry.clone(),
        beforeStats,
        afterStats: beforeStats,
        holesFilled: 0,
        edgesStitched: 0,
        degeneratesRemoved: 0,
        partsRemoved: 0,
        verification: {
          ...verification,
          rejected: true,
        },
      };
    }
  }

  return {
    geometry: finalGeo,
    beforeStats,
    afterStats: finalStats,
    holesFilled: finalHoles,
    edgesStitched: finalStitched,
    degeneratesRemoved: finalDegen,
    partsRemoved: finalParts,
    verification,
  };
}

/**
 * Remove broken shards or tiny unconnected mesh components from a BufferGeometry.
 *
 * @param {THREE.BufferGeometry} geometry
 * @param {object} [options]
 * @returns {{ geometry: THREE.BufferGeometry, partsRemoved: number, trianglesRemoved: number, beforeStats: object, afterStats: object }}
 */
export function removeDisconnectedParts(geometry, options = {}) {
  const { weldEps = 1e-5, maxAreaRatio = 0.05, keepOnlyLargest = false } = options;
  const beforeStats = analyzeMesh(geometry);
  const { vertices, tris: rawTris } = extractWeldedMesh(geometry, weldEps);
  // Only drop exact duplicates / zero-area triangles here; never touch the main body's
  // non-manifold seams (that is MeshFixer's job), so this stays a pure loose-part cleanup.
  const prunedDeg = pruneTriangles(vertices, rawTris);
  const partRes = pruneDisconnectedParts(vertices, prunedDeg.tris, {
    maxAreaRatio,
    keepOnlyLargest,
  });

  const cleanGeo = buildGeometryFromTris(vertices, partRes.tris);
  const afterStats = analyzeMesh(cleanGeo);

  return {
    geometry: cleanGeo,
    partsRemoved: partRes.partsRemoved,
    trianglesRemoved: prunedDeg.removed + partRes.trianglesRemoved,
    beforeStats,
    afterStats,
  };
}

/**
 * Detect unconnected or loose components without modifying the geometry.
 * Returns statistics and a BufferGeometry of the loose parts suitable for 3D viewport preview.
 *
 * @param {THREE.BufferGeometry} geometry
 * @param {object} [options]
 * @returns {{ count: number, triangles: number, components: Array<object>, geometry: THREE.BufferGeometry|null }}
 */
export function findLooseParts(geometry, options = {}) {
  const { weldEps = 1e-5, maxAreaRatio = 0.05, keepOnlyLargest = false } = options;
  if (!geometry) {
    return { count: 0, triangles: 0, components: [], geometry: null };
  }

  const { vertices, tris: rawTris } = extractWeldedMesh(geometry, weldEps);
  const prunedDeg = pruneTriangles(vertices, rawTris);
  const components = findConnectedComponents(vertices, prunedDeg.tris, maxAreaRatio);

  if (components.length <= 1) {
    return { count: 0, triangles: 0, components: [], geometry: null };
  }

  const removable = [];
  const looseTris = [];

  for (let i = 1; i < components.length; i++) {
    const comp = components[i];
    if (keepOnlyLargest || comp.isRemovable) {
      removable.push(comp);
      for (const f of comp.triIndices) {
        looseTris.push(prunedDeg.tris[f]);
      }
    }
  }

  if (looseTris.length === 0) {
    return { count: 0, triangles: 0, components: [], geometry: null };
  }

  const looseGeo = buildGeometryFromTris(vertices, looseTris);
  return {
    count: removable.length,
    triangles: looseTris.length,
    components: removable,
    geometry: looseGeo,
  };
}

/**
 * Compute signed volume and surface area of non-indexed or indexed BufferGeometry triangles.
 */
function computeGeometryMetrics(geometry) {
  if (!geometry) return { volume: 0, area: 0 };
  const geo = geometry.index ? geometry.toNonIndexed() : geometry;
  const pos = geo.getAttribute('position');
  if (!pos || pos.count < 3) {
    if (geo !== geometry) geo.dispose();
    return { volume: 0, area: 0 };
  }
  let vol = 0;
  let area = 0;
  const p1 = new THREE.Vector3(), p2 = new THREE.Vector3(), p3 = new THREE.Vector3();
  const ab = new THREE.Vector3(), ac = new THREE.Vector3(), cross = new THREE.Vector3();
  const triCount = Math.floor(pos.count / 3);
  for (let i = 0; i < triCount; i++) {
    p1.fromBufferAttribute(pos, i * 3);
    p2.fromBufferAttribute(pos, i * 3 + 1);
    p3.fromBufferAttribute(pos, i * 3 + 2);
    vol += p1.dot(p2.cross(p3)) / 6.0;
    ab.subVectors(p2, p1);
    ac.subVectors(p3, p1);
    cross.crossVectors(ab, ac);
    area += 0.5 * cross.length();
  }
  if (geo !== geometry) geo.dispose();
  return { volume: Math.abs(vol), area };
}

/**
 * Verify a repaired mesh by computing its boolean difference against the original body
 * (Fixed - Original) to detect whether large, spurious new parts or volumes were generated.
 *
 * @param {THREE.BufferGeometry} origGeometry - Original input body before fixing
 * @param {THREE.BufferGeometry} fixedGeometry - Candidate repaired geometry
 * @param {object} [options]
 * @param {number} [options.maxVolumeRatio=0.02] - Maximum allowable volume ratio of any new part relative to original body (default 2%)
 * @param {number} [options.maxAreaRatio=0.08] - Maximum allowable surface area ratio of any new part relative to original body (default 8%)
 * @param {number} [options.maxDimRatio=0.35] - Maximum allowable bounding diagonal ratio (default 35%)
 * @param {number} [options.boundExpandRatio=0.05] - Maximum tolerance for bounding box expansion (default 5%)
 * @returns {{
 *   verified: boolean,
 *   hasLargeNewParts: boolean,
 *   largePartsCount: number,
 *   diffTriangles: number,
 *   diffVolume: number,
 *   diffArea: number,
 *   largeParts: Array<object>,
 *   reason?: string
 * }}
 */
export function verifyMeshFixWithBoolDiff(origGeometry, fixedGeometry, options = {}) {
  const {
    maxVolumeRatio = 0.02,
    maxAreaRatio = 0.03,
    maxDimRatio = 0.35,
    boundExpandRatio = 0.05,
  } = options;

  if (!origGeometry || !fixedGeometry) {
    return {
      verified: true,
      hasLargeNewParts: false,
      largePartsCount: 0,
      diffTriangles: 0,
      diffVolume: 0,
      diffArea: 0,
      largeParts: [],
    };
  }

  // 1. Analyze original and fixed body bounds and metrics
  if (!origGeometry.boundingBox) origGeometry.computeBoundingBox();
  if (!fixedGeometry.boundingBox) fixedGeometry.computeBoundingBox();
  const origBox = origGeometry.boundingBox.clone();
  const fixBox = fixedGeometry.boundingBox.clone();
  const origSize = origBox.getSize(new THREE.Vector3());
  const origDiag = Math.max(origSize.length(), 1e-4);

  const origMetrics = computeGeometryMetrics(origGeometry);
  const origArea = Math.max(origMetrics.area, 1e-4);
  const origVol = Math.max(origMetrics.volume, origSize.x * origSize.y * origSize.z * 0.15, 1e-4);

  const fixedMetrics = computeGeometryMetrics(fixedGeometry);
  const fixedVol = fixedMetrics.volume;
  const fixedArea = fixedMetrics.area;

  const expandTol = Math.max(origDiag * boundExpandRatio, 0.5);
  const boundsExceeded = (
    fixBox.min.x < origBox.min.x - expandTol ||
    fixBox.min.y < origBox.min.y - expandTol ||
    fixBox.min.z < origBox.min.z - expandTol ||
    fixBox.max.x > origBox.max.x + expandTol ||
    fixBox.max.y > origBox.max.y + expandTol ||
    fixBox.max.z > origBox.max.z + expandTol
  );

  const origPos = origGeometry.getAttribute('position');
  const fixPos = fixedGeometry.getAttribute('position');
  const origFaces = origPos ? Math.floor(origPos.count / 3) : 0;
  const fixFaces = fixPos ? Math.floor(fixPos.count / 3) : 0;

  // If fixed geometry has fewer or equal faces and bounds did not expand, no new geometry/bridges could have been created
  if (!boundsExceeded && fixFaces <= origFaces) {
    return {
      verified: true,
      hasLargeNewParts: false,
      largePartsCount: 0,
      diffTriangles: 0,
      diffVolume: 0,
      diffArea: 0,
      largeParts: [],
    };
  }

  // If fixed geometry is essentially identical to original (e.g. vertices were welded without volumetric change)
  const volDiffRatio = Math.abs(fixedVol - origVol) / origVol;
  const areaDiffRatio = Math.abs(fixedArea - origArea) / origArea;
  if (!boundsExceeded && volDiffRatio < 0.005 && areaDiffRatio < 0.01) {
    return {
      verified: true,
      hasLargeNewParts: false,
      largePartsCount: 0,
      diffTriangles: 0,
      diffVolume: 0,
      diffArea: 0,
      largeParts: [],
    };
  }

  // 2. Perform CSG Boolean Difference: Fixed - Original
  let diffGeo;
  try {
    const evaluator = new Evaluator();
    evaluator.attributes = ['position'];

    const bOrig = new Brush(origGeometry.index ? origGeometry.toNonIndexed() : origGeometry.clone());
    bOrig.updateMatrixWorld();
    const bFixed = new Brush(fixedGeometry.index ? fixedGeometry.toNonIndexed() : fixedGeometry.clone());
    bFixed.updateMatrixWorld();

    const diffResult = evaluator.evaluate(bFixed, bOrig, SUBTRACTION);
    diffGeo = diffResult?.geometry || null;
  } catch (err) {
    console.warn('verifyMeshFixWithBoolDiff: CSG difference evaluation failed, fallback to geometric bounds:', err);
    return {
      verified: !boundsExceeded,
      hasLargeNewParts: boundsExceeded,
      largePartsCount: boundsExceeded ? 1 : 0,
      diffTriangles: 0,
      diffVolume: 0,
      diffArea: 0,
      largeParts: [],
      reason: boundsExceeded ? 'Fixed mesh expanded significantly beyond original bounding envelope' : undefined,
    };
  }

  const diffPos = diffGeo ? diffGeo.getAttribute('position') : null;
  const diffTriCount = diffPos ? Math.floor(diffPos.count / 3) : 0;

  if (diffTriCount === 0) {
    return {
      verified: true,
      hasLargeNewParts: false,
      largePartsCount: 0,
      diffTriangles: 0,
      diffVolume: 0,
      diffArea: 0,
      largeParts: [],
    };
  }

  // 3. Cluster diff triangles into connected components / parts
  const { vertices: diffVertices, tris: diffTris } = extractWeldedMesh(diffGeo, 1e-4);
  const diffComponents = findConnectedComponents(diffVertices, diffTris, 0.0);
  const largeParts = [];

  for (const comp of diffComponents) {
    const compArea = comp.area || 0;
    const dx = Math.max(comp.maxX - comp.minX, 0);
    const dy = Math.max(comp.maxY - comp.minY, 0);
    const dz = Math.max(comp.maxZ - comp.minZ, 0);
    const compDiag = Math.hypot(dx, dy, dz);

    // Determine if this component forms a closed solid shell or an open surface sheet
    const edgeCounts = new Map();
    for (const f of comp.triIndices) {
      const [a, b, c] = diffTris[f];
      const e1 = a < b ? `${a}_${b}` : `${b}_${a}`;
      const e2 = b < c ? `${b}_${c}` : `${c}_${b}`;
      const e3 = c < a ? `${c}_${a}` : `${a}_${c}`;
      edgeCounts.set(e1, (edgeCounts.get(e1) || 0) + 1);
      edgeCounts.set(e2, (edgeCounts.get(e2) || 0) + 1);
      edgeCounts.set(e3, (edgeCounts.get(e3) || 0) + 1);
    }
    let openEdges = 0;
    for (const cnt of edgeCounts.values()) {
      if (cnt === 1) openEdges++;
    }
    const isClosedSolid = openEdges === 0 && comp.triIndices.length >= 4;

    let compVolume = 0;
    if (isClosedSolid) {
      const p1 = new THREE.Vector3(), p2 = new THREE.Vector3(), p3 = new THREE.Vector3();
      for (const f of comp.triIndices) {
        const [a, b, c] = diffTris[f];
        const va = diffVertices[a], vb = diffVertices[b], vc = diffVertices[c];
        p1.set(va.x, va.y, va.z);
        p2.set(vb.x, vb.y, vb.z);
        p3.set(vc.x, vc.y, vc.z);
        compVolume += p1.dot(p2.cross(p3)) / 6.0;
      }
      compVolume = Math.abs(compVolume);
    }

    const volRatio = compVolume / origVol;
    const areaRatio = compArea / origArea;
    const dimRatio = compDiag / origDiag;

    const outOfBounds = (
      comp.minX < origBox.min.x - expandTol ||
      comp.minY < origBox.min.y - expandTol ||
      comp.minZ < origBox.min.z - expandTol ||
      comp.maxX > origBox.max.x + expandTol ||
      comp.maxY > origBox.max.y + expandTol ||
      comp.maxZ > origBox.max.z + expandTol
    );

    // Identify as large new part if:
    // a) Closed 3D solid with significant volume (> maxVolumeRatio); OR
    // b) Excessive surface area expansion (> maxAreaRatio); OR
    // c) Outside original bounding envelope with non-trivial area; OR
    // d) An unattached sheet / bridge spanning across 3D space with span > 0.5 mm
    const isBridgeSheet = !isClosedSolid && compDiag > 0.5 && compArea > 0.1 && (comp.triIndices?.length || 0) >= 2;
    const isLarge = (
      (isClosedSolid && volRatio > maxVolumeRatio) ||
      (areaRatio > maxAreaRatio) ||
      (outOfBounds && areaRatio > 0.015) ||
      isBridgeSheet
    );

    if (isLarge) {
      largeParts.push({
        triCount: comp.triIndices ? comp.triIndices.length : diffTriCount,
        volume: compVolume,
        area: compArea,
        dimensions: { x: dx, y: dy, z: dz },
        volRatio,
        areaRatio,
        dimRatio,
        outOfBounds,
      });
    }
  }

  let totalNewVol = 0;
  let totalNewArea = 0;
  for (const comp of diffComponents) {
    totalNewArea += (comp.area || 0);
  }
  for (const p of largeParts) {
    totalNewVol += p.volume;
  }

  const hasLargeNewParts = largeParts.length > 0;
  let reason;
  if (hasLargeNewParts) {
    const maxV = Math.max(...largeParts.map(p => p.volRatio));
    const maxA = Math.max(...largeParts.map(p => p.areaRatio));
    reason = `Detected ${largeParts.length} large new part(s) generated by fixer (max volume ratio: ${(maxV * 100).toFixed(1)}%, max area ratio: ${(maxA * 100).toFixed(1)}%)`;
  }

  return {
    verified: !hasLargeNewParts,
    hasLargeNewParts,
    largePartsCount: largeParts.length,
    diffTriangles: diffTriCount,
    diffVolume: totalNewVol,
    diffArea: totalNewArea,
    largeParts,
    reason,
  };
}
