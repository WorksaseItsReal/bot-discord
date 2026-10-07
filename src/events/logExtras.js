'use strict';

const { AttachmentBuilder, GuildVerificationLevel } = require('discord.js');
const { truncate } = require('../utils/embeds');
const { field, wide, ICONS, userLine, code } = require('../utils/ui');
const { logCard } = require('../services/LoggingService');
const { discordTimestamp } = require('../utils/time');

/**
 * Événements complémentaires pour des logs complets : boosts, suppressions en
 * masse (avec transcription), fils, paramètres du serveur, emojis.
 */
const VERIFICATION = {
  [GuildVerificationLevel.None]: 'Aucun',
  [GuildVerificationLevel.Low]: 'Faible (e-mail vérifié)',
  [GuildVerificationLevel.Medium]: 'Moyen (inscrit depuis 5 min)',
  [GuildVerificationLevel.High]: 'Élevé (membre depuis 10 min)',
  [GuildVerificationLevel.VeryHigh]: 'Maximal (téléphone vérifié)',
};

const send = (client, guildId, category, embed, event) => client.services.logging.send(guildId, category, embed, undefined, { event });

module.exports = [
  {
    name: 'guildMemberUpdate',
    async execute(client, oldMember, newMember) {
      if (oldMember.partial) return; // état précédent inconnu : impossible de calculer la différence
      const user = newMember.user;
      const guildId = newMember.guild.id;

      // Rôles et pseudos : journalisés via le journal d'audit (events/auditLogs.js), qui
      // fonctionne aussi pour les membres hors cache et indique l'auteur du changement.
      if (!oldMember.premiumSince && newMember.premiumSince) {
        await send(client, guildId, 'members', logCard({
          category: 'members',
          tone: 'celebrate',
          icon: ICONS.boost,
          title: 'Nouveau boost !',
          description: `${user} boost le serveur. Merci ! 💜`,
          user,
          fields: [field(ICONS.user, 'Membre', userLine(user)), field(ICONS.count, 'Boosts du serveur', `${newMember.guild.premiumSubscriptionCount ?? '—'}`)],
        }), 'memberBoost');
      }
    },
  },
  {
    name: 'messageDeleteBulk',
    async execute(client, messages, channel) {
      if (!channel?.guild) return;
      const list = [...messages.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
      const authors = new Set(list.map((m) => m.author?.id).filter(Boolean));
      const preview = list
        .filter((m) => m.content)
        .slice(-10)
        .map((m) => `**${m.author?.username ?? '?'}** : ${truncate(m.content.replace(/\n/g, ' '), 90)}`);
      const ctx = {
        event: 'messageBulkDelete',
        channelId: channel.id,
        parentId: channel.parentId,
        categoryId: channel.parent?.parentId ?? null,
      };
      if (!client.services.logging.wouldLog(channel.guild.id, 'messages', ctx)) return;
      // Transcription complète des messages en cache, jointe au log.
      const transcript = list
        .map((m) => `[${new Date(m.createdTimestamp).toISOString().replace('T', ' ').slice(0, 19)}] ${m.author?.tag ?? 'inconnu'} : ${m.content || '(sans texte)'}${m.attachments?.size ? ` [${m.attachments.size} pièce(s) jointe(s)]` : ''}`)
        .join('\n');
      ctx.files = transcript ? [new AttachmentBuilder(Buffer.from(transcript, 'utf8'), { name: `purge-${channel.id}-${Date.now()}.txt` })] : [];
      await client.services.logging.send(channel.guild.id, 'messages', logCard({
        category: 'messages',
        tone: 'danger',
        icon: ICONS.delete,
        title: 'Suppression en masse',
        description: `**${messages.size}** messages supprimés dans ${channel}.`,
        id: channel.id,
        fields: [
          field(ICONS.channel, 'Salon', `${channel}`),
          field(ICONS.count, 'Messages', `${messages.size}`),
          field(ICONS.members, 'Auteurs', `${authors.size}`),
          preview.length ? wide(ICONS.list, 'Derniers messages en cache', truncate(preview.join('\n'), 1024)) : null,
          transcript ? wide('📄', 'Transcription', 'Fichier joint (messages encore en cache).') : null,
        ],
      }), undefined, ctx);
    },
  },
  {
    name: 'threadCreate',
    async execute(client, thread, newlyCreated) {
      if (!newlyCreated || !thread.guild) return;
      await send(client, thread.guild.id, 'channels', logCard({
        category: 'channels',
        tone: 'success',
        icon: '🧵',
        title: 'Fil créé',
        description: `Nouveau fil ${thread} dans ${thread.parent ?? 'un salon'}.`,
        id: thread.id,
        fields: [
          field('🧵', 'Fil', `${thread} · ${code(thread.name)}`),
          field(ICONS.channel, 'Salon parent', thread.parent ? `${thread.parent}` : '—'),
          field(ICONS.user, 'Créé par', thread.ownerId ? `<@${thread.ownerId}>` : '—'),
        ],
      }), 'threadCreate');
    },
  },
  {
    name: 'threadDelete',
    async execute(client, thread) {
      if (!thread.guild) return;
      await send(client, thread.guild.id, 'channels', logCard({
        category: 'channels',
        tone: 'danger',
        icon: '🧵',
        title: 'Fil supprimé',
        description: `Le fil **${truncate(thread.name, 100)}** a été supprimé.`,
        id: thread.id,
        fields: [field(ICONS.channel, 'Salon parent', thread.parent ? `${thread.parent}` : '—'), field(ICONS.date, 'Créé', thread.createdTimestamp ? discordTimestamp(thread.createdTimestamp, 'R') : '—')],
      }), 'threadDelete');
    },
  },
  {
    name: 'guildUpdate',
    async execute(client, oldGuild, newGuild) {
      const changes = [];
      if (oldGuild.name !== newGuild.name) changes.push(['Nom', oldGuild.name, newGuild.name]);
      if (oldGuild.icon !== newGuild.icon) changes.push(['Icône', oldGuild.icon ? 'ancienne' : '*aucune*', newGuild.icon ? 'nouvelle' : '*aucune*']);
      if (oldGuild.banner !== newGuild.banner) changes.push(['Bannière', oldGuild.banner ? 'ancienne' : '*aucune*', newGuild.banner ? 'nouvelle' : '*aucune*']);
      if (oldGuild.vanityURLCode !== newGuild.vanityURLCode) changes.push(['Invitation personnalisée', oldGuild.vanityURLCode ?? '*aucune*', newGuild.vanityURLCode ?? '*aucune*']);
      if (oldGuild.verificationLevel !== newGuild.verificationLevel) changes.push(['Niveau de vérification', VERIFICATION[oldGuild.verificationLevel] ?? `${oldGuild.verificationLevel}`, VERIFICATION[newGuild.verificationLevel] ?? `${newGuild.verificationLevel}`]);
      if (oldGuild.ownerId !== newGuild.ownerId) changes.push(['Propriétaire', `<@${oldGuild.ownerId}>`, `<@${newGuild.ownerId}>`]);
      if (oldGuild.description !== newGuild.description) changes.push(['Description', truncate(oldGuild.description ?? '*aucune*', 300), truncate(newGuild.description ?? '*aucune*', 300)]);
      if (!changes.length) return;
      await send(client, newGuild.id, 'server', logCard({
        category: 'server',
        tone: 'info',
        icon: ICONS.server,
        title: 'Serveur modifié',
        description: `${changes.length} paramètre(s) modifié(s).`,
        thumbnail: newGuild.iconURL?.({ size: 128 }) ?? null,
        id: newGuild.id,
        fields: changes.slice(0, 8).map(([label, before, after]) => wide(ICONS.settings, label, `${before} → ${after}`)),
      }), 'serverUpdate');
    },
  },
  {
    name: 'emojiCreate',
    async execute(client, emoji) {
      await send(client, emoji.guild.id, 'server', logCard({
        category: 'server',
        tone: 'success',
        icon: ICONS.emoji,
        title: 'Emoji ajouté',
        description: `${emoji} \`:${emoji.name}:\` a été ajouté.`,
        thumbnail: emoji.imageURL?.() ?? null,
        id: emoji.id,
        fields: [field(ICONS.emoji, 'Nom', code(emoji.name)), field('🎞️', 'Animé', emoji.animated ? 'Oui' : 'Non')],
      }), 'emojiCreate');
    },
  },
  {
    name: 'emojiDelete',
    async execute(client, emoji) {
      await send(client, emoji.guild.id, 'server', logCard({
        category: 'server',
        tone: 'danger',
        icon: ICONS.emoji,
        title: 'Emoji supprimé',
        description: `L'emoji \`:${emoji.name}:\` a été supprimé.`,
        thumbnail: emoji.imageURL?.() ?? null,
        id: emoji.id,
        fields: [field(ICONS.emoji, 'Nom', code(emoji.name))],
      }), 'emojiDelete');
    },
  },
];
