import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { unzipSync, strFromU8 } from 'three/examples/jsm/libs/fflate.module.js';
import { detectEdges, autoDetectAngleThreshold } from '../src/edgeDetector.js';
import { applyChamferAsync } from '../src/chamferEngine.js';
import { analyzeMesh } from '../src/meshFixer.js';
import { get3MFUnitScale } from '../src/loaders.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const MODELS_DIR = path.join(ROOT_DIR, 'public', 'models');
const TEST_LIBRARY_DIR = path.join(MODELS_DIR, 'test-library');
const MANIFEST_PATH = path.join(TEST_LIBRARY_DIR, 'manifest.json');

/**
 * Load an ASCII or binary STL file from disk into a THREE.BufferGeometry.
 * @param {string} filePath
 * @returns {THREE.BufferGeometry}
 */
function loadStlGeometry(filePath) {
  const buf = fs.readFileSync(filePath);
  const arrayBuffer = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return new STLLoader().parse(arrayBuffer);
}

/**
 * Load a 3MF file from disk in Node.js by parsing `.model` XML meshes and unit scale.
 * @param {string} filePath
 * @returns {THREE.BufferGeometry}
 */
function load3mfGeometry(filePath) {
  const buf = fs.readFileSync(filePath);
  const arrayBuffer = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const unitScale = get3MFUnitScale(arrayBuffer);
  const zip = unzipSync(new Uint8Array(arrayBuffer));
  const positions = [];

  for (const [entryName, data] of Object.entries(zip)) {
    if (!entryName.endsWith('.model')) continue;
    const xml = strFromU8(data);
    for (const meshMatch of xml.matchAll(/<mesh\b[^>]*>([\s\S]*?)<\/mesh>/g)) {
      const meshXml = meshMatch[1];
      const verts = [];
      for (const m of meshXml.matchAll(/<vertex\b[^>]*\bx="([^"]+)"[^>]*\by="([^"]+)"[^>]*\bz="([^"]+)"/g)) {
        verts.push(
          parseFloat(m[1]) * unitScale,
          parseFloat(m[2]) * unitScale,
          parseFloat(m[3]) * unitScale
        );
      }
      for (const m of meshXml.matchAll(/<triangle\b[^>]*\bv1="(\d+)"[^>]*\bv2="(\d+)"[^>]*\bv3="(\d+)"/g)) {
        const i1 = parseInt(m[1], 10) * 3;
        const i2 = parseInt(m[2], 10) * 3;
        const i3 = parseInt(m[3], 10) * 3;
        positions.push(
          verts[i1], verts[i1 + 1], verts[i1 + 2],
          verts[i2], verts[i2 + 1], verts[i2 + 2],
          verts[i3], verts[i3 + 1], verts[i3 + 2]
        );
      }
    }
  }

  if (positions.length === 0) {
    throw new Error(`No mesh triangles found in 3MF file: ${filePath}`);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * Load either an `.stl` or `.3mf` mesh file from disk into a THREE.BufferGeometry.
 * @param {string} filePath
 * @returns {THREE.BufferGeometry}
 */
function loadModelGeometry(filePath) {
  if (filePath.toLowerCase().endsWith('.3mf')) {
    return load3mfGeometry(filePath);
  }
  return loadStlGeometry(filePath);
}

/**
 * Collect the built-in STL demo models and all test library models from manifest.json.
 * @returns {Array<{name: string, group: string, filePath: string, meta?: object}>}
 */
function collectTestModels() {
  const builtinNames = fs
    .readdirSync(MODELS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.stl'))
    .map((entry) => entry.name)
    .sort();

  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));

  const builtinModels = builtinNames.map((name) => ({
    name,
    group: 'built-in',
    filePath: path.join(MODELS_DIR, name),
  }));

  const testLibraryModels = manifest.map((entry) => ({
    name: entry.file,
    group: entry.printablesId
      ? `printables-#${entry.printablesId}`
      : entry.source || 'test-library',
    filePath: path.join(TEST_LIBRARY_DIR, entry.file),
    meta: entry,
  }));

  return [...builtinModels, ...testLibraryModels];
}

function getTriangleCount(geometry) {
  return geometry.index ? geometry.index.count / 3 : geometry.attributes.position.count / 3;
}

/**
 * Pad a cell string for aligned summary output.
 */
function pad(value, width, alignRight = false) {
  const str = String(value);
  if (str.length >= width) return str;
  return alignRight ? str.padStart(width, ' ') : str.padEnd(width, ' ');
}

