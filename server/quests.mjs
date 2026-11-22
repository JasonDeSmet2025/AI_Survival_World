/**
 * Quest proposals (AI Agent scope).
 *
 * The LLM may PROPOSE a quest; it can never create one. Every quest the
 * model can possibly mention lives in QUEST_TEMPLATES below: the model only
 * ever sees the ids of quests belonging to the NPC it speaks for, and the
 * only way it can express a quest is the marker `MISSIE:<id>` at the end of
 * its reply. parseQuestOffer() strips the marker and validates the id
 * against:
 *   - the template table (title, goal and reward come from HERE, never from
 *     the model, so it cannot promise rewards the game cannot pay),
 *   - the offering NPC (Mara cannot hand out Tomas' quests),
 *   - the client-reported active/completed quests (no double offers),
 *   - the server-side offered-set per session (the same quest is never
 *     handed out twice by the same NPC while pending or after completion).
 *
 * The goal types below are exactly the events the game client can verify
 * deterministically (gather/craft/build/cook/talk). A quest the game cannot
 * verify is not a quest, so it does not exist here.
 */

export const QUEST_TEMPLATES = {
  mara_bessen: {
    id: 'mara_bessen',
    npc: 'mara',
    title: 'Bessen plukken',
    desc: 'Mara heeft honger. Pluk 4 bessen uit de struiken.',
    goal: { type: 'gather', item: 'berry', count: 4 },
    reward: { xp: 15, items: [] },
  },
  mara_kook: {
    id: 'mara_kook',
    npc: 'mara',
    title: 'Rood vruchtensap',
    desc: 'Kook 1 bes boven een kampvuur; gekookt eten is veiliger.',
    goal: { type: 'cook', item: 'cooked_berry', count: 1 },
    reward: { xp: 20, items: [{ id: 'berry', count: 3 }] },
  },
  mara_klets: {
    id: 'mara_klets',
    npc: 'mara',
    title: 'Praat eens met Tomas',
    desc: 'Mara wil dat je gaat praten met Tomas, de timmerman bij het kamp.',
    goal: { type: 'talk', npc: 'tomas', count: 1 },
    reward: { xp: 10, items: [] },
  },
  tomas_hout: {
    id: 'tomas_hout',
    npc: 'tomas',
    title: 'Bouwhout',
    desc: 'Tomas heeft 6 stuks hout nodig voor zijn onderdak.',
    goal: { type: 'gather', item: 'wood', count: 6 },
    reward: { xp: 15, items: [] },
  },
  tomas_steen: {
    id: 'tomas_steen',
    npc: 'tomas',
    title: 'Steen voor de haard',
    desc: 'Tomas wil 4 steen uit de rotsen voor een stevige haard.',
    goal: { type: 'gather', item: 'stone', count: 4 },
    reward: { xp: 15, items: [{ id: 'berry', count: 2 }] },
  },
  tomas_vuur: {
    id: 'tomas_vuur',
    npc: 'tomas',
    title: 'Vuur maken',
    desc: 'Bouw 1 kampvuur. Zonder vuur slaap je hier niet.',
    goal: { type: 'build', kind: 'campfire', count: 1 },
    reward: { xp: 25, items: [] },
  },
};

/** Quest ids one specific NPC is allowed to hand out. */
export function questsForNpc(npcId) {
  return Object.values(QUEST_TEMPLATES).filter((q) => q.npc === npcId);
}

/**
 * The prompt block that teaches the NPC its roleplay job and its quest
 * options. `done` = ids the client reports as active OR completed OR already
 * offered; those are never listed again.
 */
export function questInstruction(npcId, done = []) {
  const skip = new Set((done ?? []).map((s) => String(s).toLowerCase()));
  const open = questsForNpc(npcId).filter((q) => !skip.has(q.id));
  const lines = [
    'Rolspel: je bent deze persoon, altijd en volledig. Speel écht rol: heb een mening,' +
      ' toon gevoel ( trots, bezorgd, nieuwsgierig), en stel ZELF ook een vraag aan de speler' +
      ' als het gesprek daar om vraagt — max één vraag per bericht. Haak aan op wat de speler' +
      ' eerder zei. Je mag kleine opdrachten (missies) geven uit de lijst hieronder.' +
      ' Vind je dat de speler iets nuttigs heeft gedaan, laat dan blijken dat je het zag.',
  ];
  if (open.length) {
    lines.push(
      'Missies die je kunt geven: ' +
        open.map((q) => `${q.id} (${q.title}: ${q.desc})`).join(' | ') +
        '. Geef een missie alleen als de speler vraagt om werk of als het gesprek erom vraagt.' +
        ' Doe dat door je antwoord te BEINDIGEN met precies "MISSIE:<id>" op een nieuwe regel' +
        ' (bijv. MISSIE:' + open[0].id + '). Noem het id niet in je gewone tekst, maximaal één' +
        ' missie per bericht, en geen missie als de speler al een openstaande missie van jou heeft.',
    );
  } else {
    lines.push(
      'Je hebt al al het werk dat je hebt gegeven weggegeven of de speler heeft het al gedaan:' +
        ' geef geen nieuwe missie en schrijf nooit MISSIE:<id>.',
    );
  }
  return lines.join('\n');
}

const MARKER = /(?:^|\s)MISSIE\s*:\s*([a-z][a-z0-9_]{1,31})/i;
const MARKER_ALL = /(?:^|\s)MISSIE\s*:\s*[a-z][a-z0-9_]{1,31}/gi;

/**
 * Extract and validate one quest offer from the raw model reply.
 *
 * @param {string} raw the unsanitized model output
 * @param {object} v
 * @param {string} v.npcId           the NPC that just spoke
 * @param {string[]} [v.active]      quest ids the client has in progress
 * @param {string[]} [v.completed]   quest ids the client finished
 * @param {string[]} [v.offered]     ids this NPC already offered this session
 * @returns {{ text: string, quest: object|null }} text = reply WITHOUT the
 *          marker (ready for sanitizeReply); quest = the trusted template.
 */
export function parseQuestOffer(raw, v) {
  if (typeof raw !== 'string') return { text: raw ?? '', quest: null };
  const m = raw.match(MARKER);
  if (!m) return { text: raw, quest: null };
  const id = m[1].toLowerCase();
  const template = Object.prototype.hasOwnProperty.call(QUEST_TEMPLATES, id) ? QUEST_TEMPLATES[id] : null;
  const bad = !template || template.npc !== v.npcId || inList(v.active, id) || inList(v.completed, id) || inList(v.offered, id);
  // The marker is ALWAYS stripped (every occurrence), even when rejected:
  // the player must never see internal ids in dialogue.
  const text = raw.replace(MARKER_ALL, '').replace(/\s+$/, '').trim();
  return { text, quest: bad ? null : template };
}

function inList(list, id) {
  return Array.isArray(list) && list.some((x) => String(x).toLowerCase() === id);
}

/** Client-supplied quest id lists, sanitized for prompt/log use. */
export function cleanQuestIds(list, limit = 8) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((x) => typeof x === 'string' && /^[a-z][a-z0-9_]{1,31}$/i.test(x.trim()))
    .map((x) => x.trim().toLowerCase())
    .slice(0, limit);
}
