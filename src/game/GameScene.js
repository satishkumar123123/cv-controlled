import Phaser from 'phaser';

export const RUNNER = Object.freeze({
  WIDTH: 640, HEIGHT: 480, GROUND_Y: 440, PLAYER_X: 110,
  PLAYER_WIDTH: 30, STAND_HEIGHT: 60, DUCK_HEIGHT: 28,
  GRAVITY: 1400, JUMP_VELOCITY: -600,
  BASE_SPEED: 220, MAX_SPEED: 360, SPEED_PER_POINT: 0.15,
  PIXELS_PER_POINT: 10, POOL_SIZE: 8, RESTORE_MS: 90,
  INVULNERABLE_MS: 1500, MIN_RECOVERY_SECONDS: 2.2, MAX_RECOVERY_SECONDS: 3,
  HIGH_CLEARANCE: 38, STORAGE_KEY: 'cv-runner.highScore.v1'
});
export const RunState = Object.freeze({ WAITING: 'WAITING', RUNNING: 'RUNNING', PAUSED: 'PAUSED', GAME_OVER: 'GAME_OVER' });
export const speedForScore = (score) => Math.min(RUNNER.MAX_SPEED, RUNNER.BASE_SPEED + Math.max(0, score) * RUNNER.SPEED_PER_POINT);
// Reserve player width too: this is a clearance-to-next-contact recovery gap,
// not just a center-to-center gap. It remains safe through speed ramp-up.
export const minimumObstacleGap = () => RUNNER.MAX_SPEED * RUNNER.MIN_RECOVERY_SECONDS + RUNNER.PLAYER_WIDTH;

export class GameScene extends Phaser.Scene {
  constructor() { super('GameScene'); this.desiredDuckState = false; }

