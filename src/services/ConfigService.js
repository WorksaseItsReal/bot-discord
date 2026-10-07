'use strict';

const { defaultGuildConfig } = require('../config/defaults');
const { createLogger } = require('../core/logger');

const logger = createLogger('config');

/** Taille maximale du JSON corrompu journalisé / sauvegardé. */
const CORRUPT_LOG_CHARS = 500;
const CORRUPT_BACKUP_CHARS = 20_000;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Fusion profonde des valeurs stockées sur les valeurs par défaut (objets
 * uniquement, pas de tableaux fusionnés). Typée pour les objets : quand la
 * valeur par défaut est un objet, seule une valeur stockée objet est prise en
 * compte — un `null`, un scalaire ou un tableau stocké (donnée abîmée, ancien
 * format) ne remplace jamais une section entière de la config par défaut.
 */
function deepMerge(target, source) {
  const out = Array.isArray(target) ? [...target] : { ...target };
  for (const key of Object.keys(source || {})) {
    const sv = source[key];
    if (isPlainObject(out[key])) {
      if (isPlainObject(sv)) out[key] = deepMerge(out[key], sv);
      // sinon : type incompatible, la valeur par défaut est conservée
    } else {
      out[key] = sv;
    }
  }
  return out;
}

/**
 * Application d'un patch sur la config stockée (non typée : un patch peut
 * remettre une valeur à null, la lecture via deepMerge retombera sur le défaut).
 */
function mergePatch(target, source) {
  const out = { ...target };
  for (const key of Object.keys(source || {})) {
    const sv = source[key];
    out[key] = isPlainObject(sv) && isPlainObject(out[key]) ? mergePatch(out[key], sv) : sv;
  }
  return out;
}

function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

/**
 * Gère la configuration par serveur avec cache en mémoire et fusion des
 * valeurs par défaut. Une seule source de vérité pour lire/écrire la config.
 */
class ConfigService {
  /** @param {import('../database/repositories/GuildConfigRepository').GuildConfigRepository} repo */
  constructor(repo) {
    this.repo = repo;
    /** @type {Map<string, object>} */
    this.cache = new Map();
  }

  /** @returns {object} config effective (defaults + overrides) pour un serveur */
  get(guildId) {
    if (this.cache.has(guildId)) return this.cache.get(guildId);
    const stored = this.repo.get(guildId) || {};
    const merged = deepMerge(clone(defaultGuildConfig), stored);
    this.cache.set(guildId, merged);
    return merged;
  }

  /** Config stockée brute ; une ligne corrompue est sauvegardée avant d'être écrasée. */
  #readStored(guildId) {
    if (typeof this.repo.read !== 'function') return this.repo.get(guildId) || {};
    const { data, raw, corrupted } = this.repo.read(guildId);
    if (!corrupted) return data || {};
    const text = String(raw ?? '');
    logger.warn(
      `Configuration corrompue du serveur ${guildId} écrasée ; contenu brut sauvegardé dans _corruptBackup ` +
        `(${text.length} caractères) : ${text.slice(0, CORRUPT_LOG_CHARS)}${text.length > CORRUPT_LOG_CHARS ? '…' : ''}`,
    );
    return { _corruptBackup: { at: Date.now(), raw: text.slice(0, CORRUPT_BACKUP_CHARS), truncated: text.length > CORRUPT_BACKUP_CHARS } };
  }

  /**
   * Met à jour une partie de la config d'un serveur (patch fusionné).
   * @returns {object} nouvelle config effective
   */
  update(guildId, patch) {
    const current = this.#readStored(guildId);
    const nextStored = mergePatch(current, patch);
    this.repo.set(guildId, nextStored);
    const effective = deepMerge(clone(defaultGuildConfig), nextStored);
    this.cache.set(guildId, effective);
    return effective;
  }

  /**
   * Le bot a quitté le serveur : on date le départ (purge après 30 jours par le
   * scheduler). Sans config stockée, il n'y a rien à purger.
   */
  markLeft(guildId, at = Date.now()) {
    this.cache.delete(guildId);
    const stored = this.repo.get(guildId);
    if (!stored) return false;
    this.repo.set(guildId, { ...stored, _leftAt: at });
    return true;
  }

  /** Le bot est de retour sur le serveur : annule la purge programmée. */
  clearLeft(guildId) {
    const stored = this.repo.get(guildId);
    if (!stored || stored._leftAt == null) return false;
    const { _leftAt, ...rest } = stored;
    this.repo.set(guildId, rest);
    this.cache.delete(guildId);
    return true;
  }

  /** Supprime définitivement la config stockée d'un serveur. */
  forget(guildId) {
    this.repo.delete(guildId);
    this.cache.delete(guildId);
  }

  invalidate(guildId) {
    this.cache.delete(guildId);
  }
}

module.exports = { ConfigService, deepMerge, mergePatch };
