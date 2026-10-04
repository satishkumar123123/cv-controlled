const { resolve, sep } = require('node:path');

const APP_URL = 'app://runner/index.html';
function isAppUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'app:' && url.hostname === 'runner' && !url.port && !url.username && !url.password;
  } catch { return false; }
}

function assetPath(value, root) {
  if (!isAppUrl(value)) return null;
  try {
    const path = decodeURIComponent(new URL(value).pathname).replace(/\\/g, '/');
    if (path.includes('\0') || path.split('/').includes('..')) return null;
    const base = resolve(root);
    const target = resolve(base, `.${path === '/' ? '/index.html' : path}`);
    return target.startsWith(base + sep) ? target : null;
  } catch { return null; }
}

function isCameraRequest(url, permission, mediaTypes) {
  return isAppUrl(url) && permission === 'media' && Array.isArray(mediaTypes) &&
    mediaTypes.length > 0 && mediaTypes.every((type) => type === 'video');
}

module.exports = { APP_URL, isAppUrl, assetPath, isCameraRequest };
