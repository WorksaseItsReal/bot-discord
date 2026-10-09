'use strict';

const { ActivityType } = require('discord.js');

/**
 * Présence du bot : statuts tournants, réglage GLOBAL (tous les serveurs) par variables
 * d'environnement — le plus simple et le plus sûr : seul l'hébergeur du bot peut le changer.
 *
 *   PRESENCE_STATUSES="regarde:/help • {serveurs} serveurs | joue:/projet | écoute:{membres} membres"
 *   PRESENCE_INTERVAL_MINUTES=1   (1 minute au minimum)
 *
 * Types : joue / playing, regarde / watching, écoute / listening (sans type : « regarde »).
 * Variables : {serveurs} (nombre de serveurs), {membres} (total des membres).
 */

const TYPES = Object.freeze({
  playing: ActivityType.Playing,
  joue: ActivityType.Playing,
  watching: ActivityType.Watching,
  regarde: ActivityType.Watching,
  listening: ActivityType.Listening,
  ecoute: ActivityType.Listening,
  'écoute': ActivityType.Listening,
});
const TYPE_LABELS = Object.freeze({ [ActivityType.Playing]: 'Joue à', [ActivityType.Watching]: 'Regarde', [ActivityType.Listening]: 'Écoute' });
const MAX_STATUSES = 10;
const MAX_TEXT = 128;
const MIN_INTERVAL_MINUTES = 1;
const MAX_INTERVAL_MINUTES = 1440;

/** Statuts par défaut (comportement historique du bot). */
const DEFAULT_STATUSES = Object.freeze([
  { type: ActivityType.Watching, text: '/help • toutes les commandes' },
  { type: ActivityType.Watching, text: '{serveurs} serveur(s)' },
  { type: ActivityType.Playing, text: '/projet • vos projets' },
  { type: ActivityType.Listening, text: '{membres} membres' },
]);

/**
 * Liste de statuts saisie (« type:texte | type:texte »). Entrées vides, trop longues ou en
 * trop ignorées (signalées dans `invalid`). Pur.
 * @returns {{ statuses: Array<{ type: number, text: string }>, invalid: string[] }}
 */
function parseStatuses(raw) {
  const statuses = [];
  const invalid = [];
  for (const part of String(raw ?? '').split('|')) {
    const entry = part.trim();
    if (!entry) continue;
    const colon = entry.indexOf(':');
    const head = colon > 0 ? entry.slice(0, colon).trim().toLowerCase() : '';
    const known = Object.hasOwn(TYPES, head);
    const type = known ? TYPES[head] : ActivityType.Watching;
    // eslint-disable-next-line no-control-regex
    const text = (known ? entry.slice(colon + 1) : entry).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!text || text.length > MAX_TEXT || statuses.length >= MAX_STATUSES) {
      invalid.push(entry.slice(0, 60));
      continue;
    }
    statuses.push({ type, text });
  }
  return { statuses, invalid };
}

/**
 * Réglages effectifs à partir de la configuration (src/config).
 * @param {{ presenceStatuses?: string, presenceIntervalMinutes?: number|null }} config
 * @returns {{ statuses: Array<{ type: number, text: string }>, intervalMs: number, source: 'env'|'default', invalid: string[] }}
 */
function presenceSettings(config = {}) {
  const { statuses, invalid } = parseStatuses(config.presenceStatuses);
  const minutes = Number(config.presenceIntervalMinutes);
  const interval = Number.isFinite(minutes) && minutes >= MIN_INTERVAL_MINUTES && minutes <= MAX_INTERVAL_MINUTES ? minutes : MIN_INTERVAL_MINUTES;
  return {
    statuses: statuses.length ? statuses : DEFAULT_STATUSES.map((s) => ({ ...s })),
    intervalMs: Math.round(interval * 60_000),
    source: statuses.length ? 'env' : 'default',
    invalid,
  };
}

/** Texte affiché (variables remplacées, 128 caractères au plus). Pur. */
function renderStatus(status, { servers = 0, members = 0 } = {}) {
  const name = status.text
    .replace(/\{serveurs\}/gi, String(servers))
    .replace(/\{membres\}/gi, String(members))
    .slice(0, MAX_TEXT);
  return { name, type: status.type };
}

/** Compteurs du bot (serveurs, membres). */
function counts(client) {
  return {
    servers: client.guilds?.cache?.size ?? 0,
    members: client.guilds?.cache?.reduce?.((n, g) => n + (g.memberCount || 0), 0) ?? 0,
  };
}

/**
 * (Re)lance la rotation : un seul minuteur, `client.presenceTimer` (arrêté par
 * GadgetClient#doShutdown). Un appel répété remplace le minuteur précédent.
 * @returns {ReturnType<typeof presenceSettings>}
 */
function startPresenceRotation(client, settings, onError = () => {}) {
  if (client.presenceTimer) clearInterval(client.presenceTimer);
  let i = 0;
  const update = () => {
    try {
      const status = settings.statuses[i % settings.statuses.length];
      client.user?.setPresence({ activities: [renderStatus(status, counts(client))], status: 'online' });
      i += 1;
    } catch (err) {
      onError(err);
    }
  };
  update();
  client.presenceTimer = setInterval(update, settings.intervalMs);
  client.presenceTimer.unref?.();
  return settings;
}

module.exports = {
  parseStatuses,
  presenceSettings,
  renderStatus,
  startPresenceRotation,
  counts,
  DEFAULT_STATUSES,
  TYPE_LABELS,
  MAX_STATUSES,
  MIN_INTERVAL_MINUTES,
};
