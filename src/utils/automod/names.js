'use strict';

const { canonical, leet, variants, INVISIBLE } = require('./normalize');
const { findBadWord } = require('./words');
const { isZalgo } = require('./detectors');

/**
 * AutoMod des pseudos (filtre `badNames`) : fonctions pures, testées dans tests/automod-names.test.js.
 *  - dehoist : pseudo commençant par un symbole ASCII ou un caractère invisible pour
 *    remonter en tête de la liste des membres ;
 *  - mots interdits : la liste de l'AutoMod (même moteur anti-contournement) ;
 *  - usurpation : « admin », « modérateur », « discord », « staff », « système »
 *    (accents, homoglyphes, leetspeak, lettres espacées compris), ou nom d'un membre
 *    du staff imité à un homoglyphe près ;
 *  - illisible : texte zalgo, ou rien de lisible (que des caractères invisibles/marques).
 */

/** Symboles ASCII utilisés pour remonter en tête de liste (dehoist). */
const HOIST_CHARS = '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~';
/** Mots d'usurpation (forme canonique), reconnus en DÉBUT de mot. */
const IMPERSONATION_WORDS = ['admin', 'moderat', 'moderateur', 'discord', 'staff', 'system'];
/** Libellés affichés des vérifications. */
const NAME_CHECKS = {
  dehoist: { label: 'Remonter dans la liste', emoji: '⏫', description: 'Pseudo commençant par un symbole (! ? . @ …) ou un caractère invisible' },
  words: { label: 'Mots interdits', emoji: '🚫', description: 'Mots de la liste de l\'AutoMod (section Listes)' },
  impersonation: { label: 'Usurpation', emoji: '🎭', description: '« admin », « modérateur », « discord », « staff », « système », ou nom d\'un membre du staff imité' },
  unreadable: { label: 'Pseudo illisible', emoji: '👻', description: 'Texte zalgo ou caractères invisibles uniquement' },
};
/** Modèle de renommage par défaut ({id} : 4 derniers chiffres de l'identifiant). */
const DEFAULT_NAME_TEMPLATE = 'Membre {id}';
/** Longueur maximale d'un pseudo Discord. */
const MAX_NICK = 32;

const INVISIBLE_ONE = new RegExp(`^(?:${INVISIBLE.source})`, 'u');

/** Le pseudo commence-t-il par un symbole ou un caractère invisible pour remonter en tête de liste ? Pur. */
function isHoisted(name) {
  const text = String(name ?? '');
  if (!text) return false;
  if (HOIST_CHARS.includes(text[0])) return true;
  // Caractère invisible (zero-width, Braille vide…) ou espace exotique en tête.
  return INVISIBLE_ONE.test(text) || /^[\s  - 　]/u.test(text);
}

/** Pseudo illisible : zalgo, ou aucun caractère visible une fois invisibles et marques retirés. Pur. */
function isUnreadable(name) {
  const text = String(name ?? '');
  if (!text) return false;
  if (isZalgo(text, { minMarks: 4 })) return true;
  const visible = text.replace(INVISIBLE, '').normalize('NFD').replace(/[\p{M}\s\p{Cf}\p{Cc}]+/gu, '');
  return visible.length === 0;
}

/**
 * Forme de comparaison d'un nom (« squelette ») : canonique, leetspeak, sans séparateurs,
 * confusions courantes repliées (rn → m, vv → w, l → i). Deux noms au même squelette ne
 * diffèrent que d'homoglyphes. Pur.
 */
function nameSkeleton(name) {
  return leet(canonical(name))
    .replace(/[^a-z0-9]+/g, '')
    .replace(/rn/g, 'm')
    .replace(/vv/g, 'w')
    .replace(/[l|]/g, 'i');
}