async function validateModel(model) {
  const startMs = Date.now();
  const geometry = loadModelGeometry(model.filePath);
  let outGeometry = null;

  try {
    const before = analyzeMesh(geometry);
    const inTris = Math.round(getTriangleCount(geometry));
    const optAngle = autoDetectAngleThreshold(geometry, { convexOnly: true });
    const edgeData = detectEdges(geometry, optAngle, { convexOnly: true });

    const edgeCount = edgeData.sharpEdges.length;
    const surfaceCount = edgeData.surfaces.length;
    if (edgeCount === 0 || surfaceCount === 0) {
      throw new Error(`Expected detected edges & surfaces, got edges=${edgeCount}, surfaces=${surfaceCount}`);
    }

    outGeometry = await applyChamferAsync(geometry, edgeData, {
      width: 0.25,
      segments: 1,
      profile: 'chamfer',
    });
    const after = analyzeMesh(outGeometry);
    const postEdges = detectEdges(outGeometry, optAngle, { convexOnly: true });
    const outTris = Math.round(getTriangleCount(outGeometry));
    const elapsedMs = Date.now() - startMs;

    const ok =
      after.isWatertight === true &&
      after.openEdges === 0 &&
      after.nonManifoldEdges === 0 &&
      after.issueCount === 0 &&
      postEdges.sharpEdges.length > 0 &&
      postEdges.surfaces.length > 0;

    return {
      name: model.name,
      group: model.group,
      inTris,
      outTris,
      optAngle,
      edgeCount,
      surfaceCount,
      inWatertight: before.isWatertight,
      outWatertight: after.isWatertight,
      openEdges: after.openEdges,
      nonManifoldEdges: after.nonManifoldEdges,
      issueCount: after.issueCount,
      elapsedMs,
      ok,
      error: ok
        ? null
        : `watertight=${after.isWatertight}, open=${after.openEdges}, nonManifold=${after.nonManifoldEdges}, issues=${after.issueCount}, postEdges=${postEdges.sharpEdges.length}, postSurfs=${postEdges.surfaces.length}`,
    };
  } catch (err) {
    return {
      name: model.name,
      group: model.group,
      inTris: '-',
      outTris: '-',
      optAngle: '-',
      edgeCount: '-',
      surfaceCount: '-',
      inWatertight: '-',
      outWatertight: false,
      openEdges: '-',
      nonManifoldEdges: '-',
      issueCount: '-',
      elapsedMs: Date.now() - startMs,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    geometry.dispose();
    if (outGeometry && typeof outGeometry.dispose === 'function') {
      outGeometry.dispose();
    }
  }
}

async function main() {
  const models = collectTestModels();
  console.log(`Validating ${models.length} test models (width=0.25, segments=1, profile=chamfer)...\n`);

  const header = [
    pad('Model', 31),
    pad('Source', 19),
    pad('InTris', 7, true),
    pad('Angle', 6, true),
    pad('Edges', 6, true),
    pad('Surfs', 6, true),
    pad('InWT', 6),
    pad('OutTris', 8, true),
    pad('OutWT', 6),
    pad('Open', 5, true),
    pad('NonMan', 7, true),
    pad('Issues', 7, true),
    pad('Time', 7, true),
    'Status',
  ].join(' | ');

  console.log(header);
  console.log('-'.repeat(header.length));

  const results = [];
  for (const model of models) {
    const res = await validateModel(model);
    results.push(res);

    const row = [
      pad(res.name, 31),
      pad(res.group, 19),
      pad(res.inTris, 7, true),
      pad(res.optAngle === '-' ? '-' : `${res.optAngle}d`, 6, true),
      pad(res.edgeCount, 6, true),
      pad(res.surfaceCount, 6, true),
      pad(res.inWatertight, 6),
      pad(res.outTris, 8, true),
      pad(res.outWatertight, 6),
      pad(res.openEdges, 5, true),
      pad(res.nonManifoldEdges, 7, true),
      pad(res.issueCount, 7, true),
      pad(`${res.elapsedMs}ms`, 7, true),
      res.ok ? 'PASS' : `FAIL (${res.error})`,
    ].join(' | ');

    console.log(row);
  }

  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  console.log(`\nSummary: ${passed}/${results.length} models passed (${failed} failed).`);

  if (failed > 0 || results.length === 0) {
    process.exitCode = 1;
  }
}

await main();
