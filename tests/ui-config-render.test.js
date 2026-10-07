'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { Collection, PermissionFlagsBits } = require('discord.js');
const { defaultGuildConfig } = require('../src/config/defaults');
const f = require('../src/utils/projectFormat');

const settings = require('../src/commands/configuration/settings');
const diagnostics = require('../src/commands/configuration/diagnostics');
const health = require('../src/commands/configuration/health');
const backup = require('../src/commands/configuration/backup');
const custom = require('../src/commands/configuration/custom');
const projet = require('../src/commands/projects/projet');
const projectComponent = require('../src/components/project');

/**
 * Rendu des commandes de configuration et des projets (sans Discord) :
 * limites des embeds, boutons valides, permissions revérifiées.
 */

const toJSON = (x) => (typeof x?.toJSON === 'function' ? x.toJSON() : x);

/** Vérifie les limites Discord d'une réponse (embeds + composants). */
function assertPayload(payload) {
  for (const e of (payload.embeds || []).map(toJSON)) {
    assert.ok(e.color != null, 'couleur via card()');
    assert.ok((e.fields || []).length <= 25);
    for (const fl of e.fields || []) assert.ok(fl.value.length <= 1024 && fl.value.length > 0, fl.name);
    const total = (e.title?.length || 0) + (e.description?.length || 0) + (e.footer?.text?.length || 0) + (e.author?.name?.length || 0)
      + (e.fields || []).reduce((n, x) => n + x.name.length + x.value.length, 0);
    assert.ok(total <= 6000, `total ${total}`);
  }
  const rows = (payload.components || []).map(toJSON);
  assert.ok(rows.length <= 5);
  const ids = [];
  for (const r of rows) {
    assert.ok(r.components.length <= 5, 'max 5 boutons par rangée');
    for (const c of r.components) {
      if (c.custom_id) {
        assert.ok(c.custom_id.length <= 100);
        ids.push(c.custom_id);
      }
    }
  }
  assert.strictEqual(new Set(ids).size, ids.length, 'customId uniques');
  return { embeds: (payload.embeds || []).map(toJSON), ids };
}

const perms = (granted) => ({ has: (flag) => granted.includes(flag) });

function fakeInteraction({ granted = [], userId = 'u1', guild, message } = {}) {
  const calls = {};
  return {
    calls,
    user: { id: userId, toString: () => `<@${userId}>` },
    guildId: guild?.id ?? 'g1',
    guild,
    message,
    member: { id: userId },
    memberPermissions: perms(granted),
    inGuild: () => true,
    isButton: () => true,
    isModalSubmit: () => false,
    update: async (p) => { calls.update = p; },
    reply: async (p) => { calls.reply = p; },
  };
}

function fakeGuild({ admin = false, channels = [] } = {}) {
  const me = {
    permissions: { has: (flag) => admin || ![PermissionFlagsBits.ViewAuditLog, PermissionFlagsBits.Administrator].includes(flag) },
    roles: { highest: { position: 5, toString: () => '<@&bot>' } },
  };
  return {
    id: 'g1',
    name: 'Serveur test',
    memberCount: 42,
    iconURL: () => null,
    members: { me },
    roles: { cache: new Collection([['r1', { position: 10 }], ['r2', { position: 8 }], ['bot', { position: 5 }]]) },
    channels: { cache: new Collection(channels.map((c) => [c.id, { ...c, toString: () => `<#${c.id}>`, isTextBased: () => true, permissionsFor: () => ({ has: () => true }) }])) },
  };
}

const cfg = (patch = {}) => ({ ...JSON.parse(JSON.stringify(defaultGuildConfig)), ...patch });

