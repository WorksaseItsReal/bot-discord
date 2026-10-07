'use strict';

const { truncate } = require('../utils/embeds');
const { field, wide, ICONS, userLine, code } = require('../utils/ui');
const { logCard, fitList } = require('../services/LoggingService');
const { discordTimestamp } = require('../utils/time');

/**
 * Événements complémentaires pour des logs complets : rôles et pseudos des
 * membres, boosts, suppressions en masse, fils, paramètres du serveur, emojis.
 */
const send = (client, guildId, category, embed, event) => client.services.logging.send(guildId, category, embed, undefined, { event });

module.exports = [
  {
    name: 'guildMemberUpdate',
    async execute(client, oldMember, newMember) {
      if (oldMember.partial) return; // état précédent inconnu : impossible de calculer la différence
      const user = newMember.user;
      const guildId = newMember.guild.id;

      const added = newMember.roles.cache.filter((r) => !oldMember.roles.cache.has(r.id));
      const removed = oldMember.roles.cache.filter((r) => !newMember.roles.cache.has(r.id));
      if (added.size || removed.size) {
        await send(client, guildId, 'members', logCard({
          category: 'members',
          tone: 'info',
          icon: ICONS.role,
          title: 'Rôles modifiés',
          description: `Les rôles de ${user} ont changé.`,
          user,
          fields: [
            field(ICONS.user, 'Membre', userLine(user)),
            added.size ? wide('➕', `Ajoutés (${added.size})`, fitList(added.map((r) => `${r}`), 1000)) : null,
            removed.size ? wide('➖', `Retirés (${removed.size})`, fitList(removed.map((r) => `${r}`), 1000)) : null,
          ],
        }), 'memberRoles');
      }

      if (oldMember.nickname !== newMember.nickname) {
        await send(client, guildId, 'members', logCard({
          category: 'members',
          tone: 'info',
          icon: '✏️',
          title: 'Pseudo modifié',
          description: `${user} a un nouveau pseudo.`,
          user,
          fields: [
            field(ICONS.user, 'Membre', userLine(user)),
            field('⬅️', 'Avant', truncate(oldMember.nickname ?? '*aucun*', 100)),
            field('➡️', 'Après', truncate(newMember.nickname ?? '*aucun*', 100)),
          ],
        }), 'memberNickname');
      }

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
        ],
      }), undefined, { event: 'messageBulkDelete' });
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
      if (oldGuild.verificationLevel !== newGuild.verificationLevel) changes.push(['Niveau de vérification', `${oldGuild.verificationLevel}`, `${newGuild.verificationLevel}`]);
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
