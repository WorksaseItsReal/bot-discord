'use strict';

/**
 * Briques pures partagées par le starboard, les réponses automatiques et les
 * messages épinglés automatiquement (aucun accès Discord ni base ici).
 */

const VARIATION = /️/g;
const CUSTOM_EMOJI = /^<(a?):([\w~]{2,32}):(\d{17,20})>$/;
/** Un seul emoji Unicode : pictogramme (+ teinte, séquence ZWJ, balises), drapeau ou touche (1️⃣). */
const PICTO = '\\p{Extended_Pictographic}(?:\\uFE0F|\\p{Emoji_Modifier})*';
const UNICODE_EMOJI = new RegExp(`^(?:${PICTO}(?:\\u200D${PICTO})*[\\u{E0020}-\\u{E007F}]*|\\p{Regional_Indicator}{2}|[#*0-9]\\uFE0F?\\u20E3)$`, 'u');

/**
 * Emoji saisi par un administrateur : Unicode (⭐) ou personnalisé (<:nom:id>). Pur.
 * @returns {{ id: string|null, name: string, animated: boolean, text: string } | null}
 */
function parseEmoji(input) {
  const raw = String(input ?? '').trim();
  if (!raw || raw.length > 64) return null;
  const custom = CUSTOM_EMOJI.exec(raw);
  if (custom) return { id: custom[3], name: custom[2], animated: custom[1] === 'a', text: raw };
  if ([...raw].length > 16 || !UNICODE_EMOJI.test(raw)) return null;
  return { id: null, name: raw, animated: false, text: raw };
}

/** L'emoji d'une réaction (discord.js) correspond-il à l'emoji configuré ? Pur. */
function emojiMatches(configured, reactionEmoji) {
  const want = typeof configured === 'string' ? parseEmoji(configured) : configured;
  if (!want || !reactionEmoji) return false;
  if (want.id) return reactionEmoji.id === want.id;
  return !reactionEmoji.id && String(reactionEmoji.name ?? '').replace(VARIATION, '') === want.name.replace(VARIATION, '');
}

/** Texte normalisé pour la comparaison : minuscules, sans accents, espaces réduits. Pur. */
function normalize(text) {
  return String(text ?? '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

const WORD_CHAR = /[\p{L}\p{N}_]/u;

/** Modes de déclenchement : aucun motif d'expression régulière n'est accepté. */
const TRIGGER_MODES = Object.freeze({
  word: 'Mot entier',
  contains: 'Contient',
  starts: 'Commence par',
  exact: 'Message exact',
});

/**
 * Le message déclenche-t-il le motif ? Comparaison littérale (indexOf), jamais
 * d'expression régulière construite à partir d'une saisie. Pur.
 */
function matchesTrigger(content, pattern, mode = 'word') {
  const text = normalize(content);
  const needle = normalize(pattern);
  if (!needle || !text) return false;
  switch (mode) {
    case 'exact':
      return text === needle;
    case 'starts':
      return text.startsWith(needle);
    case 'contains':
      return text.includes(needle);
    case 'word': {
      const edgeIsWord = (ch) => Boolean(ch) && WORD_CHAR.test(ch);
      let from = 0;
      while (from <= text.length - needle.length) {
        const i = text.indexOf(needle, from);
        if (i === -1) return false;
        const before = i === 0 ? '' : text[i - 1];
        const after = text[i + needle.length] ?? '';
        // Une limite de mot n'est exigée que si le motif commence / finit par une lettre.
        const okBefore = !edgeIsWord(needle[0]) || !edgeIsWord(before);
        const okAfter = !edgeIsWord(needle[needle.length - 1]) || !edgeIsWord(after);
        if (okBefore && okAfter) return true;
        from = i + 1;
      }
      return false;
    }
    default:
      return false;
  }
}

/** Remplit une réponse automatique ({membre}, {serveur}). Pur. */
function renderResponse(template, { member = '', server = '' } = {}) {
  return String(template ?? '')
    .replace(/\{(membre|member)\}/gi, member)
    .replace(/\{(serveur|server)\}/gi, server)
    .slice(0, 2000);
}

/** Première image d'un message (pièce jointe image, puis image ou miniature d'embed). Pur. */
function firstImage(message) {
  const attachments = message?.attachments?.values?.() ?? message?.attachments ?? [];
  for (const a of attachments) {
    const type = a?.contentType ?? a?.content_type ?? '';
    const name = String(a?.name ?? a?.filename ?? a?.url ?? '').toLowerCase().split('?')[0];
    if (/^image\//.test(type) || /\.(png|jpe?g|gif|webp)$/.test(name)) return a.url ?? null;
  }
  for (const e of message?.embeds ?? []) {
    const url = e?.image?.url ?? e?.thumbnail?.url ?? null;
    if (url) return url;
  }
  return null;
}

/** Salon NSFW (un fil hérite de son salon parent) ? Pur. */
function isNsfwChannel(channel) {
  return Boolean(channel?.nsfw || channel?.parent?.nsfw);
}

module.exports = { parseEmoji, emojiMatches, normalize, matchesTrigger, renderResponse, firstImage, isNsfwChannel, TRIGGER_MODES };
