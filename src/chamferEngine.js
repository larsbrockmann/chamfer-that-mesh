/* ============================================================
   chamferEngine.js — Continuous-chain CSG chamfer / fillet engine
   ============================================================ */
import * as THREE from 'three';
import { Brush, Evaluator, SUBTRACTION, ADDITION } from 'three-bvh-csg';

/**
 * Parameters for the chamfer / fillet / hybrid operation.
 */
export class ChamferParams {
  /**
   * @param {number} width     — chamfer width in model units (default 0.5)
   * @param {number} segments  — segment count
   * @param {string} profile   — 'chamfer' | 'fillet' | 'hybrid' (default 'chamfer')
   */
  constructor(width = 0.5, segments = 1, profile = 'chamfer') {
    this.width = Math.max(0.001, width);
    this.profile = profile; // 'chamfer' | 'fillet' | 'hybrid'
    if (profile === 'chamfer') {
      this.segments = 1;
    } else if (profile === 'hybrid') {
      this.segments = Math.max(3, Math.round(segments || 5));
    } else {
      this.segments = Math.max(1, Math.round(segments));
    }
  }
}

/**
 * Compute the un-normalized profile offset vector at normalized step t (0 to 1)
 * between i1 and i2 according to the chosen profile:
 * - 'chamfer': straight chord preserving miter scale
 * - 'fillet': true tangent circular arc between Face 1 and Face 2
 * - 'hybrid': wide flat center chamfer flanked by tangent circular shoulder arcs
 */
function computeProfileOffset(i1, i2, t, profile, segments) {
  let tau = t;
  if (profile === 'hybrid' && segments >= 3) {
    const shoulderTau = 0.26;
    const leftSteps = Math.max(1, Math.floor((segments - 1) / 2));
    const rightSteps = Math.max(1, segments - 1 - leftSteps);
    const s = Math.round(t * segments);
    if (s <= leftSteps) {
      tau = (s / leftSteps) * shoulderTau;
    } else {
      tau = 1 - shoulderTau + ((s - (leftSteps + 1)) / rightSteps) * shoulderTau;
    }
  }

  const linear = new THREE.Vector3().lerpVectors(i1, i2, tau);
  if (profile === 'chamfer' || segments <= 1) {
    return linear;
  }

  const s1 = i1.length();
  const s2 = i2.length();
  if (s1 < 1e-8 || s2 < 1e-8) return linear;

  const u1 = i1.clone().divideScalar(s1);
  const u2 = i2.clone().divideScalar(s2);
  const dot = Math.max(-0.95, Math.min(0.9999, u1.dot(u2)));
  if (1 - dot < 1e-4) return linear;

  const denom = 1 + dot;
  const center = new THREE.Vector3().addVectors(u1, u2).divideScalar(denom);
  const radius = Math.sqrt(Math.max(0, (1 - dot) / denom));

  const radial1 = new THREE.Vector3().subVectors(u1, center);
  const radial2 = new THREE.Vector3().subVectors(u2, center);
  const r1Len = radial1.length();
  const r2Len = radial2.length();
  if (r1Len < 1e-6 || r2Len < 1e-6) return linear;

  radial1.divideScalar(r1Len);
  radial2.divideScalar(r2Len);

  const omega = Math.acos(Math.max(-1, Math.min(1, radial1.dot(radial2))));
  let radialDir;
  if (omega < 1e-5) {
    radialDir = radial1.clone().lerp(radial2, tau).normalize();
  } else {
    const sinOmega = Math.sin(omega);
    const w1 = Math.sin((1 - tau) * omega) / sinOmega;
    const w2 = Math.sin(tau * omega) / sinOmega;
    radialDir = radial1.clone().multiplyScalar(w1).addScaledVector(radial2, w2);
  }

  const arcUnit = center.addScaledVector(radialDir, radius);
  const scale = s1 * (1 - tau) + s2 * tau;
  return arcUnit.multiplyScalar(scale);
}

const SMOOTH_TURN_COS = -0.7; // Allow miter turns up to 135 degrees across continuous faces

function getOutwardTangent(edge, vi) {
  return (edge.vi1 === vi
    ? new THREE.Vector3().subVectors(edge.v2, edge.v1)
    : new THREE.Vector3().subVectors(edge.v1, edge.v2)
  ).normalize();
}

function alignPartnerInsets(frame, partnerFrame) {
  const sameOrder =
    frame.inset1.dot(partnerFrame.inset1) + frame.inset2.dot(partnerFrame.inset2);
  const swappedOrder =
    frame.inset1.dot(partnerFrame.inset2) + frame.inset2.dot(partnerFrame.inset1);
  if (swappedOrder > sameOrder) {
    return {
      n1: partnerFrame.n2,
      n2: partnerFrame.n1,
      i1: partnerFrame.inset2,
      i2: partnerFrame.inset1,
    };
  }
  return {
    n1: partnerFrame.n1,
    n2: partnerFrame.n2,
    i1: partnerFrame.inset1,
    i2: partnerFrame.inset2,
  };
}

/**
 * Collect distinct mesh face normals at every vertex referenced by `edges`,
 * so non-smooth endpoints can detect whether extension runs into an opposing wall.
 */
