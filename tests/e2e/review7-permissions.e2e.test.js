'use strict';

/**
 * Revue n° 7 — lot fx7-permissions, bout en bout sur le vrai discord.js.
 * S34 : une délégation (/permissions, palier « courant ») exercée par un BOUTON « cmd:<commande>: »
 * est journalisée (log « permissionUse »), comme la commande slash ; un clic refusé, ou fait avec la
 * permission native, n'est pas journalisé.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { PermissionFlagsBits: P } = require('discord.js');
const { createHarness, IDS } = require('./harness');

const opt = (name, type, value) => ({ name, type, value });
const sub = (name, options = []) => [{ name, type: 1, options }];
const perm = (h, name, options, as = 'owner') => h.slash('permissions', sub(name, options), { as });
const level = (h, n, action, roleId, as = 'owner') => perm(h, 'niveau', [opt('numero', 4, n), opt('action', 3, action), opt('role', 8, roleId)], as);
const assign = (h, name, n, as = 'owner') => perm(h, 'commande', [opt('nom', 3, name), opt('niveau', 4, n)], as);
const button = (message, prefix) => (message?.components ?? []).flatMap((r) => r.components ?? []).find((c) => c.custom_id?.startsWith(prefix));
const useLogs = (h, mark) => h.fake.messageLog.slice(mark).map((id) => h.message(id))
  .filter((m) => m && m.channel_id === IDS.channels.logs && m.author?.id === h.client.user.id && (m.embeds ?? []).some((e) => /Commande exécutée par délégation/.test(e.title ?? '')));
const ok = (h, rec, label) => assert.ok(!h.isError(rec), `${label} : ${h.replyText(rec)}`);
const denied = (h, rec, re, label) => {
  assert.ok(h.isError(rec), `${label} aurait dû être refusé : ${h.replyText(rec)}`);
  if (re) assert.match(h.replyText(rec), re, label);
};
const slowPatched = (h, mark, seconds) => h.fake.calls.slice(mark).some((c) => c.method === 'PATCH' && c.body?.rate_limit_per_user === seconds);

test('S34 : bouton « cmd:slowmode:set » exercé par délégation → un log permissionUse (après la réponse) ; clic refusé ou natif → aucun log', async () => {
  const h = await createHarness();
  try {
    h.configureAll();
    ok(h, await level(h, 1, 'ajouter', IDS.roles.gamer, 'admin'), 'niveau 1 ← Joueur');
    ok(h, await assign(h, 'slowmode', 1, 'admin'), 'slowmode 1');
    const memberPerms = BigInt(h.permissionsIn(IDS.users.member, IDS.channels.general));
    assert.equal(memberPerms & P.ManageChannels, 0n, 'le membre n\'a pas « Gérer les salons »');

    // Commande slash déléguée : déjà journalisée (référence).
    let mark = h.fake.messageLog.length;
    const slow = await h.slash('slowmode', [opt('duree', 3, '30s')], { as: 'member' });
    ok(h, slow, '/slowmode délégué');
    assert.equal(useLogs(h, mark).length, 1, 'log permissionUse de la commande');

    // Bouton « Désactiver » cliqué par le membre délégué : action faite ET journalisée.
    const card = h.messagesOf(slow).find((m) => button(m, 'cmd:slowmode:set:'));
    assert.ok(card, 'carte /slowmode sans bouton « Désactiver »');
    mark = h.fake.messageLog.length;
    let calls = h.fake.calls.length;
    const clicked = await h.click(card, button(card, 'cmd:slowmode:set:').custom_id, { as: 'member' });
    ok(h, clicked, 'bouton « Désactiver » délégué');
    assert.ok(slowPatched(h, calls, 0), 'mode lent désactivé');
    const uses = useLogs(h, mark);
    assert.equal(uses.length, 1, `${uses.length} log(s) permissionUse pour le bouton`);
    const description = uses[0].embeds[0].description;
    assert.match(description, /\/slowmode/);
    assert.match(description, /Gérer les salons/);
    assert.match(description, /niveau 1/);
    assert.match(description, /bouton/, 'le log indique que la délégation passe par un bouton');
    // Réponse AVANT le log : la mise à jour du message (callback) précède l'envoi du log.
    const callbackIdx = h.fake.calls.slice(calls).findIndex((c) => c.method === 'POST' && /\/interactions\/\d+\/[^/]+\/callback$/.test(c.route));
    const logIdx = h.fake.calls.slice(calls).findIndex((c) => c.method === 'POST' && c.route === `/channels/${IDS.channels.logs}/messages`);
    assert.ok(callbackIdx >= 0 && logIdx > callbackIdx, `réponse (${callbackIdx}) avant le log (${logIdx})`);

    // Bouton « Rétablir » cliqué par un membre SANS niveau : refusé, aucun log.
    const updated = h.message(card.id);
    const restore = button(updated, 'cmd:slowmode:set:');
    assert.ok(restore, 'bouton « Rétablir » absent');
    mark = h.fake.messageLog.length;
    calls = h.fake.calls.length;
    denied(h, await h.click(updated, restore.custom_id, { as: 'target' }), /Gérer les salons/, 'bouton sans niveau');
    assert.ok(!slowPatched(h, calls, 30), 'aucun changement sans permission');
    assert.equal(useLogs(h, mark).length, 0, 'clic refusé : aucun log permissionUse');

    // Même bouton cliqué par l'administrateur (permission native) : action faite, aucun log de délégation.
    mark = h.fake.messageLog.length;
    calls = h.fake.calls.length;
    ok(h, await h.click(updated, restore.custom_id, { as: 'admin' }), 'bouton « Rétablir » (permission native)');
    assert.ok(slowPatched(h, calls, 30), 'mode lent rétabli');
    assert.equal(useLogs(h, mark).length, 0, 'permission native : aucun log permissionUse');
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});
