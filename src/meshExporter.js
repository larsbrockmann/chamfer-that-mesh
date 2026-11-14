/* ============================================================
   meshExporter.js — Export modified mesh as binary STL or 3MF
   ============================================================ */
import { STLExporter } from 'three/addons/exporters/STLExporter.js';
import * as fflate from 'three/addons/libs/fflate.module.js';

/**
 * Export a THREE.Mesh as binary STL and trigger a browser download.
 * @param {THREE.Mesh} mesh
 * @param {string} filename
 */
export function exportSTL(mesh, filename = 'beveled_model.stl') {
  const exporter = new STLExporter();
  const buffer = exporter.parse(mesh, { binary: true });

  const blob = new Blob([buffer], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);

  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();

  setTimeout(() => {
    URL.revokeObjectURL(url);
    document.body.removeChild(a);
  }, 100);
}

/**
 * Export a THREE.Mesh as standard 3MF archive and trigger a browser download.
 * @param {THREE.Mesh} mesh
 * @param {string} filename
 */
export function export3MF(mesh, filename = 'beveled_model.3mf') {
  const geo = mesh.geometry;
  const posAttr = geo.getAttribute('position');
  if (!posAttr) return;

  const indexed = !!geo.index;
  const indices = indexed ? geo.index : null;
  const triCount = indexed ? geo.index.count / 3 : posAttr.count / 3;

  // Build vertex XML
  let vXml = '';
  for (let i = 0; i < posAttr.count; i++) {
    const x = posAttr.getX(i).toFixed(4);
    const y = posAttr.getY(i).toFixed(4);
    const z = posAttr.getZ(i).toFixed(4);
    vXml += `          <vertex x="${x}" y="${y}" z="${z}" />\n`;
  }

  // Build triangle XML
  let tXml = '';
  if (indexed) {
    for (let i = 0; i < triCount; i++) {
      const v1 = indices.getX(i * 3);
      const v2 = indices.getX(i * 3 + 1);
      const v3 = indices.getX(i * 3 + 2);
      tXml += `          <triangle v1="${v1}" v2="${v2}" v3="${v3}" />\n`;
    }
  } else {
    for (let i = 0; i < triCount; i++) {
      const v1 = i * 3;
      const v2 = i * 3 + 1;
      const v3 = i * 3 + 2;
      tXml += `          <triangle v1="${v1}" v2="${v2}" v3="${v3}" />\n`;
    }
  }

  const modelXml = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
  <metadata name="Application">Chamfer That Mesh</metadata>
  <resources>
    <object id="1" type="model">
      <mesh>
        <vertices>
${vXml}        </vertices>
        <triangles>
${tXml}        </triangles>
      </mesh>
    </object>
  </resources>
  <build>
    <item objectid="1" />
  </build>
</model>`;

  const relsXml = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel" />
</Relationships>`;

  const contentTypesXml = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml" />
  <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml" />
</Types>`;

  const zipData = fflate.zipSync({
    '[Content_Types].xml': fflate.strToU8(contentTypesXml),
    '_rels/.rels': fflate.strToU8(relsXml),
    '3D/3dmodel.model': fflate.strToU8(modelXml),
  });

  const blob = new Blob([zipData], { type: 'model/3mf' });
  const url = URL.createObjectURL(blob);

  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();

  setTimeout(() => {
    URL.revokeObjectURL(url);
    document.body.removeChild(a);
  }, 100);
}
