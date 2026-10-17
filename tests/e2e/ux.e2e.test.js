'use strict';

/**
 * Audit d'expérience utilisateur, sur le vrai discord.js : chaque sous-commande, lancée par un
 * administrateur puis par un simple membre, doit répondre par une EMBED (jamais de texte brut,
 * jamais de réponse vide ni de « réfléchit… » abandonné), et une commande protégée par une
 * permission Discord ne doit JAMAIS aboutir pour un membre qui ne l'a pas — même si un
 * administrateur l'a ouverte à tous dans Paramètres du serveur → Intégrations.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness } = require('./harness');
const { leavesOf, runLeaf } = require('./lib/explore');
const { OVERRIDES } = require('./lib/overrides');

function outcome(h, rec) {
  if (rec.modals?.length) return { kind: 'modal' };
  const id = rec.original ?? rec.followUps?.[0] ?? null;
  const msg = id ? (typeof id === 'string' ? h.message(id) : id) : null;
  if (!msg) return { kind: rec.ackType ? 'sans-réponse' : 'non-acquittée' };
  if (msg.embeds?.length) return { kind: (msg.embeds[0].description ?? '').startsWith('❌') ? 'erreur' : 'embed', msg };
  if (msg.poll) return { kind: 'sondage', msg };
  return { kind: msg.content ? 'texte-brut' : 'vide', msg };
}

test('chaque sous-commande répond par une embed ; aucune commande protégée n\'aboutit pour un simple membre', async () => {
  const h = await createHarness();
  h.configureAll();
  const notEmbed = [];
  const leaked = [];
  let runs = 0;
  try {
    for (const [name, command] of h.client.commands) {
      const json = command.data.toJSON();
      if (json.type && json.type !== 1) continue; // menus contextuels : couverts ailleurs
      const gated = json.default_member_permissions != null;
      for (const leaf of leavesOf(json)) {
        const key = [name, ...leaf.path].join(' ');
        for (const as of ['admin', 'member']) {
          const rec = await runLeaf(h, name, leaf, { overrides: OVERRIDES[key] ?? {}, as });
          runs += 1;
          const { kind } = outcome(h, rec);
          if (!['embed', 'erreur', 'modal', 'sondage'].includes(kind)) notEmbed.push(`/${key} (${as}) : ${kind}`);
          if (as === 'member' && gated && kind !== 'erreur') leaked.push(`/${key} : ${kind}`);
        }
      }
    }
  } finally {
    await h.close();
  }
  assert.ok(runs > 250, `${runs} lancements`);
  assert.deepEqual(notEmbed, [], 'réponses sans embed');
  assert.deepEqual(leaked, [], 'commandes protégées exécutées par un membre sans la permission');
});

test('permission « 0 » (masquée à tous) : réservée aux administrateurs', async () => {
  const { PermissionsBitField } = require('discord.js');
  const interactionCreate = require('../../src/events/interactionCreate');
  const assertMemberPermissions = interactionCreate.assertMemberPermissions;
  assert.equal(typeof assertMemberPermissions, 'function');
  const command = { data: { name: 'secret', default_member_permissions: '0' } };
  const i = (perms) => ({ inGuild: () => true, memberPermissions: new PermissionsBitField(perms) });
  assert.throws(() => assertMemberPermissions(i(['ManageGuild']), command), /Administrateur/);
  assert.doesNotThrow(() => assertMemberPermissions(i(['Administrator']), command));
  // En MP ou sans permission déclarée : rien à vérifier.
  assert.doesNotThrow(() => assertMemberPermissions({ inGuild: () => false }, command));
  assert.doesNotThrow(() => assertMemberPermissions(i([]), { data: { name: 'libre' } }));
});
