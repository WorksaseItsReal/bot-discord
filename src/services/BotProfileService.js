'use strict';

const { PermissionFlagsBits } = require('discord.js');
const { createLogger } = require('../core/logger');
const { UserError } = require('../core/errors');
const { fetchDiscordImage } = require('../utils/discordCdn');
const { effectivePresence, startPresenceRotation, validActivity } = require('../utils/presence');
const { nameViolation, impersonationWord } = require('../utils/automod/names');
const { findBadWord } = require('../utils/automod/words');
const { extractInvites } = require('../utils/automod/links');
const { phishingScore } = require('../utils/automod/phishing');

const logger = createLogger('bot-profile');

/**
 * Identité du bot.
 *  - GLOBALE (console /bot des propriétaires) : nom, avatar, bannière, présence imposée
 *    (clé « presence » de bot_settings, prioritaire au démarrage et dans la rotation).
 *  - PAR SERVEUR (/settings profil) : pseudo, avatar, bannière et bio via `guild.members.editMe`,
 *    sans jamais toucher au profil global.
 * Les images viennent UNIQUEMENT du CDN de Discord (utils/discordCdn.js) et sont passées en
 * Buffer : jamais de chaîne à editMe / setAvatar (resolveImage lirait un fichier local).
 * Aucun log de serveur pour la console /bot (réglage d'instance) : seulement le logger.
 */

const PRESENCE_KEY = 'presence';
const MAX_NICK = 32;
const MAX_BIO = 190;
const MIN_USERNAME = 2;
const MAX_USERNAME = 32;
/** Avatar et bannière par serveur : un changement par 10 minutes et par serveur. */
const PROFILE_IMAGE_COOLDOWN_MS = 10 * 60_000;

/** Couleurs nommées acceptées par /settings theme. */
const NAMED_COLORS = Object.freeze({
  rouge: 0xed4245,
  red: 0xed4245,
  orange: 0xf57731,
  jaune: 0xfee75c,
  yellow: 0xfee75c,
  or: 0xf1c40f,
  gold: 0xf1c40f,
  vert: 0x57f287,
  green: 0x57f287,
  turquoise: 0x1abc9c,
  cyan: 0x00a8fc,
  bleu: 0x3498db,
  blue: 0x3498db,
  blurple: 0x5865f2,
  violet: 0x9b59b6,
  purple: 0x9b59b6,
  rose: 0xeb459e,
  pink: 0xeb459e,
  blanc: 0xffffff,
  white: 0xffffff,
  gris: 0x95a5a6,
  grey: 0x95a5a6,
  gray: 0x95a5a6,
  noir: 0x010101,
  black: 0x010101,
});
const RESET_WORDS = new Set(['defaut', 'défaut', 'default', 'aucun', 'aucune', 'none', 'reset', 'reinitialiser', 'réinitialiser']);

/**
 * Couleur saisie pour /settings theme : « #FF0000 », « ff0000 », « #f00 », « rgb(255, 0, 0) »,
 * « 255,0,0 », un nom (« rouge », « bleu »…) ou « défaut » (→ null). Le noir devient 0x010101
 * (Discord traite 0 comme « pas de couleur »). Lève une UserError. Pur.
 * @returns {number|null}
 */
