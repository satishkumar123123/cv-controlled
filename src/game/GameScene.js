import Phaser from 'phaser';

export class GameScene extends Phaser.Scene {
  constructor() {
    super('GameScene');
  }

  create() {
    this.add.text(20, 20, 'CV Endless Runner - Ready', { fill: '#38bdf8' });
    this.ground = this.add.rectangle(320, 460, 640, 40, 0x475569);
    this.physics.add.existing(this.ground, true);

    this.player = this.add.rectangle(100, 400, 30, 60, 0x22c55e);
    this.physics.add.existing(this.player);
    this.physics.add.collider(this.player, this.ground);
  }

  jump() {
    if (this.player.body.touching.down) {
      this.player.body.setVelocityY(-550);
    }
  }

  duck(isDucking) {
    if (isDucking) {
      this.player.setSize(30, 30);
      this.player.setDisplaySize(30, 30);
      this.player.fillColor = 0xeab308;
    } else {
      this.player.setSize(30, 60);
      this.player.setDisplaySize(30, 60);
      this.player.fillColor = 0x22c55e;
    }
  }
}
