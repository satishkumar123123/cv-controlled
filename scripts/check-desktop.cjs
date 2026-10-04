// Optional: npm install --no-save --package-lock=false playwright
// Linux CI: xvfb-run -a npm run test:desktop (build first).
const { _electron: electron } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const { resolve } = require('node:path');
const ROOT = resolve(__dirname, '..');

(async () => {
  let application, page;
  try {
    const args = process.env.RUNNER_PACKAGED_EXECUTABLE ? [] : [ROOT];
    args.push('--use-fake-device-for-media-stream', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage');
    // Root-only container test constraint. Production commands keep the sandbox.
    if (process.getuid?.() === 0) args.push('--no-sandbox');
    application = await electron.launch({ executablePath: process.env.RUNNER_PACKAGED_EXECUTABLE || require('electron'), args, timeout: 60000 });
    page = await application.firstWindow();
    // camera_utils also displays an alert on acquisition failure. Electron may
    // already close it when its native dialog resolves; handle that test race.
    page.on('dialog', (dialog) => { void dialog.dismiss().catch(() => {}); });
    if (process.env.RUNNER_DESKTOP_DEBUG === '1') {
      page.on('console', (message) => console.log('Renderer:', message.type(), message.text()));
      page.on('requestfailed', (request) => console.log('Request failed:', request.url(), request.failure()));
    }
    const errors = [], externalRequests = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('request', (request) => { if (/^https?:/.test(request.url())) externalRequests.push(request.url()); });
    await page.waitForFunction(() => window.game?.scene.getScene('GameScene')?.player && window.poseTracker);
    assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
    assert.equal(await page.evaluate(() => window.isSecureContext), true);
    assert.equal(await page.evaluate(() => document.querySelectorAll('#game-container canvas').length), 1);
    await page.evaluate(() => localStorage.setItem('cv-runner.desktop-smoke', 'persistent'));
    await page.reload();
    assert.equal(await page.evaluate(() => localStorage.getItem('cv-runner.desktop-smoke')), 'persistent');
    await page.evaluate(() => localStorage.removeItem('cv-runner.desktop-smoke'));

    // Deny via the actual app permission handler; then allow a fake camera on retry.
    await application.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }); });
    await page.getByRole('button', { name: 'Start camera', exact: true }).click();
    await page.waitForFunction(() => /denied/i.test(document.querySelector('#state-val').textContent), null, { timeout: 60000 });
    assert.equal(await page.getByRole('button', { name: 'Start camera', exact: true }).isEnabled(), true);
    await application.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 0 }); });
    await page.getByRole('button', { name: 'Start camera', exact: true }).click();
    await page.waitForFunction(() => window.performanceMonitor.getSummary().processedFrames >= 2, null, { timeout: 60000 });
    assert.equal(await page.evaluate(() => window.poseTracker.assetBaseUrl), '/pose');
    await page.getByRole('button', { name: 'Stop camera', exact: true }).click();
    await page.waitForFunction(() => !window.poseTracker.isRunning && !document.querySelector('#webcam').srcObject);
    assert.equal(await page.evaluate(() => window.performanceMonitor.active), false);
    assert.deepEqual(externalRequests, []);
    assert.deepEqual(errors, []);
    console.log('PASS: Electron secure origin, isolated renderer, persistent storage, local model/WASM, denied-camera retry, generated-camera inference, stop cleanup and zero external requests.');
  } catch (error) {
    if (page && !page.isClosed()) console.error('Desktop status:', await page.locator('#state-val').textContent({ timeout: 3000 }).catch(() => 'page unavailable'));
    throw error;
  } finally { await application?.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
