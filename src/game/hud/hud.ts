import { harvestSeconds, ITEMS, RECIPES, toolForNode, YIELDS } from '../core/items';
import { MAX_LEVEL } from '../systems/progress';
import type { StatSnapshot } from '../systems/stats';
import type { Slot } from '../systems/inventory';

/**
 * Hand-drawn inline SVG item icons (Visual Agent scope).
 * Muted, survival-appropriate palettes; 24x24 viewBox scaled to the slot.
 * Tools are real recognizable silhouettes (axe, pickaxe), not color chips.
 */
const SVG_OPEN = '<svg viewBox="0 0 24 24" width="100%" height="100%" aria-hidden="true">';
const SVG_CLOSE = '</svg>';

const ICONS: Record<string, string> = {
  wood: SVG_OPEN +
    '<rect x="2" y="7" width="17" height="6" rx="3" fill="#6b4a2a"/>' +
    '<ellipse cx="19" cy="10" rx="2" ry="3" fill="#a5794a"/>' +
    '<path d="M5 10h11M7 8.5v3M12 8.5v3" stroke="#4c3018" stroke-width="0.8"/>' +
    '<rect x="6" y="13" width="16" height="6" rx="3" fill="#5d4024"/>' +
    '<ellipse cx="21.5" cy="16" rx="2" ry="3" fill="#93683d"/>' +
    '<path d="M9 16h12" stroke="#402815" stroke-width="0.8"/>' +
    SVG_CLOSE,
  stone: SVG_OPEN +
    '<path d="M5 17 L3 11 L8 6 L15 5 L21 10 L19 17 L12 19 Z" fill="#8d8a84"/>' +
    '<path d="M8 6 L11 11 L15 5 M11 11 L5 17 M11 11 L19 17 M11 11 L12 19" stroke="#67645f" stroke-width="0.9" fill="none"/>' +
    '<path d="M15 5 L14 10 L19 10" stroke="#a8a5a0" stroke-width="0.7" fill="none"/>' +
    SVG_CLOSE,
  berry: SVG_OPEN +
    '<path d="M12 4 C14 5 15 7 14.5 9 C12.5 8 11.5 6.5 12 4 Z" fill="#4a6b34"/>' +
    '<circle cx="9" cy="14" r="3.4" fill="#8c2830"/>' +
    '<circle cx="15.5" cy="13" r="3" fill="#9c3238"/>' +
    '<circle cx="12" cy="17.5" r="3.2" fill="#7c222c"/>' +
    '<circle cx="8" cy="13" r="0.8" fill="#d8909a"/>' +
    '<circle cx="14.5" cy="12" r="0.7" fill="#d8909a"/>' +
    SVG_CLOSE,
  stone_axe: SVG_OPEN +
    '<g transform="rotate(38 12 12)">' +
    '<rect x="10.8" y="8" width="2.4" height="14" rx="1" fill="#6b4a2a"/>' +
    '<rect x="11" y="2" width="2" height="7" rx="0.8" fill="#54381d"/>' +
    '<path d="M8.5 3 L18 2 L20 6 L16 9.5 L9 8 Z" fill="#8d8a84"/>' +
    '<path d="M20 6 L16 9.5 L18.5 6.5 Z" fill="#b3b0aa"/>' +
    '</g>' +
    SVG_CLOSE,
  stone_pick: SVG_OPEN +
    '<g transform="rotate(38 12 12)">' +
    '<rect x="11" y="9" width="2.2" height="13" rx="1" fill="#6b4a2a"/>' +
    '<rect x="11.2" y="2.5" width="1.8" height="7" rx="0.8" fill="#54381d"/>' +
    '<path d="M3 7 C6 2.5 18 2.5 21 7 L19.5 8 C16.5 4.5 7.5 4.5 4.5 8 Z" fill="#8d8a84"/>' +
    '<path d="M3 7 L4.5 8 L6 5.5 Z" fill="#b3b0aa"/>' +
    '<path d="M21 7 L19.5 8 L18 5.5 Z" fill="#b3b0aa"/>' +
    '</g>' +
    SVG_CLOSE,
  campfire: SVG_OPEN +
    '<rect x="4" y="17" width="7" height="2.6" rx="1.2" fill="#6b4a2a" transform="rotate(14 7.5 18)"/>' +
    '<rect x="13" y="17" width="7" height="2.6" rx="1.2" fill="#5d4024" transform="rotate(-14 16.5 18)"/>' +
    '<path d="M12 4 C14.5 7 16 9 15 12 C15.5 11 16 10 16.5 9.5 C17.5 12 17 15 14.5 16.5 C12 18 8.5 17 7.5 14.5 C6.5 12 8 9.5 10 8.5 C9.5 10 10 11 11 11.5 C10.5 8.5 11 6 12 4 Z" fill="#d97a2b"/>' +
    '<path d="M12 8 C13.2 9.5 13.8 11 13 12.5 C12.3 14 10.8 14 10 13 C9.2 12 9.5 10 12 8 Z" fill="#edb25a"/>' +
    SVG_CLOSE,
  wall: SVG_OPEN +
    '<rect x="4" y="4" width="3" height="16" fill="#6b4a2a"/>' +
    '<rect x="17" y="4" width="3" height="16" fill="#6b4a2a"/>' +
    '<rect x="7" y="6" width="10" height="3" fill="#7a5631"/>' +
    '<rect x="7" y="11" width="10" height="3" fill="#6f4c2a"/>' +
    '<rect x="7" y="16" width="10" height="3" fill="#7a5631"/>' +
    '<path d="M4.5 4.8h2M17.5 4.8h2" stroke="#4c3018" stroke-width="1"/>' +
    SVG_CLOSE,
  floor: SVG_OPEN +
    '<g transform="rotate(-18 12 12)">' +
    '<rect x="2" y="6" width="20" height="3.4" fill="#7a5631"/>' +
    '<rect x="2" y="10.2" width="20" height="3.4" fill="#6f4c2a"/>' +
    '<rect x="2" y="14.4" width="20" height="3.4" fill="#7a5631"/>' +
    '<path d="M8 6v3.4M15 10.2v3.4M11 14.4v3.4" stroke="#4c3018" stroke-width="0.8"/>' +
    '</g>' +
    SVG_CLOSE,
  roof: SVG_OPEN +
    '<path d="M2 13 L12 4 L22 13 L20.5 14.5 L12 7 L3.5 14.5 Z" fill="#6f4c2a"/>' +
    '<rect x="9.5" y="4" width="5" height="2" fill="#8d8a84"/>' +
    '<path d="M5 15 h14 l-1.5 2 h-11 Z" fill="#5d4024"/>' +
    '<path d="M6 13 L12 7.5 L18 13" stroke="#8a6a3c" stroke-width="1.2" fill="none"/>' +
    SVG_CLOSE,
};

