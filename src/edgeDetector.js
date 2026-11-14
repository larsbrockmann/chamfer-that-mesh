/* ============================================================
   edgeDetector.js — Half-edge mesh builder, sharp edge detection & selection
   ============================================================ */
import * as THREE from 'three';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';

/**
 * Container for detected-edge data and selection state.
 */
export class EdgeData {
  constructor() {
    /** @type {Array<object>} */
    this.sharpEdges = [];
    /** @type {number} count of initially detected raw edges before filtering */
    this.rawDetectedCount = 0;
    /** @type {number} count of edges filtered or combined */
    this.filteredCount = 0;
    /** @type {LineSegments2|null} */
    this.lineSegments = null;
    /** @type {LineSegmentsGeometry|null} */
    this.lineGeo = null;
    /** @type {LineMaterial|null} */
    this.lineMat = null;
    /** @type {Map<string, number[]>} edge key -> face indices */
    this.adjacency = new Map();
    /** @type {THREE.Vector3[]} welded vertex positions */
    this.vertices = [];
    /** @type {number[][]} face vertex index triples */
    this.faces = [];
    /** @type {THREE.Vector3[]} face normals */
    this.faceNormals = [];
    /** @type {number[][]} array of edge index chains/loops */
    this.chains = [];
    /** @type {number} currently hovered edge index */
    this.hoveredEdgeIdx = -1;
    /** @type {number} currently hovered chain index */
    this.hoveredChainIdx = -1;
  }

  selectAll() {
    for (const e of this.sharpEdges) e.selected = true;
    this.updateColors();
  }

  clearSelection() {
    for (const e of this.sharpEdges) e.selected = false;
    this.updateColors();
  }

  invertSelection() {
    for (const e of this.sharpEdges) e.selected = !e.selected;
    this.updateColors();
  }

  getSelectedEdges() {
    return this.sharpEdges.filter((e) => e.selected);
  }

  getSelectedCount() {
    return this.sharpEdges.filter((e) => e.selected).length;
  }

  /**
   * Toggle edge selection (either single edge or whole connected loop).
   */
  toggleEdge(edgeIdx, loopMode = true) {
    if (edgeIdx < 0 || edgeIdx >= this.sharpEdges.length) return;
    const target = this.sharpEdges[edgeIdx];
    const newSelected = !target.selected;

    if (loopMode && target.chainId !== undefined && this.chains[target.chainId]) {
      for (const idx of this.chains[target.chainId]) {
        this.sharpEdges[idx].selected = newSelected;
      }
    } else {
      target.selected = newSelected;
    }

    this.updateColors();
  }

  /**
   * Set currently hovered edge.
   */
  setHovered(edgeIdx, loopMode = true) {
    if (this.hoveredEdgeIdx === edgeIdx) return;
    this.hoveredEdgeIdx = edgeIdx;
    if (edgeIdx >= 0 && loopMode && this.sharpEdges[edgeIdx]) {
      this.hoveredChainIdx = this.sharpEdges[edgeIdx].chainId;
    } else {
      this.hoveredChainIdx = -1;
    }
    this.updateColors();
  }

  /**
   * Update line colors based on selected/hovered state.
   */
  updateColors() {
    if (!this.lineGeo || this.sharpEdges.length === 0) return;
    const colors = new Float32Array(this.sharpEdges.length * 6);

    for (let i = 0; i < this.sharpEdges.length; i++) {
      const e = this.sharpEdges[i];
      const isHovered =
        this.hoveredEdgeIdx === i ||
        (this.hoveredChainIdx >= 0 && e.chainId === this.hoveredChainIdx);
      const isSel = e.selected;

      let r, g, b;
      if (isSel && isHovered) {
        // Hovering over an already selected edge:
        // Vivid electric azure-blue highlight so it stays clearly in the selected family
        r = 0.22;
        g = 0.62;
        b = 1.0;
      } else if (isSel) {
        // Ultra-Vibrant Neon Cyan for selected edges
        r = 0.0;
        g = 0.95;
        b = 1.0;
      } else if (isHovered) {
        // Hovering over an unselected edge:
        // Bright Vivid Amber/Gold (invitation to select for chamfer)
        r = 1.0;
        g = 0.88;
        b = 0.15;
      } else {
        // Neutral Cool Steel Slate for unselected detected edges (never brown/coral)
        r = 0.40;
        g = 0.50;
        b = 0.60;
      }

      const off = i * 6;
      colors[off] = r;
      colors[off + 1] = g;
      colors[off + 2] = b;
      colors[off + 3] = r;
      colors[off + 4] = g;
      colors[off + 5] = b;
    }

    this.lineGeo.setColors(colors);
  }

