'use strict';

/**
 * Revue n° 7, lot « identité » (tests unitaires) : permissions demandées par le lien /invite.
 *  - S47 : toute permission dont un module Secur a besoin (annulation ou sanction) est demandée à
 *    l'invitation, donc contrôlée par /diagnostics (« Gérer les webhooks » manquait).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { PermissionFlagsBits } = require('discord.js');
const { INVITE_PERMISSIONS } = require('../src/commands/utility/invite');
const { MODULE_PERMS, PUNISH_PERMS } = require('../src/utils/securityAudit');
const diagnostics = require('../src/commands/configuration/diagnostics');

test('S47 : /invite demande toutes les permissions des modules Secur (annulation et sanction), dont « Gérer les webhooks »', () => {
  assert.ok(INVITE_PERMISSIONS.includes('ManageWebhooks'), '« Gérer les webhooks » non demandée par /invite');
  const needed = new Set(['ViewAuditLog', ...Object.values(MODULE_PERMS).flat(), ...Object.values(PUNISH_PERMS).flat()]);
  const missing = [...needed].filter((perm) => !INVITE_PERMISSIONS.includes(perm));
  assert.deepEqual(missing, [], `permissions Secur absentes du lien /invite : ${missing.join(', ')}`);
  assert.equal(new Set(INVITE_PERMISSIONS).size, INVITE_PERMISSIONS.length, 'doublon dans INVITE_PERMISSIONS');
  assert.ok(INVITE_PERMISSIONS.every((name) => typeof PermissionFlagsBits[name] === 'bigint'), 'nom de permission inconnu');
});

test('S47 : /diagnostics contrôle « Gérer les webhooks » parmi les permissions du bot', () => {
  const row = diagnostics.RECOMMENDED_PERMS.find(([, flag]) => flag === PermissionFlagsBits.ManageWebhooks);
  assert.ok(row, '« Gérer les webhooks » non contrôlée par /diagnostics');
  assert.equal(row[0], 'Gérer les webhooks');
});