/**
 * Full DOM HUD (Visual/Shell scope): survival bars, hotbar, interaction
 * prompt + progress, crafting menu, NPC chat, toasts, MP status, FPS,
 * death overlay. All DOM, no Babylon.
 */
export class Hud {
  private root: HTMLDivElement;

  private bars!: Record<'health' | 'hunger' | 'thirst' | 'stamina', HTMLDivElement>;
  private tempEl!: HTMLDivElement;
  private levelBadge!: HTMLDivElement;
  private levelFill!: HTMLDivElement;
  private levelBox!: HTMLDivElement;
  private hotbarEl!: HTMLDivElement;
  private invEl!: HTMLDivElement;
  private invSlots: HTMLDivElement[] = [];
  private invCursorEl!: HTMLDivElement;
  private promptEl!: HTMLDivElement;
  private progressEl!: HTMLDivElement;
  private craftEl!: HTMLDivElement;
  private craftItems: Array<{ el: HTMLButtonElement; id: string }> = [];
  private chatEl!: HTMLDivElement;
  private chatLog!: HTMLDivElement;
  private chatInput!: HTMLInputElement;
  private chatName!: HTMLSpanElement;
  private toastEl!: HTMLDivElement;
  private mpEl!: HTMLDivElement;
  private fpsEl!: HTMLDivElement;
  private deathEl!: HTMLDivElement;
  private sleepFadeEl!: HTMLDivElement;
  /** Red vignette shown while the player is taking damage. */
  private damageFlashEl!: HTMLDivElement;

  private onRespawn: () => void;

  constructor(container: HTMLElement, onRespawn: () => void) {
    this.root = document.createElement('div');
    this.root.className = 'hud';
    this.onRespawn = onRespawn;
    this.build();
    container.appendChild(this.root);
  }

