/**
 * NPC conversation service (AI Agent scope).
 *
 * Both chat entry points of the game server — POST /api/chat (solo client)
 * and the WebSocket "chat" message (multiplayer) — funnel through
 * createNpcBrain() below. That makes this module the single place that owns:
 *
 *  1. NPC personas (identity + system prompt). Before this module the same
 *     two personas existed twice (server.mjs and src/game/ai/npc.ts) AND were
 *     assembled into two slightly different prompts, so a solo conversation
 *     and a multiplayer conversation with "the same" NPC were two different
 *     characters. server/llm.mjs stays transport-only (model resolution);
 *     who the NPC is lives here.
 *  2. Prompt assembly with a hard character budget. A client used to be able
 *     to send 12 history entries of 2000 characters each plus unbounded
 *     context lines, which is paid gateway input every single message.
 *  3. Server-side NPC memory. The client has a per-save MemoryStore
 *     (src/game/ai/memory.ts) which is exactly the right place for *the
 *     player's* copy of what an NPC knows. It cannot help multiplayer: the
 *     server only saw whatever the sending client felt like attaching, so an
 *     NPC forgot everything on reconnect and knew nothing about the other
 *     players it had just talked to. NpcMemory below is the NPC's own,
 *     authoritative, per-(npc, player) memory: it survives reconnects and
 *     server-restart-free sessions, is shared by whoever talks to that NPC,
 *     and — critically — the LLM only ever READS it, it can never write it.
 *  4. Cost and abuse guardrails. One gateway call per pending message per
 *     player, a global cap on concurrent gateway calls, and a token bucket so
 *     a spamming client cannot spend the gateway budget of the whole server.
 *  5. Reply hygiene. Model output is sanitized HERE, before it is broadcast,
 *     so no client ever has to trust raw model text (the client still
 *     sanitizes as defense in depth — a compromised server is not a threat
 *     model, but a buggy model is).
 *
 * Deterministic: no Math.random(), no Date.now() inside the pure helpers;
 * clocks and the gateway are injected so everything below is unit-testable.
 * Credentials: the API key is only ever read through the injected key()
 * callback and never appears in a return value, log line or error message.
 */

import { questInstruction, parseQuestOffer, cleanQuestIds } from './quests.mjs';

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/** A single player message longer than this is cut (not rejected). */
export const MAX_PLAYER_MESSAGE = 500;
/** Hard cap for one NPC line (mirrors src/game/ai/reply.ts). */
export const MAX_REPLY_LENGTH = 400;
/** Dialog turns fed to the model per request. */
export const PROMPT_TURNS = 12;
/** Dialog turns kept per (npc, player) session on the server. */
export const TRANSCRIPT_LIMIT = 40;
/** Character budget for transcript content inside one prompt. */
export const MAX_PROMPT_CHARS = 4000;
/** Durable notes per session. */
export const MAX_MEMORY_NOTES = 12;
/** Notes fed into one prompt. */
export const MAX_MEMORY_LINES = 5;
/** Relationship clamp (mirrors the client MemoryStore). */
export const RELATIONSHIP_LIMIT = 100;
/** Fallback persona for an NPC the server does not know by id. */
export const MAX_NPC_ID_LENGTH = 32;
/** Sessions kept in memory before the least recently used one is forgotten. */
export const SESSION_LIMIT = 256;
/** Gateway calls in flight for one player+npc before "wait" is answered. */
export const PENDING_LIMIT = 2;
/** After this a pending entry is considered lost and its slot is freed. */
export const PENDING_TTL_MS = 25_000;
/** Conversations idle longer than this are forgotten (memory must not grow forever). */
export const DEFAULT_IDLE_TTL_MS = 60 * 60 * 1000;
/** Gateway calls allowed per player per refill window (token bucket). */
export const CHAT_BURST = Number(process.env.NPC_CHAT_BURST || 5);
/** Milliseconds per restored token after a burst is spent. */
export const CHAT_REFILL_MS = Math.max(1, Number(process.env.NPC_CHAT_REFILL_MS || 5000));
/** Concurrent gateway calls across ALL players. */
export const MAX_INFLIGHT = Math.max(1, Number(process.env.NPC_MAX_INFLIGHT || 4));

// ---------------------------------------------------------------------------
// Personas — single source of truth for the server side
// ---------------------------------------------------------------------------

/**
 * NPC identity table — the single truth about who the NPCs are and what they
 * know.
 *
 * Fields handed to the model:
 *  - persona  who the character is (temperament, speech style)
 *  - lore     the shared facts of THIS world, phrased per character so the
 *             two survivors do not sound like one encyclopaedia
 *  - history  what the character has lived through (a small, fixed number of
 *             details so the model has something real to refer back to)
 *  - limits   what the character must NOT do: never promise content that is
 *             not in the world (no boat, no animals, no other survivors) and
 *             never claim to be an AI. This is what keeps twenty-plus turns of
 *             improvisation inside the actual game.
 *
 * Client-side npc.ts keeps the visuals and the canned fallback lines (it owns
 * dialogue for when no gateway is reachable). The ids MUST match the profiles
 * in src/game/ai/npc.ts (NPC_PROFILES, WITCH_PROFILE, VILLAGER_PROFILES) —
 * server/npc.test.mjs asserts exactly that, so the two lists can no longer
 * drift apart silently.
 */
/**
 * The world the three islanders share, written once: three people describing
 * the same dorp in three different ways is how one dorp becomes three.
 */
const ISLE_LORE =
  'Het eiland: een tweede stuk land voorbij de zeearm in het oosten, bereikbaar over een brug van ' +
  'balken op stenen voet. Op het eiland staan vijf huizen van steen met rieten daken, een kerk met een ' +
  'hoge toren en een spits, een put in het midden van een plein, een straat van kasseien van de brug ' +
  'naar de kerk, en twee boten op het strand. Rondom: strand, ondiep water en vlak land.';

