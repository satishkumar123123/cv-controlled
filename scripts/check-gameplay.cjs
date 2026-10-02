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
    assert.deepEqual(errors, []);
    console.log('PASS: no browser JavaScript errors; Chromium ' + await browser.version());
  } finally {
    await browser?.close();
    await server.close();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
