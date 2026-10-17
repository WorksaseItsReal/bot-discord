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

/** Le serveur a-t-il des lignes à rattraper (XP, arrivées, absences, alertes) ? Évite toute lecture inutile. */
function hasRows(client, guildId) {
  const repos = client.repositories ?? {};
  return Boolean(repos.levels?.hasGuild?.(guildId) || repos.inviteJoins?.hasOpen?.(guildId) || repos.afk?.count?.(guildId) || repos.highlights?.listByGuild?.(guildId)?.length);
}

/**
 * Données personnelles des membres partis hors ligne (effacées en ligne par memberTools.js au
 * départ) : absence (/afk) et alertes de mots-clés (/alertes).
 * @returns {number} entrées effacées
 */
function forgetDepartedTools(client, guildId, isPresent) {
  const repos = client.repositories ?? {};
  const services = client.services ?? {};
  let forgotten = 0;
  for (const userId of repos.afk?.userIds?.(guildId) ?? []) {
    if (!isPresent(userId) && services.afk?.forget(guildId, userId)) forgotten += 1;
  }
  for (const entry of repos.highlights?.listByGuild?.(guildId) ?? []) {
    if (!isPresent(entry.userId) && services.highlights?.forget(guildId, entry.userId)) forgotten += 1;
  }
  return forgotten;
}

/**
 * Rattrape, pour un serveur, les départs et retours manqués (bot hors ligne, membres partis
 * avant la migration 17) : classement des niveaux (`left_at`), « net » des invitations,
 * absences et alertes de mots-clés des membres partis (effacées).
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
  const tools = forgetDepartedTools(client, guild.id, isPresent);
  if (levels.left || levels.returned || invites || tools) {
    logger.info(`Départs rattrapés sur ${guild.id} : niveaux ${levels.left} parti(s) / ${levels.returned} revenu(s), invitations ${invites}, absences et alertes effacées ${tools}.`);
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
