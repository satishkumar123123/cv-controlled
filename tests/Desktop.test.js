import { createRequire } from 'node:module';
import { resolve, sep } from 'node:path';
import { describe, it, expect } from 'vitest';
const require = createRequire(import.meta.url);
const { APP_URL, isAppUrl, assetPath, isCameraRequest } = require('../desktop/policy.cjs');

describe('desktop origin and camera boundary', () => {
  it('serves only the app origin and files within the built application', () => {
    const root = resolve('/tmp/runner-dist');
    expect(assetPath(APP_URL, root)).toBe(root + sep + 'index.html');
    expect(assetPath('app://runner/pose/model.wasm', root)).toBe(resolve(root, 'pose/model.wasm'));
    for (const url of ['https://runner/index.html', 'app://evil/pose/x', 'app://runner/%2e%2e%2fsecret',
      'app://runner/..%5csecret', 'app://runner/%00', 'app://runner/%zz', 'file:///etc/passwd', 'app://user@runner/index.html']) {
      expect(assetPath(url, root)).toBeNull();
    }
  });
  it('restricts permissions to explicit video requests from the app', () => {
    expect(isCameraRequest(APP_URL, 'media', ['video'])).toBe(true);
    expect(isAppUrl('app://runner:123/')).toBe(false);
    for (const [url, permission, types] of [[APP_URL, 'media', ['audio']], [APP_URL, 'media', ['audio', 'video']],
      [APP_URL, 'media', []], [APP_URL, 'geolocation', ['video']], [APP_URL, 'media', undefined], ['https://runner', 'media', ['video']]]) {
      expect(isCameraRequest(url, permission, types)).toBe(false);
    }
  });
});
