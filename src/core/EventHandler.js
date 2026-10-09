'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createLogger } = require('./logger');

const logger = createLogger('events');

/**
 * Charge les modules d'événements depuis src/events et les branche sur le client.
 * Chaque module exporte : { name, once?, execute(client, ...args) }.
 */
class EventHandler {
  /** @param {import('discord.js').Client} client */
  constructor(client) {
    this.client = client;
    this.count = 0;
    /** @type {{ file: string, reason: string }[]} modules non chargés */
    this.failures = [];
  }

  loadAll(dir) {
    if (!fs.existsSync(dir)) return 0;
    for (const entry of fs.readdirSync(dir)) {
      if (!entry.endsWith('.js')) continue;
      let mod;
      try {
        mod = require(path.join(path.resolve(dir), entry));
      } catch (err) {
        this.failures.push({ file: entry, reason: err?.message ?? String(err) });
        logger.error(`Échec du chargement de l'événement ${entry} :`, err);
        continue;
      }
      const events = Array.isArray(mod) ? mod : [mod];
      for (const event of events) {
        if (!event?.name || typeof event.execute !== 'function') {
          this.failures.push({ file: entry, reason: 'structure invalide' });
          logger.warn(`Événement ignoré (structure invalide) : ${entry}`);
          continue;
        }
        const bound = (...args) => Promise.resolve(event.execute(this.client, ...args)).catch((err) =>
          logger.error(`Erreur dans l'événement ${event.name} :`, err),
        );
        if (event.once) this.client.once(event.name, bound);
        else this.client.on(event.name, bound);
        this.count += 1;
      }
    }
    logger.info(`${this.count} événement(s) chargé(s).`);
    return this.count;
  }
}

module.exports = { EventHandler };