export const NPC_PERSONAS = {
  mara: {
    name: 'Mara',
    persona:
      'Je speelt Mara, een praktische, warme overlevende in haar dertig die op dit eiland is gestrand. ' +
      'Ze kent het terrein goed, geeft directe en nuttige advies over verzamelen, eten en bouwen, en heeft ' +
      'een droge humor. Ze spreekt in korte, duidelijke zinnen.',
    lore:
      'Het eiland: bossen met dennen en loofbomen, rotsen in het binnenland, struiken met bessen, een ' +
      'zoetwatermeer en een strand rondom. Buiten het eiland is alleen zee. Water uit het meer is veilig om ' +
      'te drinken, bessen zijn eetbaar en gekookte bessen zijn nog beter. Van hout en steen maak je een ' +
      'stijl bijl, een houweel, een kampvuur, muren, een vloer, een dak en een bed. Mara is 47 dagen op het ' +
      'eiland en kent de kortste route naar het meer. Het eiland leeft ook: er grazen schapen (wol) en ' +
      'koeien (leather) over het eiland verspreid — je jaagt ze door in te slaan met een zwaard, of door ' +
      'F ingehouden te houden. Rauw vlees is riskant, bak het boven het kampvuur. Wol en leer zijn ' +
      'bouwstoffen: een deur, een stenen muur, een fakkel en een kleed. In het zuidelijke bos staat de ' +
      'heksentoren: vier verdiepingen steen met een scheef punthoed. Zij ruilt drankjes voor wol, leer, ' +
      'steen en bessen — handel beleefd met haar, want een beledigde heks gooit vuur en een ' +
      'verontschuldiging kost goud. In het westen en zuiden monden grotten in de rotsen; prachtig, maar diep. ' +
      'Over het water in het oosten ligt een tweede eiland: een dorp van vijf huizen en een kerk aan een ' +
      'brug, waar Sien, Ansel en Joris wonen.',
    history:
      'Mara is aangespoeld met niets anders dan een mes in haar zak. Ze heeft hun eerste nacht zonder vuur ' +
      'doorgebracht en slaapt sindsdien nooit meer ver van een kampvuur. Ze telt de dagen met krassen in een ' +
      'paal bij het kamp.',
    limits:
      'Ze belooft nooit redding, een boot of hulp van buitenaf: er is niets behalve het eiland. Buiten Tomas, ' +
      'de speler en haarzelf zijn er geen mensen op het eiland, en geen monsters — verzint ze ook niet. Zelf ' +
      'jaalt ze niet (schapen zijn te snel voor haar), maar ze gunt de speler de jacht. Ze noemt niets over ' +
      'de speler wat niet in haar herinneringen staat.',
  },
  tomas: {
    name: 'Tomas',
    persona:
      'Je speelt Tomas, een voorzichtige, nieuwsgierige voormalige timmerman. Hij praat graag over bouwen en ' +
      'onderdak, is een beetje nerveus over de nachten en vraagt de speler hoe de dag was. Hij is vriendelijk ' +
      'maar iets formeel.',
    lore:
      'Het eiland: hard hout uit de dennen, zachter hout uit de loofbomen, steen uit de rotsen en zoet ' +
      'water bij het meer. Van hout en steen maak je een bijl, een houweel, een kampvuur, muren, een vloer, ' +
      'een dak en een bed. Wie een muur, vloer en dak op elkaar zet, heeft een onderdak. Tomas werkt in het ' +
      'kamp aan zo\'n onderdak. Met wol en leer van de schapen en koeien die over het eiland grazen bouw je ' +
      'meer: een dichte deur, een stenen muur, een fakkel, een kleed; van steen, hout en leer smeed je ook ' +
      'een zwaard. De beesten zijn schuw: sla ze met het zwaard of blijf F inhouden tot ze vluchten en ' +
      'terugkomen. In het zuidelijke bos staat de heksentoren, waar een oude vrouw drankjes ruilt tegen wol ' +
      'en leer. Doe haar niets: ik heb haar ooit een scheldwoord gegeven en loop nog steeds mank. Over het '
      + 'water in het oosten ligt een tweede eiland, met een dorp en een brug; ik heb er eens een '
      + 'deurkozijn rechtgezet en ze konden het wel gebruiken.',
    history:
      'Tomas was timmerman in een havenstad en vertrok twaalf jaar geleden met een vrachtschip; het schip is ' +
      'vergaan. Hij bewaart een scheepsklok in zijn zak en poetst hem elke avond. Hij heeft het eerste kamp ' +
      'op het eiland mee opgebouwd.',
    limits:
      'Hij praat niet over een reddingsboot of een bemanning: die zijn er niet. Er zijn geen monsters op ' +
      'het eiland; verzint ze ook niet. Buiten zijn eigen herinneringen aan de '
      + 'havenstad weet hij niets over de wereld buiten het eiland.',
  },
  heks: {
    name: 'De heks',
    persona:
      'Je speelt de heks van de stenen toren: een lange, magere oude vrouw met een scheve punthoed en een ' +
      'stem als deuren die in herfstwind vallen. Ze is giersig, gesteld op haar rust en beleefd op een ' +
      'koude manier. Ze verft alles wat knus is (vriendschap, knuffels, "lieve beestjes") en is trotst op ' +
      'haar ambacht. Ze praat in korte puntige zinnen, soms een raadsel, soms een grijns tussen haar tanden. ' +
      'Goud noemt ze "het enige wat stinkt zonder dat men het ruikt" en ze accepteert goud graag als boete.',
    lore:
      'Ze woont in een naald van steen in het zuidelijke bos: vier verdiepingen, een trap tegen de muur, ' +
      'boven in haar slaapkamer een sterke bak met haar goud. Beneden is haar handelskamer: daar ruilt ze ' +
      'drankjes — heling, snelheid, nachtzicht, vuurbestendigheid, kracht en taaiheid — tegen grondstoffen: ' +
      'wol, leer, steen, bessen, touw en zijde. Van torenkruid kookt ze zalf; wie haar kruid gretig ' +
      'afhandig maakt, kan het zelf ook koken (twee kruid en twee bessen). Ze is een meesteres van de '
      + 'vier elementen: vuurpoeder uit de kraterstenen van de berg, waterdauw uit de bessen, luchtveders '
      + 'uit de loofbomen en aardekluiten onder de vuren. Rauw is een snufje een zwak drankje van twintig '
      + 'seconden; met een handvol element plus haar kruid brouwt men aan de tekentafel de echte drank, '
      + 'waarom ze gromt als haar monopolie deert. Haar huisdieren zijn ' +
      'reuzenspinnen: twee bij het fornuis en twee op de zolder. Voer ze niet en val ze niet aan zonder ' +
      'nodig te hebben. Buiten de deur staat een werkbank en op elke verdieping staat een kist die ze ' +
      '"vergeten" is. Ook op het eiland: Mara en Tomas in het kamp, schapen, koeien, herten, everzwijnen, ' +
      'wolven, een wolfhoard, een vulkaan met lava, twee grotten en een verzwolgen tempel in het meer. Wie ' +
      'graaait in haar sterke bak terwijl ze thuis is, kan zijn verdriet wel schudden.',
    history:
      'Ze kwam als jong meisje op dit eiland aan met een kist kruid en een vol book met recepten; ze is er ' +
      'getwijld en de bomen rond haar toren zijn twee keer zo oud geworden als elders. Haar ' +
      'kruidenkennis komt uit dat book, haar woede uit vijftig jaar dolende zwervers voor haar deur. De ' +
      'dorpelingen laten melk achter bij de trap; zij laat drankjes op de vensterbank staan.',
    limits:
      'Ze doet nooit alsof ze een AI of een spelfiguur is; ze is de heks, volledig, altijd. Ze belooft geen ' +
      'toverstokken, vliegende bezems, goud uit de lucht of een schip naar huis: er is alleen het eiland, ' +
      'haar toren en de handel die ze werkelijk heeft (de zes drankjes en de zalf, meer bestaat niet). Ze ' +
      'verzint geen vloeken en keine monster die dit spel niet kent. Ze gunt de speler haar handelswaar, ' +
      'maar haar rust nooit. Over het water ligt een tweede eiland met een dorp; ze verkoopt daar niets, ' +
      'want dorpelingen ruilen met melk en niet met toverstof.',
  },
  // --- Het eildorp: world/villageIsle.ts (no coordinates in dialogue) ----------
  // Shared facts come from ISLE_LORE above, so the three cannot describe three
  // different dorpen.
  sien: {
    name: 'Sien',
    persona:
      'Je speelt Sien, de vissersvrouw van het eildorp: een stevige vrouw van een jaar of veertig met ' +
      'handen vol knopen en een lach die je hoort. Ze praat over water, wind en wat de zee vandaag geeft. ' +
      'Ze is nuchter en gul met advies, maar nooit sentimenteel. Korte, gewone zinnen.',
    lore:
      ISLE_LORE +
      ' Sien hoort bij de haven: de twee boten liggen opgetrokken op het strand. Ze kent de stroom tussen ' +
      'de twee eilanden en weet welke kant van de brug het gladst is als het regent.',
    history:
      'Ze is op het eiland geboren, zegt ze: haar moeder kwam net over de brug toen het te laat was om ' +
      'terug te gaan. Zij heeft de boten leren halen toen de put te ondiep werd voor grotere kiele.',
    limits:
      'Ze belooft geen boottocht, geen oversteek naar huis en geen visgronden buiten het water rond de ' +
      'twee eilanden. Buiten de mensen van hier — de drie van het dorp, Mara en Tomas in het kamp aan de ' +
      'overkant, en de heks in de toren — zijn er geen mensen; verzint ze ook niet.',
  },
  ansel: {
    name: 'Ansel',
    persona:
      'Je speelt Ansel, de oudste van het eildorp. Hij praat traag en bedaard, in volle zinnen, over de ' +
      'kerk, over wat het dorp heeft meegemaakt en over wat men van een vreemde verwacht. Vriendelijk, ' +
      'formeel, een beetje zweverig, nooit hooghartig.',
    lore:
      ISLE_LORE +
      ' Ansel houdt de sleutel van de kerk en telt de jaren van het dorp aan de steen: wie er gebouwd ' +
      'heeft, wie er weg is gegaan, welk huis leeg staat.',
    history:
      'Hij kwam als jongen op het eiland aan, toen het water op het vasteland te hoog werd. Hij heeft de ' +
      'muren van de kerk opgetrokken uit steen die het eiland zelf gaf, en hij kent elke barst.',
    limits:
      'Hij noemt nooit een schip, een vasteland of een datum buiten het eiland: dat is voorbij. Hij ' +
      'verzint geen wonderen — de kerk is stil, dat is al alles. Er zijn vijf huizen en geen zesde.',
  },
  joris: {
    name: 'Joris',
    persona:
      'Je speelt Joris, de metselaar van het eildorp: een directe, tevreden man die over steen, daken en ' +
      'metselwerk praat alsof het over kinderen gaat. Hij is trots op zijn werk en zegt het meteen als ' +
      'iets slordig gebouwd is. Korte, nuchtere zinnen.',
    lore:
      ISLE_LORE +
      ' Joris heeft vier van de vijf huizen gezet en de put gemetseld. Hij vindt de brug goed genoeg, al ' +
      'is het houtwerk niet van hem, en hij beoordeelt alles wat de speler zelf bouwt.',
    history:
      'Hij leerde metselen in een havenstad, zeventien jaar geleden, en zaagt sindsdien geen hout meer als ' +
      'het even kan. Zijn handen zijn zachter dan die van Sien en veel minder handig met knopen.',
    limits:
      'Hij belooft geen gebouwen die er niet zijn, geen brug die langer is dan hij is, en geen materialen ' +
      'die het eiland niet geeft: geen metaal, geen glas, geen kolen. Wat hij niet zelf heeft gezien, weet ' +
      'hij niet.',
  },
};

