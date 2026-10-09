'use strict';

/**
 * Bout en bout : CHAQUE commande slash (chaque sous-commande) est exécutée sur le
 * vrai discord.js, puis chaque bouton / option de menu / formulaire de ses réponses
 * est exploré (tableaux de bord : toutes les vues du menu de navigation).
 * Échec : log d'erreur du bot, rejet non géré, dépréciation, interaction non
 * acquittée (ou acquittée après 3 s), corps hors limites Discord, texte suspect.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { PermissionsBitField } = require('discord.js');
const { createHarness, IDS } = require('./harness');
const { leavesOf, runLeaf, explore, newStats, missingNavViews, wrapPath } = require('./lib/explore');
const { OVERRIDES } = require('./lib/overrides');

const key = (name, leaf) => [name, ...leaf.path].join(' ');
const opt = (name, type, value) => ({ name, type, value });
const DASHBOARDS = ['automod', 'logs', 'antiraid', 'tickets', 'bienvenue', 'niveaux', 'settings', 'tempvoice', 'compteurs', 'signalements', 'communaute', 'alertes', 'economie', 'statistiques', 'activite', 'candidatures'];
// Tableaux de bord ouverts par une sous-commande.
const DASHBOARD_SUB = { alertes: 'config' };
const dashboardOptions = (name) => (DASHBOARD_SUB[name] ? [{ name: DASHBOARD_SUB[name], type: 1, options: [] }] : []);

test('chaque commande slash, en administrateur, avec exploration des composants', async (t) => {
  const h = await createHarness();
  h.configureAll();
  const stats = newStats();
  const ran = new Set();
  let leaves = 0;
  try {
    for (const [name, command] of h.client.commands) {
      await t.test(`/${name}`, async () => {
        h.resetProblems();
        for (const leaf of leavesOf(command.data.toJSON())) {
          const rec = await runLeaf(h, name, leaf, { overrides: OVERRIDES[key(name, leaf)] ?? {} });
          assert.ok(rec.ackType != null, `/${key(name, leaf)} jamais acquittée`);
          await explore(h, rec, { stats, budget: DASHBOARDS.includes(name) ? 400 : 150 });
          leaves += 1;
        }
        ran.add(name);
        assert.equal(h.problemCount(), 0, h.formatProblems());
      });
    }
    assert.equal(ran.size, h.client.commands.size);
    assert.ok(h.client.commands.size >= 73, `${h.client.commands.size} commandes chargées`);
    const missing = missingNavViews(stats);
    assert.deepEqual(missing, [], `vues de tableau de bord jamais ouvertes : ${missing.join(', ')}`);
    // Tableaux de bord navigués par boutons ou par un menu de choix (pas de menu « nav »).
    const NO_NAV = ['settings', 'compteurs', 'signalements', 'alertes', 'activite'];
    for (const name of DASHBOARDS.filter((n) => !NO_NAV.includes(n))) {
      assert.ok([...stats.navOptions.keys()].some((id) => id.startsWith(`cmd:${name}:`)), `/${name} : menu de navigation non rencontré`);
    }
    t.diagnostic(`${leaves} sous-commandes · ${stats.actions} actions (${stats.buttons} boutons, ${stats.selects} menus, ${stats.modals} formulaires) · ${stats.keys.size} composants distincts · ${[...stats.navChosen].filter((k) => k.includes(':nav=')).length} vues de tableaux de bord`);
  } finally {
    await h.close();
  }
});

test('commandes utilisables en MP : exécutées depuis un message privé', async () => {
  const h = await createHarness();
  try {
    const dmCommands = [...h.client.commands.values()].filter((c) => c.guildOnly === false);
    assert.ok(dmCommands.length >= 10);
    for (const command of dmCommands) {
      for (const leaf of leavesOf(command.data.toJSON())) {
        const rec = await runLeaf(h, command.data.name, leaf, { channel: 'dm', overrides: OVERRIDES[key(command.data.name, leaf)] ?? {} });
        await explore(h, rec, { budget: 30 });
      }
    }
    // Une commande réservée aux serveurs reste refusée proprement en MP.
    const rec = await h.slash('ban', [{ name: 'membre', type: 6, value: IDS.users.target }], { channel: 'dm' });
    assert.ok(h.isError(rec));
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('membre sans permission : commandes ouvertes à tous, puis boutons de modération d\'autrui refusés', async () => {
  const h = await createHarness();
  h.configureAll();
  h.configure({ moderation: { confirmDangerous: false } });
  const memberPerms = new PermissionsBitField(BigInt(h.permissionsIn(IDS.users.member, IDS.channels.general)));
  try {
    // Discord ne transmet une commande qu'aux membres ayant ses permissions par défaut.
    let open = 0;
    for (const [name, command] of h.client.commands) {
      const required = command.data.toJSON().default_member_permissions;
      if (required != null && !memberPerms.has(BigInt(required))) continue;
      open += 1;
      for (const leaf of leavesOf(command.data.toJSON())) {
        const rec = await runLeaf(h, name, leaf, { as: 'member', overrides: OVERRIDES[key(name, leaf)] ?? {} });
        assert.ok(rec.ackType != null, `/${key(name, leaf)} non acquittée`);
        await explore(h, rec, { as: 'member', budget: 40 });
      }
    }
    assert.ok(open >= 25, `${open} commandes ouvertes aux membres`);

    // Cartes de sanction d'un modérateur : leurs boutons (lever, historique…) cliqués par un membre.
    const cards = [];
    for (const [name, values] of [['warn', {}], ['mute', { duree: '1h' }], ['timeout', { duree: '10m' }], ['ban', {}]]) {
      const command = h.client.commands.get(name);
      const target = name === 'ban' ? h.addUser('Banni', { ageDays: 300 }) : null;
      if (target) await h.memberJoin(target);
      const rec = await runLeaf(h, name, leavesOf(command.data.toJSON())[0], { as: 'mod', overrides: { membre: target?.id ?? IDS.users.target, ...values } });
      cards.push(rec);
    }
    const state = () => JSON.stringify({ bans: [...h.fake.bans.keys()], members: [...h.fake.members.values()].map((m) => [m.user.id, m.roles, m.communication_disabled_until ?? null]) });
    const before = state();
    for (const rec of cards) await explore(h, rec, { as: 'member', budget: 30 });
    assert.equal(state(), before, 'un membre sans permission a levé ou modifié une sanction');
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('membre cliquant les tableaux de bord d\'un administrateur : aucune modification', async () => {
  const h = await createHarness();
  h.configureAll();
  try {
    for (const name of DASHBOARDS.filter((n) => n !== 'tempvoice' && n !== 'settings')) {
      const rec = await h.slash(name, dashboardOptions(name), { as: 'admin' });
      const configBefore = JSON.stringify(h.client.services.config.get(h.guild.id));
      await explore(h, rec, { as: 'member', budget: 25, skip: (a) => a.customId.startsWith('confirm:') || a.customId.startsWith('cancel:') || a.customId.startsWith('page:') });
      assert.equal(JSON.stringify(h.client.services.config.get(h.guild.id)), configBefore, `/${name} : un membre a modifié la configuration`);
    }
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('gros serveur (69 rôles, 150 salons, 200 membres, noms longs et Markdown) : listes et menus dans les limites', async () => {
  const h = await createHarness({ big: true });
  h.configureAll();
  try {
    for (const [name, command] of h.client.commands) {
      for (const leaf of leavesOf(command.data.toJSON())) {
        // /massrole espace volontairement ses lots (1 s entre deux lots) : limitée aux bots ici.
        const overrides = name === 'massrole' ? { ...OVERRIDES.massrole, cible: 'bots' } : OVERRIDES[key(name, leaf)] ?? {};
        const rec = await runLeaf(h, name, leaf, { overrides });
        await explore(h, rec, { budget: DASHBOARDS.includes(name) ? 150 : 40 });
      }
    }
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('autocomplétions : saisies variées, admin et membre, réponses valides (≤ 25 choix)', async () => {
  const h = await createHarness();
  h.configureAll();
  try {
    for (let i = 0; i < 30; i += 1) {
      await h.slash('custom', [{ name: 'create', type: 1, options: [opt('nom', 3, `tag${i}-${'x'.repeat(20)}`), opt('contenu', 3, 'c')] }]);
      await h.slash('projet', [{ name: 'creer', type: 1, options: [opt('nom', 3, `Projet ${i} ${'é'.repeat(60)}`)] }], { as: i % 2 ? 'admin' : 'member' });
    }
    let count = 0;
    for (const [name, command] of h.client.commands) {
      for (const leaf of leavesOf(command.data.toJSON())) {
        const others = leaf.options.filter((o) => o.required && !o.autocomplete && o.type === 3).map((o) => opt(o.name, 3, 'Projet 1'));
        for (const ac of leaf.options.filter((o) => o.autocomplete)) {
          for (const value of ['', 'p', 'x'.repeat(100), '%_\'"`*', 'Projet 1']) {
            for (const as of ['admin', 'member']) {
              const filled = leaf.options.filter((o) => o.autocomplete && o !== ac).map((o) => opt(o.name, 3, 'Projet 1'));
              const rec = await h.autocomplete(name, wrapPath(leaf.path, [...others, ...filled, { ...opt(ac.name, 3, value), focused: true }]), { as });
              assert.equal(rec.ackType, 8, `/${key(name, leaf)} ${ac.name} : pas de réponse d'autocomplétion`);
              count += 1;
            }
          }
        }
      }
    }
    assert.ok(count >= 100, `${count} autocomplétions`);
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});
