'use strict';


/**
 * Briques de base des embeds : marque (pied de page), limites Discord, troncature
 * et mise en forme. Le rendu lui-même passe par le système de design (ui.js).
 */

/** Limites officielles des embeds Discord. */
const LIMITS = Object.freeze({
  title: 256,
  description: 4096,
  fields: 25,
  fieldName: 256,
  fieldValue: 1024,
  footer: 2048,
  author: 256,
  total: 6000,
});

/** Marque affichée dans le pied de page (renseignée au démarrage, cf. events/ready.js). */
const brand = { name: 'Inspecteur Gadget', iconURL: null };

function setBrand({ name, iconURL } = {}) {
  if (name) brand.name = String(name).slice(0, 80);
  if (iconURL !== undefined) brand.iconURL = iconURL || null;
}

/**
 * Thème par serveur (/settings theme) — appliqué par MARQUAGE, jamais par valeur de couleur :
 * card() (ui.js) pose ce symbole sur les cartes de ton « marque » (brand ou ton absent), et
 * seules ces cartes reçoivent la couleur du serveur lors de l'assainissement. Une couleur
 * explicite (card({ tone: 0x5865F2 }) de /couleur, couleur d'un rôle), un EmbedBuilder brut
 * (/embed, constructeur d'embeds) ou un ton sémantique (succès, erreur…) ne sont jamais thémés.
 */
const THEMABLE = Symbol.for('gadget.themable');

/** (guildId) => couleur entière ou null ; posé par GadgetClient au démarrage. */
let themeResolver = null;

/** Installe (ou retire, avec null) le résolveur de thème. @returns {Function|null} */
function setThemeResolver(fn) {
  themeResolver = typeof fn === 'function' ? fn : null;
  return themeResolver;
}

/** Résolveur de thème installé (ou null). */
function getThemeResolver() {
  return themeResolver;
}

/**
 * Couleur du thème d'un serveur, ou null (pas de serveur, pas de résolveur, pas de thème,
 * valeur invalide). Le noir (0) devient 0x010101 : Discord traite 0 comme « pas de couleur ».
 * Ne lève jamais.
 */
function themeColor(guildId) {
  if (!guildId || !themeResolver) return null;
  try {
    const color = themeResolver(guildId);
    if (!Number.isInteger(color) || color < 0 || color > 0xffffff) return null;
    return color === 0 ? 0x010101 : color;
  } catch {
    return null;
  }
}

/** Vrai si l'embed (builder) porte la marque « thémable » de card(). */
function isThemable(embed) {
  return Boolean(embed && embed[THEMABLE]);
}

/** Tronque proprement une chaîne (ajoute « … »). */
function truncate(value, max) {
  const str = value == null ? '' : String(value);
  if (str.length <= max) return str;
  return `${str.slice(0, Math.max(0, max - 1))}…`;
}

/** Pied de page de marque, éventuellement suffixé (ex: « Page 2/5 »). */
function brandFooter(suffix) {
  const text = truncate(suffix ? `${brand.name} • ${suffix}` : brand.name, LIMITS.footer);
  return brand.iconURL ? { text, iconURL: brand.iconURL } : { text };
}

/** Chargé à la demande : ui.js dépend lui-même de ce module (marque, limites). */
function ui() {
  return require('./ui');
}

/**
 * Barre de progression textuelle. Pure (testée).
 * @param {number} ratio entre 0 et 1 (borné)
 * @param {number} [size=12] nombre de segments
 */
function progressBar(ratio, size = 12) {
  const r = Number.isFinite(ratio) ? Math.min(1, Math.max(0, ratio)) : 0;
  const filled = Math.round(r * size);
  return `${'█'.repeat(filled)}${'░'.repeat(size - filled)}`;
}

/** Liste de mentions/textes bornée : « a, b, c et 4 autres ». */
function listOrMore(items, max = 10, separator = ', ') {
  if (!items?.length) return '—';
  const shown = items.slice(0, max).join(separator);
  const rest = items.length - max;
  return rest > 0 ? `${shown} et ${rest} autre${rest > 1 ? 's' : ''}` : shown;
}

/**
 * Rend un embed (builder ou objet) conforme aux limites Discord : tronque titres,
 * descriptions, champs, et le total à 6000 caractères. Ne lève jamais.
 * @returns {object} données JSON de l'embed
 */
function sanitizeEmbed(input) {
  const data = typeof input?.toJSON === 'function' ? input.toJSON() : { ...(input || {}) };
  if (data.title) data.title = truncate(data.title, LIMITS.title);
  if (data.description != null) {
    data.description = truncate(data.description, LIMITS.description);
    if (!data.description) delete data.description;
  }
  if (data.author?.name) data.author = { ...data.author, name: truncate(data.author.name, LIMITS.author) };
  if (data.footer?.text) data.footer = { ...data.footer, text: truncate(data.footer.text, LIMITS.footer) };
  if (Array.isArray(data.fields)) {
    data.fields = data.fields.slice(0, LIMITS.fields).map((f) => ({
      ...f,
      name: truncate(f.name || '​', LIMITS.fieldName) || '​',
      value: truncate(f.value || '​', LIMITS.fieldValue) || '​',
    }));
  }
  return data;
}

function embedLength(data) {
  return (
    (data.title?.length || 0) +
    (data.description?.length || 0) +
    (data.footer?.text?.length || 0) +
    (data.author?.name?.length || 0) +
    (data.fields || []).reduce((n, f) => n + (f.name?.length || 0) + (f.value?.length || 0), 0)
  );
}

/**
 * Sanitize une liste d'embeds d'un même message (max 10, total ≤ 6000). Avec `guildId`, les
 * cartes MARQUÉES par card() (ton « marque ») prennent la couleur du thème de ce serveur.
 * @param {Array} list
 * @param {{ guildId?: string|null }} [opts]
 * @returns {object[]}
 */
function sanitizeEmbeds(list, { guildId = null } = {}) {
  const color = themeColor(guildId);
  const out = (list || []).slice(0, 10).map((embed) => {
    const data = sanitizeEmbed(embed);
    if (color != null && isThemable(embed)) data.color = color;
    return data;
  });
  let total = out.reduce((n, e) => n + embedLength(e), 0);
  // Réduit d'abord les derniers champs, puis les descriptions, jusqu'à passer sous la limite.
  for (let i = out.length - 1; i >= 0 && total > LIMITS.total; i--) {
    const e = out[i];
    while (e.fields?.length && total > LIMITS.total) {
      const f = e.fields.pop();
      total -= (f.name?.length || 0) + (f.value?.length || 0);
    }
    if (total > LIMITS.total && e.description) {
      const keep = Math.max(0, e.description.length - (total - LIMITS.total));
      total -= e.description.length - keep;
      e.description = truncate(e.description, Math.max(1, keep));
    }
  }
  return out;
}

/** Réponse d'erreur normalisée (éphémère). */
function errorReply(description, { title, footer } = {}) {
  return { embeds: [ui().status.fail(description, title, footer ? { footer } : {})], ephemeral: true };
}

module.exports = {
  errorReply,
  setBrand,
  THEMABLE,
  setThemeResolver,
  getThemeResolver,
  themeColor,
  isThemable,
  brand,
  brandFooter,
  truncate,
  progressBar,
  listOrMore,
  sanitizeEmbed,
  sanitizeEmbeds,
  LIMITS,
};