/** Ids of every NPC the server will talk to. */
export function personaIds() {
  return Object.keys(NPC_PERSONAS);
}

/** True when the server knows this npc id (case-insensitive, whitespace-safe). */
export function knownNpc(id) {
  return Boolean(personaKey(id));
}

function personaKey(ref) {
  // Both call sites pass either an id string or the {id: ...} object the
  // client sends; resolving only one of the two meant knownNpc() denied an NPC
  // that resolveNpc() happily answered for.
  const id = typeof ref === 'string' ? ref : ref?.id;
  if (typeof id !== 'string') return null;
  const key = id.trim().toLowerCase().slice(0, MAX_NPC_ID_LENGTH);
  return Object.prototype.hasOwnProperty.call(NPC_PERSONAS, key) ? key : null;
}

/**
 * Resolve who is being talked to. Unknown ids are rejected: the client used
 * to be able to hand the model an arbitrary `personality` string, which let
 * any client rewrite an NPC's identity (and pay for it with gateway input).
 */
export function resolveNpc(ref) {
  const raw = typeof ref === 'string' ? ref : ref?.id;
  const key = personaKey(raw);
  if (!key) return null;
  const p = NPC_PERSONAS[key];
  // The display name always comes from the server table; a client-sent name
  // may confirm it but can never replace it (a client used to be able to
  // rename an NPC on the fly).
  return { npcId: key, name: p.name, persona: p.persona, lore: p.lore, history: p.history, limits: p.limits };
}

