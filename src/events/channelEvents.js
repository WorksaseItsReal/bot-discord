'use strict';

const { AuditLogEvent, ChannelType } = require('discord.js');
const { truncate } = require('../utils/embeds');
const { field, wide, ICONS, code } = require('../utils/ui');
const { formatDuration } = require('../utils/time');
const { fetchExecutor } = require('../utils/audit');
const { logCard } = require('../services/LoggingService');

const TYPE_LABELS = {
  [ChannelType.GuildText]: 'Textuel',
  [ChannelType.GuildVoice]: 'Vocal',
  [ChannelType.GuildCategory]: 'Catégorie',
  [ChannelType.GuildAnnouncement]: 'Annonces',
  [ChannelType.GuildStageVoice]: 'Conférence',
  [ChannelType.GuildForum]: 'Forum',
  [ChannelType.GuildMedia]: 'Média',
  [ChannelType.PublicThread]: 'Fil public',
  [ChannelType.PrivateThread]: 'Fil privé',
  [ChannelType.AnnouncementThread]: 'Fil d\'annonces',
};

const typeLabel = (channel) => TYPE_LABELS[channel.type] ?? 'Salon';
const parentLabel = (channel) => (channel.parent ? code(channel.parent.name) : '*Aucune*');

/** Changements notables entre deux versions d'un salon (nom, sujet, mode lent, NSFW, catégorie). */
function channelChanges(oldC, newC) {
  const fields = [];
  if (oldC.name !== newC.name) fields.push(field('✏️', 'Nom', `${code(oldC.name)} → ${code(newC.name)}`));
  if ((oldC.topic ?? '') !== (newC.topic ?? '')) {
    fields.push(wide('📄', 'Sujet', `${truncate(oldC.topic || '*Aucun*', 480)}\n→ ${truncate(newC.topic || '*Aucun*', 480)}`));
  }
  if ((oldC.rateLimitPerUser ?? 0) !== (newC.rateLimitPerUser ?? 0)) {
    const fmt = (s) => (s ? formatDuration(s * 1000) : 'Désactivé');
    fields.push(field('🐢', 'Mode lent', `${fmt(oldC.rateLimitPerUser)} → ${fmt(newC.rateLimitPerUser)}`));
  }
  if (Boolean(oldC.nsfw) !== Boolean(newC.nsfw)) fields.push(field('🔞', 'NSFW', newC.nsfw ? 'Activé' : 'Désactivé'));
  if (oldC.parentId !== newC.parentId) fields.push(field(ICONS.category, 'Catégorie', `${parentLabel(oldC)} → ${parentLabel(newC)}`));
  return fields;
}

/**
 * Regroupe les événements de salons (création/suppression/màj) : logs.
 * (L'AntiRaid est alimenté par guildAuditLogEntryCreate, voir banEvents.js.)
 * Un module d'événement = un nom ; on exporte donc un tableau via index des events.
 */
module.exports = [
  {
    name: 'channelCreate',
    async execute(client, channel) {
      if (!channel.guild) return;
      await client.services.logging.send(
        channel.guild.id,
        'channels',
        logCard({
          category: 'channels',
          tone: 'success',
          icon: ICONS.channel,
          title: 'Salon créé',
          description: `Le salon ${channel} a été créé.`,
          fields: [
            field(ICONS.channel, 'Salon', `${channel}\n${code(channel.name)}`),
            field(ICONS.list, 'Type', typeLabel(channel)),
            field(ICONS.category, 'Catégorie', parentLabel(channel)),
          ],
          id: channel.id,
        }), undefined, { event: 'channelCreate' });
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
        repos?.locks?.deleteChannel?.(channel.guild.id, channel.id); // états lock / hide
      } catch {
        /* nettoyage best-effort */
      }
      // Salon de logs supprimé : débranché tout de suite (plus aucun envoi vers un salon fantôme).
      const cfg = client.services.config?.get?.(channel.guild.id);
      const unplug = Object.fromEntries(Object.entries(cfg?.logChannels ?? {}).filter(([, id]) => id === channel.id).map(([k]) => [k, null]));
      if (Object.keys(unplug).length) client.services.config.update(channel.guild.id, { logChannels: unplug });
      // Pas d'appel au journal d'audit si ce log est désactivé.
      if (client.services.logging?.wouldLog?.(channel.guild.id, 'channels', { event: 'channelDelete' }) === false) return;
      const executor = await fetchExecutor(channel.guild, AuditLogEvent.ChannelDelete, channel.id);
      await client.services.logging.send(
        channel.guild.id,
        'channels',
        logCard({
          category: 'channels',
          tone: 'danger',
          icon: ICONS.delete,
          title: 'Salon supprimé',
          description: `Le salon **${channel.name}** a été supprimé.`,
          fields: [
            field(ICONS.list, 'Type', typeLabel(channel)),
            field(ICONS.category, 'Catégorie', parentLabel(channel)),
            field(ICONS.moderator, 'Par', executor ? `<@${executor}>` : '*Inconnu*'),
          ],
          id: channel.id,
        }), undefined, { event: 'channelDelete' });
    },
  },
  {
    name: 'channelUpdate',
    async execute(client, oldC, newC) {
      if (!newC.guild) return;
      const changes = channelChanges(oldC, newC);
      if (!changes.length) return; // ex : simples changements de permissions
      await client.services.logging.send(
        newC.guild.id,
        'channels',
        logCard({
          category: 'channels',
          tone: 'info',
          icon: ICONS.settings,
          title: 'Salon modifié',
          description: `Le salon ${newC} a été modifié.`,
          fields: changes,
          id: newC.id,
        }), undefined, { event: 'channelUpdate' });
    },
  },
];