test('settings : tableau de bord, onglets et permission revérifiée', async () => {
  const guild = fakeGuild({ channels: [{ id: 'c1' }] });
  const conf = cfg({ logChannels: { ...defaultGuildConfig.logChannels, moderation: 'c1', messages: 'gone' } });
  const client = { services: { config: { get: () => conf } } };

  await assert.rejects(settings.buttons.view(fakeInteraction({ guild }), client), /Gérer le serveur/);

  for (const action of ['view', 'logs', 'moderation']) {
    const i = fakeInteraction({ guild, granted: [PermissionFlagsBits.ManageGuild] });
    await settings.buttons[action](i, client);
    const { embeds, ids } = assertPayload(i.calls.update);
    assert.ok(ids.includes('cmd:settings:logs'));
    if (action === 'logs') {
      const text = JSON.stringify(embeds[0]);
      assert.ok(text.includes('introuvable'), 'salon supprimé signalé');
    }
  }
  const dash = settings.renderDashboard(guild, conf).toJSON();
  assert.ok(dash.fields.some((x) => x.name.includes('Salons de logs')));
});

test('diagnostics : contrôles groupés, score et bouton relancer', async () => {
  const guild = fakeGuild();
  const conf = cfg({ logChannels: { ...defaultGuildConfig.logChannels, moderation: 'missing' } });
  const groups = diagnostics.analyze(guild, conf);
  const all = groups.flatMap((g) => g.checks);
  assert.ok(all.some((c) => c.level === 'fail'), 'salon de logs introuvable = erreur');
  assert.ok(all.some((c) => c.level === 'warn' && /logs d'audit/.test(c.text)), 'permission manquante = avertissement');
  assert.ok(all.some((c) => c.level === 'warn' && /rôles au-dessus/.test(c.text)), 'hiérarchie = avertissement');
  const adminChecks = diagnostics.analyze(fakeGuild({ admin: true }), cfg())[0].checks;
  assert.deepStrictEqual(adminChecks.map((c) => c.level), ['ok'], 'administrateur : un seul contrôle');
  const s = diagnostics.score(groups);
  assert.ok(s.percent > 0 && s.percent < 100);

  const client = { services: { config: { get: () => conf } } };
  await assert.rejects(diagnostics.buttons.rerun(fakeInteraction({ guild }), client), /Gérer le serveur/);
  const i = fakeInteraction({ guild, granted: [PermissionFlagsBits.ManageGuild] });
  await diagnostics.buttons.rerun(i, client);
  const { embeds, ids } = assertPayload(i.calls.update);
  assert.deepStrictEqual(ids, ['cmd:diagnostics:rerun']);
  assert.ok(embeds[0].description.includes('%'));
});

test('health : carte technique et actualisation réservée à l\'auteur', async () => {
  const client = {
    ws: { ping: 42 },
    uptime: 3_600_000,
    config: { version: '1.0.0' },
    database: { raw: { prepare: () => ({ get: () => 1 }) } },
    services: { scheduler: { timer: {} } },
    guilds: { cache: { size: 3 } },
    commands: { size: 60 },
    stats: { commandsRun: 12, errors: 0 },
  };
  await assert.rejects(health.buttons.refresh(fakeInteraction({ userId: 'x' }), client, ['owner']), /réservé/);
  const i = fakeInteraction({ userId: 'owner' });
  await health.buttons.refresh(i, client, ['owner']);
  const { embeds, ids } = assertPayload(i.calls.update);
  assert.deepStrictEqual(ids, ['cmd:health:refresh:owner']);
  assert.ok(embeds[0].description.includes('opérationnels'));
});

test('backup : composition, fiche détaillée et permission Administrateur', async () => {
  const data = {
    name: 'Serveur',
    roles: [{ name: 'Admin' }, { name: 'Modo' }],
    channels: [{ type: 4, name: 'Général' }, { type: 0, name: 'chat' }, { type: 2, name: 'vocal' }],
    counts: { roles: 2, channels: 3 },
  };
  assert.deepStrictEqual(backup.composition(data), { roles: 2, channels: 3, categories: 1, text: 1, voice: 1 });
  const row = { id: 'abc123', name: 'Avant refonte', data, created_by: 'u1', created_at: Date.now() };
  const client = { services: { backup: { get: (g, id) => (id === 'abc123' ? row : (() => { throw new Error('introuvable'); })()) } } };
  await assert.rejects(backup.buttons.info(fakeInteraction({}), client, ['abc123']), /Administrateur/);
  await assert.rejects(backup.buttons.restore(fakeInteraction({}), client, ['abc123']), /Administrateur/);
  await assert.rejects(backup.buttons.remove(fakeInteraction({}), client, ['abc123']), /Administrateur/);
  const i = fakeInteraction({ granted: [PermissionFlagsBits.Administrator] });
  await backup.buttons.info(i, client, ['abc123']);
  const { ids } = assertPayload(i.calls.reply);
  assert.deepStrictEqual(ids, ['cmd:backup:restore:abc123', 'cmd:backup:remove:abc123']);
  assert.strictEqual(i.calls.reply.ephemeral, true);
});

test('custom : bouton Tester (aperçu éphémère, tag manquant, permission)', async () => {
  const guild = fakeGuild();
  const tags = { bonjour: { name: 'bonjour', content: 'Salut {user} sur {server} ({membercount})', is_embed: 0 } };
  const client = { repositories: { customCommands: { get: (g, n) => tags[n] } } };
  await assert.rejects(custom.buttons.test(fakeInteraction({ guild }), client, ['bonjour']), /Gérer le serveur/);
  const ok = fakeInteraction({ guild, granted: [PermissionFlagsBits.ManageGuild] });
  await assert.rejects(custom.buttons.test(ok, client, ['absent']), /n'existe plus/);
  await custom.buttons.test(ok, client, ['bonjour']);
  const { embeds } = assertPayload(ok.calls.reply);
  assert.ok(embeds[0].description.includes('Salut <@u1> sur Serveur test (42)'));
  assert.strictEqual(ok.calls.reply.ephemeral, true);
});

// ---------------------------------------------------------------- projets

function entries(n) {
  return Array.from({ length: n }, (_, i) => ({
    project: { id: i + 1, number: i + 1, name: `Projet ${i}`, status: i % 2 ? 'en_cours' : 'termine', ownerId: 'o', tags: ['web'], progress: 40, createdAt: 0, updatedAt: 0, deadline: Date.now() - 86400000 * 3 },
    counts: { total: 2, done: 1 },
  }));
}

test('projet liste : pagination persistante + Actualiser + 🗑️', async () => {
  const guild = fakeGuild();
  const service = { list: () => entries(13) };
  const client = { services: { projects: service }, users: { cache: new Map(), fetch: async () => null } };
  await assert.rejects(projet.buttons.list(fakeInteraction({ guild, userId: 'x' }), client, ['owner', '1', '-', '-', 'n']), /réservé/);
  const i = fakeInteraction({ guild, userId: 'owner' });
  await projet.buttons.list(i, client, ['owner', '1', 'en_cours', '-', 'n']);
  const { embeds, ids } = assertPayload(i.calls.update);
  assert.ok(embeds[0].footer.text.includes('Page 2/3'));
  assert.ok(ids.includes('cmd:projet:list:owner:0:en_cours:-:p'));
  assert.ok(ids.includes('cmd:projet:list:owner:2:en_cours:-:n'));
  assert.ok(ids.includes('cmd:projet:list:owner:1:en_cours:-:r'));
  assert.ok(ids.includes('cmd:_:delete:owner'));

  // Liste vidée entre-temps : carte informative, 🗑️ conservé.
  const empty = fakeInteraction({ guild, userId: 'owner' });
  await projet.buttons.list(empty, { ...client, services: { projects: { list: () => [] } } }, ['owner', '0', '-', '-', 'r']);
  assert.deepStrictEqual(assertPayload(empty.calls.update).ids, ['cmd:_:delete:owner']);
});

test('projet stats : carte et actualisation', async () => {
  const guild = fakeGuild();
  const stats = { total: 4, byStatus: { en_cours: 2, termine: 2 }, overdue: 1, topOwners: [['a', 3], ['b', 1]], tasks: { total: 10, done: 4 } };
  const client = { services: { projects: { stats: () => stats } } };
  const i = fakeInteraction({ guild, userId: 'owner' });
  await projet.buttons.stats(i, client, ['owner']);
  const { embeds, ids } = assertPayload(i.calls.update);
  assert.deepStrictEqual(ids, ['cmd:projet:stats:owner', 'cmd:_:delete:owner']);
  assert.ok(embeds[0].fields.some((x) => x.name.includes('Taux de réussite') && x.value.includes('50 %')));
});

test('projet : boutons Publier / Modifier revérifient les droits et l\'existence', async () => {
  const project = { id: 7, number: 2, guildId: 'g1', name: 'P', tags: [], color: null };
  const service = {
    repo: { get: (id) => (id === 7 ? project : null) },
    assertCanEdit: () => { throw new Error('Seuls le responsable…'); },
  };
  const client = { services: { projects: service } };
  await assert.rejects(projet.buttons.edit(fakeInteraction({}), client, ['99']), /n'existe plus/);
  await assert.rejects(projet.buttons.edit(fakeInteraction({}), client, ['7']), /Seuls/);
  await assert.rejects(projet.buttons.publish(fakeInteraction({}), client, ['7']), /Seuls/);

  const modal = projet.buildEditModal({ ...project, description: 'd', imageUrl: null, color: 0xff0000, tags: ['a'] }).toJSON();
  assert.strictEqual(modal.custom_id, 'project:edit:7', 'formulaire compatible avec le composant project:');
  assert.strictEqual(modal.components.length, 5);
});

test('fiche projet : bouton Actualiser conserve le 🗑️ d\'une réponse, jamais sur une fiche publiée', async () => {
  const project = { id: 3, number: 3, guildId: 'g1', name: 'Site', status: 'en_cours', ownerId: 'o', tags: [], links: [{ label: 'Git', url: 'https://e.com' }], createdAt: 0, updatedAt: 0 };
  const service = {
    repo: { get: () => project, tasks: () => [{ title: 't', done: false }] },
    render: (p) => ({ embeds: [f.buildProjectEmbed(p, { tasks: [] })], components: f.buildProjectComponents(p, { hasTasks: true }) }),
  };
  const client = { services: { projects: service } };
  const withDel = { components: [{ components: [{ customId: 'project:refresh:3' }, { customId: 'cmd:_:delete:owner' }] }] };
  const i = fakeInteraction({ message: withDel });
  i.customId = 'project:refresh:3';
  await projectComponent.execute(i, client);
  assert.ok(assertPayload(i.calls.update).ids.includes('cmd:_:delete:owner'));

  const published = fakeInteraction({ message: { components: [{ components: [{ customId: 'project:refresh:3' }] }] } });
  published.customId = 'project:refresh:3';
  await projectComponent.execute(published, client);
  const { ids } = assertPayload(published.calls.update);
  assert.ok(!ids.some((id) => id.startsWith('cmd:_:delete')));
  assert.deepStrictEqual(ids, ['project:tasks:3', 'project:refresh:3'], 'identifiants historiques inchangés');

  const tasks = fakeInteraction({});
  tasks.customId = 'project:tasks:3';
  await projectComponent.execute(tasks, client);
  assert.strictEqual(tasks.calls.reply.ephemeral, true);
  assertPayload(tasks.calls.reply);
});

test('projectFormat : stats, réglages et tâches passent par card()', () => {
  const stats = f.buildProjectStatsEmbed({ total: 0, byStatus: {}, overdue: 0, topOwners: [], tasks: { total: 0, done: 0 } }, { guildName: 'S' }).toJSON();
  assert.ok(stats.footer.text);
  const settingsCard = f.buildProjectSettingsEmbed({ managerRoleId: null, channelId: 'c', openCreation: false, maxPerUser: 3 }, { changed: true }).toJSON();
  assert.ok(settingsCard.title.includes('mis à jour'));
  const many = Array.from({ length: 25 }, (_, i) => ({ title: 'x'.repeat(100), done: i % 2 === 0, doneBy: '123456789012345678' }));
  assertPayload({ embeds: [f.buildTaskListEmbed({ id: 1, number: 1, name: 'N', status: 'en_cours', color: null }, many)] });
  const pages = f.buildProjectListPages(entries(7), { guildName: 'S' });
  for (const p of pages) assertPayload({ embeds: [p] });
  assert.ok(pages[0].toJSON().description.includes('en retard'));
});