  create() {
    this.cameras.main.setBackgroundColor('#0f172a');
    this.physics.world.gravity.y = RUNNER.GRAVITY;
    this.highScore = this._readHighScore();
    this._controllerValid = false;
    this._controllerNeutral = false;

    // Everything is drawn immediately with primitives; no image assets needed.
    this.add.rectangle(320, 305, 640, 2, 0x1e293b);
    this.add.rectangle(320, 365, 640, 2, 0x1e293b);
    this.ground = this.add.rectangle(320, 460, 640, 40, 0x334155);
    this.physics.add.existing(this.ground, true);
    this.add.rectangle(320, RUNNER.GROUND_Y + 2, 640, 4, 0x94a3b8);
    this.groundMarks = Array.from({ length: 12 }, (_, index) =>
      this.add.rectangle(index * 64, 462, 24, 4, 0x64748b));

    this.player = this.add.rectangle(RUNNER.PLAYER_X, RUNNER.GROUND_Y - 30, 30, 60, 0x22c55e)
      .setStrokeStyle(2, 0xe2e8f0).setDepth(3);
    this.physics.add.existing(this.player);
    this.player.body.setMaxVelocity(0, 1000);
    // Reconcile before obstacle overlaps in this physics step, not one frame
    // after landing beside a barrier. update() also handles resting contact.
    this.groundCollider = this.physics.add.collider(this.player, this.ground, this._reconcileDuckState, undefined, this);

    this.obstacles = this.physics.add.group({ allowGravity: false, immovable: true, maxSize: RUNNER.POOL_SIZE });
    // Preallocate a bounded pool. Recycle hidden bodies; never allocate per spawn.
    for (let i = 0; i < RUNNER.POOL_SIZE; i++) {
      const obstacle = this.add.rectangle(0, 0, 40, 40, 0xef4444).setDepth(2);
      this.obstacles.add(obstacle);
      this._recycle(obstacle);
    }
    this.obstacleCollider = this.physics.add.overlap(this.player, this.obstacles, this._onObstacleHit, undefined, this);
    const textStyle = { fontFamily: 'monospace', fontSize: '20px', color: '#f8fafc' };
    this.scoreText = this.add.text(20, 18, '', textStyle).setDepth(5);
    this.bestText = this.add.text(620, 18, '', textStyle).setOrigin(1, 0).setDepth(5);
    this.hintText = this.add.text(20, 57, '', { ...textStyle, fontSize: '18px' }).setDepth(5);
    this.runInfo = this.add.text(20, 86, '', { ...textStyle, fontSize: '13px', color: '#94a3b8' }).setDepth(5);

    this.overlayTitle = this.add.text(320, 158, '', { ...textStyle, fontSize: '28px' }).setOrigin(0.5);
    this.overlayMessage = this.add.text(320, 210, '', {
      ...textStyle, fontSize: '16px', align: 'center', wordWrap: { width: 440 }
    }).setOrigin(0.5);
    this.restartPrompt = this.add.text(320, 277, 'Restart  [SPACE]', {
      ...textStyle, fontSize: '18px', color: '#22c55e', backgroundColor: '#1e293b', padding: { x: 16, y: 10 }
    }).setOrigin(0.5).setInteractive({ useHandCursor: true }).on('pointerdown', () => this.restartGame());
    this.recalibratePrompt = this.add.text(320, 328, 'Recalibrate / Restart', {
      ...textStyle, fontSize: '16px', color: '#38bdf8', backgroundColor: '#1e293b', padding: { x: 14, y: 8 }
    }).setOrigin(0.5).setInteractive({ useHandCursor: true }).on('pointerdown', () => this.restartGame({ recalibrate: true }));
    this.overlay = this.add.container(0, 0, [
      this.add.rectangle(320, 238, 510, 278, 0x020617, 0.94).setStrokeStyle(1, 0x475569),
      this.overlayTitle, this.overlayMessage, this.restartPrompt, this.recalibratePrompt
    ]).setDepth(20);

    this.input.keyboard?.on('keydown-SPACE', this._onSpace, this);
    this.game.events.on(Phaser.Core.Events.BLUR, this._onBlur, this);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, this._shutdown, this);
    this._resetRun();
    // Metrics may have arrived before Phaser finished booting.
    const metrics = this.registry.get('gestureMetrics');
    if (metrics) this.setControllerStatus(metrics.valid, metrics.state === 'NEUTRAL' && metrics.armed);
  }

  _resetRun() {
    this.runState = RunState.WAITING;
    this.physics.pause();
    this.score = 0;
    this.distance = 0;
    this.speed = RUNNER.BASE_SPEED;
    this.runTimeMs = 0;
    this.invulnerableUntil = RUNNER.INVULNERABLE_MS;
    this._distanceUntilSpawn = RUNNER.BASE_SPEED * 1.5;
    this._lastDrawnScore = -1;
    this.isDucking = false;
    this.desiredDuckState = false;
    this._restoring = false;
    this._jumpActive = false;
    for (const obstacle of this.obstacles.getChildren()) this._recycle(obstacle);
    this.player.setSize(30, 60).setDisplaySize(30, 60).setAlpha(1).setFillStyle(0x22c55e);
    this.player.body.setSize(30, 60);
    this.player.body.reset(RUNNER.PLAYER_X, RUNNER.GROUND_Y - 30);
    this._scrollGround();
    this._updateHUD();
    this._showOverlay('READY TO RUN', 'Start camera, calibrate, then stand still.\nRed hurdles: JUMP • Purple barriers: DUCK', false);
    this.game.events.emit('runner:state', this.runState);
  }

  /** Called by the CV integration. Lost tracking freezes gameplay and scoring. */
  setControllerStatus(valid, neutral = false, reason = '') {
    this._controllerValid = Boolean(valid);
    this._controllerNeutral = Boolean(valid && neutral);
    if (!valid) this.duck(false); // Clear a pending airborne duck on tracking loss.
    if (!this.player || this.runState === RunState.GAME_OVER) return;
    if (!valid && this.runState === RunState.RUNNING) {
      this.runState = RunState.PAUSED;
      this.physics.pause();
      this._showOverlay('TRACKING PAUSED', reason || 'Show your full body and stand still to resume.', false);
      this.game.events.emit('runner:state', this.runState);
    }
    if ((this.runState === RunState.WAITING || this.runState === RunState.PAUSED) && this._controllerNeutral) {
      this.runState = RunState.RUNNING;
      this.invulnerableUntil = this.runTimeMs + RUNNER.INVULNERABLE_MS;
      this.overlay.setVisible(false);
      this.physics.resume();
      this.game.events.emit('runner:state', this.runState);
    }
  }

  jump() {
    if (this.runState !== RunState.RUNNING || !this._controllerValid || this.isDucking || this.desiredDuckState ||
        this._jumpActive || !this._isGrounded()) return false;
    this._restoring = false;
    this._resizePlayer(RUNNER.STAND_HEIGHT);
    this._jumpActive = true;
    this.player.body.setVelocityY(RUNNER.JUMP_VELOCITY);
    this.player.setFillStyle(0x38bdf8);
    return true;
  }

  duck(isDucking) {
    if (!isDucking) this.desiredDuckState = false;
    if (!this.player?.body || ![RunState.RUNNING, RunState.PAUSED].includes(this.runState)) return false;
    if (isDucking) {
      if (this.runState !== RunState.RUNNING || !this._controllerValid) return false;
      this.desiredDuckState = true;
      if (this._jumpActive || !this._isGrounded()) return false;
      this.isDucking = true;
      this._restoring = false;
      this._resizePlayer(RUNNER.DUCK_HEIGHT);
      this.player.setFillStyle(0xeab308);
    } else if (this.isDucking) {
      this.isDucking = false;
      this._restoring = true; // Grow body and visual together over 90 ms.
    }
    return true;
  }

  _reconcileDuckState() {
    if (!this._isGrounded()) return;
    this._jumpActive = false;
    if (this.desiredDuckState && !this.isDucking) this.duck(true);
    else if (!this.desiredDuckState && this.isDucking) this.duck(false);
  }

  _resizePlayer(height) {
    const feetY = this.player.body.bottom;
    const { x: vx, y: vy } = this.player.body.velocity;
    this.player.setSize(30, height).setDisplaySize(30, height);
    this.player.body.setSize(30, height);
    // reset synchronizes current/previous body positions; restore the velocity
    // it clears so interpolation never produces a jump or a floor penetration.
    this.player.body.reset(RUNNER.PLAYER_X, feetY - height / 2);
    this.player.body.setVelocity(vx, vy);
  }

  _isGrounded() {
    const body = this.player.body;
    return body.velocity.y >= -1 && (body.blocked.down || body.touching.down ||
      (Math.abs(body.bottom - RUNNER.GROUND_Y) <= 2 && Math.abs(body.velocity.y) < 50));
  }

  /** Public for scripted levels/tests; normal play chooses either kind randomly. */
  spawnObstacle(kind = Phaser.Math.Between(0, 1) ? 'HIGH' : 'LOW') {
    if (this.runState !== RunState.RUNNING || !['HIGH', 'LOW'].includes(kind)) return null;
    const obstacle = this.obstacles.getFirstDead(false);
    if (!obstacle) return null;
    const high = kind === 'HIGH';
    const width = high ? Phaser.Math.Between(92, 108) : Phaser.Math.Between(34, 44);
    const bottom = high ? RUNNER.GROUND_Y - RUNNER.HIGH_CLEARANCE : RUNNER.GROUND_Y;
    // A ceiling-to-clearance barrier has no route above it, at any scroll speed.
    const height = high ? bottom : Phaser.Math.Between(35, 45);
    obstacle.kind = kind;
    obstacle.setSize(width, height).setDisplaySize(width, height)
      .setFillStyle(high ? 0xa78bfa : 0xef4444).setStrokeStyle(2, high ? 0x67e8f9 : 0xfecaca)
      .setActive(true).setVisible(true);
    obstacle.body.enable = true;
    obstacle.body.setSize(width, height);
    obstacle.body.reset(RUNNER.WIDTH + width / 2 + 12, bottom - height / 2);
    obstacle.body.setVelocityX(-this.speed);
    return obstacle;
  }

  _recycle(obstacle) {
    obstacle.body.setVelocity(0, 0);
    obstacle.body.enable = false;
    obstacle.setActive(false).setVisible(false);
  }

  update(_time, delta) {
    if (this.runState !== RunState.RUNNING) return;
    // Large render stalls must not skip recovery intervals or award idle score.
    const elapsed = Math.min(Math.max(delta, 0), 50);
    this.runTimeMs += elapsed;
    this.speed = speedForScore(this.score);
    const travel = this.speed * elapsed / 1000;
    this.distance += travel;
    this.score = Math.floor(this.distance / RUNNER.PIXELS_PER_POINT);
    this.highScore = Math.max(this.highScore, this.score);
    this._scrollGround();

    this._reconcileDuckState();
    if (this._restoring) {
      const height = Math.min(RUNNER.STAND_HEIGHT, this.player.height +
        (RUNNER.STAND_HEIGHT - RUNNER.DUCK_HEIGHT) * elapsed / RUNNER.RESTORE_MS);
      this._resizePlayer(height);
      this._restoring = height < RUNNER.STAND_HEIGHT;
    }
    const grounded = this._isGrounded();
    if (grounded) this._jumpActive = false;
    this.player.setFillStyle(!grounded ? 0x38bdf8 : this.isDucking ? 0xeab308 : 0x22c55e);
    this.player.setAlpha(this.runTimeMs < this.invulnerableUntil ? 0.55 + 0.45 * Math.abs(Math.sin(this.runTimeMs / 100)) : 1);

    for (const obstacle of this.obstacles.getChildren()) {
      if (!obstacle.active) continue;
      if (obstacle.body.right < -20) this._recycle(obstacle);
      else obstacle.body.setVelocityX(-this.speed);
    }
    this._distanceUntilSpawn -= travel;
    if (this._distanceUntilSpawn <= 0) {
      const obstacle = this.spawnObstacle();
      // Do not catch up missed spawns after a stall; reserve a new full gap.
      this._distanceUntilSpawn = (obstacle?.width ?? 44) + minimumObstacleGap() +
        Phaser.Math.FloatBetween(0, RUNNER.MAX_SPEED * (RUNNER.MAX_RECOVERY_SECONDS - RUNNER.MIN_RECOVERY_SECONDS));
    }
    this._updateHUD();
  }

  _scrollGround() {
    const offset = this.distance % 64;
    this.groundMarks.forEach((mark, index) => { mark.x = index * 64 - offset; });
  }

  _updateHUD() {
    if (this.score !== this._lastDrawnScore) {
      this.scoreText.setText(`SCORE ${String(this.score).padStart(5, '0')}`);
      this.bestText.setText(`BEST ${String(this.highScore).padStart(5, '0')}`);
      this._lastDrawnScore = this.score;
    }
    const next = this.obstacles.getChildren().filter((o) => o.active && o.body.right >= this.player.body.left)
      .reduce((closest, o) => !closest || o.x < closest.x ? o : closest, null);
    const hint = next ? next.kind === 'LOW' ? 'NEXT: JUMP  ▲' : 'NEXT: DUCK  ▼' : 'STAND READY';
    if (this.hintText.text !== hint) this.hintText.setText(hint).setColor(next?.kind === 'LOW' ? '#fca5a5' : '#a5f3fc');
    const info = this.runTimeMs < this.invulnerableUntil ? 'Restart protection • get ready' : `Speed ${Math.round(this.speed)} px/s • move to control`;
    if (this.runInfo.text !== info) this.runInfo.setText(info);
  }

  _onObstacleHit() {
    if (this.runState === RunState.RUNNING && this.runTimeMs >= this.invulnerableUntil) this.gameOver();
  }

  gameOver() {
    if (this.runState !== RunState.RUNNING) return;
    this.runState = RunState.GAME_OVER;
    this.desiredDuckState = false;
    this.physics.pause(); // Stops collisions, falling and every pooled obstacle.
    this.player.setAlpha(1);
    this.saveHighScore();
    this._showOverlay('GAME OVER', `Score ${this.score}  •  Best ${this.highScore}\nRestart, or recalibrate if your position changed.`, true);
    this.game.events.emit('runner:gameover', { score: this.score, highScore: this.highScore });
    this.game.events.emit('runner:state', this.runState);
  }

  /** Reuse the scene/pool/listeners. The controller must return to neutral. */
  restartGame({ recalibrate = false } = {}) {
    if (!this.player) return;
    this.saveHighScore();
    this._controllerValid = false;
    this._controllerNeutral = false;
    this._resetRun();
    this._showOverlay('READY TO RUN', recalibrate ? 'Complete calibration, then stand still.' : 'Return to your calibrated standing position.\nKeep the camera running to start.', false);
    this.game.events.emit('runner:restartRequested', { recalibrate });
  }

  _showOverlay(title, message, showButtons) {
    this.overlayTitle.setText(title);
    this.overlayMessage.setText(message);
    this.restartPrompt.setVisible(showButtons);
    this.recalibratePrompt.setVisible(showButtons);
    this.overlay.setVisible(true);
  }

  _onSpace(event) {
    if (event.repeat || /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(event.target?.tagName) || event.target?.isContentEditable) return;
    if (this.runState === RunState.GAME_OVER) {
      event.preventDefault();
      this.restartGame();
    }
  }

  _onBlur() { this.setControllerStatus(false, false, 'Return to this tab and stand still to resume.'); }

  _readHighScore() {
    try {
      const value = Number(globalThis.localStorage?.getItem(RUNNER.STORAGE_KEY));
      return Number.isSafeInteger(value) && value >= 0 ? value : 0;
    } catch { return 0; }
  }

  saveHighScore() {
    this.highScore = Math.max(this.highScore ?? 0, this.score ?? 0, this._readHighScore());
    try { globalThis.localStorage?.setItem(RUNNER.STORAGE_KEY, String(this.highScore)); }
    catch { /* Storage can be denied; the in-memory best still works. */ }
  }

  _shutdown() {
    this.saveHighScore();
    this.input.keyboard?.off('keydown-SPACE', this._onSpace, this);
    this.game.events.off(Phaser.Core.Events.BLUR, this._onBlur, this);
    if (this.groundCollider?.world) this.groundCollider.destroy();
    if (this.obstacleCollider?.world) this.obstacleCollider.destroy();
    // Phaser owns/destroys the scene's display objects and physics bodies.
  }
}