/** Mot d'usurpation contenu dans le pseudo (début de mot, camelCase compris), ou null. Pur. */
function impersonationWord(name) {
  // « xXAdminXx » / « MrStaff » : coupe les mots collés avant la mise en minuscules.
  const split = String(name ?? '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/([A-Z])([A-Z][a-z])/g, '$1 $2');
  for (const form of variants(split)) {
    for (const word of IMPERSONATION_WORDS) {
      if (new RegExp(`(?<![a-z])${word}`).test(form)) return word === 'moderat' ? 'moderateur' : word === 'system' ? 'systeme' : word;
    }
  }
  return null;
}

/**
 * Première règle enfreinte par un pseudo, ou null.
 * @param {string} name pseudo affiché
 * @param {{ dehoist?: boolean, words?: boolean, impersonation?: boolean, unreadable?: boolean }} checks vérifications actives
 * @param {{ words?: string[], staff?: Map<string, string> }} [ctx] mots interdits ; squelettes des
 *   noms du staff → nom affiché (le membre vérifié en est exclu)
 * @returns {{ check: string, reason: string, detail?: string } | null}
 */
function nameViolation(name, checks = {}, { words = [], staff = null } = {}) {
  const text = String(name ?? '');
  if (!text) return null;
  if (checks.unreadable !== false && isUnreadable(text)) return { check: 'unreadable', reason: 'Pseudo illisible', detail: 'zalgo ou caractères invisibles' };
  if (checks.dehoist !== false && isHoisted(text)) {
    const first = [...text][0];
    return { check: 'dehoist', reason: 'Pseudo pour remonter dans la liste', detail: HOIST_CHARS.includes(first) ? `commence par « ${first} »` : 'commence par un caractère invisible' };
  }
  if (checks.impersonation !== false) {
    const word = impersonationWord(text);
    if (word) return { check: 'impersonation', reason: 'Usurpation (nom réservé)', detail: `contient « ${word} »` };
    const skeleton = nameSkeleton(text);
    if (skeleton.length >= 3 && staff?.has(skeleton)) return { check: 'impersonation', reason: 'Usurpation d\'un membre du staff', detail: `imite « ${staff.get(skeleton)} »` };
  }
  if (checks.words !== false && words?.length) {
    const found = findBadWord(text, words);
    if (found) return { check: 'words', reason: 'Mot interdit dans le pseudo', detail: `« ${found.slice(0, 40)} »` };
  }
  return null;
}

/** Pseudo de remplacement : modèle, `{id}` = 4 derniers chiffres de l'identifiant, 32 caractères au plus. Pur. */
function replacementName(template, userId) {
  const id4 = String(userId ?? '').slice(-4) || '0000';
  const out = String(template || DEFAULT_NAME_TEMPLATE).replace(/\{id\}/gi, id4).replace(/\s+/g, ' ').trim();
  return [...out].slice(0, MAX_NICK).join('');
}

/**
 * Modèle valide : 1 à 32 caractères une fois rempli, et lui-même conforme (sinon le
 * renommage déclencherait de nouveau le filtre). Renvoie un message d'erreur, ou null. Pur.
 */
function templateIssue(template, words = []) {
  const raw = String(template ?? '').trim();
  if (!raw) return 'Le modèle ne peut pas être vide.';
  if (/[\n\r]/.test(raw)) return 'Le modèle tient sur une ligne.';
  if (/@everyone|@here|<[@#&!]/i.test(raw)) return 'Le modèle ne peut pas contenir de mention.';
  const sample = replacementName(raw, '123456789012345678');
  if ([...raw.replace(/\{id\}/gi, '1234')].length > MAX_NICK) return `Le modèle rempli dépasse ${MAX_NICK} caractères.`;
  const v = nameViolation(sample, {}, { words });
  if (v) return `Le pseudo produit (« ${sample} ») serait lui-même refusé : ${v.reason.toLowerCase()}.`;
  return null;
}

module.exports = {
  HOIST_CHARS,
  IMPERSONATION_WORDS,
  NAME_CHECKS,
  DEFAULT_NAME_TEMPLATE,
  isHoisted,
  isUnreadable,
  nameSkeleton,
  impersonationWord,
  nameViolation,
  replacementName,
  templateIssue,
};