function buildVertexWallNormals(edges, edgeData) {
  const neededVerts = new Set();
  for (const e of edges) {
    neededVerts.add(e.vi1);
    neededVerts.add(e.vi2);
  }

  const vertWallNormals = new Map();
  if (!edgeData?.faces || !edgeData?.faceNormals) return vertWallNormals;

  for (let f = 0; f < edgeData.faces.length; f++) {
    const face = edgeData.faces[f];
    const fn = edgeData.faceNormals[f];
    if (!fn) continue;
    for (const vi of face) {
      if (!neededVerts.has(vi)) continue;
      let list = vertWallNormals.get(vi);
      if (!list) {
        list = [];
        vertWallNormals.set(vi, list);
      }
      let duplicate = false;
      for (const existing of list) {
        if (existing.dot(fn) > 0.9999) {
          duplicate = true;
          break;
        }
      }
      if (!duplicate) list.push(fn);
    }
  }

  return vertWallNormals;
}

/**
 * Compute per-edge insets and pairwise-matched smooth/mitered endpoint frames
 * without cross-contaminating 3-way junctions or sharp reflex corners.
 *
 * @param {Array<object>} edges
 * @param {import('./edgeDetector.js').EdgeData} edgeData
 * @returns {{ baseFrames: Array<object|null>, endpointFrames: Map<string, object>, smoothPartners: Map<string, number> }}
 */
