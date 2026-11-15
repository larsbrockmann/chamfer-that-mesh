import Module from 'manifold-3d';

let manifoldPromise = null;

export async function getManifold() {
  if (!manifoldPromise) {
    manifoldPromise = (async () => {
      const mod = await Module({
        locateFile: (path) => {
          if (path.endsWith('.wasm')) {
            if (typeof window === 'undefined') {
              const url = new URL('../public/manifold.wasm', import.meta.url);
              return url.pathname.replace(/^\/([A-Za-z]:)/, '$1');
            }
            try {
              return new URL('manifold.wasm', window.location.href).href;
            } catch (_) {
              return './manifold.wasm';
            }
          }
          return path;
        },
      });
      mod.setup();
      return mod;
    })();
  }
  return manifoldPromise;
}
