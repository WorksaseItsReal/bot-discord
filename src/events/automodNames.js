'use strict';

const { createLogger } = require('../core/logger');
const { shownName, isStaff } = require('../services/AutoModService');

const logger = createLogger('automod');

/**
 * AutoMod des pseudos (filtre `badNames`, tableau de bord /automod → Sécurité) :
 * pseudo vérifié à l'arrivée et à chaque changement de nom (pseudo du serveur, nom global
 * ou nom d'utilisateur), renommé selon le modèle en cas d'infraction (AutoModService.checkMemberName).
 * Les renommages du bot et ceux d'un modérateur ne sont jamais refiltrés.
 */
module.exports = [
  {
    name: 'guildMemberAdd',
    async execute(client, member) {
      await client.services.automod?.checkMemberName?.(member, { source: 'join' }).catch((e) => logger.debug('Pseudo à l\'arrivée :', e?.message));
    },
  },
  {
    name: 'guildMemberUpdate',
    async execute(client, oldMember, newMember) {
      const automod = client.services.automod;
      if (!automod?.checkMemberName) return;
      // Nom ou rôles d'un membre du staff modifiés : les noms protégés contre l'imitation sont recalculés.
      const roleChange = !oldMember?.partial && oldMember?.roles?.cache?.size !== newMember?.roles?.cache?.size;
      if ((isStaff(oldMember) || isStaff(newMember)) && (roleChange || shownName(oldMember) !== shownName(newMember))) {
        automod.forgetStaffNames(newMember.guild.id);
      }
      await automod.checkMemberName(newMember, { previous: oldMember, source: 'update' }).catch((e) => logger.debug('Pseudo modifié :', e?.message));
    },
  },
  {
    // Nom global ou nom d'utilisateur modifié : vérifié sur chaque serveur où il est affiché
    // (membres sans pseudo de serveur). discord.js met à jour l'utilisateur partagé avant
    // guildMemberUpdate : ce changement n'y est pas visible.
    name: 'userUpdate',
    async execute(client, oldUser, newUser) {
      const automod = client.services.automod;
      if (!automod?.checkMemberName || newUser?.bot) return;
      if (oldUser?.globalName === newUser?.globalName && oldUser?.username === newUser?.username) return;
      for (const guild of client.guilds.cache.values()) {
        const member = guild.members.cache.get(newUser.id);
        if (!member || member.nickname) continue;
        if (isStaff(member)) automod.forgetStaffNames(guild.id);
        await automod.checkMemberName(member, { source: 'update' }).catch((e) => logger.debug('Nom global modifié :', e?.message));
      }
    },
  },
];
