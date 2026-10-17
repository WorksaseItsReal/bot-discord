'use strict';

const { escapeMarkdown, PermissionFlagsBits } = require('discord.js');
const { findBadWord } = require('./automod/words');
const { extractLinks, extractInvites } = require('./automod/links');
const { phishingScore } = require('./automod/phishing');
const { UserError } = require('../core/errors');

/**
 * Textes de membres affichés par le bot : jamais de lien masqué « [texte](url) » cliquable
 * (le bot signerait un lien d'hameçonnage déguisé). Les barres obliques inverses et les
 * crochets sont échappés : le texte et l'adresse s'affichent tels quels. Le reste du
 * Markdown (gras, listes…) est conservé. Pur.
 */
function neutralizeMaskedLinks(text) {
  return String(text ?? '').replace(/[\\[\]]/g, '\\$&');
}

/**
 * Pseudo, surnom ou nom de serveur affiché dans un embed : tout le Markdown échappé, liens
 * masqués compris (escapeMarkdown({ maskedLink: true }) n'échappe que le premier de la ligne). Pur.
 */
function safeName(name) {
  return escapeMarkdown(String(name ?? '')).replace(/[[\]]/g, '\\$&');
}

/**
 * Texte libre d'un membre que le bot publiera (suggestion, rappel, sondage) : refusé s'il
 * contient ce que l'AutoMod supprimerait dans un message ordinaire (mot interdit, invitation,
 * lien d'arnaque, lien non autorisé) — sinon le bot, que l'AutoMod ignore, le publierait à sa
 * place. Comme l'AutoMod : AutoMod ou filtre désactivé, « Gérer les messages », rôles et salons
 * ignorés ou exemptés du filtre → aucun refus. Lève une UserError.
 * @param {string} text
 * @param {{ automod?: object, guild?: object|null, member?: object|null, channel?: object|null, label?: string }} ctx
 */
function assertAutomodClean(text, { automod, guild = null, member = null, channel = null, label = 'Ce texte' } = {}) {
  if (!text || !automod?.enabled) return;
  if (member?.permissions?.has?.(PermissionFlagsBits.ManageMessages)) return;
  const ignored = automod.ignoredChannels ?? [];
  if (channel && (ignored.includes(channel.id) || (channel.parentId && ignored.includes(channel.parentId)))) return;
  if (member?.roles?.cache?.some?.((r) => automod.ignoredRoles?.includes(r.id))) return;
  // Chargé à la demande : AutoModService dépend lui-même des services de logs et de modération.
  const { blockedLinks, blockedInvites, effectiveFilters } = require('../services/AutoModService');
  const f = effectiveFilters(automod.filters ?? {}, { member, channel });
  if (f.badWords?.enabled && findBadWord(text, f.badWords.words)) throw new UserError(`${label} contient un mot interdit sur ce serveur.`);
  if (f.antiInvite?.enabled && blockedInvites(extractInvites(text), f.antiInvite, guild).length) {
    throw new UserError(`${label} contient une invitation vers un autre serveur : elles ne sont pas autorisées ici.`);
  }
  const links = extractLinks(text);
  if (!links.length) return;
  if (f.antiPhishing?.enabled || f.antiHacked?.enabled) {
    const scan = phishingScore(text, { allowedDomains: f.antiLink?.allowedDomains });
    const phishing = (f.antiPhishing?.enabled && scan.score >= (f.antiPhishing.threshold ?? 3)) || (f.antiHacked?.enabled && scan.score >= (f.antiHacked.scamScore ?? 5));
    if (phishing) throw new UserError(`${label} contient un lien d'arnaque probable.`);
  }
  if (f.antiLink?.enabled && blockedLinks(links, f.antiLink).length) throw new UserError(`${label} contient un lien non autorisé sur ce serveur.`);
}

module.exports = { neutralizeMaskedLinks, safeName, assertAutomodClean };
