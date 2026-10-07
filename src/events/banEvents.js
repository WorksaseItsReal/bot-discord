'use strict';

const { AuditLogEvent } = require('discord.js');
const { truncate } = require('../utils/embeds');
const { field, wide, ICONS, userLine } = require('../utils/ui');
const { fetchExecutor } = require('../utils/audit');
const { logCard } = require('../services/LoggingService');

/**
 * Logs des bannissements faits HORS du bot (menu Discord, autre bot…).
 * Les actions du bot lui-même (/ban, /unban, boutons, fin de tempban, AntiRaid)
 * sont déjà journalisées par leurs services avec la carte de sanction : on évite le doublon.
 */
module.exports = [
  {
    name: 'guildBanAdd',
    async execute(client, ban) {
      const executor = await fetchExecutor(ban.guild, AuditLogEvent.MemberBanAdd, ban.user.id);
      if (executor !== client.user?.id) {
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
          }),
        );
      }
      if (executor) await client.services.antiraid.handleDestructive(ban.guild, executor, 'ban').catch(() => {});
    },
  },
  {
    name: 'guildBanRemove',
    async execute(client, ban) {
      // Débannissement (commande, scheduler ou manuel) : plus aucun ban temporaire actif.
      client.services.moderation?.clearTempbans(ban.guild.id, ban.user.id);
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
        }),
      );
    },
  },
];