  /**
   * Update viewport resolution on line material for crisp screen-space line width.
   */
  setResolution(w, h) {
    if (this.lineMat) {
      this.lineMat.resolution.set(w, h);
    }
  }

  dispose() {
    if (this.lineSegments) {
      this.lineGeo?.dispose();
      this.lineMat?.dispose();
      this.lineSegments = null;
    }
  }
}

function flipEdgeInPlace(e) {
  const tmpV = e.v1;
  e.v1 = e.v2;
  e.v2 = tmpV;
  const tmpVi = e.vi1;
  e.vi1 = e.vi2;
  e.vi2 = tmpVi;
}

function getEdgeDirFrom(edge, fromVi) {
  return (edge.vi1 === fromVi
    ? new THREE.Vector3().subVectors(edge.v2, edge.v1)
    : new THREE.Vector3().subVectors(edge.v1, edge.v2)
  ).normalize();
}

function faceNormalContinuity(eA, eB, faceNormals) {
  if (!faceNormals) return 2;
  const nA1 = faceNormals[eA.faceIdx1];
  const nA2 = faceNormals[eA.faceIdx2];
  const nB1 = faceNormals[eB.faceIdx1];
  const nB2 = faceNormals[eB.faceIdx2];
  if (!nA1 || !nA2 || !nB1 || !nB2) return 2;
  return Math.max(
    nA1.dot(nB1) + nA2.dot(nB2),
    nA1.dot(nB2) + nA2.dot(nB1)
  );
}

/**
 * Cluster connected sharp edges into continuous loops and open chains,
 * separating convex/concave edges and preventing 3-way junction tangling.
 */
function buildEdgeChains(sharpEdges, faceNormals) {
  const adj = new Map();
  for (let i = 0; i < sharpEdges.length; i++) {
    const e = sharpEdges[i];
    if (!adj.has(e.vi1)) adj.set(e.vi1, []);
    if (!adj.has(e.vi2)) adj.set(e.vi2, []);
    adj.get(e.vi1).push({ edgeIdx: i, other: e.vi2 });
    adj.get(e.vi2).push({ edgeIdx: i, other: e.vi1 });
  }

  const visited = new Set();
  const chains = [];
  const junctionCos = Math.cos((45 * Math.PI) / 180);

  function pickBestContinuation(curEdgeIdx, sharedVi) {
    const incident = adj.get(sharedVi) || [];
    const isJunction = incident.length > 2;
    const cur = sharpEdges[curEdgeIdx];
    const dIn = getEdgeDirFrom(cur, sharedVi).negate();

    let best = null;
    let bestScore = -Infinity;

    for (const cand of incident) {
      if (visited.has(cand.edgeIdx)) continue;
      const candEdge = sharpEdges[cand.edgeIdx];
      if (candEdge.isConvex !== cur.isConvex) continue;

      const dOut = getEdgeDirFrom(candEdge, sharedVi);
      const dot = dIn.dot(dOut);
      const fnScore = faceNormalContinuity(cur, candEdge, faceNormals);

      if (isJunction) {
        if (dot < junctionCos || fnScore < 1.6) continue;
      } else {
        if (dot < -0.2) continue;
      }

      const score = dot + 0.5 * fnScore;
      if (score > bestScore) {
        bestScore = score;
        best = cand;
      }
    }

    return best;
  }

  for (let i = 0; i < sharpEdges.length; i++) {
    if (visited.has(i)) continue;
    const chainEdgeIndices = [i];
    visited.add(i);

    const vStart = sharpEdges[i].vi1;
    let vCurr = sharpEdges[i].vi2;
    let fwdEdgeIdx = i;

    while (true) {
      const next = pickBestContinuation(fwdEdgeIdx, vCurr);
      if (!next) break;
      visited.add(next.edgeIdx);
      chainEdgeIndices.push(next.edgeIdx);
      fwdEdgeIdx = next.edgeIdx;
      vCurr = next.other;
      if (vCurr === vStart) break; // closed loop
    }

    if (vCurr !== vStart) {
      let vBack = vStart;
      let backEdgeIdx = i;
      while (true) {
        const back = pickBestContinuation(backEdgeIdx, vBack);
        if (!back) break;
        visited.add(back.edgeIdx);
        chainEdgeIndices.unshift(back.edgeIdx);
        backEdgeIdx = back.edgeIdx;
        vBack = back.other;
        if (vBack === vCurr) break;
      }
    }

    // Orient edges consistently along the chain path
    if (chainEdgeIndices.length >= 2) {
      const e0 = sharpEdges[chainEdgeIndices[0]];
      const e1 = sharpEdges[chainEdgeIndices[1]];
      if (
        (e0.vi1 === e1.vi1 || e0.vi1 === e1.vi2) &&
        e0.vi2 !== e1.vi1 &&
        e0.vi2 !== e1.vi2
      ) {
        flipEdgeInPlace(e0);
      }
      for (let k = 1; k < chainEdgeIndices.length; k++) {
        const prev = sharpEdges[chainEdgeIndices[k - 1]];
        const cur = sharpEdges[chainEdgeIndices[k]];
        if (cur.vi1 !== prev.vi2 && cur.vi2 === prev.vi2) {
          flipEdgeInPlace(cur);
        }
      }
    }

    const chainId = chains.length;
    for (const edgeIdx of chainEdgeIndices) {
      sharpEdges[edgeIdx].chainId = chainId;
    }
    chains.push(chainEdgeIndices);
  }

  return chains;
}