function buildVertexChamferFrames(edges, edgeData) {
  const baseFrames = new Array(edges.length).fill(null);
  const incidentByVert = new Map();

  for (let idx = 0; idx < edges.length; idx++) {
    const edge = edges[idx];
    const { v1, v2, faceIdx1, faceIdx2, vi1, vi2 } = edge;
    const n1 = edgeData.faceNormals[faceIdx1];
    const n2 = edgeData.faceNormals[faceIdx2];
    if (!n1 || !n2) continue;

    const edgeVec = new THREE.Vector3().subVectors(v2, v1);
    const edgeLen = edgeVec.length();
    if (edgeLen < 1e-8) continue;
    const edgeDir = edgeVec.divideScalar(edgeLen);
    const mid = new THREE.Vector3().addVectors(v1, v2).multiplyScalar(0.5);

    const inset1 = new THREE.Vector3().crossVectors(n1, edgeDir).normalize();
    const inset2 = new THREE.Vector3().crossVectors(edgeDir, n2).normalize();

    // Verify inset directions point inward into each respective face
    const [a, b, c] = edgeData.faces[faceIdx1];
    const opp1Idx = edge.opp1Idx !== undefined
      ? edge.opp1Idx
      : [a, b, c].find((i) => i !== vi1 && i !== vi2);
    if (opp1Idx !== undefined && edgeData.vertices[opp1Idx]) {
      const toOpp1 = new THREE.Vector3().subVectors(edgeData.vertices[opp1Idx], mid);
      if (toOpp1.dot(inset1) < 0) inset1.negate();
    }

    const [d, e, f] = edgeData.faces[faceIdx2];
    const opp2Idx = edge.opp2Idx !== undefined
      ? edge.opp2Idx
      : [d, e, f].find((i) => i !== vi1 && i !== vi2);
    if (opp2Idx !== undefined && edgeData.vertices[opp2Idx]) {
      const toOpp2 = new THREE.Vector3().subVectors(edgeData.vertices[opp2Idx], mid);
      if (toOpp2.dot(inset2) < 0) inset2.negate();
    }

    const cornerNorm = new THREE.Vector3().addVectors(n1, n2);
    if (cornerNorm.lengthSq() > 1e-10) {
      cornerNorm.normalize();
    } else {
      cornerNorm.copy(n1);
    }

    baseFrames[idx] = { inset1, inset2, cornerNorm, n1, n2, edgeDir, edgeLen };

    for (const vi of [vi1, vi2]) {
      if (!incidentByVert.has(vi)) incidentByVert.set(vi, []);
      incidentByVert.get(vi).push(idx);
    }
  }

  const vertWallNormals = buildVertexWallNormals(edges, edgeData);
  const smoothPartners = new Map();

  function findBestPartnerAtVertex(edgeIdx, vi) {
    const f1 = baseFrames[edgeIdx];
    const edge = edges[edgeIdx];
    const incident = incidentByVert.get(vi) || [];
    const dIn = getOutwardTangent(edge, vi).negate();

    const compatible = [];
    for (const candIdx of incident) {
      if (candIdx === edgeIdx) continue;
      const cand = edges[candIdx];
      const f2 = baseFrames[candIdx];
      if (!f2) continue;
      if ((cand.isConvex !== false) !== (edge.isConvex !== false)) continue;

      const dOut = getOutwardTangent(cand, vi);
      const turnDot = dIn.dot(dOut);
      if (turnDot < SMOOTH_TURN_COS) continue;

      const aligned = alignPartnerInsets(f1, f2);
      const n1Dot = f1.n1.dot(aligned.n1);
      const n2Dot = f1.n2.dot(aligned.n2);
      const maxNormDot = Math.max(n1Dot, n2Dot);
      const minNormDot = Math.min(n1Dot, n2Dot);
      // Require at least one face to align continuously along the joint
      if (maxNormDot < 0.65) continue;

      // Higher score for straighter paths and aligned normals
      const score = turnDot * 2.0 + maxNormDot * 2.0 + Math.max(-0.2, minNormDot);
      compatible.push({ candIdx, score, turnDot });
    }

    if (compatible.length === 0) return -1;
    compatible.sort((x, y) => y.score - x.score);
    return compatible[0].candIdx;
  }

  // Pair vertices mutual-best so 3-way junctions pair only the two continuing curve edges
  for (let idx = 0; idx < edges.length; idx++) {
    if (!baseFrames[idx]) continue;
    const edge = edges[idx];
    for (const [endSide, vi] of [[1, edge.vi1], [2, edge.vi2]]) {
      const pIdx = findBestPartnerAtVertex(idx, vi);
      if (pIdx >= 0 && findBestPartnerAtVertex(pIdx, vi) === idx) {
        smoothPartners.set(`${idx}:${endSide}`, pIdx);
      }
    }
  }

  function isEndpointBlocked(edge, frame, vi, extDir) {
    const incident = incidentByVert.get(vi) || [];
    // At intersecting corners / multi-edge junctions, clamp end extension flush to the junction
    if (incident.length >= 2) return true;

    const list = vertWallNormals.get(vi);
    if (!list) return false;
    for (const fn of list) {
      if (fn.dot(frame.n1) > 0.99 || fn.dot(frame.n2) > 0.99) continue;
      if (fn.dot(extDir) < -0.15) return true;
    }
    return false;
  }

  const endpointFrames = new Map();
  for (let idx = 0; idx < edges.length; idx++) {
    const f1 = baseFrames[idx];
    if (!f1) continue;
    const edge = edges[idx];

    for (const [endSide, vi] of [[1, edge.vi1], [2, edge.vi2]]) {
      const key = `${idx}:${endSide}`;
      const pIdx = smoothPartners.get(key);
      if (pIdx !== undefined) {
        const f2 = baseFrames[pIdx];
        const aligned = alignPartnerInsets(f1, f2);
        const sumI1 = new THREE.Vector3().addVectors(f1.inset1, aligned.i1);
        const sumI2 = new THREE.Vector3().addVectors(f1.inset2, aligned.i2);
        const sumCN = new THREE.Vector3().addVectors(f1.cornerNorm, f2.cornerNorm);

        const dirI1 = sumI1.lengthSq() > 1e-10 ? sumI1.normalize() : f1.inset1.clone();
        const dirI2 = sumI2.lengthSq() > 1e-10 ? sumI2.normalize() : f1.inset2.clone();
        const cn = sumCN.lengthSq() > 1e-10 ? sumCN.normalize() : f1.cornerNorm.clone();

        // Symmetrical miter scale preserves perpendicular setback across all turn angles
        const miterDot1 = 0.5 * (f1.inset1.dot(dirI1) + aligned.i1.dot(dirI1));
        const miterDot2 = 0.5 * (f1.inset2.dot(dirI2) + aligned.i2.dot(dirI2));
        const scale1 = 1 / Math.max(0.35, miterDot1);
        const scale2 = 1 / Math.max(0.35, miterDot2);

        endpointFrames.set(key, {
          smooth: true,
          blocked: false,
          i1: dirI1.multiplyScalar(scale1),
          i2: dirI2.multiplyScalar(scale2),
          cn,
        });
      } else {
        const extDir = endSide === 1
          ? f1.edgeDir.clone().negate()
          : f1.edgeDir.clone();
        const blocked = isEndpointBlocked(edge, f1, vi, extDir);
        const wallNormals = (vertWallNormals.get(vi) || []).filter(
          (fn) => fn.dot(f1.n1) <= 0.99 && fn.dot(f1.n2) <= 0.99
        );
        endpointFrames.set(key, {
          smooth: false,
          blocked,
          wallNormals,
          i1: f1.inset1.clone(),
          i2: f1.inset2.clone(),
          cn: f1.cornerNorm.clone(),
        });
      }
    }
  }

  return { baseFrames, endpointFrames, smoothPartners };
}

/**
 * Create a preview overlay of the chamfer/fillet faces along the detected sharp edges.
 * Uses pairwise vertex-aligned frames so preview ribbons on curves connect seamlessly.
 *
 * @param {import('./edgeDetector.js').EdgeData} edgeData
 * @param {ChamferParams} params
 * @returns {THREE.Group}
 */
