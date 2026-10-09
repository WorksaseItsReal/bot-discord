'use strict';

const { GatewayIntentBits } = require('discord.js');
const { createLogger } = require('../core/logger');

const logger = createLogger('departures');

/** Premier serveur traité après le démarrage, puis un serveur à la fois, espacés. */
const START_DELAY_MS = 30_000;
const GUILD_DELAY_MS = 5_000;
/** Lecture de la liste complète des membres (une par serveur, au démarrage). */
const FETCH_TIMEOUT_MS = 60_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms).unref?.());
const stopping = (client) => Boolean(client.shutdownPromise);

/** Le serveur a-t-il des lignes à rattraper (XP ou arrivées) ? Évite toute lecture inutile. */
function hasRows(client, guildId) {
  return Boolean(client.repositories?.levels?.hasGuild?.(guildId) || client.repositories?.inviteJoins?.hasOpen?.(guildId));
}

/**
 * Rattrape, pour un serveur, les départs et retours manqués (bot hors ligne, membres partis
 * avant la migration 17) : classement des niveaux (`left_at`) et « net » des invitations.
 * Uniquement d'après la liste COMPLÈTE des membres : une liste partielle (lecture échouée,
 * intent GuildMembers absent) ne marque jamais personne comme parti.
 * @returns {Promise<{ levels: { left: number, returned: number }, invites: number }|null>} null : serveur ignoré
 */
async function reconcileGuild(client, guild, { now = Date.now() } = {}) {
  if (!guild?.available || stopping(client)) return null;
  if (!client.options?.intents?.has?.(GatewayIntentBits.GuildMembers)) return null;
  if (!hasRows(client, guild.id)) return null;
  if ((guild.members.cache.size ?? 0) < (guild.memberCount ?? Infinity)) {
    await guild.members.fetch({ time: FETCH_TIMEOUT_MS }).catch((e) => logger.debug(`Liste des membres de ${guild.id} :`, e?.message));
  }
  if (stopping(client) || !client.guilds.cache.has(guild.id)) return null;
  if ((guild.members.cache.size ?? 0) < (guild.memberCount ?? Infinity)) return null; // liste incomplète
  const isPresent = (id) => guild.members.cache.has(id);
  const levels = client.repositories?.levels?.reconcileDepartures?.(guild.id, isPresent, now) ?? { left: 0, returned: 0 };
  const invites = client.repositories?.inviteJoins?.reconcileDepartures?.(guild.id, isPresent, now) ?? 0;
  if (levels.left || levels.returned || invites) {
    logger.info(`Départs rattrapés sur ${guild.id} : niveaux ${levels.left} parti(s) / ${levels.returned} revenu(s), invitations ${invites}.`);
  }
  return { levels, invites };
}

/**
 * Au démarrage : rattrapage des départs manqués, un serveur à la fois (une seule lecture
 * des membres par serveur, espacées), sans bloquer les autres tâches de démarrage.
 * Interrompu proprement à l'arrêt du bot.
 */
module.exports = {
  name: 'clientReady',
  once: true,
  reconcileGuild,
  delays: { start: START_DELAY_MS, guild: GUILD_DELAY_MS },
  /** @param {import('../core/GadgetClient').GadgetClient} client */
  execute(client) {
    const { delays } = module.exports;
    const run = async () => {
      await sleep(delays.start);
      for (const guildId of [...client.guilds.cache.keys()]) {
        if (stopping(client)) return;
        const guild = client.guilds.cache.get(guildId);
        await reconcileGuild(client, guild).catch((e) => logger.warn(`Rattrapage des départs (${guildId}) :`, e?.message));
        await sleep(delays.guild);
      }
    };
    // Pas d'attente : les autres gestionnaires de clientReady ne sont pas retardés.
    run().catch((e) => logger.warn('Rattrapage des départs :', e?.message));
  },
};
