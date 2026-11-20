/* ============================================================
   edgeDetector.js — Half-edge mesh builder, sharp edge detection & selection
   ============================================================ */
import * as THREE from 'three';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { getFastMeshTopology } from './meshTopology.js';

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
    /** @type {THREE.Vector3[]} welded vertex positions (populated on small meshes) */
    this.vertices = [];
    /** @type {number[][]} face vertex index triples (populated on small meshes) */
    this.faces = [];
    /** @type {THREE.Vector3[]} face normals (populated on small meshes) */
    this.faceNormals = [];
    /** @type {object|null} cached TypedArray topology */
    this.topology = null;
    /** @type {Float32Array|null} welded vertex coordinates (3 per vertex) */
    this.vertCoords = null;
    /** @type {Uint32Array|null} welded triangle indices (3 per face) */
    this.triIndices = null;
    /** @type {Float32Array|null} face normals (3 per face) */
    this.faceNormalCoords = null;
    /** @type {Float32Array|null} sharp edge endpoints [v1x,v1y,v1z,v2x,v2y,v2z,...] */
    this.edgeEndpointCoords = null;
    /** @type {Float32Array|null} reusable LineSegmentsGeometry color buffer */
    this._colorBuffer = null;
    /** @type {number[][]} array of edge index chains/loops */
    this.chains = [];
    /** @type {Array<{ id: number, faceIndices: number[] | Int32Array, edgeIndices: number[], normal: THREE.Vector3 }>} */
    this.surfaces = [];
    /** @type {Int32Array} maps triangle index to surface id */
    this.faceToSurface = new Int32Array(0);
    /** @type {number} currently hovered edge index */
    this.hoveredEdgeIdx = -1;
    /** @type {number} currently hovered chain index */
    this.hoveredChainIdx = -1;
    /** @type {number} currently hovered surface index */
    this.hoveredSurfaceIdx = -1;
    /** @type {Set<number>} sharp edge indices highlighted by hovered surface */
    this.hoveredSurfaceEdgeSet = new Set();
  }

  getVertex(vi, out = new THREE.Vector3()) {
    if (this.vertCoords && vi * 3 + 2 < this.vertCoords.length) {
      const o = vi * 3;
      return out.set(this.vertCoords[o], this.vertCoords[o + 1], this.vertCoords[o + 2]);
    }
    const v = this.vertices[vi];
    return v ? out.copy(v) : out.set(0, 0, 0);
  }

  getFaceNormal(f, out = new THREE.Vector3()) {
    if (this.faceNormalCoords && f * 3 + 2 < this.faceNormalCoords.length) {
      const o = f * 3;
      return out.set(
        this.faceNormalCoords[o],
        this.faceNormalCoords[o + 1],
        this.faceNormalCoords[o + 2]
      );
    }
    const n = this.faceNormals[f];
    return n ? out.copy(n) : out.set(0, 0, 0);
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

  selectHorizontal() {
    for (const e of this.sharpEdges) {
      const dy = Math.abs(e.v2.y - e.v1.y);
      const len = e.v1.distanceTo(e.v2) || 1e-6;
      e.selected = (dy / len) <= 0.30;
    }
    this.updateColors();
  }

  selectVertical() {
    for (const e of this.sharpEdges) {
      const dy = Math.abs(e.v2.y - e.v1.y);
      const len = e.v1.distanceTo(e.v2) || 1e-6;
      e.selected = (dy / len) >= 0.93;
    }
    this.updateColors();
  }

  selectTopBottom() {
    if (this.sharpEdges.length === 0) return;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const e of this.sharpEdges) {
      minY = Math.min(minY, e.v1.y, e.v2.y);
      maxY = Math.max(maxY, e.v1.y, e.v2.y);
    }
    const height = maxY - minY;
    const band = Math.max(0.05, height * 0.06);
    for (const e of this.sharpEdges) {
      const midY = (e.v1.y + e.v2.y) * 0.5;
      const isTop = midY >= maxY - band;
      const isBottom = midY <= minY + band;
      e.selected = isTop || isBottom;
    }
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
    const nextChainIdx =
      edgeIdx >= 0 && loopMode && this.sharpEdges[edgeIdx]
        ? this.sharpEdges[edgeIdx].chainId
        : -1;
    if (
      this.hoveredEdgeIdx === edgeIdx &&
      this.hoveredChainIdx === nextChainIdx &&
      this.hoveredSurfaceIdx === -1
    ) {
      return;
    }
    this.hoveredSurfaceIdx = -1;
    this.hoveredSurfaceEdgeSet.clear();
    this.hoveredEdgeIdx = edgeIdx;
    this.hoveredChainIdx = nextChainIdx;
    this.updateColors();
  }

  /**
   * Set currently hovered logical surface and highlight all its adjacent sharp edges.
   */
  setHoveredSurface(surfaceId) {
    const validId =
      surfaceId >= 0 &&
      surfaceId < this.surfaces.length &&
      this.surfaces[surfaceId].edgeIndices.length > 0
        ? surfaceId
        : -1;
    if (
      this.hoveredSurfaceIdx === validId &&
      this.hoveredEdgeIdx === -1 &&
      this.hoveredChainIdx === -1
    ) {
      return;
    }
    this.hoveredEdgeIdx = -1;
    this.hoveredChainIdx = -1;
    this.hoveredSurfaceIdx = validId;
    this.hoveredSurfaceEdgeSet.clear();
    if (validId >= 0) {
      for (const idx of this.surfaces[validId].edgeIndices) {
        this.hoveredSurfaceEdgeSet.add(idx);
      }
    }
    this.updateColors();
  }

  /**
   * Compute selection summary for all sharp edges adjacent to `surfaceId`.
   */
  getSurfaceSelectionState(surfaceId) {
    if (surfaceId < 0 || surfaceId >= this.surfaces.length) {
      return { total: 0, selectedCount: 0, allSelected: false, noneSelected: true };
    }
    const edgeIndices = this.surfaces[surfaceId].edgeIndices;
    const total = edgeIndices.length;
    let selectedCount = 0;
    for (const idx of edgeIndices) {
      if (this.sharpEdges[idx]?.selected) selectedCount++;
    }
    return {
      total,
      selectedCount,
      allSelected: total > 0 && selectedCount === total,
      noneSelected: selectedCount === 0,
    };
  }

  /**
   * Select or deselect all sharp edges adjacent to `surfaceId`.
   * If all adjacent edges are already selected, deselects all; otherwise selects all.
   */
  toggleSurface(surfaceId) {
    if (surfaceId < 0 || surfaceId >= this.surfaces.length) return null;
    const edgeIndices = this.surfaces[surfaceId].edgeIndices;
    if (!edgeIndices || edgeIndices.length === 0) return null;

    const { allSelected } = this.getSurfaceSelectionState(surfaceId);
    const newSelected = !allSelected;
    for (const idx of edgeIndices) {
      if (this.sharpEdges[idx]) {
        this.sharpEdges[idx].selected = newSelected;
      }
    }
    this.updateColors();
    return { newSelected, count: edgeIndices.length };
  }

  /**
   * Update line colors based on selected/hovered state.
   */
  updateColors() {
    if (!this.lineGeo || this.sharpEdges.length === 0) return;
    const needed = this.sharpEdges.length * 6;
    if (!this._colorBuffer || this._colorBuffer.length !== needed) {
      this._colorBuffer = new Float32Array(needed);
    }
    const colors = this._colorBuffer;

    for (let i = 0; i < this.sharpEdges.length; i++) {
      const e = this.sharpEdges[i];
      const isHovered =
        this.hoveredEdgeIdx === i ||
        (this.hoveredChainIdx >= 0 && e.chainId === this.hoveredChainIdx) ||
        this.hoveredSurfaceEdgeSet.has(i);
      const isSel = e.selected;

      let r, g, b;
      if (isSel && isHovered) {
        // Hovering over a selected edge: Warm Coral-Orange (click will deselect)
        r = 1.0;
        g = 0.42;
        b = 0.22;
      } else if (isSel) {
        // Vibrant Electric Cyan for selected edges (active for chamfer)
        r = 0.0;
        g = 0.83;
        b = 1.0;
      } else if (isHovered) {
        // Hovering over an unselected edge: Bright Emerald-Mint Green (click will select)
        r = 0.12;
        g = 0.94;
        b = 0.56;
      } else {
        // Dark Muted Graphite for unselected edges (inactive / off)
        r = 0.20;
        g = 0.23;
        b = 0.30;
      }

      const off = i * 6;
      colors[off] = r;
      colors[off + 1] = g;
      colors[off + 2] = b;
      colors[off + 3] = r;
      colors[off + 4] = g;
      colors[off + 5] = b;
    }

    const colorAttr = this.lineGeo.getAttribute('instanceColorStart');
    if (colorAttr && colorAttr.data?.array === colors) {
      colorAttr.data.needsUpdate = true;
    } else {
      this.lineGeo.setColors(colors);
    }
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
    this.topology = null;
    this.vertCoords = null;
    this.triIndices = null;
    this.faceNormalCoords = null;
    this.edgeEndpointCoords = null;
    this._colorBuffer = null;
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

function dotNormal(faceNormalsOrCoords, f1, f2) {
  if (faceNormalsOrCoords instanceof Float32Array) {
    const o1 = f1 * 3;
    const o2 = f2 * 3;
    if (o1 + 2 >= faceNormalsOrCoords.length || o2 + 2 >= faceNormalsOrCoords.length) return null;
    return (
      faceNormalsOrCoords[o1] * faceNormalsOrCoords[o2] +
      faceNormalsOrCoords[o1 + 1] * faceNormalsOrCoords[o2 + 1] +
      faceNormalsOrCoords[o1 + 2] * faceNormalsOrCoords[o2 + 2]
    );
  }
  const n1 = faceNormalsOrCoords[f1];
  const n2 = faceNormalsOrCoords[f2];
  if (!n1 || !n2) return null;
  return n1.dot(n2);
}

function faceNormalContinuity(eA, eB, faceNormalsOrCoords) {
  if (!faceNormalsOrCoords) return 2;
  const d11 = dotNormal(faceNormalsOrCoords, eA.faceIdx1, eB.faceIdx1);
  const d22 = dotNormal(faceNormalsOrCoords, eA.faceIdx2, eB.faceIdx2);
  const d12 = dotNormal(faceNormalsOrCoords, eA.faceIdx1, eB.faceIdx2);
  const d21 = dotNormal(faceNormalsOrCoords, eA.faceIdx2, eB.faceIdx1);
  if (d11 === null || d22 === null || d12 === null || d21 === null) return 2;
  return Math.max(d11 + d22, d12 + d21);
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
function areFacesCoplanar(eA, eB, faceNormalsOrCoords) {
  if (!faceNormalsOrCoords) return true;
  const d11 = dotNormal(faceNormalsOrCoords, eA.faceIdx1, eB.faceIdx1);
  const d22 = dotNormal(faceNormalsOrCoords, eA.faceIdx2, eB.faceIdx2);
  const d12 = dotNormal(faceNormalsOrCoords, eA.faceIdx1, eB.faceIdx2);
  const d21 = dotNormal(faceNormalsOrCoords, eA.faceIdx2, eB.faceIdx1);
  if (d11 === null || d22 === null || d12 === null || d21 === null) return true;
  return (d11 >= 0.999 && d22 >= 0.999) || (d12 >= 0.999 && d21 >= 0.999);
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
          const cloned = {
            ...e,
            v1: e.v1.clone(),
            v2: e.v2.clone(),
            faceIndices: e.faceIndices ? [...e.faceIndices] : [e.faceIdx1, e.faceIdx2],
            chainId: newChains.length,
          };
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
      faceIndices: e0.faceIndices ? [...e0.faceIndices] : [e0.faceIdx1, e0.faceIdx2],
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
        if (next.faceIndices) {
          cur.faceIndices.push(...next.faceIndices);
        } else {
          cur.faceIndices.push(next.faceIdx1, next.faceIdx2);
        }
      } else {
        working.push(cur);
        cur = {
          v1: nextV1.clone(),
          v2: nextV2.clone(),
          vi1: nextVi1,
          vi2: nextVi2,
          faceIdx1: next.faceIdx1,
          faceIdx2: next.faceIdx2,
          faceIndices: next.faceIndices ? [...next.faceIndices] : [next.faceIdx1, next.faceIdx2],
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
 * Cluster mesh triangles into logical smooth/planar surfaces separated by sharp dihedral creases,
 * and map each surface to the sharp edges bordering it.
 */
function buildSurfaces(topo, sharpEdges, thresholdRad) {
  const nFaces = topo.triCount;
  const faceToSurface = new Int32Array(nFaces).fill(-1);
  if (nFaces === 0) return { surfaces: [], faceToSurface };

  const { eF1, eF2, eCount, edgeSlots, validFace, faceNormalCoords: fn } = topo;

  // Flat CSR face-neighbor graph (zero per-face array allocations)
  const deg = new Int32Array(nFaces);
  for (let i = 0; i < edgeSlots.length; i++) {
    const slot = edgeSlots[i];
    if (eCount[slot] !== 2) continue;
    const f1 = eF1[slot];
    const f2 = eF2[slot];
    if (!validFace[f1] || !validFace[f2]) continue;
    deg[f1]++;
    deg[f2]++;
  }

  const faceOffsets = new Int32Array(nFaces + 1);
  for (let f = 0; f < nFaces; f++) {
    faceOffsets[f + 1] = faceOffsets[f] + deg[f];
  }
  const faceNeighbors = new Int32Array(faceOffsets[nFaces]);
  const writeCursor = faceOffsets.slice(0, nFaces);

  for (let i = 0; i < edgeSlots.length; i++) {
    const slot = edgeSlots[i];
    if (eCount[slot] !== 2) continue;
    const f1 = eF1[slot];
    const f2 = eF2[slot];
    if (!validFace[f1] || !validFace[f2]) continue;
    faceNeighbors[writeCursor[f1]++] = f2;
    faceNeighbors[writeCursor[f2]++] = f1;
  }

  const smoothCos = Math.cos(Math.max(thresholdRad, 1e-4));
  const surfaces = [];
  const queue = new Int32Array(nFaces);

  for (let f = 0; f < nFaces; f++) {
    if (faceToSurface[f] >= 0 || !validFace[f]) continue;
    const sId = surfaces.length;
    faceToSurface[f] = sId;
    let qHead = 0;
    let qTail = 0;
    queue[qTail++] = f;
    const faceIndices = [f];

    let avgX = fn[f * 3];
    let avgY = fn[f * 3 + 1];
    let avgZ = fn[f * 3 + 2];

    while (qHead < qTail) {
      const cur = queue[qHead++];
      const curOff = cur * 3;
      const cnx = fn[curOff];
      const cny = fn[curOff + 1];
      const cnz = fn[curOff + 2];

      const start = faceOffsets[cur];
      const end = faceOffsets[cur + 1];
      for (let k = start; k < end; k++) {
        const nb = faceNeighbors[k];
        if (faceToSurface[nb] >= 0) continue;
        const nbOff = nb * 3;
        const nnx = fn[nbOff];
        const nny = fn[nbOff + 1];
        const nnz = fn[nbOff + 2];
        if (cnx * nnx + cny * nny + cnz * nnz >= smoothCos) {
          faceToSurface[nb] = sId;
          faceIndices.push(nb);
          avgX += nnx;
          avgY += nny;
          avgZ += nnz;
          queue[qTail++] = nb;
        }
      }
    }

    const avgNormal = new THREE.Vector3(avgX, avgY, avgZ);
    if (avgNormal.lengthSq() > 1e-12) {
      avgNormal.normalize();
    } else {
      avgNormal.set(0, 1, 0);
    }

    surfaces.push({
      id: sId,
      faceIndices,
      edgeIndices: [],
      normal: avgNormal,
    });
  }

  const surfaceEdgeSets = new Array(surfaces.length);
  for (let eIdx = 0; eIdx < sharpEdges.length; eIdx++) {
    const e = sharpEdges[eIdx];
    const adjFaces = e.faceIndices || [e.faceIdx1, e.faceIdx2];
    for (const fIdx of adjFaces) {
      if (fIdx === undefined || fIdx < 0 || fIdx >= nFaces) continue;
      const sId = faceToSurface[fIdx];
      if (sId >= 0) {
        let s = surfaceEdgeSets[sId];
        if (!s) {
          s = new Set();
          surfaceEdgeSets[sId] = s;
        }
        s.add(eIdx);
      }
    }
  }

  for (let sId = 0; sId < surfaces.length; sId++) {
    if (surfaceEdgeSets[sId]) {
      surfaces[sId].edgeIndices = Array.from(surfaceEdgeSets[sId]);
    }
  }

  return { surfaces, faceToSurface };
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

  const topo = getFastMeshTopology(geometry);
  if (!topo || topo.triCount === 0) return edgeData;

  const {
    vertCount,
    triCount,
    vertCoords,
    triIndices,
    faceNormalCoords,
    validFace,
    eV1,
    eV2,
    eF1,
    eF2,
    eCount,
    edgeSlots,
  } = topo;

  edgeData.topology = topo;
  edgeData.vertCoords = vertCoords;
  edgeData.triIndices = triIndices;
  edgeData.faceNormalCoords = faceNormalCoords;

  // Populate legacy object arrays on small meshes; large meshes read TypedArrays directly
  if (triCount <= 25000) {
    const vertsArr = new Array(vertCount);
    for (let i = 0; i < vertCount; i++) {
      const o = i * 3;
      vertsArr[i] = new THREE.Vector3(vertCoords[o], vertCoords[o + 1], vertCoords[o + 2]);
    }
    const facesArr = new Array(triCount);
    const fnArr = new Array(triCount);
    for (let f = 0; f < triCount; f++) {
      const o = f * 3;
      facesArr[f] = [triIndices[o], triIndices[o + 1], triIndices[o + 2]];
      fnArr[f] = new THREE.Vector3(
        faceNormalCoords[o],
        faceNormalCoords[o + 1],
        faceNormalCoords[o + 2]
      );
    }
    edgeData.vertices = vertsArr;
    edgeData.faces = facesArr;
    edgeData.faceNormals = fnArr;
  }

  // ---- Find sharp edges by dihedral angle directly over TypedArray edge slots ----
  const thresholdRad = Math.max(1e-4, (angleThresholdDeg * Math.PI) / 180 - 1e-5);
  const sharpEdges = [];

  for (let sIdx = 0; sIdx < edgeSlots.length; sIdx++) {
    const slot = edgeSlots[sIdx];
    if (eCount[slot] !== 2) continue;
    const f1 = eF1[slot];
    const f2 = eF2[slot];
    if (!validFace[f1] || !validFace[f2]) continue;
    const f1o = f1 * 3;
    const f2o = f2 * 3;

    let dot =
      faceNormalCoords[f1o] * faceNormalCoords[f2o] +
      faceNormalCoords[f1o + 1] * faceNormalCoords[f2o + 1] +
      faceNormalCoords[f1o + 2] * faceNormalCoords[f2o + 2];
    if (dot > 1) dot = 1;
    else if (dot < -1) dot = -1;

    const dihedralAngle = Math.acos(dot);
    if (dihedralAngle <= thresholdRad) continue;

    const vi1 = eV1[slot];
    const vi2 = eV2[slot];

    const t1a = triIndices[f1o];
    const t1b = triIndices[f1o + 1];
    const t1c = triIndices[f1o + 2];
    const opp1Idx = t1a !== vi1 && t1a !== vi2 ? t1a : t1b !== vi1 && t1b !== vi2 ? t1b : t1c !== vi1 && t1c !== vi2 ? t1c : undefined;

    const t2a = triIndices[f2o];
    const t2b = triIndices[f2o + 1];
    const t2c = triIndices[f2o + 2];
    const opp2Idx = t2a !== vi1 && t2a !== vi2 ? t2a : t2b !== vi1 && t2b !== vi2 ? t2b : t2c !== vi1 && t2c !== vi2 ? t2c : undefined;

    const v1o = vi1 * 3;
    const v2o = vi2 * 3;
    let isConvex = true;
    if (opp1Idx !== undefined) {
      const oo = opp1Idx * 3;
      const dx = vertCoords[oo] - vertCoords[v1o];
      const dy = vertCoords[oo + 1] - vertCoords[v1o + 1];
      const dz = vertCoords[oo + 2] - vertCoords[v1o + 2];
      isConvex =
        faceNormalCoords[f2o] * dx +
          faceNormalCoords[f2o + 1] * dy +
          faceNormalCoords[f2o + 2] * dz <=
        0;
    }

    if (convexOnly && !isConvex) continue;

    sharpEdges.push({
      v1: new THREE.Vector3(vertCoords[v1o], vertCoords[v1o + 1], vertCoords[v1o + 2]),
      v2: new THREE.Vector3(vertCoords[v2o], vertCoords[v2o + 1], vertCoords[v2o + 2]),
      vi1,
      vi2,
      opp1Idx,
      opp2Idx,
      isConvex,
      dihedralAngle,
      faceIdx1: f1,
      faceIdx2: f2,
      faceIndices: [f1, f2],
      selected: true, // Selected by default
    });
  }

  const rawChains = buildEdgeChains(sharpEdges, faceNormalCoords);
  const rawCount = sharpEdges.length;

  // ---- Filter & combine tiny/collinear edges ----
  const { edges: filteredEdges, chains: filteredChains } = filterAndProcessChains(
    rawChains,
    sharpEdges,
    faceNormalCoords,
    { filterTiny, minEdgeLength, filterMode, collinearAngleDeg }
  );

  edgeData.rawDetectedCount = rawCount;
  edgeData.filteredCount = Math.max(0, rawCount - filteredEdges.length);
  edgeData.sharpEdges = filteredEdges;
  edgeData.chains = filteredChains;

  const { surfaces, faceToSurface } = buildSurfaces(topo, filteredEdges, thresholdRad);
  edgeData.surfaces = surfaces;
  edgeData.faceToSurface = faceToSurface;

  // ---- Build Float32Array endpoint buffer & High-Visibility LineSegments2 ----
  if (filteredEdges.length > 0) {
    const endpointCoords = new Float32Array(filteredEdges.length * 6);
    for (let i = 0; i < filteredEdges.length; i++) {
      const e = filteredEdges[i];
      const off = i * 6;
      endpointCoords[off] = e.v1.x;
      endpointCoords[off + 1] = e.v1.y;
      endpointCoords[off + 2] = e.v1.z;
      endpointCoords[off + 3] = e.v2.x;
      endpointCoords[off + 4] = e.v2.y;
      endpointCoords[off + 5] = e.v2.z;
    }
    edgeData.edgeEndpointCoords = endpointCoords;

    const lineGeo = new LineSegmentsGeometry();
    lineGeo.setPositions(endpointCoords);

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
      transparent: true,
      opacity: 1.0,
    });

    const lines = new LineSegments2(lineGeo, lineMat);
    lines.name = 'sharpEdges';
    lines.renderOrder = 10;

    edgeData.lineGeo = lineGeo;
    edgeData.lineMat = lineMat;
    edgeData.lineSegments = lines;

    // Apply initial colors (all selected = electric cyan)
    edgeData.updateColors();
  }

  return edgeData;
}

/**
 * Automatically determine the optimal sharp-edge angle threshold in degrees for a geometry or EdgeData.
 * Analyzes the distribution of dihedral angles between adjacent faces, identifying
 * the natural separation gap between low-angle surface tessellation facets and
 * intentional sharp mechanical feature edges.
 *
 * @param {THREE.BufferGeometry|EdgeData} geometryOrEdgeData
 * @param {object} [options]
 * @returns {number} optimal angle threshold in degrees (e.g. 15..60)
 */
export function autoDetectAngleThreshold(geometryOrEdgeData, options = {}) {
  if (!geometryOrEdgeData) return 30;

  const convexOnly = !!options.convexOnly;
  const angles = [];
  const radToDeg = 180 / Math.PI;

  const topo = geometryOrEdgeData.topology
    ? geometryOrEdgeData.topology
    : geometryOrEdgeData.getAttribute
      ? getFastMeshTopology(geometryOrEdgeData)
      : null;

  if (topo) {
    const { vertCoords, triIndices, faceNormalCoords, validFace, eV1, eV2, eF1, eF2, eCount, edgeSlots } = topo;
    const minCos = Math.cos(Math.PI / 180); // ignore < 1 deg flat facets

    for (let i = 0; i < edgeSlots.length; i++) {
      const slot = edgeSlots[i];
      if (eCount[slot] !== 2) continue;
      const f1 = eF1[slot];
      const f2 = eF2[slot];
      if (!validFace[f1] || !validFace[f2]) continue;
      const f1o = f1 * 3;
      const f2o = f2 * 3;

      let dot =
        faceNormalCoords[f1o] * faceNormalCoords[f2o] +
        faceNormalCoords[f1o + 1] * faceNormalCoords[f2o + 1] +
        faceNormalCoords[f1o + 2] * faceNormalCoords[f2o + 2];
      if (dot > minCos) continue;
      if (dot < -1) dot = -1;

      const deg = Math.acos(dot) * radToDeg;

      if (convexOnly) {
        const vi1 = eV1[slot];
        const vi2 = eV2[slot];
        const a = triIndices[f1o];
        const b = triIndices[f1o + 1];
        const c = triIndices[f1o + 2];
        const opp1 = a !== vi1 && a !== vi2 ? a : b !== vi1 && b !== vi2 ? b : c !== vi1 && c !== vi2 ? c : -1;
        if (opp1 >= 0) {
          const oo = opp1 * 3;
          const v1o = vi1 * 3;
          const d =
            faceNormalCoords[f2o] * (vertCoords[oo] - vertCoords[v1o]) +
            faceNormalCoords[f2o + 1] * (vertCoords[oo + 1] - vertCoords[v1o + 1]) +
            faceNormalCoords[f2o + 2] * (vertCoords[oo + 2] - vertCoords[v1o + 2]);
          if (d > 0) continue;
        }
      }

      angles.push(deg);
    }
  } else if (geometryOrEdgeData.adjacency instanceof Map && Array.isArray(geometryOrEdgeData.faceNormals)) {
    const { adjacency, faceNormals, faces, vertices } = geometryOrEdgeData;
    for (const [key, faceList] of adjacency) {
      if (faceList.length !== 2) continue;
      const [f1, f2] = faceList;
      const n1 = faceNormals[f1];
      const n2 = faceNormals[f2];
      if (!n1 || !n2) continue;

      const dot = THREE.MathUtils.clamp(n1.dot(n2), -1, 1);
      const deg = Math.acos(dot) * radToDeg;
      if (deg < 1.0) continue;

      if (convexOnly && faces && vertices) {
        const parts = key.split('_');
        const vi1 = parseInt(parts[0], 10);
        const vi2 = parseInt(parts[1], 10);
        const opp1Idx = faces[f1].find((idx) => idx !== vi1 && idx !== vi2);
        if (opp1Idx !== undefined) {
          const vDiff = new THREE.Vector3().subVectors(vertices[opp1Idx], vertices[vi1]);
          if (n2.dot(vDiff) > 0) continue;
        }
      }

      angles.push(deg);
    }
  }

  if (angles.length === 0) return 30;

  let minA = Infinity;
  const roundedMask = new Uint8Array(181);
  for (let i = 0; i < angles.length; i++) {
    const a = angles[i];
    if (a < minA) minA = a;
    const r = Math.min(180, Math.max(0, Math.round(a)));
    roundedMask[r] = 1;
  }

  if (minA >= 35) {
    return Math.max(15, Math.min(30, Math.round(minA * 0.6)));
  }

  const uniqueAngles = [];
  for (let deg = 0; deg <= 180; deg++) {
    if (roundedMask[deg]) uniqueAngles.push(deg);
  }

  let bestThreshold = 30;
  let maxGapScore = 0;

  for (let i = 0; i < uniqueAngles.length - 1; i++) {
    const a1 = uniqueAngles[i];
    const a2 = uniqueAngles[i + 1];
    const gap = a2 - a1;
    if (a1 <= 40 && a2 >= 20 && gap >= 4) {
      const score = gap * (1 + 0.05 * Math.min(a1, 30));
      if (score > maxGapScore) {
        maxGapScore = score;
        const target = Math.round(a1 + Math.max(3, gap * 0.4));
        bestThreshold = Math.min(target, a2 - 1);
      }
    }
  }

  return Math.max(10, Math.min(60, bestThreshold));
}
