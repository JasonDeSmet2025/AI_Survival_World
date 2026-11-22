/**
 * LLM reply validation (AI Agent scope).
 *
 * Defense in depth: the server already asks the model for short plain Dutch
 * speech, but models still emit markdown, stage directions, code fences, a
 * runaway length, their own "Name:" prefix, or the occasional
 * "as an AI language model" slip. The client sanitizes before anything
 * reaches the chat HUD, so in-game dialog always looks like NPC speech and a
 * broken reply degrades to deterministic canned dialogue instead of showing
 * junk.
 */

/** Hard cap for one NPC line in the HUD. */
export const MAX_REPLY_LENGTH = 400;

/** Replies shorter than this are not worth showing (model said nothing). */
export const MIN_REPLY_LENGTH = 1;

/**
 * Phrases that mean "the model broke character". A match rejects the reply
 * so the caller falls back to canned dialogue rather than advertising that
 * the NPC is a language model.
 */
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

/** Leading "Mara:" / "**Tomas** -" style speaker prefixes the model adds. */
const SPEAKER_PREFIX = /^\s*[*(\s_]*([a-zà-ÿ]{2,16})\s*(?:\*\*|\))?[\s]*[:–—-]\s+/i;

/** Short parenthetical stage directions such as "(zucht)" or "(hoest)". */
const PARENTHETICAL = /\(\s*[a-zà-ÿ .,'-]{1,24}\)\s*/gi;

/** Markdown emphasis (*word*, _word_) — the words themselves are kept. */
const EMPHASIS = /(?:^|[\s(])[*_](\S[^*_\n]{0,80}?)[*_](?=$|[\s,.!?;:)])/g;

/**
 * Sanitize a raw LLM reply into plain NPC speech.
 *
 * - removes code fences/spans, markdown headings, emphasis, list bullets,
 *   blockquotes and horizontal rules
 * - collapses links "[text](url)" to "text"
 * - removes a duplicated "Name:" speaker prefix
 * - rejects out-of-character / assistant-speak replies (returns null)
 * - collapses all whitespace and newlines to single spaces
 * - truncates to maxLen at a word boundary with an ellipsis
 *
 * Returns null when nothing usable remains.
 */
export function sanitizeReply(raw: unknown, maxLen: number = MAX_REPLY_LENGTH): string | null {
  if (typeof raw !== 'string') return null;
  let t = raw;

  // Code fences first: they can swallow whole markdown blocks.
  t = t.replace(/```[\s\S]*?```/g, ' ');
  t = t.replace(/`([^`\n]*)`/g, '$1');
  // Links: keep the visible label, drop the URL.
  t = t.replace(/\[([^\]]*)\]\(([^)]*)\)/g, '$1');
  // Headings, emphasis, bullets, quotes, rules.
  t = t.replace(/^#{1,6}\s+/gm, '');
  t = t.replace(/\*\*([^*]+)\*\*/g, '$1');
  t = t.replace(/__([^_]+)__/g, '$1');
  t = t.replace(EMPHASIS, (_m, word: string) => ' ' + word);
  t = t.replace(PARENTHETICAL, ' ');
  t = t.replace(/\*{1,3}([^*\n]+)\*{1,3}/g, '$1');
  t = t.replace(/_{1,3}([^_\n]+)_{1,3}/g, '$1');
  t = t.replace(/^\s*[-*+]\s+\d+\.\s*/gm, '');
  t = t.replace(/^\s*[-*+]\s+/gm, '');
  t = t.replace(/^\s*\d+[.)]\s+/gm, '');
  t = t.replace(/^\s*>\s?/gm, '');
  t = t.replace(/^[-_=*]{3,}\s*$/gm, ' ');
  // Leftover markdown debris.
  t = t.replace(/[|#>_~]{2,}/g, ' ');
  t = t.replace(/[*#`]+/g, '');

  t = t.replace(/\s+/g, ' ').trim();
  if (!t) return null;

  // Character check runs before removing any speaker prefix the model added.
  if (OUT_OF_CHARACTER.some((re) => re.test(t))) return null;

  // The model occasionally repeats the speaker name; the HUD already shows it.
  for (let guard = 0; guard < 2; guard++) {
    const m = t.match(SPEAKER_PREFIX);
    if (!m) break;
    const rest = t.slice(m[0].length).trim();
    if (rest.length < 1) break;
    t = rest;
  }

  // URLs never belong in spoken dialog.
  t = t.replace(/\bhttps?:\/\/\S+/gi, '').replace(/\s+/g, ' ').trim();
  if (t.length < MIN_REPLY_LENGTH) return null;

  if (t.length > maxLen) {
    const cut = t.slice(0, maxLen);
    const lastSpace = cut.lastIndexOf(' ');
    t = (lastSpace > maxLen * 0.6 ? cut.slice(0, lastSpace) : cut).replace(/[,.;:!?\s—-]+$/, '') + '…';
  }
  return t || null;
}

/**
 * True when a reply is usable as NPC speech.
 */
export function isUsableReply(raw: unknown, maxLen: number = MAX_REPLY_LENGTH): boolean {
  return sanitizeReply(raw, maxLen) !== null;
}
