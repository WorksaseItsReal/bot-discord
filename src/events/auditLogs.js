'use strict';

const { AuditLogEvent } = require('discord.js');
const { truncate } = require('../utils/embeds');
const { field, wide, ICONS, userLine } = require('../utils/ui');
const { logCard, fitList } = require('../services/LoggingService');
const { discordTimestamp } = require('../utils/time');

/**
 * Logs alimentés par le journal d'audit de Discord (événement guildAuditLogEntryCreate) :
 *  - rôles ajoutés / retirés et pseudos : fiables même pour les membres hors cache
 *    (après un redémarrage) et avec l'auteur du changement ;
 *  - kicks et timeouts faits HORS du bot (menu Discord, autre bot) : ceux du bot sont
 *    déjà journalisés par ses propres cartes de sanction.
 * Nécessite la permission « Voir les logs du serveur ».
 */

const by = (entry) => (entry.executorId ? `<@${entry.executorId}>` : '*Inconnu*');

async function memberUser(client, guild, id) {
  return guild.members.cache.get(id)?.user ?? (await client.users.fetch(id).catch(() => null));
}

module.exports = {
  name: 'guildAuditLogEntryCreate',
  async execute(client, entry, guild) {
    if (!guild || !entry?.targetId) return;
    const logging = client.services.logging;
    const isBot = entry.executorId && entry.executorId === client.user?.id;

    if (entry.action === AuditLogEvent.MemberRoleUpdate) {
      if (!logging.wouldLog(guild.id, 'members', { event: 'memberRoles' })) return;
      const added = entry.changes.find((c) => c.key === '$add')?.new ?? [];
      const removed = entry.changes.find((c) => c.key === '$remove')?.new ?? [];
      if (!added.length && !removed.length) return;
      const user = await memberUser(client, guild, entry.targetId);
      await logging.send(guild.id, 'members', logCard({
        category: 'members',
        tone: 'info',
        icon: ICONS.role,
        title: 'Rôles modifiés',
        description: `Les rôles de ${user ?? `<@${entry.targetId}>`} ont changé.`,
        user,
        id: entry.targetId,
        fields: [
          field(ICONS.user, 'Membre', user ? userLine(user) : `<@${entry.targetId}>`),
          field(ICONS.moderator, 'Par', by(entry)),
          added.length ? wide('➕', `Ajoutés (${added.length})`, fitList(added.map((r) => `<@&${r.id}>`), 1000)) : null,
          removed.length ? wide('➖', `Retirés (${removed.length})`, fitList(removed.map((r) => `<@&${r.id}>`), 1000)) : null,
          entry.reason ? wide(ICONS.reason, 'Raison', truncate(entry.reason, 1024)) : null,
        ],
      }), undefined, { event: 'memberRoles' });
      return;
    }

    if (entry.action === AuditLogEvent.MemberUpdate) {
      const nick = entry.changes.find((c) => c.key === 'nick');
      if (nick && logging.wouldLog(guild.id, 'members', { event: 'memberNickname' })) {
        const user = await memberUser(client, guild, entry.targetId);
        await logging.send(guild.id, 'members', logCard({
          category: 'members',
          tone: 'info',
          icon: '✏️',
          title: 'Pseudo modifié',
          description: `${user ?? `<@${entry.targetId}>`} a un nouveau pseudo.`,
          user,
          id: entry.targetId,
          fields: [
            field(ICONS.user, 'Membre', user ? userLine(user) : `<@${entry.targetId}>`),
            field('⬅️', 'Avant', truncate(nick.old ?? '*aucun*', 100)),
            field('➡️', 'Après', truncate(nick.new ?? '*aucun*', 100)),
            entry.executorId !== entry.targetId ? field(ICONS.moderator, 'Par', by(entry)) : null,
          ],
        }), undefined, { event: 'memberNickname' });
      }
      const timeout = entry.changes.find((c) => c.key === 'communication_disabled_until');
      if (timeout && !isBot && logging.wouldLog(guild.id, 'moderation', { event: 'manualBan' })) {
        const until = timeout.new ? Date.parse(timeout.new) : null;
        const user = await memberUser(client, guild, entry.targetId);
        await logging.send(guild.id, 'moderation', logCard({
          category: 'moderation',
          tone: until ? 'caution' : 'success',
          icon: until ? ICONS.mute : ICONS.unmute,
          title: until ? 'Timeout manuel' : 'Timeout retiré manuellement',
          description: `${user ?? `<@${entry.targetId}>`} ${until ? 'a été exclu temporairement' : 'n\'est plus exclu'} (hors du bot).`,
          user,
          id: entry.targetId,
          fields: [
            field(ICONS.user, 'Membre', user ? userLine(user) : `<@${entry.targetId}>`),
            field(ICONS.moderator, 'Par', by(entry)),
            until ? field(ICONS.expires, 'Jusqu\'au', discordTimestamp(until, 'f')) : null,
            wide(ICONS.reason, 'Raison', entry.reason ? truncate(entry.reason, 1024) : '*Aucune raison fournie*'),
          ],
        }), undefined, { event: 'manualBan' });
      }
      return;
    }

    if (entry.action === AuditLogEvent.MemberKick && !isBot) {
      if (!logging.wouldLog(guild.id, 'moderation', { event: 'manualBan' })) return;
      const user = await client.users.fetch(entry.targetId).catch(() => null);
      await logging.send(guild.id, 'moderation', logCard({
        category: 'moderation',
        tone: 'caution',
        icon: ICONS.kick,
        title: 'Expulsion manuelle',
        description: `${user ?? `<@${entry.targetId}>`} a été expulsé (hors du bot).`,
        user,
        id: entry.targetId,
        fields: [
          field(ICONS.user, 'Membre', user ? userLine(user) : `<@${entry.targetId}>`),
          field(ICONS.moderator, 'Par', by(entry)),
          wide(ICONS.reason, 'Raison', entry.reason ? truncate(entry.reason, 1024) : '*Aucune raison fournie*'),
        ],
      }), undefined, { event: 'manualBan' });
    }
  },
};
