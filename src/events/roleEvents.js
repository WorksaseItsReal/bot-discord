'use strict';

const { AuditLogEvent } = require('discord.js');
const { embeds } = require('../utils/embeds');
const { fetchExecutor } = require('../utils/audit');

module.exports = [
  {
    name: 'roleCreate',
    async execute(client, role) {
      await client.services.logging.send(role.guild.id, 'roles', embeds.success(`Rôle créé : ${role} (${role.name})`, '🎭 Rôle créé'));
    },
  },
  {
    name: 'roleDelete',
    async execute(client, role) {
      const executor = await fetchExecutor(role.guild, AuditLogEvent.RoleDelete, role.id);
      await client.services.logging.send(role.guild.id, 'roles', embeds.error(`Rôle supprimé : **${role.name}**${executor ? ` par <@${executor}>` : ''}`, '🎭 Rôle supprimé'));
      if (executor) await client.services.antiraid.handleDestructive(role.guild, executor, 'roleDelete').catch(() => {});
    },
  },
  {
    name: 'roleUpdate',
    async execute(client, oldR, newR) {
      if (oldR.name === newR.name && oldR.color === newR.color && oldR.permissions.bitfield === newR.permissions.bitfield) return;
      const changes = [];
      if (oldR.name !== newR.name) changes.push(`nom : **${oldR.name}** → **${newR.name}**`);
      if (oldR.color !== newR.color) changes.push(`couleur : ${oldR.hexColor} → ${newR.hexColor}`);
      if (oldR.permissions.bitfield !== newR.permissions.bitfield) changes.push('permissions modifiées');
      await client.services.logging.send(newR.guild.id, 'roles', embeds.info(`${newR} : ${changes.join(', ')}`, '🎭 Rôle modifié'));
    },
  },
];