export function previewChamfer(edgeData, params) {
  const group = new THREE.Group();
  group.name = 'chamferPreview';

  const edges = edgeData?.getSelectedEdges ? edgeData.getSelectedEdges() : edgeData?.sharpEdges;
  if (!edges || edges.length === 0) return group;

  const { width, segments, profile = 'chamfer' } = params;
  const { baseFrames, endpointFrames } = buildVertexChamferFrames(edges, edgeData);
  const positions = [];
  const linePositions = [];
  const surfaceBias = Math.max(0.008, width * 0.008);

  for (let idx = 0; idx < edges.length; idx++) {
    const frame = baseFrames[idx];
    if (!frame) continue;
    const edge = edges[idx];
    const { v1, v2 } = edge;

    const ep1 = endpointFrames.get(`${idx}:1`);
    const ep2 = endpointFrames.get(`${idx}:2`);
    const i1_v1 = ep1 ? ep1.i1 : frame.inset1;
    const i2_v1 = ep1 ? ep1.i2 : frame.inset2;
    const cn_v1 = ep1 ? ep1.cn : frame.cornerNorm;

    const i1_v2 = ep2 ? ep2.i1 : frame.inset1;
    const i2_v2 = ep2 ? ep2.i2 : frame.inset2;
    const cn_v2 = ep2 ? ep2.cn : frame.cornerNorm;

    const stripVerts = [];
    for (let s = 0; s <= segments; s++) {
      const t = s / segments;
      const off1 = computeProfileOffset(i1_v1, i2_v1, t, profile, segments);
      const off2 = computeProfileOffset(i1_v2, i2_v2, t, profile, segments);

      const p1 = v1.clone().addScaledVector(off1, width);
      const p2 = v2.clone().addScaledVector(off2, width);
      stripVerts.push(p1, p2);

      // Record rib lines: outer cut boundaries sit just above respective faces,
      // intermediate fillet/hybrid ribs get a small corner-normal bias
      const b1 = s === 0 ? frame.n1 : (s === segments ? frame.n2 : cn_v1);
      const b2 = s === 0 ? frame.n1 : (s === segments ? frame.n2 : cn_v2);
      const l1 = p1.clone().addScaledVector(b1, surfaceBias * 1.5);
      const l2 = p2.clone().addScaledVector(b2, surfaceBias * 1.5);
      linePositions.push(l1.x, l1.y, l1.z, l2.x, l2.y, l2.z);
    }

    // Build interior bevel strip quads (2 triangles each)
    for (let s = 0; s < segments; s++) {
      const a = stripVerts[s * 2];
      const b = stripVerts[s * 2 + 1];
      const c = stripVerts[(s + 1) * 2];
      const d = stripVerts[(s + 1) * 2 + 1];

      positions.push(
        a.x, a.y, a.z,  b.x, b.y, b.z,  c.x, c.y, c.z,
        b.x, b.y, b.z,  d.x, d.y, d.z,  c.x, c.y, c.z
      );
    }

    // Build visible surface setback overlay quads along Face 1 & Face 2
    const f1v1 = v1.clone().addScaledVector(frame.n1, surfaceBias);
    const f1v2 = v2.clone().addScaledVector(frame.n1, surfaceBias);
    const f1s1 = stripVerts[0].clone().addScaledVector(frame.n1, surfaceBias);
    const f1s2 = stripVerts[1].clone().addScaledVector(frame.n1, surfaceBias);
    positions.push(
      f1v1.x, f1v1.y, f1v1.z,  f1v2.x, f1v2.y, f1v2.z,  f1s1.x, f1s1.y, f1s1.z,
      f1v2.x, f1v2.y, f1v2.z,  f1s2.x, f1s2.y, f1s2.z,  f1s1.x, f1s1.y, f1s1.z
    );

    const last = segments * 2;
    const f2v1 = v1.clone().addScaledVector(frame.n2, surfaceBias);
    const f2v2 = v2.clone().addScaledVector(frame.n2, surfaceBias);
    const f2s1 = stripVerts[last].clone().addScaledVector(frame.n2, surfaceBias);
    const f2s2 = stripVerts[last + 1].clone().addScaledVector(frame.n2, surfaceBias);
    positions.push(
      f2v1.x, f2v1.y, f2v1.z,  f2s1.x, f2s1.y, f2s1.z,  f2v2.x, f2v2.y, f2v2.z,
      f2v2.x, f2v2.y, f2v2.z,  f2s1.x, f2s1.y, f2s1.z,  f2s2.x, f2s2.y, f2s2.z
    );
  }

  if (positions.length > 0) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.computeVertexNormals();

    const mat = new THREE.MeshStandardMaterial({
      color: 0x2ed573,
      emissive: 0x0a3d1e,
      roughness: 0.35,
      metalness: 0.1,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.72,
      polygonOffset: true,
      polygonOffsetFactor: -1.5,
      polygonOffsetUnits: -3.0,
      depthWrite: false,
    });

    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = 2;
    group.add(mesh);
  }

  if (linePositions.length > 0) {
    const lineGeo = new THREE.BufferGeometry();
    lineGeo.setAttribute('position', new THREE.Float32BufferAttribute(linePositions, 3));

    const lineMat = new THREE.LineBasicMaterial({
      color: 0x7bed9f,
      transparent: true,
      opacity: 0.95,
      polygonOffset: true,
      polygonOffsetFactor: -2.0,
      polygonOffsetUnits: -4.0,
    });

    const lines = new THREE.LineSegments(lineGeo, lineMat);
    lines.renderOrder = 3;
    group.add(lines);
  }

  return group;
}