  private build(): void {
    const el = (cls: string, parent: HTMLElement = this.root): HTMLDivElement => {
      const e = document.createElement('div');
      e.className = cls;
      parent.appendChild(e);
      return e;
    };

    // --- Title + hints
    el('hud-title').textContent = 'AI SURVIVAL WORLD';
    const hints = el('hud-hints');
    hints.innerHTML = [
      '<span><b>W/Z</b> vooruit · <b>S</b> achteruit · <b>A/D</b> zijwaarts · <b>Mouse</b> kijken</span>',
      '<span><b>Shift</b> sprint · <b>Space</b> jump/swim · <b>C</b> crouch (houd C bij het landen voor een zachtere landing)</span>',
      '<span><b>F</b> gather · <b>E</b> interact/use/place</span>',
      '<span><b>E</b> bij een vuur = hout toevoegen · voedsel geselecteerd = koken (bessen → gekookt)</span>',
      '<span><b>E</b> bij een bed = slapen tot \u2019s ochtends · <b>Esc</b> = wakker worden</span>',
      '<span><b>B</b> crafting · <b>I</b> inventory · <b>1-8</b> hotbar · <b>Q</b> drop · <b>R</b> eat · <b>N</b> new world · <b>Esc</b> release mouse</span>',
      '<span>Oogsten, maken en bouwen geeft XP — levels ontgrendelen nieuwe recepten</span>',
    ].join('');

    // --- Survival bars
    const barsBox = el('bars-box');
    const makeBar = (label: string, cls: string) => {
      const b = el('bar', barsBox);
      const fill = el(`bar-fill ${cls}`, b);
      const l = el('bar-label', b);
      l.textContent = label;
      return fill;
    };
    this.bars = {
      health: makeBar('Health', 'bar-health'),
      hunger: makeBar('Hunger', 'bar-hunger'),
      thirst: makeBar('Thirst', 'bar-thirst'),
      stamina: makeBar('Stamina', 'bar-stamina'),
    };
    this.tempEl = el('temp', barsBox);

    // --- Level + XP (progression)
    this.levelBox = el('level', barsBox);
    this.levelBadge = el('level-badge', this.levelBox);
    const levelBar = el('level-bar', this.levelBox);
    this.levelFill = el('level-fill', levelBar);

    // --- Hotbar
    this.hotbarEl = el('hotbar');
    for (let i = 0; i < 8; i++) {
      const slot = el('slot', this.hotbarEl);
      slot.dataset.index = String(i);
      el('slot-swatch', slot);
      el('slot-count', slot);
      el('slot-label', slot);
      el('slot-durability', slot);
      slot.addEventListener('click', (e) => {
        e.stopPropagation();
        window.dispatchEvent(new CustomEvent('hud-hotbar-click', { detail: i }));
      });
      slot.title = `Slot ${i + 1}`;
    }

    // --- Interaction prompt + progress
    this.promptEl = el('prompt');
    this.progressEl = el('progress');

    // --- Crosshair
    el('crosshair');

    // --- Full inventory panel (all 24 slots + held-cursor slot)
    this.invEl = el('inv');
    this.invEl.hidden = true;
    const invHead = el('inv-head', this.invEl);
    invHead.textContent = 'INVENTARIS  (I to close)';
    const grid = el('inv-grid', this.invEl);
    for (let i = 0; i < 24; i++) {
      const slot = el('slot', grid);
      slot.dataset.index = String(i);
      if (i < 8) {
        slot.classList.add('hot');
        const key = el('slot-key', slot);
        key.textContent = String(i + 1);
      }
      el('slot-swatch', slot);
      el('slot-count', slot);
      el('slot-label', slot);
      el('slot-durability', slot);
      slot.addEventListener('click', (e) => {
        e.stopPropagation();
        window.dispatchEvent(new CustomEvent('hud-inv-slot-click', { detail: i }));
      });
      slot.title = i < 8 ? `Hotbar ${i + 1}` : `Slot ${i + 1}`;
      this.invSlots.push(slot);
    }
    const cursorRow = el('inv-cursor-row', this.invEl);
    this.invCursorEl = el('slot inv-cursor', cursorRow);
    el('slot-swatch', this.invCursorEl);
    el('slot-count', this.invCursorEl);
    el('slot-label', this.invCursorEl);
    el('slot-durability', this.invCursorEl);
    const cursorHint = el('inv-cursor-hint', cursorRow);
    cursorHint.textContent = 'vastgehouden';
    const invHints = el('inv-hints', this.invEl);
    invHints.innerHTML =
      '<b>Klik</b> item = oppakken · <b>klik</b> slot = neerleggen / samenvoegen / verwisselen · '
      + '<b>Q</b> = 1 item gooien · <b>I</b>/Esc = sluiten · gele rij = hotbar (1–8)';

    // --- Crafting menu
    this.craftEl = el('craft');
    this.craftEl.hidden = true;
    const craftTitle = el('craft-title', this.craftEl);
    craftTitle.textContent = 'CRAFTING  (B to close)';
    for (const r of RECIPES) {
      const out = ITEMS[r.output.id];
      const btn = document.createElement('button');
      btn.className = 'craft-item';
      // data-req feeds the CSS lock tag on level-locked recipes.
      btn.dataset.req = String(r.unlockLevel ?? 1);
      btn.innerHTML =
        `<span class="craft-name">${out.name} x${r.output.count} · ${r.craftSeconds}s</span>` +
        `<span class="craft-cost">${r.inputs.map((i) => `${i.count} ${ITEMS[i.id].name}`).join(', ')}</span>`;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        window.dispatchEvent(new CustomEvent('hud-craft-click', { detail: r.id }));
      });
      this.craftEl.appendChild(btn);
      this.craftItems.push({ el: btn, id: r.id });
    }

    // --- NPC chat
    this.chatEl = el('chat');
    this.chatEl.hidden = true;
    const chatHead = el('chat-head', this.chatEl);
    this.chatName = document.createElement('span');
    this.chatName.className = 'chat-name';
    chatHead.appendChild(this.chatName);
    const closeBtn = document.createElement('button');
    closeBtn.textContent = '✕';
    closeBtn.className = 'chat-close';
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      window.dispatchEvent(new CustomEvent('hud-chat-close'));
    });
    chatHead.appendChild(closeBtn);
    this.chatLog = el('chat-log', this.chatEl);
    const inputRow = el('chat-input-row', this.chatEl);
    this.chatInput = document.createElement('input');
    this.chatInput.className = 'chat-input';
    this.chatInput.placeholder = 'Type a message… (Enter to send, Esc to close)';
    this.chatInput.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter' && this.chatInput.value.trim()) {
        window.dispatchEvent(new CustomEvent('hud-chat-send', { detail: this.chatInput.value.trim() }));
        this.chatInput.value = '';
      }
      if (e.key === 'Escape') window.dispatchEvent(new CustomEvent('hud-chat-close'));
    });
    inputRow.appendChild(this.chatInput);

    // --- Toast / MP / FPS
    this.toastEl = el('toast');
    this.mpEl = el('mp-status');
    this.fpsEl = el('fps');

    // --- Death overlay
    this.deathEl = el('death-overlay');
    this.deathEl.hidden = true;
    const deathTitle = el('death-title', this.deathEl);
    deathTitle.textContent = 'You died.';
    const deathBtn = document.createElement('button');
    deathBtn.className = 'death-btn';
    this.deathEl.appendChild(deathBtn);
    deathBtn.textContent = 'Respawn at camp';
    deathBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.onRespawn();
    });

    // --- Sleep fade (black screen while the player lies in a bed)
    this.sleepFadeEl = document.createElement('div');
    this.sleepFadeEl.className = 'sleep-fade';
    this.sleepFadeEl.hidden = true;
    this.root.appendChild(this.sleepFadeEl);

    // --- Damage flash (red vignette while the player takes damage)
    this.damageFlashEl = document.createElement('div');
    this.damageFlashEl.className = 'damage-flash';
    this.damageFlashEl.style.opacity = '0';
    this.root.appendChild(this.damageFlashEl);

    // Pointer-events back on for interactive parts.
    [this.hotbarEl, this.craftEl, this.chatEl, this.deathEl, this.mpEl, this.invEl].forEach((e) => {
      e.style.pointerEvents = 'auto';
    });
  }

  /**
   * Render one item slot (shared by the hotbar and the inventory panel).
   * Keeps icon, count, label, tool-durability bar and tooltip in sync.
   */
  private renderSlot(el: HTMLElement, s: Slot | null, fallbackTitle: string): void {
    const swatch = el.querySelector('.slot-swatch') as HTMLElement;
    const count = el.querySelector('.slot-count') as HTMLElement;
    const label = el.querySelector('.slot-label') as HTMLElement;
    const durBar = el.querySelector('.slot-durability') as HTMLElement;
    if (s && ITEMS[s.id]) {
      const iconKey = s.id;
      if (el.dataset.icon !== iconKey) {
        el.dataset.icon = iconKey;
        const icon = ICONS[s.id];
        if (icon) {
          swatch.style.background = '';
          swatch.innerHTML = icon;
        } else {
          const [r, g, b] = ITEMS[s.id].color;
          swatch.style.background = `rgb(${r * 255 | 0},${g * 255 | 0},${b * 255 | 0})`;
          swatch.innerHTML = '';
        }
      }
      swatch.style.visibility = 'visible';
      count.textContent = s.count > 1 ? String(s.count) : '';
      label.textContent = ITEMS[s.id].name;
      const tool = ITEMS[s.id].tool;
      if (tool) {
        const d = s.durability ?? tool.maxDurability;
        const frac = Math.max(0, Math.min(1, d / tool.maxDurability));
        durBar.style.width = `${Math.round(frac * 100)}%`;
        durBar.className = `slot-durability${frac > 0.5 ? '' : frac > 0.25 ? ' warn' : ' low'}`;
        const nodes = Object.keys(YIELDS).filter((k) => toolForNode(k) === s.id);
        const uses = nodes.length
          ? ` · ~${Math.floor(d / (tool.wearPerSec * Math.min(...nodes.map((k) => harvestSeconds(k, s.id)))))} uses`
          : '';
        el.title = `${ITEMS[s.id].desc}\nDuurzaamheid ${Math.round(frac * 100)}%${uses}`;
      } else {
        durBar.style.width = '0';
        el.title = ITEMS[s.id].desc;
      }
    } else {
      el.dataset.icon = '';
      swatch.style.visibility = 'hidden';
      swatch.innerHTML = '';
      count.textContent = '';
      label.textContent = '';
      durBar.style.width = '0';
      el.title = fallbackTitle;
    }
  }

  // ---------- updates ----------

  setStats(s: StatSnapshot): void {
    this.bars.health.style.width = `${s.health}%`;
    this.bars.hunger.style.width = `${s.hunger}%`;
    this.bars.thirst.style.width = `${s.thirst}%`;
    this.bars.stamina.style.width = `${s.stamina}%`;
    // Exhaustion: the stamina bar pulses and desaturates until the
    // lockout is over, so the player sees WHY sprint is unavailable.
    this.bars.stamina.classList.toggle('exhausted', !!s.exhausted);
    const cold = s.temperature < 8;
    const hot = s.temperature > 30;
    this.tempEl.textContent = `${s.temperature.toFixed(0)}°C${cold ? '  ❄' : hot ? '  🔥' : ''}`;
    this.tempEl.className = `temp${cold ? ' temp-cold' : hot ? ' temp-hot' : ''}`;
  }

  setHotbar(slots: Array<Slot | null>, selected: number): void {
    const children = this.hotbarEl.children;
    for (let i = 0; i < 8; i++) {
      const slot = children[i] as HTMLElement;
      slot.classList.toggle('selected', i === selected);
      this.renderSlot(slot, slots[i], `Slot ${i + 1}`);
    }
  }

  /**
   * Full inventory panel (all 24 slots). `cursor` is the stack currently
   * held by the UI mouse-cursor (rendered beside the grid, not part of any
   * slot). The hotbar row stays visible with its selection highlight.
   */
  setInventory(open: boolean, slots: Array<Slot | null>, selected: number, cursor: Slot | null): void {
    this.invEl.hidden = !open;
    this.root.classList.toggle('inv-open', open);
    if (!open) return;
    for (let i = 0; i < 24; i++) {
      const slot = this.invSlots[i];
      slot.classList.toggle('selected', i === selected);
      this.renderSlot(slot, slots[i] ?? null, i < 8 ? `Hotbar ${i + 1}` : `Slot ${i + 1}`);
    }
    this.renderSlot(this.invCursorEl, cursor, 'vastgehouden');
  }

  setPrompt(text: string | null): void {
    this.promptEl.textContent = text ?? '';
    this.promptEl.style.display = text ? 'block' : 'none';
  }

  setProgress(p: number | null): void {
    if (p === null) {
      this.progressEl.style.display = 'none';
      return;
    }
    this.progressEl.style.display = 'block';
    this.progressEl.style.width = `${Math.round(p * 100)}%`;
  }

  /**
   * Level badge + XP progress bar. `fraction` is the player's progress
   * within the current level in [0, 1] (1 at max level).
   */
  setLevel(level: number, fraction: number): void {
    this.levelBadge.textContent = `LV ${level}`;
    this.levelBox.title = `Niveau ${level}`;
    this.levelFill.style.width = `${Math.round(Math.max(0, Math.min(1, fraction)) * 100)}%`;
    this.levelBox.classList.toggle('max', level >= MAX_LEVEL);
  }

  /**
   * Update the crafting menu. `craftingId` marks the recipe currently
   * being worked on: while a timed craft is in progress ALL recipe
   * buttons are disabled and the active one is highlighted (`.busy`).
   * Recipes that require a higher level than `level` are shown locked.
   */
  setCrafting(open: boolean, canCraft: Set<string>, craftingId: string | null = null, level = Infinity): void {
    this.craftEl.hidden = !open;
    for (const c of this.craftItems) {
      const recipe = RECIPES.find((r) => r.id === c.id)!;
      const busy = c.id === craftingId;
      const locked = level < (recipe.unlockLevel ?? 1);
      const ok = !craftingId && !locked && canCraft.has(c.id);
      c.el.disabled = !ok && !busy;
      c.el.classList.toggle('can', ok);
      c.el.classList.toggle('busy', busy);
      c.el.classList.toggle('locked', locked && !busy);
      c.el.title = locked
        ? `Vergrend — vereist level ${recipe.unlockLevel}`
        : '';
    }
  }

  openChat(name: string): void {
    this.chatEl.hidden = false;
    this.chatName.textContent = name;
    this.chatInput.focus();
  }

  closeChat(): void {
    this.chatEl.hidden = true;
    this.chatLog.innerHTML = '';
  }

  addChatLine(who: string, text: string, dim = false): void {
    const line = document.createElement('div');
    line.className = 'chat-line' + (dim ? ' dim' : '');
    const whoSpan = document.createElement('span');
    whoSpan.className = 'chat-who';
    whoSpan.textContent = who + ': ';
    const body = document.createElement('span');
    body.textContent = text;
    line.append(whoSpan, body);
    this.chatLog.appendChild(line);
    this.chatLog.scrollTop = this.chatLog.scrollHeight;
  }

  setChatBusy(busy: boolean): void {
    this.chatInput.disabled = busy;
    if (busy) this.addChatLine('…', 'is thinking', true);
  }

  toast(msg: string): void {
    this.toastEl.textContent = msg;
    this.toastEl.classList.remove('show');
    // restart animation
    void this.toastEl.offsetWidth;
    this.toastEl.classList.add('show');
  }

  setMpStatus(text: string): void {
    this.mpEl.textContent = text;
    this.mpEl.classList.toggle('offline', text.startsWith('Solo'));
  }

  setFps(fps: number): void {
    this.fpsEl.textContent = `${fps} fps`;
    this.fpsEl.classList.toggle('low', fps < 30);
  }

  showDeath(show: boolean): void {
    this.deathEl.hidden = !show;
    if (show) this.root.classList.add('dead');
    else this.root.classList.remove('dead');
  }

  /**
   * Drive the black sleep overlay (0 = fully visible world, 1 = black).
   * The game loop sets this each frame while the player is in a bed.
   */
  setSleepFade(v: number): void {
    if (v <= 0) {
      this.sleepFadeEl.hidden = true;
      this.sleepFadeEl.style.opacity = '0';
      return;
    }
    this.sleepFadeEl.hidden = false;
    this.sleepFadeEl.style.opacity = String(Math.min(1, v));
  }

  /**
   * Drive the red damage vignette (0 = invisible, 1 = full impact).
   * A short CSS transition gives the fade-out feel; the game loop owns
   * the decay so the overlay always settles back to invisible.
   */
  setDamageFlash(v: number): void {
    this.damageFlashEl.style.opacity = String(Math.max(0, Math.min(1, v)));
  }

  dispose(): void {
    this.root.remove();
  }
}
