// Production integration: actual installed MediaPipe model, generated canvas
// stream in place of getUserMedia. The separate desktop check uses a fake device
// through native getUserMedia and the real application permission handler.
// Optional tooling: npm install --no-save --package-lock=false playwright
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { resolve } = require('node:path');
const assert = require('node:assert/strict');

(async () => {
  const { preview } = await import('vite');
  const server = await preview({ root: resolve(__dirname, '..'), preview: {
    host: '127.0.0.1', port: 3101, strictPort: true, open: false
  } });
  let browser, page;
  try {
    browser = await chromium.launch({ executablePath: process.env.RUNNER_CHROMIUM_EXECUTABLE || undefined,
      headless: true, args: ['--no-sandbox', '--no-zygote', '--disable-dev-shm-usage',
        '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--use-fake-device-for-media-stream'] });
    const context = await browser.newContext({ permissions: ['camera'] });
    await context.addInitScript(() => {
      navigator.mediaDevices.getUserMedia = async () => {
        const canvas = document.createElement('canvas');
        canvas.width = 640; canvas.height = 480;
        const drawing = canvas.getContext('2d');
        let position = 0;
        const draw = () => {
          drawing.fillStyle = '#334155'; drawing.fillRect(0, 0, 640, 480);
          drawing.fillStyle = '#facc15'; drawing.fillRect(position++ % 600, 200, 40, 80);
        };
        draw();
        const stream = canvas.captureStream(30), timer = setInterval(draw, 33);
        for (const track of stream.getTracks()) {
          const stop = track.stop.bind(track);
          track.stop = () => { clearInterval(timer); stop(); };
        }
        return stream;
      };
    });
    page = await context.newPage();
    if (process.env.RUNNER_MODEL_DEBUG === '1') page.on('console', (message) => console.log('Renderer:', message.type(), message.text()));
    const errors = [], failedAssets = [], external = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('response', (response) => { if (response.status() >= 400) failedAssets.push(response.url()); });
    page.on('request', (request) => { if (/^https?:/.test(request.url()) && new URL(request.url()).hostname !== '127.0.0.1') external.push(request.url()); });
    await page.goto('http://127.0.0.1:3101');
    await page.waitForFunction(() => window.poseTracker && window.game?.scene.getScene('GameScene')?.player);
    assert.deepEqual(await page.evaluate(() => [typeof window.Pose, typeof window.Camera]), ['function', 'function']);
    assert.equal(await page.locator('#game-container canvas').count(), 1);

    // Exercise production UI failure/retry without depending on a physical device.
    for (const [name, message] of [['NotAllowedError', /denied/i], ['NotFoundError', /camera/i], ['NotReadableError', /camera/i]]) {
      await page.evaluate((errorName) => {
        const media = navigator.mediaDevices;
        const original = media.getUserMedia.bind(media);
        media.getUserMedia = async () => { media.getUserMedia = original; throw new DOMException('Generated camera failure', errorName); };
      }, name);
      await page.getByRole('button', { name: 'Start camera', exact: true }).click();
      await page.getByRole('button', { name: 'Start camera', exact: true }).waitFor({ timeout: 60000 });
      assert.match(await page.locator('#state-val').textContent(), message);
    }
    for (let cycle = 0; cycle < 3; cycle++) {
      const previous = await page.evaluate(() => window.performanceMonitor.getSummary().processedFrames);
      await page.getByRole('button', { name: 'Start camera', exact: true }).click();
      await page.waitForFunction((count) => window.performanceMonitor.getSummary().processedFrames >= count + 2, previous, { timeout: 60000 });
      await page.evaluate(() => { window.smokeTracks = document.querySelector('#webcam').srcObject.getTracks(); });
      await page.getByRole('button', { name: 'Stop camera', exact: true }).click();
      await page.waitForFunction(() => !window.poseTracker.isRunning && !document.querySelector('#webcam').srcObject && window.smokeTracks.every((track) => track.readyState === 'ended'));
      assert.equal(await page.evaluate(() => window.performanceMonitor.active), false);
    }
    assert.deepEqual(failedAssets, []);
    assert.deepEqual(external, []);
    assert.deepEqual(errors, []);
    console.log('PASS: production Pose/Camera constructors, local model/WASM inference, permission/no-device/busy fallbacks, three stop/retry cycles, ended tracks and zero external requests or unhandled errors. Generated canvas stream; no human accuracy or hardware benchmark claim.');
  } catch (error) {
    if (page && !page.isClosed()) console.error('Model status:', await page.locator('#state-val').textContent().catch(() => 'unavailable'));
    throw error;
  } finally {
    await browser?.close();
    await new Promise((resolve) => server.httpServer.close(resolve));
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
