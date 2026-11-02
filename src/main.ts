import './game/game.css';
import { Game } from './game/game';

const canvas = document.getElementById('game-canvas');
if (!(canvas instanceof HTMLCanvasElement)) {
  throw new Error('#game-canvas element not found');
}
const hudContainer = document.getElementById('hud-root');
if (!(hudContainer instanceof HTMLDivElement)) {
  throw new Error('#hud-root element not found');
}

let game: Game | null = new Game(canvas, hudContainer);

// Release everything on page teardown (SPAs / dev reloads).
window.addEventListener('beforeunload', () => {
  game?.dispose();
  game = null;
});
