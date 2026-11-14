/* ============================================================
   chamferEngine.js — Continuous-chain CSG chamfer / fillet engine
   ============================================================ */
import * as THREE from 'three';
import { Brush, Evaluator, SUBTRACTION } from 'three-bvh-csg';

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
      this.segments = Math.max(3, Math.round(segments || 4));
    } else {
      this.segments = Math.max(1, Math.round(segments));
    }
  }
}

/**
 * Compute the profile direction vector at normalized step t (0 to 1)
 * between inset1 and inset2 according to the chosen profile.
 */
function interpolateProfileDir(i1, i2, t, profile, segments) {
  if (profile === 'chamfer' || segments === 1) {
    return t === 0 ? i1.clone() : (t === 1 ? i2.clone() : new THREE.Vector3().lerpVectors(i1, i2, t).normalize());
  }

  if (profile === 'hybrid') {
    // Chamfer-Fillet Hybrid:
    // Central planar facet flanked by softly radiused transition shoulders
    const flatDir = new THREE.Vector3().lerpVectors(i1, i2, t).normalize();
    const arcDir = new THREE.Vector3().copy(i1).lerp(i2, t).normalize();
    const centerDist = Math.abs(t - 0.5) * 2; // 0 at center, 1 at boundaries
    const shoulderWeight = Math.pow(centerDist, 1.8) * 0.75;
    return new THREE.Vector3().lerpVectors(flatDir, arcDir, shoulderWeight).normalize();
  }

  // Pure Fillet: smooth circular arc
  return new THREE.Vector3().copy(i1).lerp(i2, t).normalize();
}

const SMOOTH_CHAIN_DOT_THRESHOLD = -Math.cos((25 * Math.PI) / 180);

function getOutwardTangent(edge, vi) {
  return (edge.vi1 === vi
    ? new THREE.Vector3().subVectors(edge.v2, edge.v1)
    : new THREE.Vector3().subVectors(edge.v1, edge.v2)
  ).normalize();
}

function isSmoothChainVertex(vd, vi) {
  if (!vd || vd.count !== 2 || !vd.edges || vd.edges.length !== 2) return false;
  const d0 = getOutwardTangent(vd.edges[0], vi);
  const d1 = getOutwardTangent(vd.edges[1], vi);
  return d0.dot(d1) <= SMOOTH_CHAIN_DOT_THRESHOLD;
}

/**
 * Compute edge insets and vertex-averaged frames for continuous, seamless chamfering.
 * Prevents disconnected teeth/fins on rounded corners by matching adjacent cross-sections.
 *
 * @param {Array<object>} edges — array of sharp edges to process
 * @param {import('./edgeDetector.js').EdgeData} edgeData
 * @returns {{ edgeMap: Map<object, object>, vertexMap: Map<number, object> }}
 */
function buildVertexChamferFrames(edges, edgeData) {
  const edgeMap = new Map();
  const vertexMap = new Map();

  for (const edge of edges) {
    const { v1, v2, faceIdx1, faceIdx2, vi1, vi2 } = edge;
    const n1 = edgeData.faceNormals[faceIdx1];
    const n2 = edgeData.faceNormals[faceIdx2];
    if (!n1 || !n2) continue;

    const edgeDir = new THREE.Vector3().subVectors(v2, v1).normalize();
    const mid = new THREE.Vector3().addVectors(v1, v2).multiplyScalar(0.5);

    const inset1 = new THREE.Vector3().crossVectors(n1, edgeDir).normalize();
    const inset2 = new THREE.Vector3().crossVectors(edgeDir, n2).normalize();

    // Verify inset directions point inward into each respective face
    const [a, b, c] = edgeData.faces[faceIdx1];
    const opp1Idx = [a, b, c].find((i) => i !== vi1 && i !== vi2);
    if (opp1Idx !== undefined && edgeData.vertices[opp1Idx]) {
      const toOpp1 = new THREE.Vector3().subVectors(edgeData.vertices[opp1Idx], mid);
      if (toOpp1.dot(inset1) < 0) inset1.negate();
    }

    const [d, e, f] = edgeData.faces[faceIdx2];
    const opp2Idx = [d, e, f].find((i) => i !== vi1 && i !== vi2);
    if (opp2Idx !== undefined && edgeData.vertices[opp2Idx]) {
      const toOpp2 = new THREE.Vector3().subVectors(edgeData.vertices[opp2Idx], mid);
      if (toOpp2.dot(inset2) < 0) inset2.negate();
    }

    const cornerNorm = new THREE.Vector3().addVectors(n1, n2).normalize();

    edgeMap.set(edge, { inset1, inset2, cornerNorm, n1, n2, edgeDir });

    for (const vi of [vi1, vi2]) {
      if (!vertexMap.has(vi)) {
        vertexMap.set(vi, {
          refInset1: inset1.clone(),
          refInset2: inset2.clone(),
          sumInset1: inset1.clone(),
          sumInset2: inset2.clone(),
          sumCornerNorm: cornerNorm.clone(),
          count: 1,
          edges: [edge],
        });
      } else {
        const vd = vertexMap.get(vi);
        const swap =
          inset1.dot(vd.refInset1) + inset2.dot(vd.refInset2) <
          inset1.dot(vd.refInset2) + inset2.dot(vd.refInset1);
        vd.sumInset1.add(swap ? inset2 : inset1);
        vd.sumInset2.add(swap ? inset1 : inset2);
        vd.sumCornerNorm.add(cornerNorm);
        vd.count++;
        vd.edges.push(edge);
      }
    }
  }

  return { edgeMap, vertexMap };
}

