'use strict';

const { AuditLogEvent } = require('discord.js');
const { embeds } = require('../utils/embeds');
const { fetchExecutor } = require('../utils/audit');

/**
 * Regroupe les événements de salons (création/suppression/màj) : logs + antiraid.
 * Un module d'événement = un nom ; on exporte donc un tableau via index des events.
 */
module.exports = [
  {
    name: 'channelCreate',
    async execute(client, channel) {
      if (!channel.guild) return;
      await client.services.logging.send(channel.guild.id, 'channels', embeds.success(`Salon créé : ${channel} (${channel.name})`, '📁 Salon créé'));
    },
  },
  {
    name: 'channelDelete',
    async execute(client, channel) {
      if (!channel.guild) return;
      // Nettoyage des lignes liées au salon supprimé : sinon le membre resterait
      // « bloqué » (limite de tickets atteinte, conversation ModMail fantôme…).
      try {
        const repos = client.repositories;
        repos?.tickets?.delete(channel.id);
        repos?.modmail?.close(channel.id);
        repos?.tempVoice?.delete(channel.id);
      } catch {
        /* nettoyage best-effort */
      }
      const executor = await fetchExecutor(channel.guild, AuditLogEvent.ChannelDelete, channel.id);
      await client.services.logging.send(channel.guild.id, 'channels', embeds.error(`Salon supprimé : **${channel.name}**${executor ? ` par <@${executor}>` : ''}`, '📁 Salon supprimé'));
      if (executor) await client.services.antiraid.handleDestructive(channel.guild, executor, 'channelDelete').catch(() => {});
    },
  },
  {
    name: 'channelUpdate',
    async execute(client, oldC, newC) {
      if (!newC.guild || oldC.name === newC.name) return;
      await client.services.logging.send(newC.guild.id, 'channels', embeds.info(`Salon renommé : **${oldC.name}** → ${newC}`, '📁 Salon modifié'));
    },
  },
];
