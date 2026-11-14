/* ============================================================
   meshFixer.js — Mesh diagnostics, seam stitching, T-junction
   repair, ear-clipping hole filling & normal orientation
   ============================================================ */
import * as THREE from 'three';

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

  const cellSize = Math.max(eps * 2.5, 1e-6);
  const epsSq = eps * eps;
  const grid = new Map();
  const vertices = [];
  const remap = new Int32Array(posAttr.count);

  const cellKey = (cx, cy, cz) => `${cx},${cy},${cz}`;

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
          const bucket = grid.get(cellKey(cx + dx, cy + dy, cz + dz));
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
      const key = cellKey(cx, cy, cz);
      if (!grid.has(key)) grid.set(key, []);
      grid.get(key).push(idx);
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

function isDegenerateTri(vertices, a, b, c, areaEpsSq = 1e-16) {
  if (a === b || b === c || c === a) return true;
  const va = vertices[a];
  const vb = vertices[b];
  const vc = vertices[c];
  const abx = vb.x - va.x, aby = vb.y - va.y, abz = vb.z - va.z;
  const acx = vc.x - va.x, acy = vc.y - va.y, acz = vc.z - va.z;
  const cx = aby * acz - abz * acy;
  const cy = abz * acx - abx * acz;
  const cz = abx * acy - aby * acx;
  return cx * cx + cy * cy + cz * cz < areaEpsSq;
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
 * and degenerate triangles.
 *
 * @param {THREE.BufferGeometry} geometry
 * @returns {{ openEdges: number, holeLoops: number, nonManifoldEdges: number, degenerateTriangles: number, isWatertight: boolean, issueCount: number }}
 */
export function analyzeMesh(geometry) {
  if (!geometry || !geometry.getAttribute('position')) {
    return {
      openEdges: 0,
      holeLoops: 0,
      nonManifoldEdges: 0,
      degenerateTriangles: 0,
      isWatertight: true,
      issueCount: 0,
    };
  }

  const { vertices, tris } = extractWeldedMesh(geometry, 1e-5);
  const topo = buildTopology(vertices, tris);
  const loops = traceHoleLoops(vertices, topo.openHalfEdges);
  const closedLoops = loops.filter((l) => l.closed).length;
  const holeLoops = closedLoops > 0 ? closedLoops : (topo.openEdges > 0 ? loops.length : 0);
  const issueCount = topo.openEdges + topo.nonManifoldEdges + topo.degenerateTriangles;

  return {
    openEdges: topo.openEdges,
    holeLoops,
    nonManifoldEdges: topo.nonManifoldEdges,
    degenerateTriangles: topo.degenerateTriangles,
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

/**
 * Remove stray CSG fin/sliver triangles that attach only along non-manifold edges
 * and have zero manifold (count === 2, opposite half-edges) neighbors.
 */
function pruneNonManifoldFins(tris) {
  let current = tris;
  let totalRemoved = 0;

  for (let pass = 0; pass < 6; pass++) {
    const { ec, hc } = buildManifoldMaps(current);
    const next = [];
    let removed = 0;

    for (const tri of current) {
      const [a, b, c] = tri;
      let hasNM = false;
      let hasManifold = false;

      for (const [u, v] of [[a, b], [b, c], [c, a]]) {
        const uCount = ec.get(edgeKey(u, v)) || 0;
        const fCount = hc.get(`${u}->${v}`) || 0;
        const rCount = hc.get(`${v}->${u}`) || 0;
        if (uCount > 2 || fCount > 1 || rCount > 1) hasNM = true;
        if (uCount === 2 && fCount === 1 && rCount === 1) hasManifold = true;
      }

      if (hasNM && !hasManifold) {
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

  return { tris: current, removed: totalRemoved };
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
  const cellKey = (cx, cy, cz) => `${cx},${cy},${cz}`;

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
          const bucket = grid.get(cellKey(cx + dx, cy + dy, cz + dz));
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
      const key = cellKey(cx, cy, cz);
      if (!grid.has(key)) grid.set(key, []);
      grid.get(key).push(vIdx);
    }
  }

  if (snappedCount === 0) return { tris, snappedCount: 0 };

  const remap = new Int32Array(vertices.length);
  for (let i = 0; i < vertices.length; i++) remap[i] = findRoot(i);

  const pruned = pruneTriangles(vertices, tris, remap);
  const afterTopo = buildTopology(vertices, pruned.tris);
  if (afterTopo.nonManifoldEdges <= beforeTopo.nonManifoldEdges) {
    return { tris: pruned.tris, snappedCount };
  }

  // Fallback: try per-vertex snaps individually using live edge counts
  let curTris = tris.map((t) => [...t]);
  let safeSnapped = 0;
  const { ec } = buildManifoldMaps(curTris);
  const vToTris = new Map();
  for (let f = 0; f < curTris.length; f++) {
    for (const v of curTris[f]) {
      if (!vToTris.has(v)) vToTris.set(v, []);
      vToTris.get(v).push(f);
    }
  }

  for (const vIdx of bVerts) {
    const target = remap[vIdx];
    if (target === vIdx) continue;
    const fList = vToTris.get(vIdx);
    if (!fList || fList.length === 0) continue;

    // Test net edge-count deltas of replacing vIdx -> target across incident tris
    const deltas = new Map();
    const newTriEdges = [];
    for (const f of fList) {
      const t = curTris[f];
      const nt = [
        t[0] === vIdx ? target : t[0],
        t[1] === vIdx ? target : t[1],
        t[2] === vIdx ? target : t[2],
      ];
      for (const [u, v] of [[t[0], t[1]], [t[1], t[2]], [t[2], t[0]]]) {
        const k = edgeKey(u, v);
        deltas.set(k, (deltas.get(k) || 0) - 1);
      }
      const degenerate = nt[0] === nt[1] || nt[1] === nt[2] || nt[2] === nt[0];
      if (!degenerate) {
        for (const [u, v] of [[nt[0], nt[1]], [nt[1], nt[2]], [nt[2], nt[0]]]) {
          const k = edgeKey(u, v);
          deltas.set(k, (deltas.get(k) || 0) + 1);
        }
      }
      newTriEdges.push({ f, nt });
    }

    let valid = true;
    for (const [k, d] of deltas) {
      if (d > 0 && (ec.get(k) || 0) + d > 2) {
        valid = false;
        break;
      }
    }
    if (!valid) continue;

    for (const [k, d] of deltas) ec.set(k, (ec.get(k) || 0) + d);
    for (const { f, nt } of newTriEdges) {
      curTris[f] = nt;
      if (nt[0] !== nt[1] && nt[1] !== nt[2] && nt[2] !== nt[0]) {
        if (!vToTris.has(target)) vToTris.set(target, []);
        vToTris.get(target).push(f);
      }
    }
    vToTris.delete(vIdx);
    safeSnapped++;
  }

  if (safeSnapped === 0) return { tris, snappedCount: 0 };
  const safePruned = pruneTriangles(vertices, curTris);
  const safeTopo = buildTopology(vertices, safePruned.tris);
  if (safeTopo.nonManifoldEdges > beforeTopo.nonManifoldEdges) {
    return { tris, snappedCount: 0 };
  }
  return { tris: safePruned.tris, snappedCount: safeSnapped };
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

        const onEdge = [];
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
          if (!nSub || nSub.dot(nOrig) < 0.98) {
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

/**
 * Repair holes, T-junctions, micro-seams, degenerate faces, and winding issues
 * in a BufferGeometry.
 *
 * @param {THREE.BufferGeometry} geometry
 * @param {object} [options]
 * @returns {{ geometry: THREE.BufferGeometry, beforeStats: object, afterStats: object, holesFilled: number, edgesStitched: number, degeneratesRemoved: number }}
 */
export function fixMesh(geometry, options = {}) {
  const {
    weldEps = 1e-4,
    snapEps = 2.5e-4,
    tJuncEps = 8e-4,
    maxHoleVertices = 150,
    _retried = false,
    _pass2 = false,
  } = options;

  const beforeStats = analyzeMesh(geometry);

  // Pass 1: Vertex welding + degenerate/duplicate & stray non-manifold fin pruning
  const { vertices, tris: rawTris } = extractWeldedMesh(geometry, weldEps);
  const pruned1 = pruneTriangles(vertices, rawTris);
  const finPruned = pruneNonManifoldFins(pruned1.tris);
  let tris = finPruned.tris;
  let degeneratesRemoved = pruned1.removed + finPruned.removed;

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

    for (const loopInfo of loops) {
      if (loopInfo.closed && loopInfo.vertices.length >= 3 && loopInfo.vertices.length <= maxHoleVertices) {
        const patch = triangulateHoleLoop(vertices, loopInfo.vertices);
        const loopNormal = loopInfo.vertices.length > 4
          ? computeNewellNormal(loopInfo.vertices.map((idx) => vertices[idx]))
          : null;
        let addedForLoop = 0;

        for (const tri of patch) {
          const [pa, pb, pc] = tri;
          if (isDegenerateTri(vertices, pa, pb, pc)) continue;
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
  }

  // Pass 5: Consistent outward normal winding (guard against increasing non-manifold edges)
  const preHarmTopo = buildTopology(vertices, tris);
  const harmonized = harmonizeNormals(vertices, tris);
  const postHarmTopo = buildTopology(vertices, harmonized);
  if (postHarmTopo.nonManifoldEdges <= preHarmTopo.nonManifoldEdges) {
    tris = harmonized;
  }

  // Build non-indexed BufferGeometry
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

  const fixedGeo = new THREE.BufferGeometry();
  fixedGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  fixedGeo.computeVertexNormals();
  fixedGeo.computeBoundingBox();
  fixedGeo.computeBoundingSphere();

  const afterStats = analyzeMesh(fixedGeo);

  // If coarse initial weld introduced extra non-manifold edges, retry once at tighter weldEps
  if (afterStats.nonManifoldEdges > beforeStats.nonManifoldEdges && !_retried && weldEps > 1e-5) {
    fixedGeo.dispose();
    return fixMesh(geometry, { ...options, weldEps: 1e-5, snapEps: 1e-5, _retried: true });
  }

  // Run one follow-up pass when holes closed by Pass 4 unlock remaining T-junctions
  if (!afterStats.isWatertight && afterStats.issueCount < beforeStats.issueCount && !_pass2) {
    const pass2 = fixMesh(fixedGeo, { ...options, _pass2: true });
    if (
      pass2.afterStats.nonManifoldEdges <= afterStats.nonManifoldEdges &&
      pass2.afterStats.issueCount <= afterStats.issueCount
    ) {
      fixedGeo.dispose();
      return {
        geometry: pass2.geometry,
        beforeStats,
        afterStats: pass2.afterStats,
        holesFilled: holesFilled + pass2.holesFilled,
        edgesStitched: edgesStitched + pass2.edgesStitched,
        degeneratesRemoved: degeneratesRemoved + pass2.degeneratesRemoved,
      };
    }
    pass2.geometry.dispose();
  }

  return {
    geometry: fixedGeo,
    beforeStats,
    afterStats,
    holesFilled,
    edgesStitched,
    degeneratesRemoved,
  };
}