/**
 * Create a preview overlay of the chamfer/fillet faces along the detected sharp edges.
 * Uses vertex-aligned frames so preview ribbons on curves connect seamlessly.
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
  const { edgeMap, vertexMap } = buildVertexChamferFrames(edges, edgeData);
  const positions = [];
  const linePositions = [];
  const surfaceBias = Math.max(0.008, width * 0.008);

  for (const edge of edges) {
    const frame = edgeMap.get(edge);
    if (!frame) continue;

    const { vi1, vi2, v1, v2 } = edge;
    const vd1 = vertexMap.get(vi1);
    const vd2 = vertexMap.get(vi2);

    const i1_v1 = vd1 && vd1.count > 1 ? vd1.sumInset1.clone().normalize() : frame.inset1;
    const i2_v1 = vd1 && vd1.count > 1 ? vd1.sumInset2.clone().normalize() : frame.inset2;
    const cn_v1 = vd1 && vd1.count > 1 ? vd1.sumCornerNorm.clone().normalize() : frame.cornerNorm;

    const i1_v2 = vd2 && vd2.count > 1 ? vd2.sumInset1.clone().normalize() : frame.inset1;
    const i2_v2 = vd2 && vd2.count > 1 ? vd2.sumInset2.clone().normalize() : frame.inset2;
    const cn_v2 = vd2 && vd2.count > 1 ? vd2.sumCornerNorm.clone().normalize() : frame.cornerNorm;

    const stripVerts = [];
    for (let s = 0; s <= segments; s++) {
      const t = s / segments;
      const dir1 = interpolateProfileDir(i1_v1, i2_v1, t, profile, segments);
      const dir2 = interpolateProfileDir(i1_v2, i2_v2, t, profile, segments);

      const p1 = v1.clone().addScaledVector(dir1, width);
      const p2 = v2.clone().addScaledVector(dir2, width);
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
    // so convex edges visibly show the bevel width creeping inward across faces.
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
      color: 0xff9f43,
      emissive: 0x441a00,
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
      color: 0xffbe76,
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

function resolveEndpointFrame(frame, vd, isSmooth) {
  if (
    isSmooth &&
    vd.sumInset1.lengthSq() > 1e-10 &&
    vd.sumInset2.lengthSq() > 1e-10
  ) {
    const avg1 = vd.sumInset1.clone().normalize();
    const avg2 = vd.sumInset2.clone().normalize();
    const swap =
      frame.inset1.dot(avg1) + frame.inset2.dot(avg2) <
      frame.inset1.dot(avg2) + frame.inset2.dot(avg1);
    return {
      i1: swap ? avg2 : avg1,
      i2: swap ? avg1 : avg2,
      cn: vd.sumCornerNorm.lengthSq() > 1e-10
        ? vd.sumCornerNorm.clone().normalize()
        : frame.cornerNorm,
    };
  }
  return { i1: frame.inset1, i2: frame.inset2, cn: frame.cornerNorm };
}

function partitionSmoothChains(edges, edgeMap, vertexMap) {
  const edgeToChain = new Map();
  const chains = [];

  for (const edge of edges) {
    if (edgeToChain.has(edge) || !edgeMap.has(edge)) continue;
    const chain = [edge];
    edgeToChain.set(edge, chains.length);
    const queue = [edge];

    while (queue.length > 0) {
      const cur = queue.pop();
      for (const vi of [cur.vi1, cur.vi2]) {
        const vd = vertexMap.get(vi);
        if (!isSmoothChainVertex(vd, vi)) continue;
        for (const nb of vd.edges) {
          if (!edgeToChain.has(nb) && edgeMap.has(nb)) {
            edgeToChain.set(nb, chains.length);
            chain.push(nb);
            queue.push(nb);
          }
        }
      }
    }
    chains.push(chain);
  }

  const cornerVertToChains = new Map();
  chains.forEach((chain, cIdx) => {
    for (const e of chain) {
      for (const vi of [e.vi1, e.vi2]) {
        if (!isSmoothChainVertex(vertexMap.get(vi), vi)) {
          if (!cornerVertToChains.has(vi)) cornerVertToChains.set(vi, new Set());
          cornerVertToChains.get(vi).add(cIdx);
        }
      }
    }
  });

  const maxPasses = edges.length <= 60 ? 4 : 2;
  const chainColor = new Array(chains.length).fill(-1);

  for (let cIdx = 0; cIdx < chains.length; cIdx++) {
    const conflicts = new Int32Array(maxPasses);
    for (const e of chains[cIdx]) {
      for (const vi of [e.vi1, e.vi2]) {
        const sharing = cornerVertToChains.get(vi);
        if (!sharing) continue;
        for (const other of sharing) {
          if (other < cIdx && chainColor[other] >= 0) {
            conflicts[chainColor[other]]++;
          }
        }
      }
    }
    let bestPass = 0;
    for (let p = 1; p < maxPasses; p++) {
      if (conflicts[p] < conflicts[bestPass]) bestPass = p;
    }
    chainColor[cIdx] = bestPass;
  }

  const passes = Array.from({ length: maxPasses }, () => []);
  for (let cIdx = 0; cIdx < chains.length; cIdx++) {
    passes[chainColor[cIdx]].push(...chains[cIdx]);
  }
  return passes.filter((p) => p.length > 0);
}

/**
 * Apply chamfer/fillet to geometry using smooth-chain multi-pass CSG subtraction.
 * Consistent outward prism winding and extended outer skirts prevent grazing CSG holes.
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

  const { width, segments, profile = 'chamfer' } = params;
  const { edgeMap, vertexMap } = buildVertexChamferFrames(edges, edgeData);
  const passes = partitionSmoothChains(edges, edgeMap, vertexMap);
  if (passes.length === 0) {
    return geometry.clone();
  }

  const baseGeo = geometry.index ? geometry.toNonIndexed() : geometry.clone();
  baseGeo.computeVertexNormals();

  let curBrush = new Brush(baseGeo);
  curBrush.updateMatrixWorld();

  const evaluator = new Evaluator();
  evaluator.attributes = ['position', 'normal'];

  try {
    for (let passIdx = 0; passIdx < passes.length; passIdx++) {
      const cutterPositions = [];

      for (const edge of passes[passIdx]) {
        const frame = edgeMap.get(edge);
        if (!frame) continue;

        const { vi1, vi2, v1, v2 } = edge;
        const vd1 = vertexMap.get(vi1);
        const vd2 = vertexMap.get(vi2);
        const isSmooth1 = isSmoothChainVertex(vd1, vi1);
        const isSmooth2 = isSmoothChainVertex(vd2, vi2);

        const { i1: i1_v1, i2: i2_v1, cn: cn_v1 } = resolveEndpointFrame(frame, vd1, isSmooth1);
        const { i1: i1_v2, i2: i2_v2, cn: cn_v2 } = resolveEndpointFrame(frame, vd2, isSmooth2);

        // Extend non-smooth corner endpoints cleanly past adjacent faces
        const p1 = !isSmooth1 ? v1.clone().addScaledVector(frame.edgeDir, -width * 0.5) : v1;
        const p2 = !isSmooth2 ? v2.clone().addScaledVector(frame.edgeDir, width * 0.5) : v2;

        // Profile points along the chamfer arc at v1 and v2
        const arc1 = [];
        for (let s = 0; s <= segments; s++) {
          const t = s / segments;
          const dir = interpolateProfileDir(i1_v1, i2_v1, t, profile, segments);
          arc1.push(p1.clone().addScaledVector(dir, width));
        }
        const arc2 = [];
        for (let s = 0; s <= segments; s++) {
          const t = s / segments;
          const dir = interpolateProfileDir(i1_v2, i2_v2, t, profile, segments);
          arc2.push(p2.clone().addScaledVector(dir, width));
        }

        // Extend outer arc skirt boundaries outward into exterior air to avoid coplanar grazing
        const ext0_1 = new THREE.Vector3().subVectors(arc1[0], arc1[1]);
        if (ext0_1.lengthSq() > 1e-12) arc1[0].addScaledVector(ext0_1.normalize(), width * 0.35);
        const extN_1 = new THREE.Vector3().subVectors(arc1[segments], arc1[segments - 1]);
        if (extN_1.lengthSq() > 1e-12) arc1[segments].addScaledVector(extN_1.normalize(), width * 0.35);

        const ext0_2 = new THREE.Vector3().subVectors(arc2[0], arc2[1]);
        if (ext0_2.lengthSq() > 1e-12) arc2[0].addScaledVector(ext0_2.normalize(), width * 0.35);
        const extN_2 = new THREE.Vector3().subVectors(arc2[segments], arc2[segments - 1]);
        if (extN_2.lengthSq() > 1e-12) arc2[segments].addScaledVector(extN_2.normalize(), width * 0.35);

        const apex1 = p1.clone().addScaledVector(cn_v1, width * 1.2);
        const apex2 = p2.clone().addScaledVector(cn_v2, width * 1.2);

        const centroid = new THREE.Vector3()
          .add(apex1)
          .add(apex2)
          .add(arc1[0])
          .add(arc1[segments])
          .add(arc2[0])
          .add(arc2[segments])
          .multiplyScalar(1 / 6);

        // End caps at non-smooth endpoints
        if (!isSmooth1) {
          for (let s = 0; s < segments; s++) {
            pushTriOutward(cutterPositions, apex1, arc1[s], arc1[s + 1], centroid);
          }
        }
        if (!isSmooth2) {
          for (let s = 0; s < segments; s++) {
            pushTriOutward(cutterPositions, apex2, arc2[s + 1], arc2[s], centroid);
          }
        }

        // Side quad 1
        pushTriOutward(cutterPositions, apex1, apex2, arc2[0], centroid);
        pushTriOutward(cutterPositions, apex1, arc2[0], arc1[0], centroid);

        // Side quad 2
        const last = segments;
        pushTriOutward(cutterPositions, arc1[last], arc2[last], apex2, centroid);
        pushTriOutward(cutterPositions, arc1[last], apex2, apex1, centroid);

        // Chamfer / fillet cut faces along the arc
        for (let s = 0; s < segments; s++) {
          pushTriOutward(cutterPositions, arc1[s], arc1[s + 1], arc2[s + 1], centroid);
          pushTriOutward(cutterPositions, arc1[s], arc2[s + 1], arc2[s], centroid);
        }
      }

      if (cutterPositions.length === 0) continue;

      const cutterGeo = new THREE.BufferGeometry();
      cutterGeo.setAttribute(
        'position',
        new THREE.Float32BufferAttribute(cutterPositions, 3)
      );
      cutterGeo.computeVertexNormals();

      const cutterBrush = new Brush(cutterGeo);
      cutterBrush.updateMatrixWorld();

      const nextBrush = evaluator.evaluate(curBrush, cutterBrush, SUBTRACTION);
      cutterGeo.dispose();
      curBrush.geometry.dispose();
      curBrush = nextBrush;
      curBrush.updateMatrixWorld();
    }

    const resultGeo = curBrush.geometry.clone();
    curBrush.geometry.dispose();
    resultGeo.computeVertexNormals();
    resultGeo.computeBoundingBox();
    resultGeo.computeBoundingSphere();
    return resultGeo;
  } catch (err) {
    console.error('CSG chamfer failed, falling back to original geometry:', err);
    try { curBrush.geometry.dispose(); } catch (_) { /* ignore cleanup error */ }
    return geometry.clone();
  }
}