function pushTriOutward(arr, a, b, c, centroid) {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const abz = b.z - a.z;
  const acx = c.x - a.x;
  const acy = c.y - a.y;
  const acz = c.z - a.z;
  const nx = aby * acz - abz * acy;
  const ny = abz * acx - abx * acz;
  const nz = abx * acy - aby * acx;
  const fx = (a.x + b.x + c.x) / 3 - centroid.x;
  const fy = (a.y + b.y + c.y) / 3 - centroid.y;
  const fz = (a.z + b.z + c.z) / 3 - centroid.z;
  if (nx * fx + ny * fy + nz * fz < 0) {
    arr.push(a.x, a.y, a.z, c.x, c.y, c.z, b.x, b.y, b.z);
  } else {
    arr.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
  }
}

/**
 * Group connected edges into smooth chains and record non-smooth endpoint vertices per chain.
 */
function groupSmoothChains(edges, baseFrames, smoothPartners) {
  const edgeToChain = new Map();
  const chains = [];

  for (let idx = 0; idx < edges.length; idx++) {
    if (edgeToChain.has(idx) || !baseFrames[idx]) continue;
    const chain = [idx];
    edgeToChain.set(idx, chains.length);
    const queue = [idx];

    while (queue.length > 0) {
      const curIdx = queue.pop();
      for (const endSide of [1, 2]) {
        const pIdx = smoothPartners.get(`${curIdx}:${endSide}`);
        if (pIdx !== undefined && !edgeToChain.has(pIdx) && baseFrames[pIdx]) {
          edgeToChain.set(pIdx, chains.length);
          chain.push(pIdx);
          queue.push(pIdx);
        }
      }
    }
    chains.push(chain);
  }

  const cornerVertsPerChain = chains.map((chain) => {
    const verts = new Set();
    for (const idx of chain) {
      const e = edges[idx];
      for (const [endSide, vi] of [[1, e.vi1], [2, e.vi2]]) {
        if (!smoothPartners.has(`${idx}:${endSide}`)) {
          verts.add(vi);
        }
      }
    }
    return verts;
  });

  return { chains, cornerVertsPerChain };
}

/**
 * Slide non-smooth concave endpoint cross-section points back flush to adjacent outer wall planes.
 */
function trimSectionToWalls(points, anchorPt, slideDir, wallNormals, maxSlide) {
  if (!wallNormals || wallNormals.length === 0) return;
  for (const fn of wallNormals) {
    const dirDot = -slideDir.dot(fn); // extDir.dot(fn)
    if (dirDot <= 0.15) continue;
    for (const q of points) {
      const excess =
        (q.x - anchorPt.x) * fn.x +
        (q.y - anchorPt.y) * fn.y +
        (q.z - anchorPt.z) * fn.z;
      if (excess > 0) {
        const step = Math.min(maxSlide, excess / dirDot);
        q.addScaledVector(slideDir, step);
      }
    }
  }
}

/**
 * Append a closed, outward-oriented prism for one edge to `cutterPositions`.
 */
