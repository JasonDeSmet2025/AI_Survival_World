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
// Debug/QA hook: lets browser-level tests (and the owner's devtools) reach
// the live instance. Harmless in production; no secrets involved.
(window as unknown as Record<string, unknown>).__game = game;

// Release everything on page teardown (SPAs / dev reloads).
window.addEventListener('beforeunload', () => {
  game?.dispose();
  game = null;
});
