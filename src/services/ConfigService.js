'use strict';

const { defaultGuildConfig } = require('../config/defaults');

/** Fusion profonde simple (objets uniquement, pas de tableaux fusionnés). */
function deepMerge(target, source) {
  const out = Array.isArray(target) ? [...target] : { ...target };
  for (const key of Object.keys(source || {})) {
    const sv = source[key];
    if (sv && typeof sv === 'object' && !Array.isArray(sv) && typeof out[key] === 'object' && !Array.isArray(out[key])) {
      out[key] = deepMerge(out[key], sv);
    } else {
      out[key] = sv;
    }
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

  /**
   * Met à jour une partie de la config d'un serveur (patch fusionné).
   * @returns {object} nouvelle config effective
   */
  update(guildId, patch) {
    const current = this.repo.get(guildId) || {};
    const nextStored = deepMerge(current, patch);
    this.repo.set(guildId, nextStored);
    const effective = deepMerge(clone(defaultGuildConfig), nextStored);
    this.cache.set(guildId, effective);
    return effective;
  }

  invalidate(guildId) {
    this.cache.delete(guildId);
  }
}

module.exports = { ConfigService, deepMerge };