function buildEdgeCuttingPrism(edge, frame, ep1, ep2, width, segments, profile, apexSign, cutterPositions) {
  const isConvex = edge.isConvex !== false;

  let ext1 = 0;
  if (!ep1.smooth) {
    if (ep1.blocked) {
      ext1 = Math.min(width * 0.02, frame.edgeLen * 0.05);
    } else if (isConvex) {
      ext1 = Math.min(width * 0.5, frame.edgeLen * 0.45);
    }
  }

  let ext2 = 0;
  if (!ep2.smooth) {
    if (ep2.blocked) {
      ext2 = Math.min(width * 0.02, frame.edgeLen * 0.05);
    } else if (isConvex) {
      ext2 = Math.min(width * 0.5, frame.edgeLen * 0.45);
    }
  }

  const p1 = ext1 > 0 ? edge.v1.clone().addScaledVector(frame.edgeDir, -ext1) : edge.v1;
  const p2 = ext2 > 0 ? edge.v2.clone().addScaledVector(frame.edgeDir, ext2) : edge.v2;

  const arc1 = [];
  for (let s = 0; s <= segments; s++) {
    const t = s / segments;
    const off = computeProfileOffset(ep1.i1, ep1.i2, t, profile, segments);
    arc1.push(p1.clone().addScaledVector(off, width));
  }
  const arc2 = [];
  for (let s = 0; s <= segments; s++) {
    const t = s / segments;
    const off = computeProfileOffset(ep2.i1, ep2.i2, t, profile, segments);
    arc2.push(p2.clone().addScaledVector(off, width));
  }

  // Extend outer arc skirt boundaries to prevent coplanar CSG grazing (clamped at junctions)
  const skirtExt1 = ep1.blocked ? 0 : width * 0.2;
  const skirtExt2 = ep2.blocked ? 0 : width * 0.2;

  const ext0_1 = new THREE.Vector3().subVectors(arc1[0], arc1[1]);
  if (skirtExt1 > 0 && ext0_1.lengthSq() > 1e-12) arc1[0].addScaledVector(ext0_1.normalize(), skirtExt1);
  const extN_1 = new THREE.Vector3().subVectors(arc1[segments], arc1[segments - 1]);
  if (skirtExt1 > 0 && extN_1.lengthSq() > 1e-12) arc1[segments].addScaledVector(extN_1.normalize(), skirtExt1);

  const ext0_2 = new THREE.Vector3().subVectors(arc2[0], arc2[1]);
  if (skirtExt2 > 0 && ext0_2.lengthSq() > 1e-12) arc2[0].addScaledVector(ext0_2.normalize(), skirtExt2);
  const extN_2 = new THREE.Vector3().subVectors(arc2[segments], arc2[segments - 1]);
  if (skirtExt2 > 0 && extN_2.lengthSq() > 1e-12) arc2[segments].addScaledVector(extN_2.normalize(), skirtExt2);

  const apex1 = p1.clone().addScaledVector(ep1.cn, width * apexSign);
  const apex2 = p2.clone().addScaledVector(ep2.cn, width * apexSign);

  // Trim concave non-smooth end-caps flush against adjacent outer walls so additions never poke into air
  if (!isConvex) {
    const maxSlide = frame.edgeLen * 0.45;
    if (!ep1.smooth) {
      trimSectionToWalls([...arc1, apex1], edge.v1, frame.edgeDir, ep1.wallNormals, maxSlide);
    }
    if (!ep2.smooth) {
      trimSectionToWalls(
        [...arc2, apex2],
        edge.v2,
        frame.edgeDir.clone().negate(),
        ep2.wallNormals,
        maxSlide
      );
    }
  }

  // Use wedge spine midpoint between apex and bevel arc midpoint so centroid
  // always stays strictly inside both convex and concave/acute fillet prisms.
  const midIdx = Math.floor(segments / 2);
  const arc1Mid = segments === 1
    ? new THREE.Vector3().addVectors(arc1[0], arc1[1]).multiplyScalar(0.5)
    : arc1[midIdx];
  const arc2Mid = segments === 1
    ? new THREE.Vector3().addVectors(arc2[0], arc2[1]).multiplyScalar(0.5)
    : arc2[midIdx];
  const centroid = new THREE.Vector3()
    .add(apex1)
    .add(apex2)
    .add(arc1Mid)
    .add(arc2Mid)
    .multiplyScalar(0.25);

  if (!ep1.smooth) {
    for (let s = 0; s < segments; s++) {
      pushTriOutward(cutterPositions, apex1, arc1[s], arc1[s + 1], centroid);
    }
  }
  if (!ep2.smooth) {
    for (let s = 0; s < segments; s++) {
      pushTriOutward(cutterPositions, apex2, arc2[s + 1], arc2[s], centroid);
    }
  }

  pushTriOutward(cutterPositions, apex1, apex2, arc2[0], centroid);
  pushTriOutward(cutterPositions, apex1, arc2[0], arc1[0], centroid);

  const last = segments;
  pushTriOutward(cutterPositions, arc1[last], arc2[last], apex2, centroid);
  pushTriOutward(cutterPositions, arc1[last], apex2, apex1, centroid);

  for (let s = 0; s < segments; s++) {
    pushTriOutward(cutterPositions, arc1[s], arc1[s + 1], arc2[s + 1], centroid);
    pushTriOutward(cutterPositions, arc1[s], arc2[s + 1], arc2[s], centroid);
  }
}

const CSG_BATCH_SIZE = 500;
const MAX_CSG_PASSES = 16;

function chainsConflict(cA, cB, chainBoxes, cornerVertsPerChain) {
  if (chainBoxes[cA].intersectsBox(chainBoxes[cB])) return true;
  const vertsA = cornerVertsPerChain[cA];
  const vertsB = cornerVertsPerChain[cB];
  for (const v of vertsA) {
    if (vertsB.has(v)) return true;
  }
  return false;
}

function scheduleNonOverlappingPasses(chains, chainBoxes, cornerVertsPerChain, edgePositions) {
  const order = chains.map((_, cIdx) => cIdx);
  order.sort((a, b) => {
    let lenA = 0;
    for (const idx of chains[a]) lenA += edgePositions[idx].length;
    let lenB = 0;
    for (const idx of chains[b]) lenB += edgePositions[idx].length;
    return lenB - lenA;
  });

  const passes = [];
  for (const cIdx of order) {
    let bestPass = -1;
    let minConflicts = Infinity;

    for (let p = 0; p < passes.length; p++) {
      let conflicts = 0;
      for (const other of passes[p]) {
        if (chainsConflict(cIdx, other, chainBoxes, cornerVertsPerChain)) {
          conflicts++;
          if (conflicts >= minConflicts) break;
        }
      }
      if (conflicts === 0) {
        bestPass = p;
        break;
      }
      if (conflicts < minConflicts) {
        minConflicts = conflicts;
        bestPass = p;
      }
    }

    if (minConflicts > 0 && passes.length < MAX_CSG_PASSES) {
      passes.push([cIdx]);
    } else if (bestPass >= 0) {
      passes[bestPass].push(cIdx);
    } else {
      passes.push([cIdx]);
    }
  }

  return passes.map((chainList) => {
    const edgeIndices = [];
    for (const cIdx of chainList) edgeIndices.push(...chains[cIdx]);
    return edgeIndices;
  });
}

/**
 * Remove degenerate/obtuse-collinear CSG spike triangles and clamp vertices within `boundsBox`.
 *
 * @param {THREE.BufferGeometry} geometry
 * @param {THREE.Box3} boundsBox
 * @returns {THREE.BufferGeometry}
 */
