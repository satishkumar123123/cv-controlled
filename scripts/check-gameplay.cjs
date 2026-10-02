const { resolve, join } = require('node:path');
const { tmpdir } = require('node:os');
const { mkdtempSync, mkdirSync } = require('node:fs');
// Optional tooling: npm install --no-save --package-lock=false playwright
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const ROOT = resolve(__dirname, '..');
const OUTPUT = process.env.RUNNER_SCREENSHOT_DIR || mkdtempSync(join(tmpdir(), 'cv-runner-check-'));
mkdirSync(OUTPUT, { recursive: true });

(async () => {
  const { createServer } = await import('vite');
  const server = await createServer({ root: ROOT, server: { host: '127.0.0.1', port: 3099, strictPort: true, open: false } });
  let browser;
  try {
    await server.listen();
    browser = await chromium.launch({
      executablePath: process.env.RUNNER_CHROMIUM_EXECUTABLE || undefined, headless: true,
      args: ['--no-sandbox', '--no-zygote', '--disable-dev-shm-usage', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
      env: { ...process.env }
    });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto('http://127.0.0.1:3099');
    await page.waitForFunction(() => window.game?.scene.getScene('GameScene')?.overlay);
    const results = await page.evaluate(() => {
      window.game.loop.sleep();
      const s = window.game.scene.getScene('GameScene');
      const checks = [];
      const check = (condition, name, detail) => {
        if (!condition) throw Error(name + ': ' + JSON.stringify(detail));
        checks.push(name);
      };
      let clock = 0;
      const step = (frames = 1, inspect = () => {}) => {
        for (let i = 0; i < frames; i++) {
          const dt = 1000 / 60;
          clock += dt;
          s.physics.world.update(clock, dt);
          s.update(clock, dt);
          s.physics.world.postUpdate();
          inspect();
        }
      };
      const fresh = (shield = false) => {
        s.restartGame();
        s.setControllerStatus(true, true);
        s._distanceUntilSpawn = Infinity;
        s.invulnerableUntil = shield ? 1500 : 0;
        step(2);
      };
      const place = (kind, x = 110) => {
        const o = s.spawnObstacle(kind);
        o.body.reset(x, o.y);
        return o;
      };

      step(180);
      check(s.runState === 'WAITING' && s.score === 0 && s.obstacles.countActive() === 0, 'waits for neutral calibration');
      check(s.player.body.width === 30 && s.player.body.height === 60 && s.player.body.bottom === 440, 'standing hitbox on ground');

      fresh(); place('LOW'); step(2);
      check(s.runState === 'GAME_OVER', 'low obstacle hits standing player');
      const frozen = { score: s.score, distance: s.distance, y: s.player.y, x: s.obstacles.getFirstAlive().x };
      step(300);
      check(s.score === frozen.score && s.distance === frozen.distance && s.player.y === frozen.y && s.obstacles.getFirstAlive().x === frozen.x, 'game over freezes score, ground and bodies');

      fresh(); place('HIGH'); step(2);
      check(s.runState === 'GAME_OVER', 'high barrier hits standing player');

      for (const contactTime of [0.2, 0.42, 0.65]) {
        fresh(); s.score = 1000; s.distance = 10000; s.speed = 360;
        const ceiling = s.spawnObstacle('HIGH');
        check(ceiling.body.top === 0 && ceiling.body.bottom === 402, 'high barrier spans ceiling to 38 px clearance');
        ceiling.body.reset(s.player.body.right + ceiling.width / 2 + 360 * contactTime, ceiling.y);
        check(s.jump(), 'max-speed jump accepted before high barrier');
        step(90);
        check(s.runState === 'GAME_OVER', 'high barrier collides with max-speed jump', { contactTime, width: ceiling.width });
      }

      fresh(); check(s.duck(true), 'duck accepts grounded gesture'); const high = place('HIGH');
      check(s.player.body.height === 28 && s.player.body.top >= high.body.bottom + 7, 'duck has clearance below high barrier');
      let worstFeetError = 0;
      step(90, () => { worstFeetError = Math.max(worstFeetError, Math.abs(s.player.body.bottom - 440)); });
      check(s.runState === 'RUNNING' && worstFeetError < 0.01, 'duck safely passes barrier without floor jitter', { worstFeetError });
      check(!high.active && !high.body.enable, 'offscreen obstacles recycled');
      s.duck(false); step();
      check(s.player.body.height > 28 && s.player.body.height < 60, 'standing restore interpolates');
      step(6);
      check(s.player.body.height === 60 && Math.abs(s.player.body.bottom - 440) < 0.01, 'standing restore preserves grounded feet');

      fresh(); s.duck(true); place('LOW'); step(2);
      check(s.runState === 'GAME_OVER', 'duck cannot bypass low hurdle');

      fresh(); place('LOW', 110 + s.speed * 0.38);
      check(s.jump() && !s.jump(), 'one jump impulse, no double jump');
      let peakFeet = 440;
      step(15, () => { peakFeet = Math.min(peakFeet, s.player.body.bottom); });
      check(s.player.fillColor === 0x38bdf8 && s.player.body.height === 60, 'blue standing-size hitbox in air');
      check(!s.duck(true), 'cannot duck in flight');
      step(70, () => { peakFeet = Math.min(peakFeet, s.player.body.bottom); });
      check(s.runState === 'RUNNING' && s._isGrounded(), 'jump clears low hurdle and lands');
      check(440 - peakFeet > 115 && 440 - peakFeet < 135, 'jump trajectory matches -600 / 1400 physics', { peakRise: 440 - peakFeet });
      check(s.desiredDuckState && s.isDucking && s.player.body.height === 28 && s.player.body.bottom === 440,
        'held airborne duck is reconciled on landing without another DUCK_START');

      // The ground collider must apply a held duck before a barrier overlap in
      // the SAME physics step. A scene.update-only fix is one frame too late.
      fresh();
      s.player.body.reset(110, 408); // Feet 2 px above ground, descending.
      s.player.body.setVelocityY(300);
      s._jumpActive = true;
      check(!s.duck(true), 'landing-frame duck intent waits for contact');
      place('HIGH');
      step();
      check(s.runState === 'RUNNING' && s.isDucking && s.player.body.height === 28,
        'landing reconciliation precedes same-step barrier overlap');

      fresh(true);
      for (let i = 0; i < 80; i++) {
        let obstacle = s.obstacles.getFirstAlive() || place('LOW');
        obstacle.body.reset(110, 440 - obstacle.height / 2);
        step();
      }
      check(s.runState === 'RUNNING' && s.runTimeMs < 1500, 'restart invulnerability ignores early hits');
      for (let i = 0; i < 20 && s.runState === 'RUNNING'; i++) {
        const obstacle = s.obstacles.getFirstAlive() || place('LOW');
        obstacle.body.reset(110, 440 - obstacle.height / 2);
        step();
      }
      check(s.runState === 'GAME_OVER' && s.runTimeMs >= 1500 && s.runTimeMs < 1600, 'restart protection expires after 1.5 seconds', s.runTimeMs);

      fresh(); step(100); const before = [s.score, s.distance, s.runTimeMs];
      s.setControllerStatus(false, false); step(500);
      check(s.runState === 'PAUSED' && JSON.stringify(before) === JSON.stringify([s.score, s.distance, s.runTimeMs]), 'tracking loss freezes survival time and distance');
      s.setControllerStatus(true, false); step(30);
      check(s.runState === 'PAUSED', 'tracking recovery waits for neutral');
      s.setControllerStatus(true, true);
      check(s.runState === 'RUNNING' && Math.abs(s.invulnerableUntil - s.runTimeMs - 1500) < 0.001, 'neutral resumes with protection');

      const displayCount = s.children.list.length;
      const keyListeners = s.input.keyboard.listenerCount('keydown-SPACE');
      const restartListeners = s.game.events.listenerCount('runner:restartRequested');
      for (let i = 0; i < 40; i++) fresh();
      check(s.children.list.length === displayCount && s.obstacles.getLength() === 8 &&
        s.input.keyboard.listenerCount('keydown-SPACE') === keyListeners &&
        s.game.events.listenerCount('runner:restartRequested') === restartListeners,
        '40 restarts preserve pool, display list and listener counts');

      s.invulnerableUntil = Infinity;
      s._distanceUntilSpawn = 0;
      let spawns = 0;
      const spawn = s.spawnObstacle.bind(s);
      s.spawnObstacle = (...args) => { const o = spawn(...args); if (o) spawns++; return o; };
      step(18000);
      check(s.score > 9000 && s.speed === 360, 'five-minute survival simulation ramps score and caps speed', { score: s.score, speed: s.speed });
      check(s.obstacles.getLength() === 8 && s.children.list.length === displayCount && spawns > 80, 'long run reuses bounded obstacle pool', { spawns });
      s.spawnObstacle = spawn;
      s.gameOver();
      check(Number(localStorage.getItem('cv-runner.highScore.v1')) === s.highScore && s.highScore >= s.score, 'high score persisted at game over');
      const storedBest = localStorage.getItem('cv-runner.highScore.v1');
      localStorage.setItem('cv-runner.highScore.v1', 'broken');
      check(s._readHighScore() === 0, 'malformed storage ignored');
      localStorage.setItem('cv-runner.highScore.v1', storedBest);
      const storageDescriptor = Object.getOwnPropertyDescriptor(window, 'localStorage');
      try {
        Object.defineProperty(window, 'localStorage', { configurable: true, get() { throw new Error('Storage denied'); } });
        s.saveHighScore();
        check(s.highScore >= s.score && s._readHighScore() === 0, 'denied storage keeps in-memory high score');
      } finally { Object.defineProperty(window, 'localStorage', storageDescriptor); }
      return { checks, score: s.score, highScore: s.highScore, spawns, pool: s.obstacles.getLength() };
    });
    console.log(JSON.stringify(results, null, 2));
    // Reproduce the audited short physical jump -> valid held duck sequence
    // through the real classifier, main callbacks and Arcade physics together.
    await page.evaluate(() => {
      const scene = window.game.scene.getScene('GameScene'), tracker = window.poseTracker, classifier = window.gestureClassifier;
      const baseline = { baselineHipY: 0.45, baselineFootY: 0.87, torsoHeight: 0.25, shoulderWidth: 0.2 };
      const points = (lift = 0, duck = false) => {
        const p = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.1, z: 0, visibility: 1 }));
        for (const [left, right, y] of [[11, 12, 0.2], [23, 24, 0.45], [25, 26, 0.65], [27, 28, 0.85], [29, 30, 0.87], [31, 32, 0.87]]) {
          p[left] = { x: 0.4, y: y - lift, z: 0, visibility: 1 };
          p[right] = { x: 0.6, y: y - lift, z: 0, visibility: 1 };
        }
        if (duck) {
          for (const i of [11, 12, 23, 24]) p[i].y += 0.15;
          for (const i of [25, 26]) Object.assign(p[i], { y: 0.72, z: -0.13 });
        }
        return p;
      };
      scene.restartGame();
      scene._distanceUntilSpawn = Infinity;
      tracker.onCalibrationComplete(baseline);
      const originalDuck = scene.duck;
      let rejected = 0, time = 0;
      scene.duck = function (held) {
        const accepted = originalDuck.call(this, held);
        if (held && !accepted) rejected++;
        return accepted;
      };
      const feed = (p) => {
        tracker.onPoseUpdate(p, baseline, { timestamp: time, aspectRatio: 1 });
        scene.physics.world.update(time, 10);
        scene.update(time, 10);
        scene.physics.world.postUpdate();
      };
      try {
        for (time = 0; time <= 200; time += 10) feed(points());
        for (time = 210; time <= 420; time += 10) feed(points(Math.max(0, 0.06 * Math.sin(Math.PI * (time - 220) / 200))));
        let rearmed = false;
        for (time = 430; time < 1300; time += 10) {
          feed(points());
          if (classifier.metrics.armed) { rearmed = true; break; }
        }
        if (!rearmed) throw Error('Short jump did not rearm');
        for (time += 10; time <= 1800; time += 10) feed(points(0, true));
        if (rejected !== 1 || classifier.state !== 'DUCKING' || !scene.desiredDuckState ||
            !scene.isDucking || scene.player.body.height !== 28 || !scene._isGrounded()) {
          throw Error('Held physical duck was not reconciled after the rejected edge: ' + JSON.stringify({
            rejected, state: classifier.state, height: scene.player.body.height, desired: scene.desiredDuckState
          }));
        }
        scene.gameOver();
      } finally { scene.duck = originalDuck; }
    });
    console.log('PASS: real classifier/main/Phaser reconcile a rejected held duck after a short physical jump');
    await page.evaluate(() => window.game.loop.wake());
    await page.screenshot({ path: OUTPUT + '/runner-gameover.png' });
    await page.keyboard.press('Space');
    await page.waitForFunction(() => window.game.scene.getScene('GameScene').runState === 'WAITING');
    assert.equal(await page.evaluate(() => window.game.scene.getScene('GameScene').score), 0);
    console.log('PASS: real keyboard Space restarts game');
    await page.reload();
    await page.waitForFunction(() => window.game?.scene.getScene('GameScene')?.overlay);
    assert.ok(await page.evaluate(() => window.game.scene.getScene('GameScene').highScore) >= results.highScore);
    console.log('PASS: high score survives page reload');
    await page.evaluate(() => {
      const s = window.game.scene.getScene('GameScene');
      s.setControllerStatus(true, true); s.gameOver();
    });
    const bounds = await page.locator('#game-container canvas').boundingBox();
    await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height * 277 / 480);
    await page.waitForFunction(() => window.game.scene.getScene('GameScene').runState === 'WAITING');
    console.log('PASS: canvas restart button responds');
    await page.evaluate(() => window.game.scene.getScene('GameScene').setControllerStatus(true, true));
    await page.getByRole('button', { name: 'Restart run', exact: true }).click();
    await page.waitForFunction(() => window.game.scene.getScene('GameScene').runState === 'WAITING');
    console.log('PASS: DOM restart button responds');
    await page.evaluate(() => {
      const s = window.game.scene.getScene('GameScene');
      s.setControllerStatus(true, true);
      s.invulnerableUntil = 0;
      const low = s.spawnObstacle('LOW'); low.body.reset(420, low.y);
      const high = s.spawnObstacle('HIGH'); high.body.reset(590, high.y);
    });
    await page.screenshot({ path: OUTPUT + '/runner-playing.png' });
    await page.evaluate(() => {
      const s = window.game.scene.getScene('GameScene');
      window.oldPlayerForCheck = s.player;
      s.scene.restart();
    });
    await page.waitForFunction(() => {
      const s = window.game.scene.getScene('GameScene');
      return s.player !== window.oldPlayerForCheck && s.obstacles.getLength() === 8;
    });
    assert.equal(await page.evaluate(() => window.game.scene.getScene('GameScene').input.keyboard.listenerCount('keydown-SPACE')), 1);
    console.log('PASS: scene shutdown/recreation cleans up listeners and bodies');
    // Exercise the new browser frame callback with an actual video source. This
    // is a generated canvas stream, NOT a webcam/model performance benchmark.
    await page.evaluate(async () => {
      const source = document.createElement('canvas');
      source.width = source.height = 32;
      const context = source.getContext('2d');
      const video = document.querySelector('#webcam');
      const stream = source.captureStream(30);
      video.srcObject = stream;
      let draw = 0;
      const timer = setInterval(() => { context.fillStyle = draw++ % 2 ? 'red' : 'blue'; context.fillRect(0, 0, 32, 32); }, 30);
      let callback, timeout;
      try {
        await new Promise((resolve, reject) => {
          timeout = setTimeout(() => reject(Error('No video-frame callback on hidden video')), 3000);
          callback = video.requestVideoFrameCallback(resolve);
          video.play().catch(reject);
        });
      } finally {
        clearInterval(timer); clearTimeout(timeout);
        video.cancelVideoFrameCallback(callback);
        stream.getTracks().forEach((track) => track.stop());
        video.srcObject = null;
      }
    });
    console.log('PASS: native video-frame callback works with the hidden webcam element');
    await page.evaluate(async () => {
      const tracker = window.poseTracker, monitor = window.performanceMonitor;
      const s = window.game.scene.getScene('GameScene');
      const baseline = { baselineHipY: 0.45, baselineFootY: 0.87, torsoHeight: 0.25, shoulderWidth: 0.2 };
      const points = (lift) => {
        const p = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.1, z: 0, visibility: 1 }));
        for (const [left, right, y] of [[11, 12, 0.2], [23, 24, 0.45], [25, 26, 0.65], [27, 28, 0.85], [29, 30, 0.87], [31, 32, 0.87]]) {
          p[left] = { x: 0.4, y: y - lift, z: 0, visibility: 1 };
          p[right] = { x: 0.6, y: y - lift, z: 0, visibility: 1 };
        }
        return p;
      };
      s.restartGame();
      tracker.onCalibrationComplete(baseline);
      tracker.onStreamStateChange({ active: true, settings: { width: 640, height: 480 } });
      monitor.reset();
      let frameId = 0;
      async function feed(lift) {
        const capturedAt = performance.now();
        const frame = { frameId: ++frameId, capturedAt, timestamp: capturedAt, captureSource: 'frame-acquisition',
          inferenceStartedAt: capturedAt, inferenceEndedAt: performance.now(), aspectRatio: 1 };
        tracker.onFrameMetrics(frame);
        tracker.onPoseUpdate(points(lift), baseline, frame);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      for (let i = 0; i < 15; i++) await feed(0);
      for (let i = 0; i < 10; i++) await feed(i * 0.008);
      if (monitor.getSummary().actions.JUMP !== 1 || s.player.body.velocity.y >= 0) throw Error('Camera frame was not paired with an accepted real Phaser jump');
      await new Promise((resolve) => setTimeout(resolve, 300));
      if (!document.querySelector('#action-latency').textContent.includes('JUMP')) throw Error('Missing live action latency');
    });
    await page.getByRole('button', { name: 'Log performance summary', exact: true }).click();
    await page.screenshot({ path: OUTPUT + '/runner-performance.png', fullPage: true });
    await page.getByRole('button', { name: 'Reset sample', exact: true }).click();
    assert.equal(await page.evaluate(() => window.performanceMonitor.getSummary().processedFrames), 0);
    await page.evaluate(() => window.poseTracker.onStreamStateChange({ active: false }));
    assert.equal(await page.locator('#camera-fps').textContent(), '0.0');
    console.log('PASS: synthetic frame timestamps reach real Phaser, performance HUD and summary/reset controls');
    assert.deepEqual(errors, []);
    console.log('PASS: no browser JavaScript errors; Chromium ' + await browser.version());
  } finally {
    await browser?.close();
    await server.close();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
