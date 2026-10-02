import './style.css';
import Phaser from 'phaser';
import { GameScene } from './game/GameScene.js';

const config = {
  type: Phaser.AUTO,
  width: 640,
  height: 480,
  parent: 'game-container',
  physics: {
    default: 'arcade',
    arcade: { gravity: { y: 1200 }, debug: false }
  },
  scene: [GameScene]
};

window.game = new Phaser.Game(config);
