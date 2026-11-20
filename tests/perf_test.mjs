import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { performance } from 'node:perf_hooks';
import * as THREE from 'three';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';
import {
  getFastMeshTopology,
  buildIndexedGeometryFromTopology,
  buildCreaseGeometryFromTopology,
  detectUnoptimizedMesh,
  invalidateMeshTopology,
} from '../src/meshTopology.js';
import { simplifyGeometryAsync } from '../src/meshSimplifier.js';
import { analyzeMesh } from '../src/meshFixer.js';
import { autoDetectAngleThreshold, detectEdges } from '../src/edgeDetector.js';

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PERF_DIR = path.join(__dirname, 'perf');
const MANIFEST_PATH = path.join(PERF_DIR, 'manifest.json');

const STAGE_ORDER = [
  'parse',
  'rawTopology',
  'indexedBuild',
  'simplify',
  'analyze',
  'autoAngle',
  'detectEdges',
  'crease',
  'bvhBuild',
  'raycast100',
];

function pad(value, width, alignRight = false) {
  const str = String(value);
  if (str.length >= width) return str;
  return alignRight ? str.padStart(width, ' ') : str.padEnd(width, ' ');
}

function disposeGeo(geo) {
  if (!geo) return;
  invalidateMeshTopology(geo);
  if (typeof geo.disposeBoundsTree === 'function') {
    geo.disposeBoundsTree();
  }
  if (typeof geo.dispose === 'function') {
    geo.dispose();
  }
}

/**
 * Load a `.stl` or `.stl.gz` fixture from disk into a raw ArrayBuffer outside timed parse.
 */
