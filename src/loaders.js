/* ============================================================
   loaders.js — STL and 3MF file import (drag-drop + file picker)
   ============================================================ */
import * as THREE from 'three';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';

// 3MFLoader is a heavier addon; we import it lazily to avoid bundling if unused
let ThreeMFLoaderClass = null;

/**
 * Setup drag-and-drop + file-picker import.
 * @param {HTMLElement} dropTarget  — element for drag events (the viewport div)
 * @param {HTMLInputElement|null} fileInput — optional hidden file input
 * @param {(mesh: THREE.Mesh) => void} onLoaded — callback with the loaded mesh
 */
export function setupLoaders(dropTarget, fileInput, onLoaded, onError) {

  const overlay = document.getElementById('drop-overlay');

  // ---- Drag & Drop ----
  let dragCounter = 0;

  dropTarget.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dragCounter++;
    overlay.classList.add('visible');
  });

  dropTarget.addEventListener('dragover', (e) => {
    e.preventDefault();
  });

  dropTarget.addEventListener('dragleave', () => {
    dragCounter--;
    if (dragCounter <= 0) {
      dragCounter = 0;
      overlay.classList.remove('visible');
    }
  });

  dropTarget.addEventListener('drop', (e) => {
    e.preventDefault();
    dragCounter = 0;
    overlay.classList.remove('visible');
    const files = e.dataTransfer?.files;
    if (files && files.length > 0) {
      handleFile(files[0], onLoaded, onError);
    }
  });

  // ---- File picker ----
  if (fileInput) {
    fileInput.addEventListener('change', () => {
      if (fileInput.files && fileInput.files.length > 0) {
        handleFile(fileInput.files[0], onLoaded, onError);
        fileInput.value = ''; // reset so same file can be re-selected
      }
    });
  }
}

/**
 * Process a dropped/picked file.
 */
function handleFile(file, onLoaded, onError) {
  const name = file.name.toLowerCase();
  if (name.endsWith('.stl')) {
    loadSTL(file, onLoaded, onError);
  } else if (name.endsWith('.3mf')) {
    load3MF(file, onLoaded, onError);
  } else {
    const msg = `Unsupported file format: ${file.name}. Use .stl or .3mf.`;
    console.warn(msg);
    if (onError) onError(new Error(msg));
  }
}

function loadSTL(file, onLoaded, onError) {
  const reader = new FileReader();
  reader.onerror = () => {
    if (onError) onError(new Error(`Failed to read file: ${file.name}`));
  };
  reader.onload = (e) => {
    try {
      const loader = new STLLoader();
      const geometry = loader.parse(e.target.result);
      const pos = geometry.getAttribute('position');
      if (!pos || pos.count === 0) {
        throw new Error('STL file contains no geometry.');
      }
      const mesh = geometryToMesh(geometry);
      onLoaded(mesh);
    } catch (err) {
      console.error('Failed to parse STL:', err);
      if (onError) onError(err);
    }
  };
  reader.readAsArrayBuffer(file);
}

async function load3MF(file, onLoaded, onError) {
  try {
    // Lazy-load the 3MF loader and merge utility
    if (!ThreeMFLoaderClass) {
      const [loaderMod, utilsMod] = await Promise.all([
        import('three/addons/loaders/3MFLoader.js'),
        import('three/addons/utils/BufferGeometryUtils.js'),
      ]);
      ThreeMFLoaderClass = loaderMod.ThreeMFLoader;
      window._BufferGeometryUtils = utilsMod;
    }

    const reader = new FileReader();
    reader.onerror = () => {
      if (onError) onError(new Error(`Failed to read file: ${file.name}`));
    };
    reader.onload = (e) => {
      try {
        const loader = new ThreeMFLoaderClass();
        const group = loader.parse(e.target.result);
        // ThreeMFLoader returns a Group — extract all Mesh children
        const geometries = [];
        group.updateMatrixWorld(true);
        group.traverse((child) => {
          if (child.isMesh && child.geometry) {
            let geo = child.geometry.clone();
            geo.applyMatrix4(child.matrixWorld);
            if (geo.index) {
              geo = geo.toNonIndexed();
            }
            geometries.push(geo);
          }
        });

        if (geometries.length === 1) {
          const mesh = geometryToMesh(geometries[0]);
          onLoaded(mesh);
        } else if (geometries.length > 1) {
          const merged =
            window._BufferGeometryUtils?.mergeGeometries?.(geometries) ||
            mergeGeometriesList(geometries);
          for (const g of geometries) g.dispose();
          if (!merged) {
            throw new Error('Failed to merge multi-part 3MF geometries.');
          }
          const mesh = geometryToMesh(merged);
          onLoaded(mesh);
        } else {
          throw new Error('No 3D meshes found in 3MF file.');
        }
      } catch (err) {
        console.error('Failed to parse 3MF:', err);
        if (onError) onError(err);
      }
    };
    reader.readAsArrayBuffer(file);
  } catch (err) {
    console.error('Failed to initialize 3MF loader:', err);
    if (onError) onError(err);
  }
}

/**
 * Fallback position-only merge for an array of non-indexed BufferGeometries.
 */
function mergeGeometriesList(geometries) {
  let totalVerts = 0;
  for (const g of geometries) {
    const pos = g.getAttribute('position');
    if (pos) totalVerts += pos.count;
  }
  if (totalVerts === 0) return null;

  const merged = new Float32Array(totalVerts * 3);
  let offset = 0;
  for (const g of geometries) {
    const pos = g.getAttribute('position');
    if (!pos) continue;
    merged.set(new Float32Array(pos.array), offset);
    offset += pos.count * 3;
  }

  const result = new THREE.BufferGeometry();
  result.setAttribute('position', new THREE.BufferAttribute(merged, 3));
  return result;
}

/**
 * Create a Mesh from BufferGeometry: center, auto-scale, compute normals.
 */
function geometryToMesh(geometry) {
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();

  // Center geometry at origin (keeps 1:1 real-world millimeters)
  const center = new THREE.Vector3();
  geometry.boundingBox.getCenter(center);
  geometry.translate(-center.x, -center.y, -center.z);

  // Recompute bounding box & sphere
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();

  const material = new THREE.MeshStandardMaterial({
    color: 0x96b3ce,
    metalness: 0.28,
    roughness: 0.35,
    flatShading: true,
    side: THREE.DoubleSide,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'loadedModel';
  return mesh;
}

/**
 * Load a model directly from a URL.
 */
export function loadFromUrl(url, onLoaded, onError) {
  fetch(url)
    .then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status} while loading ${url}`);
      return r.blob();
    })
    .then((blob) => {
      const filename = url.split('/').pop() || 'model.stl';
      const file = new File([blob], filename);
      handleFile(file, onLoaded, onError);
    })
    .catch((err) => {
      console.error('Failed to load model from URL:', err);
      if (onError) onError(err);
    });
}
