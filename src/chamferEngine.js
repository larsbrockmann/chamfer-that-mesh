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
          sumInset1: new THREE.Vector3(),
          sumInset2: new THREE.Vector3(),
          sumCornerNorm: new THREE.Vector3(),
          count: 0,
        });
      }
      const vd = vertexMap.get(vi);
      vd.sumInset1.add(inset1);
      vd.sumInset2.add(inset2);
      vd.sumCornerNorm.add(cornerNorm);
      vd.count++;
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

/**
 * Apply chamfer/fillet to geometry using continuous-chain CSG subtraction.
 * Vertex-aligned cross-sections eliminate sawtooth fins and broken edges on rounded corners.
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
  const cutterPositions = [];

  for (const edge of edges) {
    const frame = edgeMap.get(edge);
    if (!frame) continue;

    const { vi1, vi2, v1, v2 } = edge;
    const vd1 = vertexMap.get(vi1);
    const vd2 = vertexMap.get(vi2);

    // Vertex-averaged insets ensure adjacent prisms share identical boundary polygons
    const i1_v1 = vd1 && vd1.count > 1 ? vd1.sumInset1.clone().normalize() : frame.inset1;
    const i2_v1 = vd1 && vd1.count > 1 ? vd1.sumInset2.clone().normalize() : frame.inset2;
    const cn_v1 = vd1 && vd1.count > 1 ? vd1.sumCornerNorm.clone().normalize() : frame.cornerNorm;

    const i1_v2 = vd2 && vd2.count > 1 ? vd2.sumInset1.clone().normalize() : frame.inset1;
    const i2_v2 = vd2 && vd2.count > 1 ? vd2.sumInset2.clone().normalize() : frame.inset2;
    const cn_v2 = vd2 && vd2.count > 1 ? vd2.sumCornerNorm.clone().normalize() : frame.cornerNorm;

    // Profile points along the chamfer arc at v1
    const arc1 = [];
    for (let s = 0; s <= segments; s++) {
      const t = s / segments;
      const dir = interpolateProfileDir(i1_v1, i2_v1, t, profile, segments);
      arc1.push(v1.clone().addScaledVector(dir, width));
    }
    // Outer apex just outside the corner
    const apex1 = v1.clone().addScaledVector(cn_v1, width * 0.15);

    // Profile points along the chamfer arc at v2
    const arc2 = [];
    for (let s = 0; s <= segments; s++) {
      const t = s / segments;
      const dir = interpolateProfileDir(i1_v2, i2_v2, t, profile, segments);
      arc2.push(v2.clone().addScaledVector(dir, width));
    }
    const apex2 = v2.clone().addScaledVector(cn_v2, width * 0.15);

    // End caps: ONLY added at open dead-end boundary terminations, NEVER at continuous curve vertices!
    if (vd1 && vd1.count === 1) {
      for (let s = 0; s < segments; s++) {
        cutterPositions.push(
          apex1.x, apex1.y, apex1.z,
          arc1[s].x, arc1[s].y, arc1[s].z,
          arc1[s + 1].x, arc1[s + 1].y, arc1[s + 1].z
        );
      }
    }

    if (vd2 && vd2.count === 1) {
      for (let s = 0; s < segments; s++) {
        cutterPositions.push(
          apex2.x, apex2.y, apex2.z,
          arc2[s + 1].x, arc2[s + 1].y, arc2[s + 1].z,
          arc2[s].x, arc2[s].y, arc2[s].z
        );
      }
    }

    // Side quad 1: from apex to first arc line
    cutterPositions.push(
      apex1.x, apex1.y, apex1.z,
      apex2.x, apex2.y, apex2.z,
      arc2[0].x, arc2[0].y, arc2[0].z,

      apex1.x, apex1.y, apex1.z,
      arc2[0].x, arc2[0].y, arc2[0].z,
      arc1[0].x, arc1[0].y, arc1[0].z
    );

    // Side quad 2: from last arc line to apex
    const last = segments;
    cutterPositions.push(
      arc1[last].x, arc1[last].y, arc1[last].z,
      arc2[last].x, arc2[last].y, arc2[last].z,
      apex2.x, apex2.y, apex2.z,

      arc1[last].x, arc1[last].y, arc1[last].z,
      apex2.x, apex2.y, apex2.z,
      apex1.x, apex1.y, apex1.z
    );

    // Chamfer / fillet cut faces along the arc
    for (let s = 0; s < segments; s++) {
      cutterPositions.push(
        arc1[s].x, arc1[s].y, arc1[s].z,
        arc1[s + 1].x, arc1[s + 1].y, arc1[s + 1].z,
        arc2[s + 1].x, arc2[s + 1].y, arc2[s + 1].z,

        arc1[s].x, arc1[s].y, arc1[s].z,
        arc2[s + 1].x, arc2[s + 1].y, arc2[s + 1].z,
        arc2[s].x, arc2[s].y, arc2[s].z
      );
    }
  }

  if (cutterPositions.length === 0) {
    return geometry.clone();
  }

  const cutterGeo = new THREE.BufferGeometry();
  cutterGeo.setAttribute(
    'position',
    new THREE.Float32BufferAttribute(cutterPositions, 3)
  );
  cutterGeo.computeVertexNormals();

  let baseGeo = geometry.index ? geometry.toNonIndexed() : geometry.clone();
  baseGeo.computeVertexNormals();

  try {
    const modelBrush = new Brush(baseGeo);
    modelBrush.updateMatrixWorld();

    const cutterBrush = new Brush(cutterGeo);
    cutterBrush.updateMatrixWorld();

    const evaluator = new Evaluator();
    evaluator.attributes = ['position', 'normal'];

    const result = evaluator.evaluate(modelBrush, cutterBrush, SUBTRACTION);
    const resultGeo = result.geometry.clone();
    resultGeo.computeVertexNormals();
    resultGeo.computeBoundingBox();
    resultGeo.computeBoundingSphere();
    return resultGeo;
  } catch (err) {
    console.error('CSG chamfer failed, falling back to original geometry:', err);
    return geometry.clone();
  }
}
