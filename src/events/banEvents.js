'use strict';

const { AuditLogEvent, SnowflakeUtil } = require('discord.js');
const { truncate } = require('../utils/embeds');
const { field, wide, ICONS, userLine } = require('../utils/ui');
const { fetchExecutor } = require('../utils/audit');
const { logCard } = require('../services/LoggingService');

/**
 * Entrées d'audit log qui alimentent la détection AntiRaid des actions destructrices.
 * MemberPrune (21) : UNE entrée pour des centaines d'expulsions → `kick` × members_removed.
 */
const DESTRUCTIVE_AUDIT_ACTIONS = {
  [AuditLogEvent.ChannelDelete]: 'channelDelete',
  [AuditLogEvent.RoleDelete]: 'roleDelete',
  [AuditLogEvent.MemberBanAdd]: 'ban',
  [AuditLogEvent.MemberKick]: 'kick',
  [AuditLogEvent.MemberPrune]: 'kick',
};

/** Nombre d'actions d'une entrée : membres expulsés par un prune (au moins 1). Pur. */
function actionCount(entry) {
  if (entry?.action !== AuditLogEvent.MemberPrune) return 1;
  const n = Number(entry.extra?.removed ?? entry.options?.members_removed ?? entry.extra?.membersRemoved ?? 1);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
}

/** Horodatage d'une entrée d'audit : son snowflake (jamais l'instant de réception). Pur. */
function entryTimestamp(entry) {
  if (Number.isFinite(entry?.createdTimestamp)) return entry.createdTimestamp;
  try {
    return entry?.id ? SnowflakeUtil.timestampFrom(String(entry.id)) : Date.now();
  } catch {
    return Date.now();
  }
}

/**
 * Logs des bannissements faits HORS du bot (menu Discord, autre bot…).
 * Les actions du bot lui-même (/ban, /unban, boutons, fin de tempban, AntiRaid)
 * sont déjà journalisées par leurs services avec la carte de sanction : elles sont
 * marquées AVANT l'appel API (ModerationService.recentBotActions) et ignorées ici,
 * sans dépendre de l'audit log (qui peut arriver en retard ou être illisible).
 *
 * + guildAuditLogEntryCreate : détection AntiRaid des actions faites hors du bot
 * (salons, rôles, bans, expulsions) — une entrée = une action, pas de double comptage. Les
 * bans et kicks faits VIA le bot (signés par lui) sont signalés par ModerationService avec le modérateur.
 */
module.exports = [
  {
    name: 'guildBanAdd',
    async execute(client, ban) {
      if (client.services.moderation?.isRecentBotAction?.('ban', ban.guild.id, ban.user.id)) return;
      // Pas de lecture du journal d'audit si ce log n'est pas envoyé (raid : des centaines de bans).
      if (client.services.logging?.wouldLog?.(ban.guild.id, 'moderation', { event: 'manualBan' }) === false) return;
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
      if (client.services.logging?.wouldLog?.(ban.guild.id, 'moderation', { event: 'manualBan' }) === false) return;
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
      // Salon créé : son auteur (bot de tickets, de vocaux temporaires…) peut le supprimer sans être compté.
      if (entry?.action === AuditLogEvent.ChannelCreate && guild && entry.executorId) {
        client.services.antiraid?.rememberChannelCreator?.(guild.id, entry.targetId, entry.executorId);
        return;
      }
      const type = DESTRUCTIVE_AUDIT_ACTIONS[entry?.action];
      if (!type || !guild || !entry.executorId) return;
      // Cible transmise pour les bans et kicks (sanctionner un arrivant récent n'est pas compté) et
      // les suppressions de salons (supprimer un salon que l'on a créé n'est pas compté). Un prune
      // n'a pas de cible. La fenêtre est calculée sur l'horodatage de l'entrée (rejeu après RESUME).
      const prune = entry.action === AuditLogEvent.MemberPrune;
      const targetId = !prune && (type === 'ban' || type === 'kick' || type === 'channelDelete') ? entry.targetId ?? null : null;
      await client.services.antiraid?.handleDestructive(guild, entry.executorId, type, { targetId, at: entryTimestamp(entry), count: actionCount(entry) }).catch(() => {});
    },
  },
];

module.exports.DESTRUCTIVE_AUDIT_ACTIONS = DESTRUCTIVE_AUDIT_ACTIONS;
module.exports.actionCount = actionCount;
module.exports.entryTimestamp = entryTimestamp;