function cleanCsgGeometry(geometry, boundsBox) {
  const geo = geometry.index ? geometry.toNonIndexed() : geometry;
  const posAttr = geo.getAttribute('position');
  if (!posAttr) {
    if (geo !== geometry) geo.dispose();
    return geometry.clone();
  }

  const count = posAttr.count;
  const cleaned = [];
  const minX = boundsBox.min.x, minY = boundsBox.min.y, minZ = boundsBox.min.z;
  const maxX = boundsBox.max.x, maxY = boundsBox.max.y, maxZ = boundsBox.max.z;
  const clamp = (v, min, max) => (v < min ? min : (v > max ? max : v));

  for (let i = 0; i + 2 < count; i += 3) {
    const ax = posAttr.getX(i), ay = posAttr.getY(i), az = posAttr.getZ(i);
    const bx = posAttr.getX(i + 1), by = posAttr.getY(i + 1), bz = posAttr.getZ(i + 1);
    const cx = posAttr.getX(i + 2), cy = posAttr.getY(i + 2), cz = posAttr.getZ(i + 2);

    const abx = bx - ax, aby = by - ay, abz = bz - az;
    const acx = cx - ax, acy = cy - ay, acz = cz - az;
    const bcx = cx - bx, bcy = cy - by, bcz = cz - bz;

    const nx = aby * acz - abz * acy;
    const ny = abz * acx - abx * acz;
    const nz = abx * acy - aby * acx;
    const crossSq = nx * nx + ny * ny + nz * nz;
    if (crossSq < 1e-12) continue;

    let l0 = abx * abx + aby * aby + abz * abz;
    let l1 = acx * acx + acy * acy + acz * acz;
    let l2 = bcx * bcx + bcy * bcy + bcz * bcz;
    if (l0 > l1) { const t = l0; l0 = l1; l1 = t; }
    if (l1 > l2) { const t = l1; l1 = l2; l2 = t; }
    if (l0 > l1) { const t = l0; l0 = l1; l1 = t; }
    if (l0 > 1e-8 && (crossSq <= l0 * l1 * 1e-4 || (l0 < 1e-3 && l2 / l0 > 1600))) continue;

    cleaned.push(
      clamp(ax, minX, maxX), clamp(ay, minY, maxY), clamp(az, minZ, maxZ),
      clamp(bx, minX, maxX), clamp(by, minY, maxY), clamp(bz, minZ, maxZ),
      clamp(cx, minX, maxX), clamp(cy, minY, maxY), clamp(cz, minZ, maxZ)
    );
  }

  if (geo !== geometry) geo.dispose();

  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(cleaned, 3));
  return out;
}

function prepareEdgeGroupBatches(groupEdges, edgeData, params, operation, apexSign) {
  if (groupEdges.length === 0) return [];

  const { width, segments, profile = 'chamfer' } = params;
  const { baseFrames, endpointFrames, smoothPartners } = buildVertexChamferFrames(groupEdges, edgeData);
  const { chains, cornerVertsPerChain } = groupSmoothChains(groupEdges, baseFrames, smoothPartners);
  if (chains.length === 0) return [];

  const edgePositions = new Array(groupEdges.length).fill(null);
  for (let idx = 0; idx < groupEdges.length; idx++) {
    const frame = baseFrames[idx];
    const ep1 = endpointFrames.get(`${idx}:1`);
    const ep2 = endpointFrames.get(`${idx}:2`);
    if (!frame || !ep1 || !ep2) continue;

    const pos = [];
    buildEdgeCuttingPrism(
      groupEdges[idx],
      frame,
      ep1,
      ep2,
      width,
      segments,
      profile,
      apexSign,
      pos
    );
    edgePositions[idx] = pos;
  }

  const chainBoxes = chains.map((chain) => {
    const box = new THREE.Box3();
    for (const idx of chain) {
      const pos = edgePositions[idx];
      if (!pos) continue;
      for (let i = 0; i < pos.length; i += 3) {
        box.expandByPoint(new THREE.Vector3(pos[i], pos[i + 1], pos[i + 2]));
      }
    }
    if (!box.isEmpty()) {
      box.expandByScalar(width * 0.05);
    }
    return box;
  });

  const passes = scheduleNonOverlappingPasses(chains, chainBoxes, cornerVertsPerChain, edgePositions);
  const batches = [];

  for (const passIndices of passes) {
    for (let offset = 0; offset < passIndices.length; offset += CSG_BATCH_SIZE) {
      const batch = passIndices.slice(offset, offset + CSG_BATCH_SIZE);
      const cutterPositions = [];
      for (const idx of batch) {
        const pos = edgePositions[idx];
        if (pos && pos.length > 0) {
          for (let i = 0; i < pos.length; i++) cutterPositions.push(pos[i]);
        }
      }
      if (cutterPositions.length > 0) {
        batches.push({ cutterPositions, edgeCount: batch.length, operation });
      }
    }
  }

  return batches;
}

