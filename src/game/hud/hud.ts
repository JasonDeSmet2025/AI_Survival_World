import { harvestSeconds, ITEMS, RECIPES, toolForNode, YIELDS } from '../core/items';
import {
  CRAFT_GROUP_LABEL,
  CRAFT_GROUP_ORDER,
  craftGroupOf,
  needsTable,
} from '../systems/crafting';
import { MAX_LEVEL } from '../systems/progress';
import {
  ACTION_LABEL,
  DEFAULT_BINDINGS,
  KEYBIND_GROUPS,
  alternatesFor,
  clampMouseSens,
  keyLabel,
  type Action,
  type Bindings,
} from '../systems/keybinds';
import type { StatSnapshot } from '../systems/stats';
import type { Slot } from '../systems/inventory';

/**
 * Hand-drawn inline SVG item icons (Visual Agent scope).
 * Muted, survival-appropriate palettes; 24x24 viewBox scaled to the slot.
 * Tools are real recognizable silhouettes (axe, pickaxe), not color chips.
 */
const SVG_OPEN = '<svg viewBox="0 0 24 24" width="100%" height="100%" aria-hidden="true">';
const SVG_CLOSE = '</svg>';

/**
 * Shell-level UI preference: whether the control cheat sheet is expanded.
 * Deliberately NOT part of the save file (it is not gameplay state) and it
 * stores no personal data — just "1" or "0".
 */
const HINTS_STORAGE_KEY = 'asw.hints-open';

const ICONS: Record<string, string> = {
  workbench: SVG_OPEN +
    // A tekentafel: four legs, a thick top, and the tools that say "here you
    // make things" — a saw and a square. Same silhouette as the 3D prop.
    '<rect x="3.2" y="10" width="1.7" height="10" rx="0.6" fill="#5d4024"/>' +
    '<rect x="19.1" y="10" width="1.7" height="10" rx="0.6" fill="#5d4024"/>' +
    '<rect x="6" y="11" width="1.6" height="9" rx="0.6" fill="#4c3018"/>' +
    '<rect x="16.4" y="11" width="1.6" height="9" rx="0.6" fill="#4c3018"/>' +
    '<rect x="2" y="7.4" width="20" height="3" rx="0.8" fill="#7a5631"/>' +
    '<path d="M4 8.9h16" stroke="#5a3d21" stroke-width="0.7"/>' +
    '<path d="M6.5 6.2 L15 4.4 L15.4 5.7 L6.9 7.4 Z" fill="#b3b0aa"/>' +
    '<rect x="6" y="5.4" width="2.6" height="1.6" rx="0.5" fill="#6b4a2a" transform="rotate(-12 7.3 6.2)"/>' +
    '<path d="M15.6 3.4 L20.4 6.6 L19.4 7.7 L14.7 4.6 Z" fill="#8d8a84"/>' +
    SVG_CLOSE,
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
  raw_mutton: SVG_OPEN +
    '<path d="M7 15 C4 13 4 8 8 6 C12 4 17 5 19 8 C21 11 19 16 15 17 C11 18 9 17 7 15 Z" fill="#c9585c"/>' +
    '<path d="M8.5 13.5 C7 12 7.5 9 10 7.8" stroke="#e89094" stroke-width="1.4" fill="none"/>' +
    '<circle cx="16.5" cy="13.5" r="1.6" fill="#e8ddd2"/>' +
    SVG_CLOSE,
  cooked_mutton: SVG_OPEN +
    '<path d="M7 15 C4 13 4 8 8 6 C12 4 17 5 19 8 C21 11 19 16 15 17 C11 18 9 17 7 15 Z" fill="#9c4a24"/>' +
    '<path d="M8.5 13.5 C7 12 7.5 9 10 7.8" stroke="#c98a52" stroke-width="1.4" fill="none"/>' +
    '<circle cx="16.5" cy="13.5" r="1.6" fill="#e8ddd2"/>' +
    '<path d="M10 4 l1 2 M13 3 l0.5 2.2" stroke="#d8d4cc" stroke-width="0.9" opacity="0.7"/>' +
    SVG_CLOSE,
  raw_beef: SVG_OPEN +
    '<path d="M5 14 C3.5 11 5 6.5 9.5 5.5 C14 4.5 18.5 6 19.5 9.5 C20.5 13 17.5 17 12.5 17.5 C8 18 6.5 16.5 5 14 Z" fill="#b03a3e"/>' +
    '<path d="M8 13 C7 11 8 8.5 10.5 7.6 M12 16 C10 15.4 9 14 8.4 12.6" stroke="#d87a7e" stroke-width="1.1" fill="none"/>' +
    SVG_CLOSE,
  cooked_beef: SVG_OPEN +
    '<path d="M5 14 C3.5 11 5 6.5 9.5 5.5 C14 4.5 18.5 6 19.5 9.5 C20.5 13 17.5 17 12.5 17.5 C8 18 6.5 16.5 5 14 Z" fill="#7c3218"/>' +
    '<path d="M8 13 C7 11 8 8.5 10.5 7.6" stroke="#b4713e" stroke-width="1.2" fill="none"/>' +
    '<path d="M9 3.6 l1 2.2 M13 3 l0.5 2.3 M16.5 4 l0.4 2" stroke="#d8d4cc" stroke-width="0.9" opacity="0.7"/>' +
    SVG_CLOSE,
  wool: SVG_OPEN +
    '<circle cx="9" cy="12" r="4" fill="#e8e2d4"/>' +
    '<circle cx="14.5" cy="9.5" r="3.4" fill="#efe9dc"/>' +
    '<circle cx="15.5" cy="14.5" r="3.6" fill="#e2dbcb"/>' +
    '<circle cx="11" cy="9" r="0.9" fill="#c9c0ac"/>' +
    '<circle cx="13" cy="15.5" r="0.9" fill="#c9c0ac"/>' +
    SVG_CLOSE,
  leather: SVG_OPEN +
    '<path d="M6 5 C10 3.5 15 3.5 19 5.5 C20.5 10 20 15 17.5 19 C13.5 20.5 9.5 20.5 6 18.5 C4 14 4 9 6 5 Z" fill="#8a5a30"/>' +
    '<path d="M8 7 C11 6 14.5 6 17 7.5 M7.5 11 h10 M8 15 h8" stroke="#6b4120" stroke-width="0.9" fill="none"/>' +
    SVG_CLOSE,
  door: SVG_OPEN +
    '<rect x="6" y="3" width="12" height="18" rx="0.8" fill="#7a5631"/>' +
    '<rect x="7.6" y="4.6" width="3.2" height="15" fill="#6b4a2a"/>' +
    '<rect x="12.6" y="4.6" width="3.2" height="15" fill="#6f4c2a"/>' +
    '<rect x="5" y="7" width="14" height="1.6" fill="#54381d"/>' +
    '<rect x="5" y="15" width="14" height="1.6" fill="#54381d"/>' +
    '<circle cx="16.6" cy="12" r="1" fill="#d8b45a"/>' +
    SVG_CLOSE,
  stone_wall: SVG_OPEN +
    '<rect x="3" y="5" width="18" height="15" fill="#8d8a84"/>' +
    '<path d="M3 9.5 h18 M3 14.5 h18 M8 5 v4.5 M14.5 5 v4.5 M6 9.5 v5 M12 9.5 v5 M18 9.5 v5 M9 14.5 v5.5 M15 14.5 v5.5" stroke="#67645f" stroke-width="0.9"/>' +
    '<rect x="3" y="3.4" width="18" height="1.8" fill="#a8a5a0"/>' +
    SVG_CLOSE,
  torch: SVG_OPEN +
    '<rect x="11" y="9" width="2" height="12" rx="0.8" fill="#6b4a2a"/>' +
    '<rect x="9.8" y="7.6" width="4.4" height="2" rx="0.7" fill="#8d8a84"/>' +
    '<path d="M12 1.5 C13.8 3.4 14.8 5 14 6.8 C13.4 8 12.4 8.4 12 8.6 C11.6 8.4 10.6 8 10 6.8 C9.2 5 10.2 3.4 12 1.5 Z" fill="#d97a2b"/>' +
    '<path d="M12 3.6 C12.9 4.8 13.3 5.8 12.8 6.8 C12.4 7.5 11.6 7.4 11.4 6.7 C11.1 5.7 11.4 4.8 12 3.6 Z" fill="#edb25a"/>' +
    SVG_CLOSE,
  carpet: SVG_OPEN +
    '<rect x="3" y="7" width="18" height="11" rx="1" fill="#a83a3e"/>' +
    '<rect x="5.4" y="9.4" width="13.2" height="6.2" fill="none" stroke="#d8bc7a" stroke-width="1.2"/>' +
    '<path d="M3 18.5 l0.6 2 M7 18.5 l0.3 2 M11 18.5 l0.4 2 M15 18.5 l0.2 2 M19 18.5 l0.5 2" stroke="#8c2f33" stroke-width="0.9"/>' +
    SVG_CLOSE,
  sword: SVG_OPEN +
    '<path d="M12 1.5 L13.6 4 L13.2 15.5 L10.8 15.5 L10.4 4 Z" fill="#c2c6cc"/>' +
    '<path d="M12 1.5 L13.6 4 L13.2 15.5 L12 15.5 Z" fill="#9aa0a8"/>' +
    '<rect x="7.2" y="15.2" width="9.6" height="2" rx="0.7" fill="#4a2f1a"/>' +
    '<rect x="11" y="17" width="2" height="4.6" rx="0.7" fill="#6b4a2a"/>' +
    '<circle cx="12" cy="22" r="1.3" fill="#4a2f1a"/>' +
    SVG_CLOSE,
  potion_heal: SVG_OPEN +
    '<path d="M10.4 3 h3.2 v3 l2.6 5.5 a4.4 4.4 0 0 1 -3.5 6.5 h-4.4 a4.4 4.4 0 0 1 -3.5 -6.5 l2.6 -5.5 Z" fill="#3f2f38"/>' +
    '<path d="M8.2 10.5 h7.6 l1.4 3 a4.4 4.4 0 0 1 -3.5 6.5 h-4.4 a4.4 4.4 0 0 1 -3.5 -6.5 Z" fill="#c8324f"/>' +
    '<rect x="9.4" y="1.8" width="5.2" height="1.8" rx="0.6" fill="#6b4a2a"/>' +
    '<path d="M12 12.4 v4.4 M9.8 14.6 h4.4" stroke="#ffd9e0" stroke-width="1.4"/>' +
    SVG_CLOSE,
  potion_swift: SVG_OPEN +
    '<path d="M10.4 3 h3.2 v3 l2.6 5.5 a4.4 4.4 0 0 1 -3.5 6.5 h-4.4 a4.4 4.4 0 0 1 -3.5 -6.5 l2.6 -5.5 Z" fill="#3a352c"/>' +
    '<path d="M8.2 10.5 h7.6 l1.4 3 a4.4 4.4 0 0 1 -3.5 6.5 h-4.4 a4.4 4.4 0 0 1 -3.5 -6.5 Z" fill="#e0a91f"/>' +
    '<rect x="9.4" y="1.8" width="5.2" height="1.8" rx="0.6" fill="#6b4a2a"/>' +
    '<path d="M13 11.6 l-3 4.2 h2.4 l-1.4 3.6" stroke="#5a3a08" stroke-width="1.2" fill="none"/>' +
    SVG_CLOSE,
  potion_night: SVG_OPEN +
    '<path d="M10.4 3 h3.2 v3 l2.6 5.5 a4.4 4.4 0 0 1 -3.5 6.5 h-4.4 a4.4 4.4 0 0 1 -3.5 -6.5 l2.6 -5.5 Z" fill="#2b3038"/>' +
    '<path d="M8.2 10.5 h7.6 l1.4 3 a4.4 4.4 0 0 1 -3.5 6.5 h-4.4 a4.4 4.4 0 0 1 -3.5 -6.5 Z" fill="#4a72d8"/>' +
    '<rect x="9.4" y="1.8" width="5.2" height="1.8" rx="0.6" fill="#6b4a2a"/>' +
    '<path d="M13.8 12.2 a3 3 0 1 0 0 5.4 a3.7 3.7 0 0 1 0 -5.4 Z" fill="#dfe8ff"/>' +
    SVG_CLOSE,
};

