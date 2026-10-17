'use strict';

/**
 * Niveaux de permissions (ADM1) : /permissions commande|niveau|verifier.
 * Chemin « succès » des explorations : un rôle DÉDIÉ (créé au besoin, porté par personne) au
 * niveau 1 et /clear attribuée au niveau 1. Aucun membre de test ne gagne de délégation : les
 * audits qui vérifient qu'un membre sans permission est refusé restent valables.
 */
const { IDS } = require('../fixtures');
const { nextId } = require('../ids');

/** Rôle « Niveau e2e » (position 1, sans permission, sans membre), créé une seule fois. */
async function levelRole(h) {
  const existing = [...h.fake.roles.values()].find((r) => r.name === 'Niveau e2e');
  if (existing) return existing.id;
  const id = nextId();
  const raw = { id, name: 'Niveau e2e', color: 0, colors: { primary_color: 0, secondary_color: null, tertiary_color: null }, hoist: false, icon: null, unicode_emoji: null, position: 1, permissions: '0', managed: false, mentionable: false, flags: 0 };
  h.fake.roles.set(id, raw);
  h.fake.dispatchNow('GUILD_ROLE_CREATE', { guild_id: h.guild.id, role: raw }, 'préparation : rôle Niveau e2e');
  await h.settle();
  return id;
}

module.exports = {
  'permissions commande': { nom: 'clear', niveau: 1 },
  'permissions niveau': { numero: 1, action: 'ajouter', role: levelRole },
  'permissions verifier': { membre: IDS.users.member },
};
