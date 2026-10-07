'use strict';

const { AuditLogEvent } = require('discord.js');
const { embeds } = require('../utils/embeds');
const { fetchExecutor } = require('../utils/audit');

/** Couleur principale d'un rôle (`Role#color` est déprécié au profit de `Role#colors`). */
function colorOf(role) {
  return role.colors?.primaryColor ?? role.color ?? 0;
}

function hexOf(role) {
  return `#${colorOf(role).toString(16).padStart(6, '0')}`;
}

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
      const colorChanged = colorOf(oldR) !== colorOf(newR);
      if (oldR.name === newR.name && !colorChanged && oldR.permissions.bitfield === newR.permissions.bitfield) return;
      const changes = [];
      if (oldR.name !== newR.name) changes.push(`nom : **${oldR.name}** → **${newR.name}**`);
      if (colorChanged) changes.push(`couleur : ${hexOf(oldR)} → ${hexOf(newR)}`);
      if (oldR.permissions.bitfield !== newR.permissions.bitfield) changes.push('permissions modifiées');
      await client.services.logging.send(newR.guild.id, 'roles', embeds.info(`${newR} : ${changes.join(', ')}`, '🎭 Rôle modifié'));
    },
  },
];
