/** Simple DOM overlay showing the game name, controls, and a lock hint. */
export class Hud {
  private root: HTMLDivElement;
  private hint: HTMLDivElement;

  constructor(container: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'hud';

    const title = document.createElement('div');
    title.className = 'hud-title';
    title.textContent = 'AI SURVIVAL WORLD';

    const controls = document.createElement('div');
    controls.className = 'hud-controls';
    controls.innerHTML = [
      '<span><b>WASD</b> / Arrows — move</span>',
      '<span><b>Mouse</b> — look around</span>',
      '<span><b>Shift</b> — sprint</span>',
      '<span><b>Esc</b> — release mouse</span>',
    ].join('');

    this.hint = document.createElement('div');
    this.hint.className = 'hud-hint';
    this.hint.textContent = 'Click the scene to capture the mouse';

    this.root.append(title, controls, this.hint);
    container.appendChild(this.root);
  }

  setPointerLocked(locked: boolean): void {
    this.hint.style.display = locked ? 'none' : 'block';
  }

  dispose(): void {
    this.root.remove();
  }
}
