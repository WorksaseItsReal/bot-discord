'use strict';

const { AuditLogEvent } = require('discord.js');
const { truncate } = require('../utils/embeds');
const { field, wide, ICONS, userLine } = require('../utils/ui');
const { fetchExecutor } = require('../utils/audit');
const { logCard } = require('../services/LoggingService');

/** Entrées d'audit log qui alimentent la détection AntiRaid des actions destructrices. */
const DESTRUCTIVE_AUDIT_ACTIONS = {
  [AuditLogEvent.ChannelDelete]: 'channelDelete',
  [AuditLogEvent.RoleDelete]: 'roleDelete',
  [AuditLogEvent.MemberBanAdd]: 'ban',
};

/**
 * Logs des bannissements faits HORS du bot (menu Discord, autre bot…).
 * Les actions du bot lui-même (/ban, /unban, boutons, fin de tempban, AntiRaid)
 * sont déjà journalisées par leurs services avec la carte de sanction : elles sont
 * marquées AVANT l'appel API (ModerationService.recentBotActions) et ignorées ici,
 * sans dépendre de l'audit log (qui peut arriver en retard ou être illisible).
 *
 * + guildAuditLogEntryCreate : détection AntiRaid des actions faites hors du bot
 * (salons, rôles, bans) — une entrée = une action, pas de double comptage. Les bans
 * faits VIA le bot (signés par lui) sont signalés par ModerationService avec le modérateur.
 */
module.exports = [
  {
    name: 'guildBanAdd',
    async execute(client, ban) {
      if (client.services.moderation?.isRecentBotAction?.('ban', ban.guild.id, ban.user.id)) return;
      const executor = await fetchExecutor(ban.guild, AuditLogEvent.MemberBanAdd, ban.user.id);
      if (executor && executor === client.user?.id) return;
      await client.services.logging.send(
        ban.guild.id,
        'moderation',
        logCard({
          category: 'moderation',
          tone: 'danger',
          icon: ICONS.ban,
          title: 'Membre banni',
          description: `${ban.user} a été banni du serveur.`,
          user: ban.user,
          fields: [
            field(ICONS.user, 'Membre', userLine(ban.user)),
            field(ICONS.moderator, 'Par', executor ? `<@${executor}>` : '*Inconnu*'),
            wide(ICONS.reason, 'Raison', ban.reason ? truncate(ban.reason, 1024) : '*Aucune raison fournie*'),
          ],
        }), undefined, { event: 'manualBan' });
    },
  },
  {
    name: 'guildBanRemove',
    async execute(client, ban) {
      // Débannissement (commande, scheduler ou manuel) : plus aucun ban temporaire actif.
      client.services.moderation?.clearTempbans(ban.guild.id, ban.user.id);
      if (client.services.moderation?.isRecentBotAction?.('unban', ban.guild.id, ban.user.id)) return;
      const executor = await fetchExecutor(ban.guild, AuditLogEvent.MemberBanRemove, ban.user.id);
      if (executor && executor === client.user?.id) return;
      await client.services.logging.send(
        ban.guild.id,
        'moderation',
        logCard({
          category: 'moderation',
          tone: 'success',
          icon: ICONS.unlock,
          title: 'Membre débanni',
          description: `${ban.user} peut de nouveau rejoindre le serveur.`,
          user: ban.user,
          fields: [
            field(ICONS.user, 'Membre', userLine(ban.user)),
            field(ICONS.moderator, 'Par', executor ? `<@${executor}>` : '*Inconnu*'),
          ],
        }), undefined, { event: 'manualBan' });
    },
  },
  {
    // Requiert l'intent GuildModeration et la permission « Voir les logs du serveur ».
    name: 'guildAuditLogEntryCreate',
    async execute(client, entry, guild) {
      const type = DESTRUCTIVE_AUDIT_ACTIONS[entry?.action];
      if (!type || !guild || !entry.executorId) return;
      // Cible transmise pour les bans : bannir un arrivant récent (raider) n'est pas compté.
      const target = type === 'ban' ? { targetId: entry.targetId ?? null } : undefined;
      await client.services.antiraid?.handleDestructive(guild, entry.executorId, type, target).catch(() => {});
    },
  },
];

module.exports.DESTRUCTIVE_AUDIT_ACTIONS = DESTRUCTIVE_AUDIT_ACTIONS;