function parseThemeColor(input) {
  const raw = String(input ?? '').trim().toLowerCase();
  if (!raw) throw new UserError('Indiquez une couleur : `#5865F2`, `rgb(88, 101, 242)`, un nom (`rouge`, `bleu`…) ou `défaut`.');
  if (RESET_WORDS.has(raw)) return null;
  let value = null;
  if (Object.hasOwn(NAMED_COLORS, raw)) value = NAMED_COLORS[raw];
  const hex = /^(?:#|0x)?([0-9a-f]{3}|[0-9a-f]{6})$/.exec(raw);
  if (value == null && hex) {
    const h = hex[1].length === 3 ? hex[1].split('').map((c) => c + c).join('') : hex[1];
    value = parseInt(h, 16);
  }
  const rgb = /^(?:rgb\s*\(\s*)?(\d{1,3})\s*[,\s]\s*(\d{1,3})\s*[,\s]\s*(\d{1,3})\s*\)?$/.exec(raw);
  if (value == null && rgb) {
    const parts = rgb.slice(1, 4).map(Number);
    if (parts.some((n) => n > 255)) throw new UserError('Chaque composante RVB va de 0 à 255.');
    value = (parts[0] << 16) | (parts[1] << 8) | parts[2];
  }
  if (value == null) throw new UserError(`Couleur « ${String(input).slice(0, 30)} » non reconnue : \`#5865F2\`, \`rgb(88, 101, 242)\`, un nom (\`rouge\`, \`bleu\`, \`vert\`…) ou \`défaut\`.`);
  return value === 0 ? 0x010101 : value;
}

/** Couleur → « #5865F2 ». Pur. */
function colorHex(value) {
  return Number.isInteger(value) ? `#${value.toString(16).padStart(6, '0').toUpperCase()}` : null;
}

/** Mots interdits du serveur (liste de l'AutoMod, même si le filtre est coupé). */
function badWordsOf(cfg) {
  return cfg?.automod?.filters?.badWords?.words ?? [];
}

/**
 * Pseudo du bot sur un serveur : 1 à 32 caractères, ni mention, ni mot interdit, ni usurpation
 * (« Discord Staff », « Admin »…), ni texte illisible. Lève une UserError. Pur.
 * @returns {string}
 */
function validateNick(input, cfg = {}) {
  const nick = String(input ?? '').replace(/\s+/g, ' ').trim();
  if (!nick) throw new UserError('Le pseudo ne peut pas être vide (utilisez `reinitialiser: pseudo` pour retirer le pseudo).');
  if ([...nick].length > MAX_NICK) throw new UserError(`Le pseudo fait au plus ${MAX_NICK} caractères.`);
  if (/@(everyone|here)|<[@#&!]/i.test(nick)) throw new UserError('Le pseudo ne peut pas contenir de mention.');
  const v = nameViolation(nick, { dehoist: false, unreadable: true, impersonation: true, words: true }, { words: badWordsOf(cfg) });
  if (v) throw new UserError(`Pseudo refusé : ${v.reason.toLowerCase()}${v.detail ? ` (${v.detail})` : ''}.`);
  return nick;
}

/**
 * Bio du bot sur un serveur : 190 caractères au plus ; refusées : mots interdits, usurpation,
 * invitations, liens d'arnaque probables, @everyone / @here. Lève une UserError. Pur.
 * @returns {string}
 */
function validateBio(input, cfg = {}) {
  const bio = String(input ?? '').trim();
  if (!bio) throw new UserError('La bio ne peut pas être vide (utilisez `reinitialiser: bio` pour la retirer).');
  if ([...bio].length > MAX_BIO) throw new UserError(`La bio fait au plus ${MAX_BIO} caractères.`);
  if (/@(everyone|here)/i.test(bio)) throw new UserError('La bio ne peut pas mentionner @everyone ou @here.');
  if (extractInvites(bio).length) throw new UserError('La bio ne peut pas contenir d\'invitation Discord.');
  const scan = phishingScore(bio, { allowedDomains: cfg?.automod?.filters?.antiLink?.allowedDomains });
  if (scan.score >= 3) throw new UserError('La bio contient un lien d\'arnaque probable.');
  const bad = findBadWord(bio, badWordsOf(cfg));
  if (bad) throw new UserError('La bio contient un mot interdit sur ce serveur.');
  const word = impersonationWord(bio);
  if (word) throw new UserError(`Bio refusée : usurpation (contient « ${word} »).`);
  return bio;
}

/**
 * Nom GLOBAL du bot : 2 à 32 caractères, ni « discord », ni mention, ni « everyone » / « here »
 * (règles de Discord pour les noms d'utilisateur). Lève une UserError. Pur.
 */
function validateUsername(input) {
  const name = String(input ?? '').replace(/\s+/g, ' ').trim();
  const length = [...name].length;
  if (length < MIN_USERNAME || length > MAX_USERNAME) throw new UserError(`Le nom du bot fait de ${MIN_USERNAME} à ${MAX_USERNAME} caractères.`);
  if (/discord|```|[@#:]|^(everyone|here)$/i.test(name)) throw new UserError('Discord refuse ce nom (« discord », @, #, :, ``` , everyone et here sont interdits).');
  return name;
}

/**
 * Erreur de Discord lors d'un changement de profil → UserError lisible (limite de débit,
 * nom refusé, image refusée), ou l'erreur d'origine. Pur.
 */
function translateProfileError(err) {
  const text = `${err?.message ?? ''} ${JSON.stringify(err?.rawError?.errors ?? {})}`;
  if (err?.status === 429 || err?.name === 'RateLimitError' || /RATE_LIMIT|too fast|trop vite/i.test(text)) {
    return new UserError('Discord limite ce changement : trop de modifications récentes. Réessayez plus tard (souvent après une heure).');
  }
  if (err?.code === 50035 && /USERNAME|username/.test(text)) return new UserError('Discord refuse ce nom (déjà pris, interdit ou trop proche d\'un nom réservé).');
  if (err?.code === 50035 && /AVATAR|BANNER|avatar|banner|image/i.test(text)) return new UserError('Discord refuse cette image (format, dimensions ou taille).');
  if (err?.code === 50046 || err?.code === 50138) return new UserError('Discord refuse cette image (format ou taille).');
  if (err?.code === 50013) return new UserError('Il me manque une permission pour modifier mon profil sur ce serveur (**Changer de pseudo**).');
  return err;
}

class BotProfileService {
  /**
   * @param {{ client: import('discord.js').Client, settings: import('../database/repositories/BotSettingsRepository').BotSettingsRepository, http?: Function }} deps
   *   http : transport injecté pour les téléchargements (tests), sinon safeFetch
   */
  constructor({ client, settings, http = undefined }) {
    this.client = client;
    this.settings = settings;
    /** Transport des téléchargements du CDN (undefined : safeFetch via discordCdn). */
    this.http = http;
  }

  // ------------------------------------------------------------ présence (globale)

  /** Présence imposée par /bot ({ activity, status }), ou null. */
  presenceOverride() {
    try {
      const value = this.settings?.get(PRESENCE_KEY);
      return value && typeof value === 'object' ? value : null;
    } catch (err) {
      logger.debug('Présence imposée illisible :', err?.message);
      return null;
    }
  }

  /** Présence effective (activité imposée prioritaire, puis PRESENCE_STATUSES, puis défaut). */
  presenceSettings() {
    return effectivePresence(this.client.config ?? {}, this.presenceOverride());
  }

  /** Origine des statuts affichés : 'bot' (imposés par /bot), 'env' (PRESENCE_STATUSES) ou 'defaut'. */
  presenceSource() {
    const source = this.presenceSettings().source;
    return source === 'bot' ? 'bot' : source === 'env' ? 'env' : 'defaut';
  }

  /** (Re)lance la rotation des statuts : minuteur unique (client.presenceTimer). */
  startPresence(onError = (err) => logger.debug('Mise à jour du statut impossible :', err?.message)) {
    return startPresenceRotation(this.client, this.presenceSettings(), onError);
  }

  #savePresence(patch, userId) {
    const current = this.presenceOverride() ?? {};
    const next = { activity: current.activity ?? null, status: current.status ?? null, ...patch };
    if (!next.activity && (!next.status || next.status === 'online')) this.settings.delete(PRESENCE_KEY);
    else this.settings.set(PRESENCE_KEY, next, userId);
    return this.startPresence();
  }

  /** Impose une activité ({ type, text, url? }) ; prioritaire sur la rotation. Lève une UserError. */
  setActivity(activity, userId) {
    const valid = validActivity(activity);
    if (!valid) throw new UserError('Activité invalide : texte de 1 à 128 caractères, et pour un stream une URL https de twitch.tv ou youtube.com.');
    logger.info(`Activité imposée par ${userId} : type ${valid.type}, « ${valid.text} ».`);
    return this.#savePresence({ activity: valid }, userId);
  }

  /** Retire l'activité imposée : la rotation (PRESENCE_STATUSES ou défaut) reprend. */
  clearActivity(userId) {
    logger.info(`Activité imposée retirée par ${userId} : rotation des statuts.`);
    return this.#savePresence({ activity: null }, userId);
  }

  /** Statut en ligne imposé (online, idle, dnd, invisible). */
  setStatus(status, userId) {
    if (!['online', 'idle', 'dnd', 'invisible'].includes(status)) throw new UserError('Statut inconnu.');
    logger.info(`Statut imposé par ${userId} : ${status}.`);
    return this.#savePresence({ status: status === 'online' ? null : status }, userId);
  }

  // ------------------------------------------------------------ identité globale

  /** Télécharge une image du CDN de Discord (Buffer). Lève une UserError lisible. */
  async fetchImage(url) {
    try {
      return await fetchDiscordImage(url, { http: this.http });
    } catch (err) {
      if (err?.name === 'FetchError') throw new UserError(`Image refusée : ${err.message}.`);
      throw err;
    }
  }

  /** Nom global du bot. */
  async setUsername(name, userId) {
    const valid = validateUsername(name);
    try {
      await this.client.user.setUsername(valid);
    } catch (err) {
      throw translateProfileError(err);
    }
    logger.info(`Nom du bot changé en « ${valid} » par ${userId}.`);
    return valid;
  }

  /** Avatar ou bannière GLOBAL depuis une pièce jointe (CDN de Discord uniquement). */
  async setGlobalImage(kind, url, userId) {
    const buffer = await this.fetchImage(url);
    try {
      await this.client.user.edit(kind === 'banner' ? { banner: buffer } : { avatar: buffer });
    } catch (err) {
      throw translateProfileError(err);
    }
    logger.info(`${kind === 'banner' ? 'Bannière' : 'Avatar'} du bot changé(e) par ${userId}.`);
  }

  // ------------------------------------------------------------ profil par serveur

  /** Clé du cooldown d'image (avatar / bannière) d'un serveur. */
  static imageCooldownKey(guildId, kind) {
    return `botprofile:${kind}:${guildId}`;
  }

  /**
   * Applique le profil du bot sur un serveur (editMe). `changes` : { nick, avatar, banner, bio }
   * avec une chaîne / un Buffer pour changer, null pour réinitialiser, undefined pour garder.
   */
  async applyGuildProfile(guild, changes, { reason } = {}) {
    const me = guild.members?.me;
    if (changes.nick !== undefined && me && !me.permissions?.has?.(PermissionFlagsBits.ChangeNickname)) {
      throw new UserError('Il me manque la permission **Changer de pseudo** sur ce serveur.');
    }
    const body = {};
    for (const key of ['nick', 'avatar', 'banner', 'bio']) if (changes[key] !== undefined) body[key] = changes[key];
    if (!Object.keys(body).length) return null;
    try {
      return await guild.members.editMe({ ...body, reason });
    } catch (err) {
      throw translateProfileError(err);
    }
  }
}

module.exports = {
  BotProfileService,
  parseThemeColor,
  colorHex,
  validateNick,
  validateBio,
  validateUsername,
  translateProfileError,
  NAMED_COLORS,
  PRESENCE_KEY,
  MAX_NICK,
  MAX_BIO,
  PROFILE_IMAGE_COOLDOWN_MS,
};