/**
 * Check whether both adjacent faces of two sharp edges are coplanar within 0.999 dot.
 */
function areFacesCoplanar(eA, eB, faceNormals) {
  if (!faceNormals) return true;
  const nA1 = faceNormals[eA.faceIdx1];
  const nA2 = faceNormals[eA.faceIdx2];
  const nB1 = faceNormals[eB.faceIdx1];
  const nB2 = faceNormals[eB.faceIdx2];
  if (!nA1 || !nA2 || !nB1 || !nB2) return true;
  return (
    (nA1.dot(nB1) >= 0.999 && nA2.dot(nB2) >= 0.999) ||
    (nA1.dot(nB2) >= 0.999 && nA2.dot(nB1) >= 0.999)
  );
}

/**
 * Filter and simplify detected edge chains:
 * - Drops degenerate zero-length edges.
 * - 'ignore': drops isolated edges shorter than minEdgeLength while preserving continuous curved loops.
 * - 'combine': merges adjacent collinear, coplanar segments along the chain without collapsing curves.
 * - 'both': combines collinear coplanar segments and drops remaining isolated micro-noise.
 */
function filterAndProcessChains(chains, sharpEdges, faceNormals, options = {}) {
  const {
    filterTiny = true,
    minEdgeLength = 0.20,
    filterMode = 'combine', // 'ignore' | 'combine' | 'both'
    collinearAngleDeg = 12,
  } = options;

  if (!filterTiny) {
    const validEdges = [];
    const validChains = [];
    for (const chain of chains) {
      const valid = [];
      for (const idx of chain) {
        const e = sharpEdges[idx];
        if (e.v1.distanceTo(e.v2) > 1e-5) {
          const newIdx = validEdges.length;
          e.chainId = validChains.length;
          validEdges.push(e);
          valid.push(newIdx);
        }
      }
      if (valid.length > 0) validChains.push(valid);
    }
    return { edges: validEdges, chains: validChains };
  }

  // Count sharp-edge degree at each vertex across all raw sharp edges
  const sharpDegree = new Map();
  for (const e of sharpEdges) {
    if (e.v1.distanceTo(e.v2) <= 1e-5) continue;
    sharpDegree.set(e.vi1, (sharpDegree.get(e.vi1) || 0) + 1);
    sharpDegree.set(e.vi2, (sharpDegree.get(e.vi2) || 0) + 1);
  }

  const strictAngleDeg = Math.min(collinearAngleDeg, 2.5);
  const strictCos = Math.cos((strictAngleDeg * Math.PI) / 180);
  const newEdges = [];
  const newChains = [];

  for (const chain of chains) {
    if (chain.length === 0) continue;

    // Filter out zero-length/degenerate edges in this chain
    const validIndices = chain.filter((idx) => {
      const e = sharpEdges[idx];
      return e.v1.distanceTo(e.v2) > 1e-5;
    });
    if (validIndices.length === 0) continue;

    // Compute total chain length
    let totalLen = 0;
    for (const idx of validIndices) {
      const e = sharpEdges[idx];
      totalLen += e.v1.distanceTo(e.v2);
    }

    // Ignore isolated micro-noise (short isolated chains with total length < minEdgeLength)
    if ((filterMode === 'ignore' || filterMode === 'both') && totalLen < minEdgeLength) {
      continue;
    }

    if (filterMode === 'ignore') {
      const preserveCurve = validIndices.length >= 3 && totalLen >= minEdgeLength * 2;
      const chainNewIndices = [];
      for (const idx of validIndices) {
        const e = sharpEdges[idx];
        if (preserveCurve || e.v1.distanceTo(e.v2) >= minEdgeLength) {
          const newIdx = newEdges.length;
          const cloned = { ...e, v1: e.v1.clone(), v2: e.v2.clone(), chainId: newChains.length };
          newEdges.push(cloned);
          chainNewIndices.push(newIdx);
        }
      }
      if (chainNewIndices.length > 0) {
        newChains.push(chainNewIndices);
      }
      continue;
    }

    // Combine or Both mode: merge only genuinely collinear, coplanar segments away from 3-way junctions
    const e0 = sharpEdges[validIndices[0]];
    let cur = {
      v1: e0.v1.clone(),
      v2: e0.v2.clone(),
      vi1: e0.vi1,
      vi2: e0.vi2,
      faceIdx1: e0.faceIdx1,
      faceIdx2: e0.faceIdx2,
      opp1Idx: e0.opp1Idx,
      opp2Idx: e0.opp2Idx,
      isConvex: e0.isConvex,
      dihedralAngle: e0.dihedralAngle,
      selected: e0.selected ?? true,
    };
    let curInitDir = new THREE.Vector3().subVectors(cur.v2, cur.v1).normalize();

    const working = [];

    for (let i = 1; i < validIndices.length; i++) {
      const next = sharpEdges[validIndices[i]];
      let nextV1 = next.v1;
      let nextV2 = next.v2;
      let nextVi1 = next.vi1;
      let nextVi2 = next.vi2;

      // Defensive orientation check if next is reversed relative to cur.v2
      if (cur.v2.distanceToSquared(next.v2) < cur.v2.distanceToSquared(next.v1)) {
        nextV1 = next.v2;
        nextV2 = next.v1;
        nextVi1 = next.vi2;
        nextVi2 = next.vi1;
      }

      const dCur = new THREE.Vector3().subVectors(cur.v2, cur.v1).normalize();
      const dNext = new THREE.Vector3().subVectors(nextV2, nextV1).normalize();
      const dChord = new THREE.Vector3().subVectors(nextV2, cur.v1).normalize();

      const connected = cur.v2.distanceToSquared(nextV1) <= 1e-8;
      const sameConvexity = cur.isConvex === next.isConvex;
      const nonBranching = (sharpDegree.get(cur.vi2) || 0) <= 2;
      const isStrictlyCollinear =
        dCur.dot(dNext) >= strictCos &&
        curInitDir.dot(dNext) >= strictCos &&
        curInitDir.dot(dChord) >= strictCos;
      const coplanar = areFacesCoplanar(cur, next, faceNormals);

      if (connected && sameConvexity && nonBranching && isStrictlyCollinear && coplanar) {
        cur.v2 = nextV2.clone();
        cur.vi2 = nextVi2;
      } else {
        working.push(cur);
        cur = {
          v1: nextV1.clone(),
          v2: nextV2.clone(),
          vi1: nextVi1,
          vi2: nextVi2,
          faceIdx1: next.faceIdx1,
          faceIdx2: next.faceIdx2,
          opp1Idx: next.opp1Idx,
          opp2Idx: next.opp2Idx,
          isConvex: next.isConvex,
          dihedralAngle: next.dihedralAngle,
          selected: next.selected ?? true,
        };
        curInitDir = dNext;
      }
    }
    working.push(cur);

    let finalWorking = working;
    if (filterMode === 'both') {
      let workingLen = 0;
      for (const e of working) workingLen += e.v1.distanceTo(e.v2);
      const preserveCurve = working.length >= 3 && workingLen >= minEdgeLength * 2;
      if (!preserveCurve) {
        finalWorking = working.filter((e) => e.v1.distanceTo(e.v2) >= minEdgeLength);
      }
    }

    if (finalWorking.length > 0) {
      const chainNewIndices = [];
      for (const e of finalWorking) {
        e.chainId = newChains.length;
        const idx = newEdges.length;
        newEdges.push(e);
        chainNewIndices.push(idx);
      }
      newChains.push(chainNewIndices);
    }
  }

  return { edges: newEdges, chains: newChains };
}