function evaluateCsgBatch(curBrush, evaluator, batch) {
  const cutterGeo = new THREE.BufferGeometry();
  cutterGeo.setAttribute(
    'position',
    new THREE.Float32BufferAttribute(batch.cutterPositions, 3)
  );
  cutterGeo.computeVertexNormals();

  const cutterBrush = new Brush(cutterGeo);
  cutterBrush.updateMatrixWorld();

  const nextBrush = evaluator.evaluate(curBrush, cutterBrush, batch.operation);
  cutterGeo.dispose();
  curBrush.geometry.dispose();
  nextBrush.updateMatrixWorld();
  return nextBrush;
}

function createAbortError() {
  const err = new Error('Chamfer operation aborted');
  err.name = 'AbortError';
  return err;
}

function buildAllCsgBatches(edges, edgeData, params) {
  const convexEdges = edges.filter((e) => e.isConvex !== false);
  const concaveEdges = edges.filter((e) => e.isConvex === false);
  if (convexEdges.length === 0 && concaveEdges.length === 0) return [];
  return [
    ...prepareEdgeGroupBatches(convexEdges, edgeData, params, SUBTRACTION, 1.2),
    ...prepareEdgeGroupBatches(concaveEdges, edgeData, params, ADDITION, -0.8),
  ];
}

function finalizeCsgResult(curBrush, origBox) {
  const resultGeo = cleanCsgGeometry(curBrush.geometry, origBox);
  curBrush.geometry.dispose();
  resultGeo.computeVertexNormals();
  resultGeo.computeBoundingBox();
  resultGeo.computeBoundingSphere();
  return resultGeo;
}

/**
 * Apply chamfer/fillet to geometry using smooth-chain multi-pass CSG.
 * Convex edges use CSG subtraction; concave edges use CSG addition with inward-buried apex.
 *
 * @param {THREE.BufferGeometry} geometry
 * @param {import('./edgeDetector.js').EdgeData} edgeData
 * @param {ChamferParams} params
 * @returns {THREE.BufferGeometry}
 */
export function applyChamfer(geometry, edgeData, params) {
  const edges = edgeData?.getSelectedEdges ? edgeData.getSelectedEdges() : edgeData?.sharpEdges;
  if (!edges || edges.length === 0) {
    return geometry.clone();
  }

  const batches = buildAllCsgBatches(edges, edgeData, params);
  if (batches.length === 0) {
    return geometry.clone();
  }

  const baseGeo = geometry.index ? geometry.toNonIndexed() : geometry.clone();
  baseGeo.computeVertexNormals();
  baseGeo.computeBoundingBox();
  const origBox = baseGeo.boundingBox.clone();

  let curBrush = new Brush(baseGeo);
  curBrush.updateMatrixWorld();

  const evaluator = new Evaluator();
  evaluator.attributes = ['position', 'normal'];

  try {
    for (const batch of batches) {
      curBrush = evaluateCsgBatch(curBrush, evaluator, batch);
    }
    return finalizeCsgResult(curBrush, origBox);
  } catch (err) {
    console.error('CSG chamfer failed, falling back to original geometry:', err);
    try { curBrush.geometry.dispose(); } catch (_) { /* ignore cleanup error */ }
    return geometry.clone();
  }
}

/**
 * Async multi-pass CSG chamfer/fillet that yields between batches so UI events
 * and an AbortSignal can cancel execution cleanly.
 *
 * @param {THREE.BufferGeometry} geometry
 * @param {import('./edgeDetector.js').EdgeData} edgeData
 * @param {ChamferParams} params
 * @param {{ signal?: AbortSignal, onProgress?: (info: { current: number, total: number, edgeCount: number }) => void }} [options]
 * @returns {Promise<THREE.BufferGeometry>}
 */
export async function applyChamferAsync(geometry, edgeData, params, options = {}) {
  const { signal, onProgress } = options;
  if (signal?.aborted) throw createAbortError();

  const edges = edgeData?.getSelectedEdges ? edgeData.getSelectedEdges() : edgeData?.sharpEdges;
  if (!edges || edges.length === 0) {
    return geometry.clone();
  }

  const batches = buildAllCsgBatches(edges, edgeData, params);
  if (batches.length === 0) {
    return geometry.clone();
  }

  const baseGeo = geometry.index ? geometry.toNonIndexed() : geometry.clone();
  baseGeo.computeVertexNormals();
  baseGeo.computeBoundingBox();
  const origBox = baseGeo.boundingBox.clone();

  let curBrush = new Brush(baseGeo);
  curBrush.updateMatrixWorld();

  const evaluator = new Evaluator();
  evaluator.attributes = ['position', 'normal'];

  try {
    for (let i = 0; i < batches.length; i++) {
      if (signal?.aborted) throw createAbortError();
      const batch = batches[i];
      onProgress?.({ current: i + 1, total: batches.length, edgeCount: batch.edgeCount });
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (signal?.aborted) throw createAbortError();
      curBrush = evaluateCsgBatch(curBrush, evaluator, batch);
    }

    if (signal?.aborted) throw createAbortError();
    return finalizeCsgResult(curBrush, origBox);
  } catch (err) {
    try { curBrush.geometry.dispose(); } catch (_) { /* ignore cleanup error */ }
    if (err?.name === 'AbortError') throw err;
    console.error('CSG chamfer failed, falling back to original geometry:', err);
    return geometry.clone();
  }
}
