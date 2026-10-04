/**
 * These pinned MediaPipe packages publish classic browser globals, not real
 * named ESM exports. index.html loads their local scripts before the app module;
 * importing named exports can appear to work in Vite dev but fail after build.
 */
export function getPoseRuntime() {
  const { Pose, Camera } = globalThis;
  if (typeof Pose !== 'function' || typeof Camera !== 'function') {
    throw new Error('Pose runtime scripts are unavailable. Run npm ci and rebuild, then retry.');
  }
  return { Pose, Camera };
}
