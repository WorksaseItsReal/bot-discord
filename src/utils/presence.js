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
const TYPE_LABELS = Object.freeze({
  [ActivityType.Playing]: 'Joue à',
  [ActivityType.Watching]: 'Regarde',
  [ActivityType.Listening]: 'Écoute',
  [ActivityType.Competing]: 'Participe à',
  [ActivityType.Streaming]: 'En direct',
  [ActivityType.Custom]: 'Statut personnalisé',
});

/**
 * Activité imposée par les propriétaires (/bot activite) : choix de la commande → type Discord.
 * Plus large que PRESENCE_STATUSES (stream avec URL, statut personnalisé).
 */
const BOT_ACTIVITY_TYPES = Object.freeze({
  joue: ActivityType.Playing,
  regarde: ActivityType.Watching,
  ecoute: ActivityType.Listening,
  participe: ActivityType.Competing,
  stream: ActivityType.Streaming,
  personnalise: ActivityType.Custom,
});
/** Statuts en ligne acceptés par Discord pour un bot. */
const PRESENCE_STATUSES_ONLINE = Object.freeze(['online', 'idle', 'dnd', 'invisible']);
const STATUS_LABELS = Object.freeze({ online: '🟢 En ligne', idle: '🌙 Inactif', dnd: '⛔ Ne pas déranger', invisible: '⚫ Invisible' });
/** Hôtes acceptés pour l'URL d'un stream (Discord n'affiche le bouton « Regarder » que pour eux). */
const STREAM_HOSTS = Object.freeze(['twitch.tv', 'www.twitch.tv', 'youtube.com', 'www.youtube.com']);
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
  // Statut personnalisé : Discord affiche `state` (le nom est imposé).
  if (status.type === ActivityType.Custom) return { name: 'Custom Status', state: name, type: status.type };
  if (status.type === ActivityType.Streaming && status.url) return { name, type: status.type, url: status.url };
  return { name, type: status.type };
}

/**
 * URL d'un stream : https, twitch.tv ou youtube.com, sans identifiants, 512 caractères au plus.
 * @returns {string|null} URL normalisée, ou null si refusée. Pur.
 */
function parseStreamUrl(raw) {
  const text = String(raw ?? '').trim();
  if (!text || text.length > 512 || /\s/.test(text)) return null;
  let url;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
  if (!STREAM_HOSTS.includes(url.hostname.toLowerCase())) return null;
  if (url.pathname === '/' || !url.pathname) return null; // une chaîne ou une vidéo, pas la page d'accueil
  return url.toString();
}

/** Texte d'activité nettoyé (caractères de contrôle retirés, espaces réduits). Pur. */
function cleanActivityText(raw) {
  // eslint-disable-next-line no-control-regex
  return String(raw ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Activité imposée valide ({ type, text, url? }), ou null (type inconnu, texte vide ou trop
 * long, stream sans URL autorisée). Pur.
 */
function validActivity(activity) {
  if (!activity || typeof activity !== 'object') return null;
  const type = Number(activity.type);
  if (!Object.values(BOT_ACTIVITY_TYPES).includes(type)) return null;
  const text = cleanActivityText(activity.text);
  if (!text || text.length > MAX_TEXT) return null;
  if (type === ActivityType.Streaming) {
    const url = parseStreamUrl(activity.url);
    return url ? { type, text, url } : null;
  }
  return { type, text };
}

/**
 * Présence effective : l'activité imposée par /bot (clé « presence » de bot_settings) est
 * PRIORITAIRE sur PRESENCE_STATUSES et les statuts par défaut ; le statut imposé (inactif,
 * ne pas déranger…) s'applique à la rotation comme à l'activité imposée. Pur.
 * @param {object} config configuration (presenceStatuses, presenceIntervalMinutes)
 * @param {{ activity?: object|null, status?: string|null }|null} override
 * @returns {ReturnType<typeof presenceSettings> & { status: string, source: 'bot'|'env'|'default' }}
 */
function effectivePresence(config = {}, override = null) {
  const base = presenceSettings(config);
  const status = PRESENCE_STATUSES_ONLINE.includes(override?.status) ? override.status : 'online';
  const activity = validActivity(override?.activity);
  if (activity) return { ...base, statuses: [activity], source: 'bot', status };
  return { ...base, status };
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
 * `settings.status` (effectivePresence) : statut en ligne imposé, « online » par défaut.
 * @returns {ReturnType<typeof presenceSettings>}
 */
function startPresenceRotation(client, settings, onError = () => {}) {
  if (client.presenceTimer) clearInterval(client.presenceTimer);
  let i = 0;
  const update = () => {
    try {
      const status = settings.statuses[i % settings.statuses.length];
      client.user?.setPresence({ activities: [renderStatus(status, counts(client))], status: settings.status ?? 'online' });
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
  effectivePresence,
  validActivity,
  parseStreamUrl,
  cleanActivityText,
  BOT_ACTIVITY_TYPES,
  PRESENCE_STATUSES_ONLINE,
  STATUS_LABELS,
  STREAM_HOSTS,
  MAX_TEXT,
  renderStatus,
  startPresenceRotation,
  counts,
  DEFAULT_STATUSES,
  TYPE_LABELS,
  MAX_STATUSES,
  MIN_INTERVAL_MINUTES,
};
