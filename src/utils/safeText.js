'use strict';

const { escapeMarkdown } = require('discord.js');

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

module.exports = { neutralizeMaskedLinks, safeName };