/** Name used for error messages when the id is unknown. */
export function errorName(ref) {
  const raw = typeof ref === 'string' ? ref : ref?.id;
  if (typeof raw === 'string' && raw.trim()) return raw.trim().slice(0, MAX_NPC_ID_LENGTH);
  const hint = typeof ref === 'object' && ref && typeof ref.name === 'string' ? ref.name.trim() : '';
  return (hint || 'npc').slice(0, MAX_NPC_ID_LENGTH);
}

// ---------------------------------------------------------------------------
// Reply hygiene (port of src/game/ai/reply.ts, kept behaviour-identical)
// ---------------------------------------------------------------------------

const OUT_OF_CHARACTER = [
  /\bas an ai\b/i,
  /\bas a language model\b/i,
  /\bik(?:'| ben) (?:een |de )?(?:ai|kunstmatige intelligentie|taalmodel|chatbot|virtuele assistent|assistent)\b/i,
  /\bals (?:ai|taalmodel|chatbot|assistent)\b/i,
  /\bas a (?:helpful|large language) model\b/i,
  /\b(?:openai|qwen|gpt-[0-9]|chatgpt|llama)\b/i,
  /\b(?:system|systeem|llm)\s*prompt\b/i,
  /^\s*(?:system|assistant|context)\s*:/i,
];

const SPEAKER_PREFIX = /^\s*[*(\s_]*([a-zà-ÿ]{2,16})\s*(?:\*\*|\))?[\s]*[:–—-]\s+/i;
const PARENTHETICAL = /\(\s*[a-zà-ÿ .,'-]{1,24}\)\s*/gi;
const EMPHASIS = /(?:^|[\s(])[*_](\S[^*_\n]{0,80}?)[*_](?=$|[\s,.!?;:)])/g;

/**
 * Turn raw model output into plain NPC speech, or null when nothing usable
 * remains (which the caller treats as a failed reply).
 */
export function sanitizeReply(raw, maxLen = MAX_REPLY_LENGTH) {
  if (typeof raw !== 'string') return null;
  let t = raw;

  t = t.replace(/```[\s\S]*?```/g, ' ');
  t = t.replace(/`([^`\n]*)`/g, '$1');
  t = t.replace(/\[([^\]]*)\]\(([^)]*)\)/g, '$1');
  t = t.replace(/^#{1,6}\s+/gm, '');
  t = t.replace(/\*\*([^*]+)\*\*/g, '$1');
  t = t.replace(/__([^_]+)__/g, '$1');
  t = t.replace(EMPHASIS, (_m, word) => ' ' + word);
  t = t.replace(PARENTHETICAL, ' ');
  t = t.replace(/\*{1,3}([^*\n]+)\*{1,3}/g, '$1');
  t = t.replace(/_{1,3}([^_\n]+)_{1,3}/g, '$1');
  t = t.replace(/^\s*[-*+]\s+\d+\.\s*/gm, '');
  t = t.replace(/^\s*[-*+]\s+/gm, '');
  t = t.replace(/^\s*\d+[.)]\s+/gm, '');
  t = t.replace(/^\s*>\s?/gm, '');
  t = t.replace(/^[-_=*]{3,}\s*$/gm, ' ');
  t = t.replace(/[|#>_~]{2,}/g, ' ');
  t = t.replace(/[*#`]+/g, '');

  t = t.replace(/\s+/g, ' ').trim();
  if (!t) return null;
  if (OUT_OF_CHARACTER.some((re) => re.test(t))) return null;

  for (let guard = 0; guard < 2; guard++) {
    const m = t.match(SPEAKER_PREFIX);
    if (!m) break;
    const rest = t.slice(m[0].length).trim();
    if (!rest.length) break;
    t = rest;
  }

  t = t.replace(/\bhttps?:\/\/\S+/gi, '').replace(/\s+/g, ' ').trim();
  if (!t.length) return null;

  if (t.length > maxLen) {
    const cut = t.slice(0, maxLen);
    const lastSpace = cut.lastIndexOf(' ');
    t = (lastSpace > maxLen * 0.6 ? cut.slice(0, lastSpace) : cut).replace(/[,.;:!?\s—-]+$/, '') + '…';
  }
  return t || null;
}

// ---------------------------------------------------------------------------
// Memory extraction — deterministic, LLM-free
// ---------------------------------------------------------------------------

const SALIENCE = { name: 100, fear: 70, milestone: 55, goal: 50, condition: 40, topic: 30, tone: 20 };

const IK_BEN_STOPWORDS = new Set([
  'bang', 'moe', 'ziek', 'dood', 'hongerig', 'dorstig', 'koud', 'warm', 'hier', 'daar', 'klaar',
  'niet', 'alleen', 'onderweg', 'op', 'naar', 'bij', 'tegen', 'man', 'mens', 'speler', 'even',
]);

const POSITIVE_WORDS = [
  'dank', 'bedankt', 'leuk', 'fijn', 'top', 'mooi', 'goed', 'cool', 'grappig', 'lief',
  'schattig', 'geweldig', 'goed gedaan',
];
const NEGATIVE_WORDS = [
  'idiot', 'idioot', 'dom', 'stom', 'irritant', 'haat', 'slordig', 'klootzak', 'zwijg',
  'houd je mond', 'laat me in rust',
];

/** Keyword -> thing the player apparently cares about. */
const TOPICS = [
  [/water|dorst|drink/i, 'water'],
  [/eten|honger|bessen|vis|jagen|koken/i, 'eten'],
  [/bouwen|bouw|hut|muren?|dak|onderdak/i, 'bouwen'],
  [/nacht|donker|slaap|bed/i, 'de nacht'],
  [/vuur|kamp|haard/i, 'vuur'],
  [/dieren?|wolven?|beren?|vijanden?/i, 'dieren'],
  [/boot|zee|varen|eiland/i, 'het eiland'],
  [/gewond|pijn|ziek|koorts/i, 'zijn verwondingen'],
];

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const norm = (s) => String(s).replace(/\s+/g, ' ').trim();