/**
 * Detect sharp edges in a BufferGeometry with automatic filtering and chain simplification.
 *
 * @param {THREE.BufferGeometry} geometry
 * @param {number} angleThresholdDeg — edges sharper than this (dihedral > threshold) are marked
 * @param {object} [options]
 * @returns {EdgeData}
 */
export function detectEdges(geometry, angleThresholdDeg = 30, options = {}) {
  const edgeData = new EdgeData();
  const posAttr = geometry.getAttribute('position');
  if (!posAttr) return edgeData;

  const opts = typeof options === 'object' ? options : {};
  const viewportResolution = {
    width: opts.width || opts.viewportWidth || 1000,
    height: opts.height || opts.viewportHeight || 800,
  };
  const filterTiny = opts.filterTiny !== undefined ? opts.filterTiny : false;
  const minEdgeLength = opts.minEdgeLength !== undefined ? opts.minEdgeLength : 0.20;
  const filterMode = opts.filterMode || 'ignore';
  const collinearAngleDeg = opts.collinearAngleDeg || 12;
  const convexOnly = !!opts.convexOnly;

  const posArray = posAttr.array;
  const indexed = !!geometry.index;
  const indices = indexed ? geometry.index.array : null;
  const triCount = indexed
    ? geometry.index.count / 3
    : posAttr.count / 3;

  // ---- 1. Read all vertex positions ----
  const rawVerts = [];
  for (let i = 0; i < posAttr.count; i++) {
    rawVerts.push(
      new THREE.Vector3(
        posArray[i * 3],
        posArray[i * 3 + 1],
        posArray[i * 3 + 2]
      )
    );
  }

  // ---- 2. Weld vertices via spatial hashing ----
  const EPSILON = 1e-6;
  const CELL = EPSILON * 100;
  const weldMap = new Map();
  const weldedPositions = [];
  const vertexRemap = new Int32Array(rawVerts.length);

  function hashKey(v) {
    const gx = Math.round(v.x / CELL);
    const gy = Math.round(v.y / CELL);
    const gz = Math.round(v.z / CELL);
    return `${gx},${gy},${gz}`;
  }

  for (let i = 0; i < rawVerts.length; i++) {
    const v = rawVerts[i];
    const key = hashKey(v);

    let found = -1;
    const bucket = weldMap.get(key);
    if (bucket) {
      for (const entry of bucket) {
        if (entry.pos.distanceToSquared(v) < EPSILON * EPSILON) {
          found = entry.weldIdx;
          break;
        }
      }
    }

    if (found >= 0) {
      vertexRemap[i] = found;
    } else {
      const idx = weldedPositions.length;
      weldedPositions.push(v.clone());
      vertexRemap[i] = idx;
      if (!weldMap.has(key)) weldMap.set(key, []);
      weldMap.get(key).push({ pos: v, weldIdx: idx });
    }
  }

  edgeData.vertices = weldedPositions;

  // ---- 3. Build faces & compute face normals ----
  const faces = [];
  const faceNormals = [];
  const tmpA = new THREE.Vector3();
  const tmpB = new THREE.Vector3();

  for (let f = 0; f < triCount; f++) {
    let i0, i1, i2;
    if (indexed) {
      i0 = indices[f * 3];
      i1 = indices[f * 3 + 1];
      i2 = indices[f * 3 + 2];
    } else {
      i0 = f * 3;
      i1 = f * 3 + 1;
      i2 = f * 3 + 2;
    }

    const w0 = vertexRemap[i0];
    const w1 = vertexRemap[i1];
    const w2 = vertexRemap[i2];
    faces.push([w0, w1, w2]);

    const p0 = weldedPositions[w0];
    const p1 = weldedPositions[w1];
    const p2 = weldedPositions[w2];
    tmpA.subVectors(p1, p0);
    tmpB.subVectors(p2, p0);
    const normal = new THREE.Vector3().crossVectors(tmpA, tmpB).normalize();
    faceNormals.push(normal);
  }

  edgeData.faces = faces;
  edgeData.faceNormals = faceNormals;

  // ---- 4. Build edge adjacency ----
  const edgeAdjacency = new Map();

  function edgeKey(a, b) {
    return a < b ? `${a}_${b}` : `${b}_${a}`;
  }

  for (let f = 0; f < faces.length; f++) {
    const [a, b, c] = faces[f];
    for (const [va, vb] of [
      [a, b],
      [b, c],
      [c, a],
    ]) {
      const key = edgeKey(va, vb);
      if (!edgeAdjacency.has(key)) edgeAdjacency.set(key, []);
      edgeAdjacency.get(key).push(f);
    }
  }

  edgeData.adjacency = edgeAdjacency;

  // ---- 5. Find sharp edges by dihedral angle ----
  const thresholdRad = (angleThresholdDeg * Math.PI) / 180;
  const sharpEdges = [];

  for (const [key, faceList] of edgeAdjacency) {
    if (faceList.length !== 2) continue;
    const [f1, f2] = faceList;
    const n1 = faceNormals[f1];
    const n2 = faceNormals[f2];

    const dot = THREE.MathUtils.clamp(n1.dot(n2), -1, 1);
    const dihedralAngle = Math.acos(dot);

    if (dihedralAngle > thresholdRad) {
      const parts = key.split('_');
      const vi1 = parseInt(parts[0]);
      const vi2 = parseInt(parts[1]);

      const face1 = faces[f1];
      const opp1Idx = face1.find((idx) => idx !== vi1 && idx !== vi2);
      const face2 = faces[f2];
      const opp2Idx = face2.find((idx) => idx !== vi1 && idx !== vi2);

      let isConvex = true;
      if (opp1Idx !== undefined) {
        const vDiff = new THREE.Vector3().subVectors(
          weldedPositions[opp1Idx],
          weldedPositions[vi1]
        );
        isConvex = n2.dot(vDiff) <= 0;
      }

      if (convexOnly && !isConvex) continue;

      sharpEdges.push({
        v1: weldedPositions[vi1].clone(),
        v2: weldedPositions[vi2].clone(),
        vi1,
        vi2,
        opp1Idx,
        opp2Idx,
        isConvex,
        dihedralAngle,
        faceIdx1: f1,
        faceIdx2: f2,
        selected: true, // Selected by default
      });
    }
  }

  const rawChains = buildEdgeChains(sharpEdges, faceNormals);
  const rawCount = sharpEdges.length;

  // ---- 6. Filter & combine tiny/collinear edges ----
  const { edges: filteredEdges, chains: filteredChains } = filterAndProcessChains(
    rawChains,
    sharpEdges,
    faceNormals,
    { filterTiny, minEdgeLength, filterMode, collinearAngleDeg }
  );

  edgeData.rawDetectedCount = rawCount;
  edgeData.filteredCount = Math.max(0, rawCount - filteredEdges.length);
  edgeData.sharpEdges = filteredEdges;
  edgeData.chains = filteredChains;

  // ---- 7. Build High-Visibility LineSegments2 Object ----
  if (filteredEdges.length > 0) {
    const linePositions = [];
    for (let i = 0; i < filteredEdges.length; i++) {
      const e = filteredEdges[i];
      linePositions.push(e.v1.x, e.v1.y, e.v1.z, e.v2.x, e.v2.y, e.v2.z);
    }

    const lineGeo = new LineSegmentsGeometry();
    lineGeo.setPositions(linePositions);

    const res = new THREE.Vector2(
      viewportResolution.width || 1000,
      viewportResolution.height || 800
    );

    const lineMat = new LineMaterial({
      vertexColors: true,
      linewidth: 5.0, // Bold 5.0px line thickness for maximum visibility
      resolution: res,
      depthTest: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -3.0,
      polygonOffsetUnits: -6.0,
      transparent: false,
    });

    const lines = new LineSegments2(lineGeo, lineMat);
    lines.name = 'sharpEdges';
    lines.renderOrder = 10;

    edgeData.lineGeo = lineGeo;
    edgeData.lineMat = lineMat;
    edgeData.lineSegments = lines;

    // Apply initial colors (all selected = neon cyan)
    edgeData.updateColors();
  }

  return edgeData;
}