/** Shop offer id -> the icon of the potion it grants (hud shop rows). */
const SHOP_ICON_BY_GIVE: Record<string, string> = {
  heal: ICONS.potion_heal,
  swift: ICONS.potion_swift,
  night: ICONS.potion_night,
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
  /** "In het veld" vs "aan de tekentafel" — the station line above the list. */
  private craftStationEl!: HTMLDivElement;
  private craftItems: Array<{ el: HTMLButtonElement; id: string }> = [];
  private chatEl!: HTMLDivElement;
  private chatLog!: HTMLDivElement;
  private chatInput!: HTMLInputElement;
  private chatName!: HTMLSpanElement;
  private questsEl!: HTMLDivElement;
  private questOfferEl!: HTMLDivElement;
  private toastEl!: HTMLDivElement;
  /**
   * Bottom-centre stack: camera-mode pill and the "cursor is free" chip. Both
   * live in the same flex column as the toast because the space above the
   * hotbar is the one place the HUD may cover at eye level — three absolutes
   * with hand-tuned `bottom:` values is how the top of this HUD used to
   * overlap itself.
   */
  private camPillEl!: HTMLDivElement;
  private pointerEl!: HTMLDivElement;
  /** Last state written to the DOM, so a per-frame call costs nothing. */
  private camPillOn = false;
  private camPillFp = false;
  /** The collapsible control cheat sheet (see build()). */
  private hintsEl!: HTMLDivElement;
  private hintsBodyEl!: HTMLDivElement;
  private hintsOpen = false;
  private settingsEl!: HTMLDivElement;
  /** Key-map list, mouse sensitivity row and the one key being rebound. */
  private keysEl!: HTMLDivElement;
  private keyStatus!: HTMLDivElement;
  private sensInput!: HTMLInputElement;
  private qualitySelect!: HTMLSelectElement;
  private sensValue!: HTMLSpanElement;
  private keysResetBtn!: HTMLButtonElement;
  private bindings: Bindings = {} as Bindings;
  private rebind: Action | null = null;
  /**
   * Timestamp until which panel clicks are ignored. Binding a MOUSE button
   * stops the mousedown but the browser still delivers `click` to whatever
   * button sits under the cursor, which would immediately arm that row again.
   */
  private clickGuardUntil = 0;
  private shopEl!: HTMLDivElement;
  private perkEl!: HTMLDivElement;
  private perkHeadEl!: HTMLDivElement;
  private perkListEl!: HTMLDivElement;
  private perkInfoEl!: HTMLDivElement;
  private negoEl!: HTMLDivElement;
  private negoListEl!: HTMLDivElement;
  private negoHeadEl!: HTMLDivElement;
  private shopListEl!: HTMLDivElement;
  private resetBtn!: HTMLButtonElement;
  private resetArmed = false;
  private resetArmTimer: ReturnType<typeof setTimeout> | null = null;
  private resetShared = false;
  private mpEl!: HTMLDivElement;
  private mpPanelEl!: HTMLDivElement;
  private mpPlayersEl!: HTMLDivElement;
  private mpNameEl!: HTMLInputElement;
  /** Overlay into which remote players' nametags are projected. */
  private mpTagsEl!: HTMLDivElement;
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

    // --- Left column: title, multiplayer state, FPS. ONE flex column so
    // these three can never overlap each other (they used to be three
    // separate absolutes, and the unstyled title sat under the MP panel).
    const left = el('hud-left');

    // --- Title + hints
    const title = el('hud-title', left);
    title.textContent = 'AI SURVIVAL WORLD';

    // --- Survival bars (right column, with the quest tracker under them)
    const right = el('hud-right');
    const barsBox = el('bars-box', right);
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

    // --- Crafting menu. Two station sections (hand work / tekentafel) with
    // the groups from systems/crafting.ts inside them: the list is long, so
    // it scrolls and reads in blocks instead of one flat wall.
    this.craftEl = el('craft');
    this.craftEl.hidden = true;
    const craftTitle = el('craft-title', this.craftEl);
    craftTitle.textContent = 'MAKEN  (B sluit)';
    this.craftStationEl = el('craft-station', this.craftEl);
    const craftList = el('craft-list', this.craftEl);
    for (const station of [false, true]) {
      const rows = RECIPES.filter((r) => needsTable(r) === station);
      if (!rows.length) continue;
      const head = el('craft-station-head', craftList);
      head.textContent = station ? '🪑 Aan de tekentafel' : '✋ Handwerk — overal te maken';
      head.dataset.station = station ? 'table' : 'hand';
      for (const g of CRAFT_GROUP_ORDER) {
        const group = rows.filter((r) => craftGroupOf(r) === g);
        if (!group.length) continue;
        const gh = el('craft-group-head', craftList);
        gh.textContent = CRAFT_GROUP_LABEL[g];
        for (const r of group) {
          const out = ITEMS[r.output.id];
          const btn = document.createElement('button');
          btn.className = 'craft-item';
          // data-req feeds the CSS lock tag on level-locked recipes, data-
          // station the tag on recipes the table is holding back right now.
          btn.dataset.req = String(r.unlockLevel ?? 1);
          if (needsTable(r)) btn.dataset.station = 'table';
          btn.innerHTML =
            `<span class="craft-name">${out.name} x${r.output.count} · ${r.craftSeconds}s</span>` +
            `<span class="craft-cost">${r.inputs.map((i) => `${i.count} ${ITEMS[i.id].name}`).join(', ')}</span>`;
          btn.addEventListener('click', (e) => {
            e.stopPropagation();
            window.dispatchEvent(new CustomEvent('hud-craft-click', { detail: r.id }));
          });
          craftList.appendChild(btn);
          this.craftItems.push({ el: btn, id: r.id });
        }
      }
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

    // --- Quest offer card (lives inside the chat: an offer is a conversational moment)
    this.questOfferEl = el('quest-offer', this.chatEl);
    this.questOfferEl.hidden = true;

    // --- Settings panel (O): the honest way into the destructive stuff.
    // "Nieuwe wereld" was a secret keyboard shortcut; world-reset now also
    // lives here, behind an explicit two-click confirm INSIDE the button
    // (arm, then confirm) so a single stray click can never nuke a save.
    this.settingsEl = el('settings');
    this.settingsEl.hidden = true;
    const setHead = el('settings-title', this.settingsEl);
    setHead.textContent = 'INSTELLINGEN  (O to close)';

    // --- Controls: the key map, drawn from the game's live bindings.
    // The HUD never decides what a key means: it renders what
    // game.ts hands it (setControls) and reports the key the player pressed.
    const keysHead = el('settings-subtitle', this.settingsEl);
    keysHead.textContent = 'BESTURING';
    this.keyStatus = el('settings-hint', this.settingsEl);
    this.keyStatus.textContent =
      'Klik een knop en druk de toets die je wil — direct actief, opslaan doet dit zelf.';
    this.keysEl = el('keybinds', this.settingsEl);
    const sensRow = el('sens-row', this.settingsEl);
    const sensLabel = document.createElement('span');
    sensLabel.className = 'sens-label';
    sensLabel.textContent = 'Muisgevoeligheid';
    this.sensInput = document.createElement('input');
    this.sensInput.className = 'sens-input';
    this.sensInput.type = 'range';
    this.sensInput.min = '0.2';
    this.sensInput.max = '3';
    this.sensInput.step = '0.05';
    this.sensInput.value = '1';
    this.sensInput.title = 'Hoe snel de camera draait per millimeter muis';
    this.sensInput.addEventListener('input', () => {
      const v = Number(this.sensInput.value);
      this.sensValue.textContent = `${v.toFixed(2)}×`;
      window.dispatchEvent(new CustomEvent('hud-sensitivity', { detail: v }));
    });
    this.sensValue = document.createElement('span');
    this.sensValue.className = 'sens-value';
    this.sensValue.textContent = '1.00×';
    sensRow.append(sensLabel, this.sensInput, this.sensValue);
    this.settingsEl.appendChild(sensRow);

    // --- Beeldkwaliteit. Automatisch is de standaard (het fps-maatwerk van
    // systems/quality.ts), maar de speler mag altijd zelf kiezen — voor iem
    // kan 24 fps scherp beter spelen dan 45 fps van was.
    const qRow = el('sens-row', this.settingsEl);
    const qLabel = document.createElement('span');
    qLabel.className = 'sens-label';
    qLabel.textContent = 'Beeldkwaliteit';
    this.qualitySelect = document.createElement('select');
    this.qualitySelect.className = 'quality-select';
    for (const [value, label] of [
      ['auto', 'Automatisch'],
      ['high', 'Hoog'],
      ['medium', 'Evenwichtig'],
      ['low', 'Laag'],
      ['potato', 'Spaartamodus'],
    ]) {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = label;
      this.qualitySelect.appendChild(opt);
    }
    this.qualitySelect.title =
      'Automatisch past schaduw, bloei en resolutie aan de fps aan; een gekozen kwaliteit blijft staan.';
    this.qualitySelect.addEventListener('change', () => {
      window.dispatchEvent(new CustomEvent('hud-quality', { detail: this.qualitySelect.value }));
    });
    const qHint = document.createElement('span');
    qHint.className = 'sens-value';
    qHint.textContent = 'fps ↔ scherpte';
    qRow.append(qLabel, this.qualitySelect, qHint);
    this.settingsEl.appendChild(qRow);
    this.keysResetBtn = document.createElement('button');
    this.keysResetBtn.className = 'settings-neutral';
    this.keysResetBtn.textContent = 'Besturing terugzetten';
    this.keysResetBtn.title = 'Alles terug naar de standaardtoetsen';
    this.keysResetBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.stopCapture();
      window.dispatchEvent(new CustomEvent('hud-keybinds-reset'));
    });
    this.settingsEl.appendChild(this.keysResetBtn);

    const setHint = el('settings-hint', this.settingsEl);
    setHint.innerHTML =
      'Alles wat hieronder staat is <b>onomkeerbaar</b>. De bevestigingsklik geldt 6 seconden.';
    this.resetBtn = document.createElement('button');
    this.resetBtn.className = 'settings-danger';
    this.resetBtn.textContent = 'Reset wereld (alles wissen)';
    this.resetBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (this.resetBtn.disabled) return;
      if (!this.resetArmed) {
        this.resetArmed = true;
        this.resetBtn.classList.add('armed');
        this.resetBtn.textContent = '✓ Bevestigen — ALLES wissen?';
        if (this.resetArmTimer) clearTimeout(this.resetArmTimer);
        this.resetArmTimer = setTimeout(() => this.disarmReset(), 6000);
        return;
      }
      this.disarmReset();
      window.dispatchEvent(new CustomEvent('hud-reset-world'));
    });
    this.settingsEl.appendChild(this.resetBtn);
    const setClose = document.createElement('button');
    setClose.className = 'settings-close';
    setClose.textContent = 'Sluiten';
    setClose.addEventListener('click', (e) => {
      e.stopPropagation();
      window.dispatchEvent(new CustomEvent('hud-settings-close'));
    });
    this.settingsEl.appendChild(setClose);

    // --- Witch shop panel (E at the cottage): barter potions for the
    // hunt materials. Same event-contract as the crafting grid — the HUD
    // only draws offers and reports clicks; the game owns every trade.
    this.shopEl = el('shop');
    this.shopEl.hidden = true;
    const shopHead = el('shop-title', this.shopEl);
    shopHead.textContent = 'DE HEKS — RUILKAMER  (E to close)';
    this.shopListEl = el('shop-list', this.shopEl);
    const shopClose = document.createElement('button');
    shopClose.className = 'shop-close';
    shopClose.textContent = 'Sluiten';
    shopClose.addEventListener('click', (e) => {
      e.stopPropagation();
      window.dispatchEvent(new CustomEvent('hud-shop-close'));
    });
    this.shopEl.appendChild(shopClose);

    // --- Perk tree panel (K): three branches, one point per level. Same
    // event-contract as the shop: the HUD draws rows and reports clicks,
    // systems/perks.ts decides whether a purchase is legal.
    this.perkEl = el('perk');
    this.perkEl.hidden = true;
    this.perkHeadEl = el('perk-title', this.perkEl);
    this.perkHeadEl.textContent = 'TALENTEN';
    this.perkListEl = el('perk-list', this.perkEl);
    this.perkInfoEl = el('perk-info', this.perkEl);
    const perkClose = document.createElement('button');
    perkClose.className = 'perk-close';
    perkClose.textContent = 'Sluiten';
    perkClose.addEventListener('click', (e) => {
      e.stopPropagation();
      window.dispatchEvent(new CustomEvent('hud-perk-close'));
    });
    this.perkEl.appendChild(perkClose);

    // --- Negotiation panel (N at a village trader): the haggle table of
    // systems/negotiation.ts. Same event contract as the shop — the HUD
    // only draws the current table state and reports clicks; every price
    // move, deal and mood change is decided by the game.
    this.negoEl = el('nego');
    this.negoEl.hidden = true;
    this.negoHeadEl = el('nego-title', this.negoEl);
    this.negoHeadEl.textContent = 'ONDERHANDELEN';
    this.negoListEl = el('nego-list', this.negoEl);
    const negoClose = document.createElement('button');
    negoClose.className = 'nego-close';
    negoClose.textContent = 'Markt verlaten';
    negoClose.addEventListener('click', (e) => {
      e.stopPropagation();
      window.dispatchEvent(new CustomEvent('hud-nego-close'));
    });
    this.negoEl.appendChild(negoClose);

    // --- Active quest tracker (right column, under the survival bars)
    this.questsEl = el('quests', right);
    this.questsEl.hidden = true;

    // --- Bottom-centre stack: mode pill, pointer chip, toast. One flex
    // column (see the field comment) so the three can never cover each other.
    const bottom = el('hud-bottom');
    this.camPillEl = el('cam-pill', bottom);
    this.camPillEl.hidden = true;
    this.pointerEl = el('pointer-chip', bottom);
    this.pointerEl.hidden = true;
    this.toastEl = el('toast', bottom);
    // Multiplayer panel: connection state, YOUR name and who else is in this
    // world. Multiplayer used to be one invisible word in a corner — nobody
    // could see whether they were alone, who the other capsules were, or how
    // to become a person with a name instead of "Speler".
    const mpPanel = el('mp-panel', left);
    this.mpPanelEl = mpPanel;
    this.mpEl = el('mp-status', mpPanel);
    this.mpPlayersEl = el('mp-players', mpPanel);
    this.mpNameEl = document.createElement('input');
    this.mpNameEl.className = 'mp-name';
    this.mpNameEl.maxLength = 24;
    this.mpNameEl.spellcheck = false;
    this.mpNameEl.placeholder = 'Je naam';
    this.mpNameEl.title = 'Je naam voor andere spelers — Enter om te bevestigen';
    mpPanel.appendChild(this.mpNameEl);
    const commitName = () => {
      const name = this.mpNameEl.value.trim();
      if (!name) return;
      window.dispatchEvent(new CustomEvent('hud-mp-name', { detail: name }));
    };
    this.mpNameEl.addEventListener('change', commitName);
    this.mpNameEl.addEventListener('keydown', (e) => {
      // The game listens for keys on the window; a name being typed must
      // never fire WASD, crafting or the inventory panel.
      e.stopPropagation();
      if (e.key === 'Enter') {
        commitName();
        this.mpNameEl.blur();
      }
      if (e.key === 'Escape') this.mpNameEl.blur();
    });
    this.mpNameEl.addEventListener('focus', () => {
      // Typing a name and steering the camera are mutually exclusive.
      try {
        document.exitPointerLock?.();
      } catch {
        /* not locked, nothing to release */
      }
    });
    this.mpNameEl.addEventListener('pointerdown', (e) => e.stopPropagation());
    this.fpsEl = el('fps', left);
    // The cheat sheet closes the left column: collapsed it is one quiet chip,
    // expanded it grows DOWNWARD into space that is empty anyway — never over
    // the hotbar, the toast or the craft menu.

    this.hintsEl = el('hud-hints', left);
    const hintsHead = document.createElement('div');
    hintsHead.className = 'hud-hints-head';
    hintsHead.innerHTML = '<b>⌨</b> Besturing <span> — klik of druk <b>H</b></span>';
    hintsHead.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleHints();
    });
    hintsHead.title = 'Besturing tonen of verbergen (H)';
    this.hintsEl.appendChild(hintsHead);
    const hintsBody = el('hud-hints-body', this.hintsEl);
    this.hintsBodyEl = hintsBody;
    // Rows are GENERATED from the live key map (renderHints) the moment the
    // sheet opens — hand-written captions are what made this panel lie.
    // Collapsed by default: the full cheat sheet is there when you want it,
    // but it must not live on screen forever. The choice is remembered.
    try {
      this.hintsOpen = localStorage.getItem(HINTS_STORAGE_KEY) === '1';
    } catch {
      this.hintsOpen = false;
    }
    this.applyHints();
    window.addEventListener('keydown', (e) => {
      // H is not bound to any game action (see systems/keybinds.ts), so the
      // shell can own it. Never while the player is typing somewhere.
      if (e.code !== 'KeyH') return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      this.toggleHints();
    });
    // World-space nametags for remote players get projected into this layer.
    this.mpTagsEl = el('mp-tags');

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
    [this.hotbarEl, this.craftEl, this.chatEl, this.deathEl, this.mpPanelEl, this.mpNameEl, this.invEl, this.settingsEl, this.shopEl, this.perkEl, this.negoEl].forEach((e) => {
      e.style.pointerEvents = 'auto';
    });
  }

  /** Show/hide the control cheat sheet (H or a click on its header). */
  private toggleHints(): void {
    this.hintsOpen = !this.hintsOpen;
    try {
      localStorage.setItem(HINTS_STORAGE_KEY, this.hintsOpen ? '1' : '0');
    } catch {
      /* private mode: the toggle still works for this session */
    }
    this.applyHints();
  }

  /**
   * (Re-)build the cheat-sheet rows FROM THE LIVE KEY MAP. A hand-written
   * list of captions is how this panel grew stale — it promised keys that the
   * settings menu had long since moved — and the player can rebind every
   * action, so the only honest source is `this.bindings` (falling back to
   * DEFAULT_BINDINGS before the game has pushed them).
   */
  private renderHints(): void {
    const key = (id: Action): string => keyLabel(this.bindings[id] ?? DEFAULT_BINDINGS[id]);
    const row = (tag: string, html: string): string =>
      `<div class="hint-row"><span class="hint-tag">${tag}</span><span>${html}</span></div>`;
    this.hintsBodyEl.innerHTML = [
      row(
        'Bewegen',
        `<b>${key('forward')} ${key('back')} ${key('left')} ${key('right')}</b> lopen · <b>${key('sprint')}</b> sprint · <b>${key('jump')}</b> jump &amp; zwemmen · <b>${key('crouch')}</b> hurken · <b>pijltjestoetsen</b> altijd: kijken en een blok mikken`,
      ),
      row(
        'Handelen',
        `<b>${key('attack')}</b> hakken, kappen, breken, vechten · <b>${key('interact')}</b> praten, vuur, bed, deur, mand — en je <b>tekentafel</b> openen · <b>${key('harvest')}</b> bessen &amp; klein wild · <b>${key('consume')}</b> eten &amp; drinken · <b>${key('buildUp')}/${key('buildDown')}</b> hoogte van een bouwblok`,
      ),
      row(
        'Maken',
        `<b>${key('craft')}</b> maakmenu · <b>${key('inventory')}</b> rugzak · <b>${key('slot1')}…${key('slot8')}</b> hotbar · <b>${key('drop')}</b> gooien · aan je <b>eigen tekentafel</b> gaat alles <b>40% sneller</b> en is de rest vrij`,
      ),
      row(
        'Kijken',
        `<b>scrollwiel</b> zoomt de camera in tot je in <b>je eigen ogen</b> staat en weer terug · <b>RMuisknop</b> geeft de muis vrij, zodat je met de cursor op de hotbar en vensterknoppen kunt klikken · <b>klik in de wereld</b> pakt de muis weer op · die twee muisknoppen zijn vast (wel te veranderen via <b>${key('settings')}</b>: kijkgevoeligheid)`,
      ),
      row(
        'Scherm',
        `<b>${key('settings')}</b> instellingen (elke toets te veranderen) · <b>${key('close')}</b> Vensters sluiten · <b>H</b> deze lijst in/uit · oogsten, maken en bouwen geeft <b>XP</b> — levels maken recepten vrij`,
      ),
    ].join('');
  }

  private applyHints(): void {
    this.hintsEl.classList.toggle('open', this.hintsOpen);
    this.renderHints();
  }

  /** Revert the reset button to its unarmed label. */
  private disarmReset(): void {
    this.resetArmed = false;
    if (this.resetArmTimer) {
      clearTimeout(this.resetArmTimer);
      this.resetArmTimer = null;
    }
    this.resetBtn.classList.remove('armed');
    this.resetBtn.textContent = this.resetShared
      ? 'Reset wereld (ALLES op de server)'
      : 'Reset wereld (alles wissen)';
  }

  /**
   * Show/hide the settings panel. `shared` says the world lives on the
   * server — the button then resets the SHARED world (every player's
   * buildings and progress), which the server executes and broadcasts.
   * It is deliberately NOT disabled anymore: this game is always
   * server-backed, so a button that could never be pressed reset nothing.
   */
  setSettings(open: boolean, shared = false): void {
    this.settingsEl.hidden = !open;
    if (!open) {
      this.disarmReset();
      // Closing mid-rebind must not leave the world frozen or a row lit.
      this.stopCapture();
    }
    this.resetShared = shared;
    this.resetBtn.textContent = shared
      ? 'Reset wereld (ALLES op de server)'
      : 'Reset wereld (alles wissen)';
    this.resetBtn.title = shared
      ? 'Wist de serverwereld: gebouwen, grondstoffen en voortgang van álle spelers'
      : 'Wist je lokale opslag en herstart de pagina';
  }

  /**
   * Draw the key map. Called whenever the panel opens and after every
   * successful rebind, so what is on screen is the map the game plays with.
   * `warning` is the reason a refused rebind failed (rendered in red).
   */
  setControls(bindings: Bindings, mouseSens: number, warning?: string | null): void {
    this.bindings = { ...bindings };
    // The cheat sheet quotes these same captions, so a rebind refreshes it.
    this.applyHints();
    this.sensInput.value = String(clampMouseSens(mouseSens));
    this.sensValue.textContent = `${Number(this.sensInput.value).toFixed(2)}×`;
    this.keyStatus.classList.toggle('warn', Boolean(warning));
    this.keyStatus.textContent = warning ??
      'Klik een knop en druk de toets die je wil — direct actief, opslaan doet dit zelf.';
    this.keysEl.innerHTML = '';
    for (const group of KEYBIND_GROUPS) {
      const head = document.createElement('div');
      head.className = 'keybind-group';
      head.textContent = group.title;
      this.keysEl.appendChild(head);
      for (const action of group.actions) {
        this.keysEl.appendChild(this.keyRow(action));
      }
    }
    // The row being rebound has to be visible while the panel is open.
    if (this.rebind) this.markRebinding(this.rebind);
  }

  /** A single "Vooruit  [W]" row, with the keys that always work too. */
  private keyRow(action: Action): HTMLElement {
    const row = document.createElement('div');
    row.className = 'keybind-row';
    row.dataset.action = action;
    const label = document.createElement('span');
    label.className = 'keybind-label';
    label.textContent = ACTION_LABEL[action];
    const btn = document.createElement('button');
    btn.className = 'keybind-key';
    btn.textContent = keyLabel(this.bindings[action]);
    btn.title = 'Klik, dan de nieuwe toets';
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (performance.now() < this.clickGuardUntil) return;
      if (this.rebind === action) {
        this.stopCapture();
        return;
      }
      this.startCapture(action);
    });
    row.append(label, btn);
    const alts = alternatesFor(action);
    if (alts.length > 0) {
      const also = document.createElement('span');
      also.className = 'keybind-also';
      also.textContent = `ook: ${alts.map(keyLabel).join(', ')}`;
      row.appendChild(also);
    }
    return row;
  }

  /**
   * Start listening for one key to bind. The capture phase on window is
   * deliberate: the game's own keydown listener sits on window in the bubble
   * phase, so stopping propagation here means the pressed key can never also
   * trigger the action it is being bound to.
   */
  private startCapture(action: Action): void {
    this.stopCapture();
    this.rebind = action;
    window.dispatchEvent(new CustomEvent('hud-rebind-start', { detail: action }));
    this.keyStatus.classList.remove('warn');
    this.keyStatus.textContent = `Kies een toets voor ${ACTION_LABEL[action]}… (Esc = afbreken)`;
    window.addEventListener('keydown', this.onCaptureKey, true);
    window.addEventListener('mousedown', this.onCaptureMouse, true);
    document.addEventListener('keydown', this.onCaptureKey, true);
    document.addEventListener('mousedown', this.onCaptureMouse, true);
    document.addEventListener('contextmenu', this.onCaptureContext, true);
    this.markRebinding(action);
  }

  private stopCapture(): void {
    window.removeEventListener('keydown', this.onCaptureKey, true);
    window.removeEventListener('mousedown', this.onCaptureMouse, true);
    document.removeEventListener('keydown', this.onCaptureKey, true);
    document.removeEventListener('mousedown', this.onCaptureMouse, true);
    document.removeEventListener('contextmenu', this.onCaptureContext, true);
    if (this.rebind !== null) {
      this.rebind = null;
      this.markRebinding(null);
      window.dispatchEvent(new CustomEvent('hud-rebind-cancel'));
    }
  }

  private markRebinding(action: Action | null): void {
    for (const el2 of Array.from(this.keysEl.querySelectorAll<HTMLElement>('.keybind-row'))) {
      el2.classList.toggle('capturing', el2.dataset.action === action);
    }
  }

  /** Show which row is waiting for a key (set by the game, the source of truth). */
  setRebinding(action: Action | null): void {
    if (action === null) this.stopCapture();
    else this.markRebinding(action);
  }

  private onCaptureContext = (e: Event): void => {
    // Right-button rebinds must not open the browser menu instead.
    e.preventDefault();
  };

  private onCaptureKey = (e: KeyboardEvent): void => {
    e.preventDefault();
    e.stopPropagation();
    const action = this.rebind;
    if (!action) return;
    if (e.key === 'Escape') {
      this.stopCapture();
      return;
    }
    this.stopCapture();
    // e.code is the PHYSICAL key, so a French keyboard binds the key under the
    // finger, whatever letter is printed on it (systems/keybinds.ts alternates).
    window.dispatchEvent(
      new CustomEvent('hud-rebind', { detail: { action, code: e.code } }),
    );
  };
  private onCaptureMouse = (e: MouseEvent): void => {
    e.preventDefault();
    e.stopPropagation();
    const action = this.rebind;
    if (!action) return;
    // The `click` that follows a mouse binding must not arm another row.
    this.clickGuardUntil = performance.now() + 350;
    this.stopCapture();
    window.dispatchEvent(
      new CustomEvent('hud-rebind', { detail: { action, code: `Mouse${e.button}` } }),
    );
  };

  /**
   * Draw the witch's offers. `rows` carries everything the HUD needs
   * (label, price line, affordability) — trade logic stays in the game.
   */
  setShop(
    open: boolean,
    rows: Array<{ id: string; name: string; price: string; afford: boolean }>,
  ): void {
    this.shopEl.hidden = !open;
    if (!open) return;
    this.shopListEl.innerHTML = '';
    for (const r of rows) {
      const row = document.createElement('div');
      row.className = 'shop-row' + (r.afford ? ' afford' : '');
      const icon = document.createElement('span');
      icon.className = 'shop-icon';
      const iconSvg = SHOP_ICON_BY_GIVE[r.id];
      if (iconSvg) icon.innerHTML = iconSvg;
      const nameEl = document.createElement('span');
      nameEl.className = 'shop-name';
      nameEl.textContent = r.name;
      const priceEl = document.createElement('span');
      priceEl.className = 'shop-price';
      priceEl.textContent = r.price;
      const btn = document.createElement('button');
      btn.className = 'shop-buy';
      btn.textContent = 'Ruilen';
      btn.disabled = !r.afford;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (btn.disabled) return;
        window.dispatchEvent(new CustomEvent('hud-trade', { detail: r.id }));
      });
      row.appendChild(icon);
      row.appendChild(nameEl);
      row.appendChild(priceEl);
      row.appendChild(btn);
      this.shopListEl.appendChild(row);
    }
  }

  /**
   * Draw the perk TREE (systems/perks.ts via game.ts). Nodes arrive with
   * layout coordinates computed from the parent-child structure — x is a
   * 0..100 percentage, row is the depth — and the HUD draws the real branch
   * shape: SVG connectors behind absolutely positioned node cards, so the
   * player sees the root first and the choices hanging under it. A connector
   * lights up along the owned path ('on'), glows while it leads to something
   * buyable ('ready') and stays dim while the parent is locked.
   */
  setPerks(
    open: boolean,
    points: number,
    nodes: Array<{
      id: string;
      name: string;
      desc: string;
      parent: string | null;
      x: number;
      row: number;
      state: 'buy' | 'owned' | 'locked' | 'poor';
    }>,
  ): void {
    this.perkEl.hidden = !open;
    if (!open) return;
    this.perkHeadEl.textContent = `TALENTEN — ${points} punt${points === 1 ? '' : 'en'} te vergeven  (K of Esc sluit)`;
    this.perkListEl.innerHTML = '';
    const maxRow = nodes.reduce((m, n) => Math.max(m, n.row), 0);
    const ROW_H = 98;
    const NODE_H = 64;
    const height = (maxRow + 1) * ROW_H + 6;
    this.perkListEl.style.height = `${height}px`;
    const byId = new Map(nodes.map((n) => [n.id, n]));

    // Connectors first, so nodes sit on top of their branches.
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'perk-links');
    svg.setAttribute('viewBox', `0 0 100 ${height}`);
    svg.setAttribute('preserveAspectRatio', 'none');
    for (const n of nodes) {
      if (!n.parent) continue;
      const p = byId.get(n.parent);
      if (!p) continue;
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      const y1 = p.row * ROW_H + NODE_H - 4;
      const y2 = n.row * ROW_H + 2;
      const mid = (y1 + y2) / 2;
      path.setAttribute('d', `M ${p.x} ${y1} C ${p.x} ${mid}, ${n.x} ${mid}, ${n.x} ${y2}`);
      path.setAttribute(
        'class',
        p.state === 'owned' ? (n.state === 'owned' ? 'on' : 'ready') : 'off',
      );
      svg.appendChild(path);
    }
    this.perkListEl.appendChild(svg);

    for (const n of nodes) {
      const node = document.createElement('button');
      node.className = `perk-node s-${n.state}`;
      node.style.left = `${n.x}%`;
      node.style.top = `${n.row * ROW_H}px`;
      node.innerHTML =
        `<span class="pn-mark">${n.state === 'owned' ? '✓' : n.state === 'locked' ? '✦' : '★'}</span>` +
        `<span class="pn-name">${n.name}</span>`;
      node.addEventListener('click', (e) => {
        e.stopPropagation();
        if (n.state !== 'buy') return;
        window.dispatchEvent(new CustomEvent('hud-perk-buy', { detail: n.id }));
      });
      node.addEventListener('mouseenter', () => {
        const tail =
          n.state === 'owned' ? ' — eigen' : n.state === 'buy' ? ' — klik om te kopen (1 punt)' : '';
        this.perkInfoEl.textContent = `${n.name} — ${n.desc}${tail}`;
      });
      node.addEventListener('mouseleave', () => this.perkDefaultInfo(points));
      this.perkListEl.appendChild(node);
    }
    this.perkDefaultInfo(points);
  }

  private perkDefaultInfo(points: number): void {
    this.perkInfoEl.textContent =
      points > 0
        ? 'Beweeg over een talent voor de werking · klik een gloeiend talent om te kopen'
        : 'Per level verdien je een talentpunt. De wortel ontgrendelt de keuze.';
  }

  /**
   * Draw one negotiation table (systems/negotiation.ts). The HUD renders
   * what the session currently says — ask, your bid, the villager's last
   * remark — and reports button presses as custom events. All numbers are
   * owned by the game.
   */
  setNegotiate(
    open: boolean,
    header: string,
    rows: Array<{
      id: string;
      label: string;
      askText: string;
      say: string;
      bid: number;
      bidText: string;
      canHaggle: boolean;
      canDeal: boolean;
      dealLabel: string;
    }>,
  ): void {
    this.negoEl.hidden = !open;
    if (!open) return;
    this.negoHeadEl.textContent = header;
    this.negoListEl.innerHTML = '';
    for (const r of rows) {
      const row = document.createElement('div');
      row.className = 'nego-row' + (r.canDeal ? ' deal' : '');
      const top = document.createElement('div');
      top.className = 'nego-top';
      top.textContent = `${r.label} — ${r.askText}`;
      const mid = document.createElement('div');
      mid.className = 'nego-mid';
      const minus = document.createElement('button');
      minus.className = 'nego-step';
      minus.textContent = '−';
      minus.disabled = !r.canHaggle;
      minus.addEventListener('click', (e) => {
        e.stopPropagation();
        window.dispatchEvent(new CustomEvent('hud-nego-bid', { detail: { id: r.id, delta: -1 } }));
      });
      const bid = document.createElement('span');
      bid.className = 'nego-bid';
      bid.textContent = r.bidText;
      const plus = document.createElement('button');
      plus.className = 'nego-step';
      plus.textContent = '+';
      plus.disabled = !r.canHaggle;
      plus.addEventListener('click', (e) => {
        e.stopPropagation();
        window.dispatchEvent(new CustomEvent('hud-nego-bid', { detail: { id: r.id, delta: 1 } }));
      });
      const offer = document.createElement('button');
      offer.className = 'nego-haggle';
      offer.textContent = 'Bieden';
      offer.disabled = !r.canHaggle;
      offer.addEventListener('click', (e) => {
        e.stopPropagation();
        window.dispatchEvent(new CustomEvent('hud-nego-haggle', { detail: r.id }));
      });
      const deal = document.createElement('button');
      deal.className = 'nego-deal';
      deal.textContent = r.dealLabel;
      deal.disabled = !r.canDeal;
      deal.addEventListener('click', (e) => {
        e.stopPropagation();
        window.dispatchEvent(new CustomEvent('hud-nego-deal', { detail: r.id }));
      });
      mid.append(minus, bid, plus, offer, deal);
      const say = document.createElement('div');
      say.className = 'nego-say';
      say.textContent = `“${r.say}”`;
      row.append(top, mid, say);
      this.negoListEl.appendChild(row);
    }
  }

  /**
   * Draw a quest offer an NPC just proposed. Accept/decline travel back to
   * the game through custom events — the HUD never mutates quest state.
   */
  showQuestOffer(id: string, title: string, desc: string, goal: string, xp: number): void {
    this.questOfferEl.innerHTML = '';
    const head = document.createElement('div');
    head.className = 'quest-offer-title';
    head.textContent = `📜 ${title}`;
    const body = document.createElement('div');
    body.className = 'quest-offer-desc';
    body.textContent = desc;
    const goalEl = document.createElement('div');
    goalEl.className = 'quest-offer-goal';
    goalEl.textContent = `${goal} · beloning ${xp} XP`;
    const row = document.createElement('div');
    row.className = 'quest-offer-row';
    const yes = document.createElement('button');
    yes.className = 'quest-yes';
    yes.textContent = 'Aannemen';
    yes.addEventListener('click', (e) => {
      e.stopPropagation();
      this.questOfferEl.hidden = true;
      this.questOfferEl.innerHTML = '';
      window.dispatchEvent(new CustomEvent('hud-quest-accept', { detail: id }));
    });
    const no = document.createElement('button');
    no.className = 'quest-no';
    no.textContent = 'Niet nu';
    no.addEventListener('click', (e) => {
      e.stopPropagation();
      this.questOfferEl.hidden = true;
      this.questOfferEl.innerHTML = '';
      window.dispatchEvent(new CustomEvent('hud-quest-decline', { detail: id }));
    });
    row.appendChild(yes);
    row.appendChild(no);
    this.questOfferEl.appendChild(head);
    this.questOfferEl.appendChild(body);
    this.questOfferEl.appendChild(goalEl);
    this.questOfferEl.appendChild(row);
    this.questOfferEl.hidden = false;
  }

  /** Redraw the active-quest tracker list. Empty list hides the panel. */
  setQuests(list: Array<{ id: string; title: string; text: string }>): void {
    this.questsEl.innerHTML = '';
    if (!list.length) {
      this.questsEl.hidden = true;
      return;
    }
    this.questsEl.hidden = false;
    for (const q of list) {
      const row = document.createElement('div');
      row.className = 'quest-row';
      const t = document.createElement('span');
      t.className = 'quest-title';
      t.textContent = q.title;
      const p = document.createElement('span');
      p.className = 'quest-goal';
      p.textContent = q.text;
      row.appendChild(t);
      row.appendChild(p);
      this.questsEl.appendChild(row);
    }
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
   * Recipes that require a higher level than `level` are shown locked, and
   * the station line says whether the player is standing at their own
   * tekentafel (`atTable`) — without it, every table recipe stays locked too.
   */
  setCrafting(
    open: boolean,
    canCraft: Set<string>,
    craftingId: string | null = null,
    level = Infinity,
    atTable = true,
  ): void {
    this.craftEl.hidden = !open;
    if (open) {
      this.craftStationEl.textContent = atTable
        ? 'Aan je tekentafel — alles beschikbaar, 40% sneller'
        : 'In het veld — alleen handwerk · bouw een tekentafel voor de rest';
      this.craftStationEl.classList.toggle('at-table', atTable);
    }
    for (const c of this.craftItems) {
      const recipe = RECIPES.find((r) => r.id === c.id)!;
      const busy = c.id === craftingId;
      const locked = level < (recipe.unlockLevel ?? 1);
      // The station is a separate lock from the level: it disappears by
      // WALKING, not by playing. It wins the visible tag when both apply,
      // because "loop naar je tafel" is the answer the player can act on now.
      const offStation = needsTable(recipe) && !atTable;
      c.el.classList.toggle('off-station', offStation && !busy);
      const ok = !craftingId && !locked && !offStation && canCraft.has(c.id);
      c.el.disabled = !ok && !busy;
      c.el.classList.toggle('can', ok);
      c.el.classList.toggle('busy', busy);
      c.el.classList.toggle('locked', locked && !busy);
      c.el.title = locked && !offStation
        ? `Vergrend — vereist level ${recipe.unlockLevel}`
        : offStation
          ? `Alleen aan je eigen tekentafel te maken${locked ? ` (plus level ${recipe.unlockLevel})` : ''} — loop erheen of druk E bij de tafel`
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
    // A declined-by-ignoring offer stays in the log: reopening the chat
    // shows the card again until the player accepts or declines.
    this.questOfferEl.hidden = !this.questOfferEl.childElementCount;
  }

  addChatLine(who: string, text: string, dim = false, speaker?: string): void {
    const line = document.createElement('div');
    line.className = 'chat-line' + (dim ? ' dim' : '');
    const whoSpan = document.createElement('span');
    whoSpan.className = 'chat-who';
    whoSpan.textContent = who + ': ';
    const body = document.createElement('span');
    body.textContent = text;
    // In multiplayer everyone hears the conversation. Without the byline you
    // could not tell whether the villager was answering YOU or your friend.
    if (speaker) line.classList.add('other-speaker');
    line.append(whoSpan, body);
    if (speaker) {
      const by = document.createElement('span');
      by.className = 'chat-byline';
      by.textContent = `tegen ${speaker}`;
      line.appendChild(by);
    }
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

  /**
   * Show which view the scrollwheel just produced. `show` is driven by a
   * timer in the game loop, so the pill explains the gesture while it is being
   * performed and then gets out of the way — a permanent "1e persoon" badge
   * would be a second crosshair-sized thing on the screen for no reason.
   *
   * Cheap to call every frame: it touches the DOM only when something changed.
   */
  setCameraView(firstPerson: boolean, show: boolean): void {
    if (show && firstPerson !== this.camPillFp) {
      this.camPillFp = firstPerson;
      this.camPillEl.textContent = firstPerson
        ? 'Eerste persoon — scroll om uit te zoomen'
        : 'Derde persoon — scroll om in te zoomen';
    }
    if (show === this.camPillOn) return;
    this.camPillOn = show;
    this.camPillEl.hidden = !show;
  }

  /**
   * The cursor is free (right button released it, or Esc / alt-tab did). This
   * chip is what makes that state survivable: without it the mouse simply
   * "stops working" from the player's point of view, and the natural reaction
   * is to thrash the mouse or press random keys.
   *
   * It says BOTH halves of the contract, because the browser needs a click
   * inside the world to take the mouse back and — by design — the right button
   * will not do it.
   */
  setPointerReleased(released: boolean): void {
    this.pointerEl.hidden = !released;
  }

  setMpStatus(text: string): void {
    this.mpEl.textContent = text;
    this.mpEl.classList.toggle('offline', text.startsWith('Solo'));
  }

  /**
   * The in-world roster. `count` is everyone connected (other players plus
   * yourself); the names are listed so you know who to look for.
   */
  setMpPlayers(names: string[]): void {
    this.mpPlayersEl.textContent = names.length ? names.join(' · ') : '';
  }

  /** Pre-fill the name box (never overwrite what the player is typing). */
  setMpName(name: string): void {
    if (this.mpNameEl === document.activeElement) return;
    this.mpNameEl.value = name;
  }

  /** DOM layer that receives the projected world-space nametags. */
  get mpTagLayer(): HTMLElement {
    return this.mpTagsEl;
  }

  setFps(fps: number): void {
    this.fpsEl.textContent = `${fps} fps`;
    this.fpsEl.classList.toggle('low', fps < 30);
  }

  /** Show the current image-quality mode in the settings dropdown. */
  setQualityMode(mode: string): void {
    this.qualitySelect.value = mode;
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
    // The rebind capture listens on window/document (capture phase) and the
    // reset-arm uses a timer: both outlive the DOM, so they are dropped here.
    this.stopCapture();
    if (this.resetArmTimer) clearTimeout(this.resetArmTimer);
    this.root.remove();
  }
}