function loadPerfBuffer(filePath) {
  const raw = fs.readFileSync(filePath);
  const buf = filePath.toLowerCase().endsWith('.gz') ? gunzipSync(raw) : raw;
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

/**
 * Run 100 BVH-accelerated first-hit raycasts over a 10x10 grid across the model's XY footprint.
 */
function runRaycastBenchmark(geometry) {
  geometry.computeBoundingBox();
  const bbox = geometry.boundingBox;
  const center = new THREE.Vector3();
  const size = new THREE.Vector3();
  bbox.getCenter(center);
  bbox.getSize(size);

  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
  mesh.updateMatrixWorld();

  const raycaster = new THREE.Raycaster();
  raycaster.firstHitOnly = true;
  const dir = new THREE.Vector3(0, 0, -1);
  const startZ = bbox.max.z + 10;

  let hits = 0;
  for (let iy = 0; iy < 10; iy++) {
    for (let ix = 0; ix < 10; ix++) {
      const rx = center.x + ((ix - 4.5) / 9) * size.x * 0.6;
      const ry = center.y + ((iy - 4.5) / 9) * size.y * 0.6;
      raycaster.set(new THREE.Vector3(rx, ry, startZ), dir);
      if (raycaster.intersectObject(mesh, false).length > 0) {
        hits++;
      }
    }
  }

  mesh.material.dispose();
  return hits;
}

/**
 * Verify bounding-box dimensions survived simplification within CAD tolerance.
 */
function checkBboxPreserved(beforeGeo, afterGeo, toleranceMm) {
  beforeGeo.computeBoundingBox();
  afterGeo.computeBoundingBox();
  const s1 = new THREE.Vector3();
  const s2 = new THREE.Vector3();
  beforeGeo.boundingBox.getSize(s1);
  afterGeo.boundingBox.getSize(s2);

  const allowedDiff = Math.max(0.1, toleranceMm * 4);
  const dx = Math.abs(s2.x - s1.x);
  const dy = Math.abs(s2.y - s1.y);
  const dz = Math.abs(s2.z - s1.z);
  return {
    ok: dx <= allowedDiff && dy <= allowedDiff && dz <= allowedDiff,
    maxDiff: Math.max(dx, dy, dz),
    allowedDiff,
  };
}

/**
 * Benchmark and assert functional + latency budgets across every large-mesh pipeline stage.
 */
async function benchmarkModel(entry, budgetMult) {
  const filePath = path.join(PERF_DIR, entry.file);
  const arrayBuffer = loadPerfBuffer(filePath);
  if (entry.rawBytes && arrayBuffer.byteLength !== entry.rawBytes) {
    throw new Error(
      `Fixture byte size mismatch for ${entry.file}: got ${arrayBuffer.byteLength}, expected ${entry.rawBytes}`
    );
  }

  let rawGeo = null;
  let indexedGeo = null;
  let simplifiedGeo = null;
  let creaseGeo = null;
  let edgeData = null;

  const timings = {};
  const totalStart = performance.now();

  try {
    let t0 = performance.now();
    rawGeo = new STLLoader().parse(arrayBuffer);
    timings.parse = performance.now() - t0;

    t0 = performance.now();
    const rawTopo = getFastMeshTopology(rawGeo);
    const optInfo = detectUnoptimizedMesh(rawTopo);
    timings.rawTopology = performance.now() - t0;

    if (rawTopo.triCount !== entry.expectedRawTriangles) {
      throw new Error(
        `Unexpected raw triangle count: got ${rawTopo.triCount}, expected ${entry.expectedRawTriangles}`
      );
    }
    if (!optInfo.isUnoptimized || optInfo.coplanarPct < entry.minCoplanarPct) {
      throw new Error(
        `Unoptimized mesh check failed: isUnoptimized=${optInfo.isUnoptimized}, coplanarPct=${optInfo.coplanarPct}% (expected >= ${entry.minCoplanarPct}%)`
      );
    }

    t0 = performance.now();
    indexedGeo = buildIndexedGeometryFromTopology(rawTopo, { center: true });
    disposeGeo(rawGeo);
    rawGeo = null;
    timings.indexedBuild = performance.now() - t0;

    t0 = performance.now();
    const simResult = await simplifyGeometryAsync(indexedGeo, {
      tolerance: entry.simplifyToleranceMm,
    });
    timings.simplify = performance.now() - t0;
    simplifiedGeo = simResult.geometry;

    if (!simplifiedGeo || simResult.trisAfter <= 0) {
      throw new Error('Simplification produced no geometry');
    }
    if (simResult.reductionPct < entry.minReductionPct) {
      throw new Error(
        `Triangle reduction ${simResult.reductionPct}% below minimum ${entry.minReductionPct}%`
      );
    }
    const bboxCheck = checkBboxPreserved(indexedGeo, simplifiedGeo, entry.simplifyToleranceMm);
    if (!bboxCheck.ok) {
      throw new Error(
        `Bounding box drifted by ${bboxCheck.maxDiff.toFixed(4)} mm (allowed ${bboxCheck.allowedDiff.toFixed(4)} mm)`
      );
    }

    t0 = performance.now();
    const health = analyzeMesh(simplifiedGeo);
    timings.analyze = performance.now() - t0;

    if (
      !health.isWatertight ||
      health.openEdges !== 0 ||
      health.nonManifoldEdges !== 0 ||
      health.issueCount !== 0 ||
      health.disconnectedParts !== 0
    ) {
      throw new Error(
        `Simplified mesh health failed: watertight=${health.isWatertight}, open=${health.openEdges}, nonManifold=${health.nonManifoldEdges}, issues=${health.issueCount}, loose=${health.disconnectedParts}`
      );
    }

    t0 = performance.now();
    const angle = autoDetectAngleThreshold(simplifiedGeo, { convexOnly: false });
    timings.autoAngle = performance.now() - t0;

    t0 = performance.now();
    edgeData = detectEdges(simplifiedGeo, angle, { convexOnly: false });
    timings.detectEdges = performance.now() - t0;

    if (!edgeData || edgeData.sharpEdges.length === 0 || edgeData.surfaces.length === 0) {
      throw new Error(
        `Edge detection failed on simplified mesh: edges=${edgeData?.sharpEdges?.length ?? 0}, surfaces=${edgeData?.surfaces?.length ?? 0}`
      );
    }

    t0 = performance.now();
    creaseGeo = buildCreaseGeometryFromTopology(getFastMeshTopology(simplifiedGeo), 14);
    timings.crease = performance.now() - t0;
    const creaseAttr = creaseGeo.getAttribute('position');
    if (!creaseAttr || creaseAttr.count <= 0) {
      throw new Error('Crease geometry extraction produced 0 vertices');
    }

    t0 = performance.now();
    simplifiedGeo.computeBoundsTree();
    timings.bvhBuild = performance.now() - t0;

    t0 = performance.now();
    const rayHits = runRaycastBenchmark(simplifiedGeo);
    timings.raycast100 = performance.now() - t0;

    if (rayHits <= 0) {
      throw new Error('BVH raycast benchmark returned 0 hits');
    }

    timings.total = performance.now() - totalStart;

    const failures = [];
    for (const stage of [...STAGE_ORDER, 'total']) {
      const budget = (entry.budgetsMs?.[stage] ?? Infinity) * budgetMult;
      if (timings[stage] > budget) {
        failures.push(
          `${stage} took ${timings[stage].toFixed(1)} ms > budget ${budget.toFixed(1)} ms`
        );
      }
    }

    return {
      label: entry.label,
      rawTris: rawTopo.triCount,
      simplifiedTris: simResult.trisAfter,
      reductionPct: simResult.reductionPct,
      coplanarPct: optInfo.coplanarPct,
      engine: simResult.engine,
      watertight: health.isWatertight,
      sharpEdges: edgeData.sharpEdges.length,
      surfaces: edgeData.surfaces.length,
      rayHits,
      timings,
      failures,
      ok: failures.length === 0,
    };
  } finally {
    if (edgeData?.dispose) edgeData.dispose();
    disposeGeo(creaseGeo);
    disposeGeo(simplifiedGeo);
    disposeGeo(indexedGeo);
    disposeGeo(rawGeo);
  }
}

async function main() {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  const rawMult = Number(process.env.PERF_BUDGET_MULTIPLIER);
  const budgetMult = Number.isFinite(rawMult) && rawMult > 0 ? rawMult : 1.0;

  console.log(
    `Running ${manifest.length} performance benchmark(s) (PERF_BUDGET_MULTIPLIER=${budgetMult}x)...\n`
  );

  let passed = 0;
  for (const entry of manifest) {
    try {
      const res = await benchmarkModel(entry, budgetMult);
      console.log(`Model: ${res.label} [${entry.file}]`);
      console.log(
        `Metrics: ${res.rawTris.toLocaleString()} → ${res.simplifiedTris.toLocaleString()} tris (-${res.reductionPct}%, ${res.coplanarPct}% coplanar, engine=${res.engine}) | Watertight=${res.watertight} | Edges=${res.sharpEdges.toLocaleString()} | Surfs=${res.surfaces.toLocaleString()} | BVH Hits=${res.rayHits}/100\n`
      );

      const header = [
        pad('Stage', 15),
        pad('Measured', 11, true),
        pad('Budget', 11, true),
        'Status',
      ].join(' | ');
      console.log(header);
      console.log('-'.repeat(header.length));

      for (const stage of [...STAGE_ORDER, 'total']) {
        const measured = `${res.timings[stage].toFixed(1)} ms`;
        const budget = (entry.budgetsMs?.[stage] ?? Infinity) * budgetMult;
        const budgetStr = Number.isFinite(budget) ? `${budget.toFixed(0)} ms` : '-';
        const ok = res.timings[stage] <= budget;
        console.log(
          [
            pad(stage, 15),
            pad(measured, 11, true),
            pad(budgetStr, 11, true),
            ok ? 'PASS' : 'FAIL',
          ].join(' | ')
        );
      }

      if (res.ok) {
        passed++;
        console.log(`\nResult: PASS (${res.label})\n`);
      } else {
        console.log(`\nResult: FAIL (${res.label}) — ${res.failures.join('; ')}\n`);
      }
    } catch (err) {
      console.error(`Result: FAIL (${entry.label}) — ${err instanceof Error ? err.message : err}\n`);
    }
  }

  const failed = manifest.length - passed;
  console.log(`Summary: ${passed}/${manifest.length} performance benchmark(s) passed (${failed} failed).`);
  if (failed > 0 || manifest.length === 0) {
    process.exitCode = 1;
  }
}

await main();
