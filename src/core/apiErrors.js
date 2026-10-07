'use strict';

/**
 * Traduction des erreurs de l'API Discord en messages clairs (français).
 * Sans cela, un simple « Missing Permissions » se transforme en
 * « Une erreur inattendue est survenue », ce qui n'aide personne.
 *
 * Codes : https://discord.com/developers/docs/topics/opcodes-and-status-codes#json
 */

const FRIENDLY = {
  10003: 'Ce salon n\'existe plus.',
  10004: 'Ce serveur est introuvable.',
  10007: 'Ce membre n\'est plus sur le serveur.',
  10008: 'Ce message n\'existe plus (il a peut-être été supprimé).',
  10011: 'Ce rôle n\'existe plus.',
  10013: 'Utilisateur introuvable.',
  10014: 'Emoji introuvable.',
  10026: 'Ce bannissement n\'existe pas.',
  30001: 'Limite de serveurs atteinte.',
  30005: 'Le serveur a atteint le nombre maximal de rôles (250).',
  30007: 'Le salon a atteint le nombre maximal de webhooks.',
  30010: 'Nombre maximal de réactions atteint sur ce message.',
  30013: 'Le serveur a atteint le nombre maximal de salons (500).',
  30035: 'Limite de bannissements récents atteinte, réessayez plus tard.',
  40005: 'Fichier trop volumineux.',
  50001: 'Je n\'ai pas accès à ce salon (vérifiez mes permissions « Voir le salon »).',
  50007: 'Impossible d\'envoyer un message privé à cet utilisateur (MP fermés).',
  50013: 'Il me manque des permissions pour effectuer cette action (ou mon rôle est trop bas dans la hiérarchie).',
  50021: 'Impossible d\'effectuer cette action sur un message système.',
  50024: 'Action impossible sur ce type de salon.',
  50034: 'Les messages de plus de 14 jours ne peuvent pas être supprimés en masse.',
  50035: 'Données invalides envoyées à Discord (texte trop long ou format incorrect).',
  50083: 'Action impossible : le fil est archivé.',
  50101: 'Impossible de modifier le pseudo du propriétaire du serveur.',
  160002: 'Impossible de répondre à ce message.',
  200000: 'Ce contenu a été bloqué par l\'AutoMod de Discord.',
};

/** Codes signifiant que l'interaction est morte : inutile d'essayer de répondre. */
const DEAD_INTERACTION = new Set([10062, 40060]);

/**
 * @param {unknown} err
 * @returns {{ friendly: string | null, code: number | null, deadInteraction: boolean, rateLimited: boolean }}
 */
function describeApiError(err) {
  const code = typeof err?.code === 'number' ? err.code : null;
  const status = typeof err?.status === 'number' ? err.status : null;
  const deadInteraction = code != null && DEAD_INTERACTION.has(code);
  const rateLimited = status === 429 || err?.name === 'RateLimitError';
  let friendly = code != null ? FRIENDLY[code] ?? null : null;
  if (!friendly && rateLimited) friendly = 'Discord limite temporairement mes actions. Réessayez dans quelques secondes.';
  if (!friendly && status != null && status >= 500) friendly = 'Discord rencontre des difficultés en ce moment. Réessayez dans un instant.';
  if (!friendly && err?.code === 'InteractionCollectorError') friendly = 'Délai dépassé.';
  return { friendly, code, deadInteraction, rateLimited };
}

module.exports = { describeApiError, FRIENDLY };