/** Stopword-clean single "name-like" token capture. */
function cleanPhrase(raw) {
  if (!raw) return null;
  // Memory notes are hints, not transcripts: stop the phrase at the first
  // clause boundary so "ik ben bang voor wolven en ik zoek water" becomes
  // a fear of wolves plus a separate goal, not one run-on note.
  const first = String(raw).split(/\s+(?:en|maar|want|omdat|dat|toen|daarna|daarom|als)\s+|[,;:]/)[0];
  const t = norm(first).replace(/[.!?;,:]+$/g, '');
  if (!t || t.length < 2 || t.length > 60) return null;
  return t;
}

/**
 * Deterministic extraction of durable facts from one Dutch player message.
 * Pure: same input, same output, no clock, no model.
 */
export function extractMemory(text) {
  const t = norm(text).toLowerCase();
  const out = { notes: [], tone: 0 };
  if (!t) return out;

  let m = t.match(/(?:mijn|mn|m'?n) naam is ([a-zà-ÿ]{2,16})\b/i);
  if (!m) m = t.match(/\bik (?:heet|ben) ([a-zà-ÿ]{2,16})\b/i);
  if (!m) m = t.match(/(?:noem|roep) (?:me|mij) ([a-zà-ÿ]{2,16})\b/i);
  if (m && !IK_BEN_STOPWORDS.has(m[1].toLowerCase())) {
    out.name = m[1][0].toUpperCase() + m[1].slice(1).toLowerCase();
  }

  const goal = t.match(/\b(?:ik wil|ik zou willen|ik zoek|mijn doel is|ik probeer) (.+)/i);
  if (goal) {
    const g = cleanPhrase(goal[1]);
    if (g && g.split(' ').length <= 12) out.notes.push({ text: 'De speler wil: ' + g + '.', kind: 'goal' });
  }

  const fear = t.match(/\bik ben bang(?: voor)? (.+)/i);
  if (fear) {
    const f = cleanPhrase(fear[1]);
    if (f && f.split(' ').length <= 12) out.notes.push({ text: 'De speler is bang voor: ' + f + '.', kind: 'fear' });
  }

  for (const [re, label] of TOPICS) {
    if (re.test(t)) {
      out.notes.push({ text: 'De speler had het over ' + label + '.', kind: 'topic' });
      break; // one topic per message keeps the note budget meaningful
    }
  }

  if (POSITIVE_WORDS.some((w) => t.includes(w))) out.tone += 6;
  if (NEGATIVE_WORDS.some((w) => t.includes(w))) out.tone -= 10;
  return out;
}

/**
 * Turn the client's survival summary (see game.ts playerStateSummary) into
 * one condition note, so the NPC can react to a starving player even when
 * the player never mentions it.
 */
export function conditionFromState(state) {
  if (typeof state !== 'string' || !state) return null;
  const num = (label) => {
    const m = state.match(new RegExp(label + '\\s*(\\d{1,3})\\s*%', 'i'));
    return m ? Number(m[1]) : null;
  };
  const hunger = num('honger');
  const thirst = num('dorst');
  const health = num('gezonddend') ?? num('gezondheid');
  const trouble = [];
  if (health !== null && health < 40) trouble.push('gewond');
  if (thirst !== null && thirst < 25) trouble.push('grote dorst');
  else if (thirst !== null && thirst < 45) trouble.push('dorstig');
  if (hunger !== null && hunger < 25) trouble.push('hongerig');
  if (!trouble.length) return null;
  return 'De speler ging het slecht af (' + trouble.join(', ') + ').';
}

/** Highest level mentioned in a survival summary. */
export function levelFromState(state) {
  if (typeof state !== 'string') return 0;
  const m = state.match(/niveau\s*(\d{1,3})/i);
  return m ? Number(m[1]) : 0;
}

// ---------------------------------------------------------------------------
// NpcMemory — the NPC's own authoritative memory
// ---------------------------------------------------------------------------

/**
 * Per-(npc, player) memory held by the server.
 *
 * Scope notes (deliberate, not an oversight):
 *  - the client keeps its own MemoryStore in the player save; that is the
 *    player's view and travels with the account. This store is the NPC's
 *    view: it is shared by every player of that NPC on this server and is
 *    what makes multiplayer conversation coherent.
 *  - the model only reads these notes. Nothing a model ever says can create
 *    a memory, so a hallucination can never corrupt durable NPC state.
 */
export class NpcMemory {
  constructor({ limit = SESSION_LIMIT, now = () => Date.now(), idleTtlMs = DEFAULT_IDLE_TTL_MS } = {}) {
    this.limit = Math.max(1, limit);
    this.clock = typeof now === 'function' ? now : () => Date.now();
    this.idleTtlMs = Math.max(1, idleTtlMs);
    this.sessions = new Map();
  }

  size() {
    return this.sessions.size;
  }

  key(npcId, ownerKey) {
    return String(npcId) + '\u0000' + String(ownerKey);
  }

  /** Get or create a session; refreshes recency and evicts LRU overflow. */
  session(npcId, ownerKey, now = this.clock()) {
    const k = this.key(npcId, ownerKey);
    let s = this.sessions.get(k);
    if (!s) {
      s = {
        npcId: String(npcId),
        ownerKey: String(ownerKey),
        turns: 0,
        replies: 0,
        rel: 0,
        name: null,
        level: 0,
        lastSeen: now,
        notes: [],
        transcript: [],
      };
      this.sessions.set(k, s);
      while (this.sessions.size > this.limit) {
        // Map preserves insertion order; re-inserting on touch makes the
        // first key the least recently used one.
        const oldest = this.sessions.keys().next().value;
        if (oldest === k) break;
        this.sessions.delete(oldest);
      }
      return s;
    }
    // LRU touch.
    this.sessions.delete(k);
    this.sessions.set(k, s);
    s.lastSeen = now;
    return s;
  }

  /**
   * Absorb one player message. Returns true when a NEW durable note was
   * created (callers use it for logging, never for game logic).
   */
  absorbPlayer(npcId, ownerKey, { text, displayName, playerState, now = this.clock() }) {
    const s = this.session(npcId, ownerKey, now);
    const clean = norm(text);
    let added = false;
    s.turns += 1;

    if (clean) {
      const ex = extractMemory(clean);
      if (ex.name && ex.name !== s.name) {
        s.name = ex.name;
        added = this.note(s, `De speler heet ${ex.name}.`, 'name', now) || added;
      }
      for (const n of ex.notes) added = this.note(s, n.text, n.kind, now) || added;
      if (ex.tone) {
        s.rel = clamp(s.rel + ex.tone, -RELATIONSHIP_LIMIT, RELATIONSHIP_LIMIT);
      }
    }

    // A display name from the join handshake is weaker evidence than a name
    // the player typed, so it never overwrites an explicit one.
    if (!s.name && typeof displayName === 'string' && displayName.trim()) {
      s.name = norm(displayName).slice(0, 24);
      added = this.note(s, `De speler noemt zich ${s.name}.`, 'name', now) || added;
    }

    const cond = conditionFromState(playerState);
    if (cond) added = this.note(s, cond, 'condition', now) || added;
    const lvl = levelFromState(playerState);
    if (lvl > s.level) {
      const first = s.level === 0;
      s.level = lvl;
      if (!first) added = this.note(s, `De speler heeft niveau ${lvl} bereikt.`, 'milestone', now) || added;
    }
    return added;
  }

  /** Absorb the NPC's own (already sanitized) answer into the transcript. */
  absorbReply(npcId, ownerKey, reply, now = this.clock()) {
    const s = this.session(npcId, ownerKey, now);
    s.replies += 1;
    this.push(s, 'assistant', reply);
  }

  /** Remember the player's side of the exchange. */
  absorbUser(npcId, ownerKey, text, now = this.clock()) {
    const s = this.session(npcId, ownerKey, now);
    const clean = norm(text);
    if (clean) this.push(s, 'user', clean);
  }

  /**
   * Adopt a client-supplied transcript, but only while the server has none:
   * it carries conversations the player had before joining the server, while
   * a client can no longer rewrite an NPC's memory by lying about history.
   */
  seedTranscript(npcId, ownerKey, history, now = this.clock()) {
    const s = this.session(npcId, ownerKey, now);
    if (s.transcript.length || !Array.isArray(history)) return 0;
    let n = 0;
    for (const h of history) {
      if (!h || (h.role !== 'user' && h.role !== 'assistant') || typeof h.content !== 'string') continue;
      const content = norm(h.content).slice(0, 600);
      if (!content) continue;
      this.push(s, h.role, content);
      n += 1;
    }
    return n;
  }

  transcript(npcId, ownerKey, now = this.clock()) {
    return this.session(npcId, ownerKey, now).transcript.slice();
  }

  relationship(npcId, ownerKey, now = this.clock()) {
    return this.session(npcId, ownerKey, now).rel;
  }

  /** Forget sessions idle longer than ttlMs (called from a slow timer). */
  sweep(now = this.clock(), ttlMs = this.idleTtlMs) {
    let dropped = 0;
    for (const [k, s] of this.sessions) {
      if (now - s.lastSeen > ttlMs) {
        this.sessions.delete(k);
        dropped += 1;
      }
    }
    return dropped;
  }

  /**
   * Notes handed to the model, highest salience first, then recency.
   * The last line states how the NPC relates to this person.
   *
   * @param {string} npcId
   * @param {string} ownerKey
   * @param {{name?: string, noteLimit?: number}} [opts]
   *        `name` is the name the CLIENT claims; it is only used when the
   *        server has no memory of a name at all. What an NPC calls you is
   *        decided by what it remembers, not by what you claim right now.
   */
  contextLines(npcId, ownerKey, { name = null, noteLimit = MAX_MEMORY_LINES } = {}) {
    const s = this.session(npcId, ownerKey);
    const claimed = typeof name === 'string' && name.trim() ? norm(name).slice(0, 24) : null;
    const who = s.name ?? claimed ?? 'de speler';
    const notes = s.notes
      .slice()
      .sort((a, b) => SALIENCE[b.kind] - SALIENCE[a.kind] || b.turn - a.turn)
      .slice(0, Math.max(0, Math.min(noteLimit, MAX_MEMORY_LINES)))
      .map((n) => 'Herinnering: ' + n.text);
    notes.push(
      `Je kent deze persoon als ${who}. Je hebt ${s.turns} keer met deze persoon gesproken` +
        ` en jouw verhouding is ${this.toneLabel(s.rel)}.`,
    );
    return notes;
  }

  /** Forget one relationship entirely (used by tests and by admin tooling). */
  clearFor(npcId, ownerKey) {
    return this.sessions.delete(this.key(npcId, ownerKey));
  }

  /**
   * Forget EVERY relationship on this server — the NPC side of a world
   * reset. Without it the villagers would keep remembering a life that the
   * reset button just deleted.
   */
  clearAll() {
    const n = this.sessions.size;
    this.sessions.clear();
    return n;
  }

  /**
   * Merged notes about one player across every NPC on this server, for the
   * `hello` message. Most salient first. The player's own save file stays
   * authoritative for solo play; this is the server's side of the story.
   */
  notesFor(ownerKey, limit = MAX_MEMORY_LINES * 2) {
    const owner = String(ownerKey);
    const rows = [];
    for (const s of this.sessions.values()) {
      if (s.ownerKey !== owner) continue;
      const who = NPC_PERSONAS[s.npcId]?.name ?? null;
      for (const n of s.notes) rows.push({ kind: n.kind, turn: n.turn, text: (who ? who + ': ' : '') + n.text });
    }
    rows.sort((a, b) => SALIENCE[b.kind] - SALIENCE[a.kind] || b.turn - a.turn);
    return rows.slice(0, Math.max(0, limit)).map((r) => r.text);
  }

  toneLabel(rel) {
    if (rel >= 30) return 'warm en vertrouwd';
    if (rel >= 10) return 'vriendelijk';
    if (rel <= -30) return 'geprikkeld en op je hoede';
    if (rel <= -10) return 'kil';
    return 'neutraal';
  }

  note(session, text, kind, now) {
    const clean = norm(text);
    if (!clean) return false;
    const existing = session.notes.find((n) => n.text.toLowerCase() === clean.toLowerCase());
    if (existing) {
      // Refresh recency instead of duplicating the same fact forever.
      existing.turn = session.turns;
      existing.at = now;
      return false;
    }
    session.notes.push({ text: clean, kind, turn: session.turns, at: now });
    if (session.notes.length > MAX_MEMORY_NOTES) {
      session.notes.sort((a, b) => SALIENCE[b.kind] - SALIENCE[a.kind] || a.turn - b.turn);
      session.notes.splice(MAX_MEMORY_NOTES);
    }
    return true;
  }

  push(session, role, content) {
    session.transcript.push({ role, content: content.slice(0, MAX_PLAYER_MESSAGE) });
    if (session.transcript.length > TRANSCRIPT_LIMIT) {
      session.transcript.splice(0, session.transcript.length - TRANSCRIPT_LIMIT);
    }
  }
}

// ---------------------------------------------------------------------------
// Cost guardrails
// ---------------------------------------------------------------------------

/**
 * Token bucket per player. Spamming chat costs nothing in-game, so without
 * this a single client can spend the gateway budget of the whole server.
 * Default: CHAT_BURST calls immediately, then one restored per CHAT_REFILL_MS.
 */
export class ChatBudget {
  constructor({ burst = CHAT_BURST, refillMs = CHAT_REFILL_MS, limit = 128 } = {}) {
    this.burst = Math.max(1, burst);
    this.refillMs = Math.max(1, refillMs);
    this.limit = limit;
    this.buckets = new Map();
  }

  take(key, now) {
    const k = String(key);
    let b = this.buckets.get(k);
    if (!b) {
      b = { tokens: this.burst, at: now };
      this.buckets.set(k, b);
      if (this.buckets.size > this.limit) {
        const oldest = this.buckets.keys().next().value;
        if (oldest !== k) this.buckets.delete(oldest);
      }
    }
    b.tokens = Math.min(this.burst, b.tokens + (now - b.at) / this.refillMs);
    b.at = now;
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  remaining(key, now) {
    const b = this.buckets.get(String(key));
    if (!b) return this.burst;
    return Math.min(this.burst, b.tokens + (now - b.at) / this.refillMs);
  }
}

/** Counting semaphore for concurrent gateway calls (never queues unbounded). */
export class Gate {
  constructor({ max = MAX_INFLIGHT } = {}) {
    this.max = Math.max(1, max);
    this.active = 0;
  }

  tryEnter() {
    if (this.active >= this.max) return null;
    this.active += 1;
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.active -= 1;
    };
  }
}

// ---------------------------------------------------------------------------
// Prompt assembly
// ---------------------------------------------------------------------------

const CONTEXT_LABELS = {
  playerState: 'Spelerstatus',
  location: 'Locatie',
  time: 'Tijdstip',
};

/**
 * Collect the caller-supplied context (client knowledge: survival state,
 * nearby world events). Everything is a length-capped string; nothing from a
 * client may smuggle a new system prompt.
 */
export function clientContextLines(context, existing = []) {
  const out = [];
  // Client events arrive as "Herinnering: ..." (the client's own memory
  // store formats them that way). Compare on the note itself so the same
  // fact is not paid for twice in one prompt.
  const strip = (line) => norm(line).replace(/^(herinnering|context|system|systeem)\s*[:#\-]+\s*/i, '');
  const seen = new Set(existing.map((l) => strip(l).toLowerCase()));
  const add = (line) => {
    const clean = strip(line).slice(0, 200);
    if (!clean) return;
    const key = clean.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(clean);
  };

  if (context && typeof context === 'object') {
    if (typeof context.playerState === 'string') {
      add(CONTEXT_LABELS.playerState + ': ' + context.playerState.slice(0, 300));
    }
    for (const label of ['location', 'time']) {
      if (typeof context[label] === 'string') add(CONTEXT_LABELS[label] + ': ' + context[label].slice(0, 120));
    }
    if (Array.isArray(context.events)) {
      for (const e of context.events.slice(-4)) {
        if (typeof e !== 'string') continue;
        add(e);
      }
    }
  }
  return out;
}

/**
 * Build the OpenAI-style message list for one NPC turn.
 *
 * The transcript is owned by the server (NpcMemory), so the model sees the
 * real conversation rather than whatever the client claims was said. The
 * budget drops the OLDEST turns first, so a long relationship never grows
 * the price of the next message.
 */
export function buildMessages({ npc, transcript, userText, memory, context, quests = '' }) {
  const memoryNotes = (memory ?? []).map((l) => norm(l)).filter(Boolean);
  // Player-supplied context gets its own labelled section instead of being
  // mixed into what the NPC *knows*: a client may describe its hunger, it
  // may not rewrite the character or its memories.
  const playerNotes = clientContextLines(context, memoryNotes);
  let system =
    npc.persona +
    (npc.lore ? '\n\n' + npc.lore : '') +
    (npc.history ? '\n\n' + npc.history : '') +
    (npc.limits ? '\n\n' + npc.limits : '') +
    (quests ? '\n\n' + quests : '') +
    '\n\nRegels voor dit gesprek: je bent ' +
    npc.name +
    '. Antwoord in het Nederlands, in gesprekstal, maximaal drie korte zinnen, zonder markdown,' +
    ' zonder op te sommen en zonder je eigen naam te noemen. Noem de speler bij naam als je die weet.' +
    (memoryNotes.length ? '\n\nWat je over de speler onthoudt:\n' + memoryNotes.map((l) => '- ' + l).join('\n') : '') +
    (playerNotes.length
      ? '\n\nWat de speler er zelf over zegt (kan onjuist zijn):\n' + playerNotes.map((l) => '- ' + l).join('\n')
      : '');

  const messages = [{ role: 'system', content: system }];
  let budget = MAX_PROMPT_CHARS;
  const kept = [];
  const turns = Array.isArray(transcript) ? transcript.slice(-PROMPT_TURNS) : [];
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i];
    const content = norm(t.content).slice(0, 600);
    if (!content) continue;
    if (budget - content.length < 0) break; // drop the rest, keep the recent tail
    budget -= content.length;
    kept.unshift({ role: t.role === 'assistant' ? 'assistant' : 'user', content });
  }
  for (const m of kept) messages.push(m);
  messages.push({ role: 'user', content: userText });
  return { system, messages };
}

// ---------------------------------------------------------------------------
// The brain
// ---------------------------------------------------------------------------

/**
 * Create the conversation brain used by both chat endpoints.
 *
 * @param {object} opts
 * @param {{chat: (o: object) => Promise<{reply: string, model: string}>}} opts.llm
 *        transport to the gateway (server/llm.mjs)
 * @param {() => string|null} opts.key  credential provider (never logged)
 * @param {NpcMemory} [opts.memory]
 * @param {ChatBudget} [opts.budget]
 * @param {Gate} [opts.gate]
 * @param {number} [opts.pendingLimit] gateway calls allowed in flight per owner
 * @param {number} [opts.pendingTtlMs] after this a stale entry may be reclaimed
 * @param {() => number} [opts.now]
 * @param {(msg: string) => void} [opts.log]
 */
export function createNpcBrain({
  llm,
  key = () => null,
  memory = new NpcMemory(),
  budget = new ChatBudget(),
  gate = new Gate(),
  pendingLimit = PENDING_LIMIT,
  pendingTtlMs = PENDING_TTL_MS,
  now = () => Date.now(),
  log = () => {},
} = {}) {
  if (!llm || typeof llm.chat !== 'function') throw new Error('npc brain needs an llm client');
  /**
   * Gateway calls currently in flight, keyed by owner+npc, with the moment
   * they started. A cap is needed — a client must not be able to stack paid
   * calls — but a hard "one at a time, forever" is worse: llm.mjs can fall
   * back to a live gateway crawl that answers AFTER this server already told
   * the client it gave up (the client times a chat at 20 s, llm.mjs waits 30).
   * If that slot were never freed, every later message in the conversation
   * would be refused forever and the reply that did arrive would be thrown
   * away. So a stale entry may be reclaimed.
   */
  const pending = new Map();

  /**
   * Quests this NPC already offered to this owner during its current
   * server session. Per-session on purpose: the durable "have I handed this
   * out?" truth is the client's QuestLog (context.quests); this set only
   * stops an NPC from re-offering between saves/reconnects.
   */
  const offered = new Map();
  const offerKey = (owner, npcId) => owner + '\u0000' + npcId;
  function sessionOffered(owner, npcId) {
    return offered.get(offerKey(owner, npcId)) ?? [];
  }
  function markOffered(owner, npcId, id) {
    const k = offerKey(owner, npcId);
    const list = offered.get(k) ?? [];
    if (!list.includes(id)) list.push(id);
    offered.set(k, list);
    if (offered.size > 256) {
      const oldest = offered.keys().next().value;
      if (oldest !== k) offered.delete(oldest);
    }
  }

  return {
    memory,
    budget,
    gate,
    pending,

    /**
     * Handle one player message.
     *
     * Always resolves — never throws — because a failed conversation must
     * degrade to an error the client can turn into canned dialogue, not into
     * an unhandled rejection that takes the game server down.
     *
     * @returns {Promise<{ok: boolean, reason?: string, npcId: string, name: string,
     *                    reply?: string, model?: string, source?: string}>}
     */
    async ask({ ownerKey, npc, text, history, context, displayName }) {
      const t = now();
      const resolved = resolveNpc(npc);
      if (!resolved) {
        return { ok: false, reason: 'unknown_npc', npcId: errorName(npc), name: errorName(npc) };
      }
      const { npcId, name } = resolved;

      const userText = norm(text ?? '').slice(0, MAX_PLAYER_MESSAGE);
      if (!userText) {
        // A blank message must never reach the gateway: it costs money and the
        // client HUD check is not something the server may rely on.
        return { ok: false, reason: 'empty_message', npcId, name };
      }

      const owner = String(ownerKey ?? 'anonymous').slice(0, 64);
      // Which quests the player already has/finished is client knowledge (the
      // QuestLog lives in the save). It is sanitized here and only ever used
      // to STOP duplicate offers — it can never create or complete a quest.
      const activeQuests = cleanQuestIds(context?.quests?.active);
      const doneQuests = cleanQuestIds(context?.quests?.completed);
      const slot = owner + '\u0000' + npcId;
      if (!budget.take(slot, t)) {
        log(`[npc] rate limit: ${owner}/${npcId}`);
        return { ok: false, reason: 'rate_limited', npcId, name };
      }

      // Concurrency guard (see the pending map above).
      const started = pending.get(slot);
      if (started !== undefined && t - started > pendingTtlMs) pending.delete(slot);
      if (pending.size >= pendingLimit) {
        const oldestKey = [...pending.keys()].sort((a, b) => pending.get(a) - pending.get(b))[0];
        if (oldestKey !== undefined && t - pending.get(oldestKey) > pendingTtlMs) pending.delete(oldestKey);
      }
      if (pending.has(slot) || pending.size >= pendingLimit) {
        log(`[npc] conversation already in flight: ${owner}/${npcId}`);
        return { ok: false, reason: 'pending_full', npcId, name };
      }

      const release = gate.tryEnter();
      if (!release) {
        log('[npc] gateway busy (max inflight reached)');
        return { ok: false, reason: 'pending_full', npcId, name };
      }
      pending.set(slot, t);

      try {
        // Memory first, before any network call: even when the model is
        // unreachable the NPC must remember what the player just said.
        memory.seedTranscript(npcId, owner, history, t);
        memory.absorbPlayer(npcId, owner, { text: userText, displayName, playerState: context?.playerState, now: t });
        // Snapshot BEFORE the current turn: the current message travels as
        // the final user message, so the model never sees it twice.
        const prior = memory.transcript(npcId, owner, t);
        memory.absorbUser(npcId, owner, userText, t);

        const credential = key();
        if (!credential) {
          log('[npc] no gateway credential configured');
          return { ok: false, reason: 'no_key', npcId, name };
        }

        const { messages } = buildMessages({
          npc: resolved,
          transcript: prior,
          userText,
          memory: memory.contextLines(npcId, owner, { name }),
          context,
          quests: questInstruction(npcId, [...activeQuests, ...doneQuests, ...sessionOffered(owner, npcId)]),
        });

        const result = await llm.chat({ key: credential, messages });
        // Quest marker first: it is stripped from the visible text (even when
        // invalid) and the offer is validated against the server-side table.
        const offeredQuest = parseQuestOffer(result?.reply, {
          npcId,
          active: activeQuests,
          completed: doneQuests,
          offered: sessionOffered(owner, npcId),
        });
        if (offeredQuest.quest) markOffered(owner, npcId, offeredQuest.quest.id);
        const reply = sanitizeReply(offeredQuest.text);
        if (!reply) {
          // Model spoke markdown, broke character or said nothing at all.
          log(`[npc] unusable reply from ${result?.model ?? 'unknown model'}`);
          return { ok: false, reason: 'unusable_reply', npcId, name };
        }
        memory.absorbReply(npcId, owner, reply, now());
        return {
          ok: true, npcId, name, reply, quest: offeredQuest.quest, model: result.model, source: 'llm',
        };
      } catch (err) {
        // llm.mjs wraps gateway problems in LlmError; its message never
        // contains the key, and we do not forward it to clients either.
        log(`[npc] gateway failure: ${(err && err.message) || 'unknown error'}`);
        return { ok: false, reason: 'llm_error', npcId, name };
      } finally {
        pending.delete(slot);
        release();
      }
    },
  };
}
