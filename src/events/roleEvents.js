'use strict';

const { AuditLogEvent } = require('discord.js');
const { field, wide, ICONS, code } = require('../utils/ui');
const { fetchExecutor } = require('../utils/audit');
const { permissionLabel } = require('../utils/permissionNames');
const { logCard, fitList } = require('../services/LoggingService');

/** Couleur principale d'un rôle (`Role#color` est déprécié au profit de `Role#colors`). */
function colorOf(role) {
  return role.colors?.primaryColor ?? role.color ?? 0;
}

function hexOf(role) {
  return `#${colorOf(role).toString(16).padStart(6, '0').toUpperCase()}`;
}

/** Permissions ajoutées / retirées entre deux versions d'un rôle. */
function permissionDiff(oldR, newR) {
  return {
    added: oldR.permissions.missing(newR.permissions).map(permissionLabel),
    removed: newR.permissions.missing(oldR.permissions).map(permissionLabel),
  };
}

module.exports = [
  {
    name: 'roleCreate',
    async execute(client, role) {
      await client.services.logging.send(
        role.guild.id,
        'roles',
        logCard({
          category: 'roles',
          tone: 'success',
          icon: ICONS.role,
          title: 'Rôle créé',
          description: `Le rôle ${role} a été créé.`,
          fields: [
            field(ICONS.role, 'Rôle', `${role}\n${code(role.name)}`),
            field(ICONS.color, 'Couleur', colorOf(role) ? code(hexOf(role)) : 'Par défaut'),
            field(ICONS.count, 'Position', `${role.position}`),
          ],
          id: role.id,
        }),
      );
    },
  },
  {
    name: 'roleDelete',
    async execute(client, role) {
      const executor = await fetchExecutor(role.guild, AuditLogEvent.RoleDelete, role.id);
      await client.services.logging.send(
        role.guild.id,
        'roles',
        logCard({
          category: 'roles',
          tone: 'danger',
          icon: ICONS.delete,
          title: 'Rôle supprimé',
          description: `Le rôle **${role.name}** a été supprimé.`,
          fields: [
            field(ICONS.role, 'Rôle', code(role.name)),
            field(ICONS.color, 'Couleur', colorOf(role) ? code(hexOf(role)) : 'Par défaut'),
            field(ICONS.moderator, 'Par', executor ? `<@${executor}>` : '*Inconnu*'),
          ],
          id: role.id,
        }),
      );
      if (executor) await client.services.antiraid.handleDestructive(role.guild, executor, 'roleDelete').catch(() => {});
    },
  },
  {
    name: 'roleUpdate',
    async execute(client, oldR, newR) {
      const colorChanged = colorOf(oldR) !== colorOf(newR);
      const permsChanged = oldR.permissions.bitfield !== newR.permissions.bitfield;
      if (oldR.name === newR.name && !colorChanged && !permsChanged) return;
      const fields = [field(ICONS.role, 'Rôle', `${newR}`)];
      if (oldR.name !== newR.name) fields.push(field('✏️', 'Nom', `${code(oldR.name)} → ${code(newR.name)}`));
      if (colorChanged) fields.push(field(ICONS.color, 'Couleur', `${code(hexOf(oldR))} → ${code(hexOf(newR))}`));
      if (permsChanged) {
        const { added, removed } = permissionDiff(oldR, newR);
        if (added.length) fields.push(wide('➕', 'Permissions accordées', fitList(added, 1000, ' · ')));
        if (removed.length) fields.push(wide('➖', 'Permissions retirées', fitList(removed, 1000, ' · ')));
      }
      await client.services.logging.send(
        newR.guild.id,
        'roles',
        logCard({ category: 'roles', tone: 'info', icon: ICONS.role, title: 'Rôle modifié', description: `Le rôle ${newR} a été modifié.`, fields, id: newR.id }),
      );
    },
  },
];
