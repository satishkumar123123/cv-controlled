import { mkdir, readdir, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = resolve(root, 'node_modules/@mediapipe/pose');
const target = resolve(root, 'public/pose');
await mkdir(target, { recursive: true });
const files = (await readdir(source)).filter((name) => /\.(js|wasm|data|binarypb)$/.test(name) ||
  ['pose_landmark_lite.tflite', 'README.md', 'package.json'].includes(name));
if (!files.includes('pose_landmark_lite.tflite')) throw new Error('Pose model is missing. Run npm ci first.');
await Promise.all(files.map((file) => copyFile(resolve(source, file), resolve(target, file))));
await copyFile(resolve(root, 'node_modules/@mediapipe/camera_utils/camera_utils.js'), resolve(target, 'camera_utils.js'));
console.log(`Prepared ${files.length + 1} pinned MediaPipe Lite/runtime files for local/offline use.`);
