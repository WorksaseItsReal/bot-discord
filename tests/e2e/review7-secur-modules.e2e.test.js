'use strict';

/**
 * Revue n° 7, modules Secur, bout en bout (vrai discord.js, faux Discord) : transfert de propriété,
 * déplacements vocaux, homonymes et disjoncteur, restauration /backup pendant la file
 * d'annulation, modifications successives, rôle rendu à l'auteur, roleRemove pendant un incident,
 * références en base d'un rôle recréé, mémoires périmées pendant que la file travaille.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness, IDS } = require('./harness');
const { presetPatch } = require('../../src/utils/secur');
const { defaultGuildConfig } = require('../../src/config/defaults');

const incidents = (h) => h.client.repositories.securityIncidents.recent(h.guild.id, 10);
const rolesOf = (h, userId) => h.fake.members.get(userId)?.roles ?? [];

async function presetHarness(preset, extra = {}) {
  const h = await createHarness();
  h.configure({ logChannels: { security: IDS.channels.logs }, automod: { enabled: false }, antiraid: { enabled: false } });
  h.configure({ secur: { modules: presetPatch(preset, defaultGuildConfig.secur.modules) }, ...extra });
  return h;
}

/* -------------------------------------------------------------------- */
/* S3 : transfert de propriété                                           */
/* -------------------------------------------------------------------- */

for (const preset of ['on', 'max']) {
  test(`S3 [${preset}] : transfert de propriété (GUILD_UPDATE avant l'audit) → l'ancien propriétaire n'est pas dérangé`, async () => {
    const h = await presetHarness(preset);
    try {
      await h.asHuman('owner').addRole('owner', IDS.roles.admin);
      await h.asHuman('owner').editGuild({ owner_id: IDS.users.admin }, { label: 'transfert' });
      await h.settle({ timeout: 5_000 });
      assert.equal(h.guild.ownerId, IDS.users.admin);
      assert.equal(incidents(h).length, 0, 'incident ouvert contre l\'ancien propriétaire');
      assert.ok(rolesOf(h, IDS.users.owner).includes(IDS.roles.admin), 'ancien propriétaire dérangé');
      assert.equal(h.problemCount(), 0, h.formatProblems());
    } finally {
      await h.close();
    }
  });
}

test('S3 [max] : un renommage du serveur par un admin reste sanctionné', async () => {
  const h = await presetHarness('max');
  try {
    await h.asHuman('admin').editGuild({ name: 'Serveur piraté' }, { label: 'renommage' });
    await h.settle({ timeout: 5_000 });
    const [inc] = incidents(h);
    assert.ok(inc, 'aucun incident');
    assert.equal(inc.executor_id, IDS.users.admin);
  } finally {
    await h.close();
  }
});

/* -------------------------------------------------------------------- */
/* S8 : déplacements vocaux                                               */
/* -------------------------------------------------------------------- */

const securVoice = require('../../src/events/securVoice');
const { nextId } = require('./lib/ids');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function voiceHarness() {
  const h = await createHarness();
  h.configure({ logChannels: { security: IDS.channels.logs }, automod: { enabled: false }, antiraid: { enabled: false }, tempVoice: { enabled: false }, secur: { modules: { voiceKick: { mode: 'on' } } } });
  return h;
}

test('S8 : un modérateur qui glisse 5 membres vers un autre vocal (entrée 26 regroupée) n\'est pas dérangé ; 6 déconnexions restent sanctionnées', async () => {
  const delay = securVoice.timing.delayMs;
  securVoice.timing.delayMs = 10;
  const h = await voiceHarness();
  try {
    const ids = [];
    for (let i = 0; i < 5; i += 1) {
      const u = h.addUser(`Invite${i}`);
      await h.memberJoin(u);
      await h.voice(u.id, 'hub');
      ids.push(u.id);
    }
    // Discord regroupe : UNE entrée 26 (salon cible) dont le compte passe de 1 à 5.
    const move = { id: nextId(), action_type: 26, target_id: null, user_id: IDS.users.mod, changes: [], options: { count: '0', channel_id: IDS.channels.voice } };
    h.fake.auditLog.unshift(move);
    for (const id of ids) {
      move.options.count = String(Number(move.options.count) + 1);
      await h.asHuman('mod').perform('PATCH', `/guilds/${h.guild.id}/members/${id}`, { channel_id: IDS.channels.voice });
      await sleep(40);
      await h.settle();
    }
    await sleep(40);
    await h.settle();
    assert.equal(ids.filter((id) => h.fake.voiceStates.get(id)?.channel_id === IDS.channels.voice).length, 5);
    assert.equal(incidents(h).length, 0, 'déplacements comptés comme des déconnexions');
    assert.ok(rolesOf(h, IDS.users.mod).includes(IDS.roles.mod), 'modérateur dérangé');

    // Non-régression : 6 déconnexions regroupées (entrée 27).
    h.fake.auditLog.unshift({ id: nextId(), action_type: 27, target_id: null, user_id: IDS.users.mod, changes: [], options: { count: '6' } });
    await h.asHuman('mod').perform('PATCH', `/guilds/${h.guild.id}/members/${ids[0]}`, { channel_id: null });
    assert.ok(await h.waitFor(() => incidents(h).length > 0, { timeout: 2_000 }), 'déconnexions non sanctionnées');
    assert.equal(incidents(h)[0].actions, 6);
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    securVoice.timing.delayMs = delay;
    await h.close();
  }
});

/* -------------------------------------------------------------------- */
/* S19 : homonymes et disjoncteur                                          */
/* -------------------------------------------------------------------- */

const settleLong = async (h) => {
  await h.settle();
  await sleep(800);
  await h.settle();
};

test('S19 : nuke avec 3 vocaux homonymes « Vocal » → le disjoncteur ne se déclenche pas, tous les salons sont recréés', async () => {
  const h = await createHarness();
  try {
    h.configureAll();
    const vocs = [];
    for (const parent of [IDS.channels.catGeneral, IDS.channels.catVoice, IDS.channels.catTickets]) vocs.push(await h.guild.channels.create({ name: 'Vocal', type: 2, parent }));
    await h.settle();
    h.configure({ secur: { modules: { channelDelete: { mode: 'on' } } } });
    const ids = [...vocs.map((v) => v.id), IDS.channels.general, IDS.channels.rules, IDS.channels.announcements];
    await Promise.all(ids.map((id) => h.fake.perform('DELETE', `/channels/${id}`, undefined, { actorId: IDS.users.admin })));
    await settleLong(h);
    const names = [...h.fake.channels.values()].map((c) => c.name);
    for (const n of ['général', 'règles', 'annonces']) assert.ok(names.includes(n), `#${n} jamais recréé`);
    assert.equal(names.filter((n) => n === 'Vocal').length, 3);
    assert.equal(h.client.services.secur.breaker.isSuspended(h.guild.id, 'channelDelete'), false, 'disjoncteur déclenché par des homonymes');
  } finally {
    await h.close();
  }
});

test('S19 : 3 rôles séparateurs homonymes supprimés avec @Joueur et @Notifications → les 5 rôles sont recréés', async () => {
  const h = await createHarness();
  try {
    h.configureAll();
    const seps = [];
    for (let i = 0; i < 3; i += 1) seps.push(await h.guild.roles.create({ name: '──────────', permissions: [] }));
    await h.settle();
    h.configure({ secur: { modules: { roleDelete: { mode: 'on' } } } });
    const before = h.fake.calls.length;
    const ids = [...seps.map((r) => r.id), IDS.roles.gamer, IDS.roles.notif];
    await Promise.all(ids.map((id) => h.fake.perform('DELETE', `/guilds/${h.guild.id}/roles/${id}`, undefined, { actorId: IDS.users.admin })));
    await settleLong(h);
    const posts = h.fake.calls.slice(before).filter((c) => c.method === 'POST' && /^\/guilds\/\d+\/roles$/.test(c.route)).map((c) => c.body.name);
    assert.equal(posts.length, 5, `rôles recréés : ${posts.join(', ')}`);
    assert.equal(h.client.services.secur.breaker.isSuspended(h.guild.id, 'roleDelete'), false);
  } finally {
    await h.close();
  }
});

test('S19 : boucle réelle (le salon recréé supprimé à chaque fois) → le disjoncteur se déclenche toujours', async () => {
  const h = await createHarness();
  try {
    h.configureAll();
    h.configure({ secur: { modules: { channelDelete: { mode: 'on', punish: 'none' } } } });
    let id = IDS.channels.rules;
    for (let i = 0; i < 4 && id && h.fake.channels.has(id); i += 1) {
      await h.fake.perform('DELETE', `/channels/${id}`, undefined, { actorId: IDS.users.admin });
      await settleLong(h);
      id = [...h.fake.channels.values()].find((c) => c.name === 'règles')?.id;
    }
    assert.ok(h.client.services.secur.breaker.isSuspended(h.guild.id, 'channelDelete'), 'boucle non détectée');
  } finally {
    await h.close();
  }
});

/* -------------------------------------------------------------------- */
/* S2 : /backup restore pendant que la file d'annulation travaille         */
/* -------------------------------------------------------------------- */

test('S2 : /backup restore pendant la file d\'annulation (429 sur les membres) → aucun doublon, configuration et membres sur la copie restaurée', async () => {
  const h = await createHarness();
  try {
    h.configure({
      logChannels: { security: IDS.channels.logs },
      automod: { enabled: false },
      antiraid: { enabled: false },
      suggestions: { channelId: IDS.channels.general },
      secur: { modules: { channelDelete: { mode: 'on' }, roleDelete: { mode: 'on' } } },
    });
    const backup = h.client.services.backup;
    const { id } = backup.create(h.guild, h.client.users.cache.get(IDS.users.owner), 'avant');
    // Limite de débit sur l'attribution des rôles par le bot : la file reste occupée.
    h.fake.inject({ match: (c) => c.method === 'PUT' && /\/guilds\/\d+\/members\/\d+\/roles\/\d+$/.test(c.route) && !c.actor }, { status: 429, retryAfter: 2_500, times: 2 });
    const actorId = IDS.users.admin;
    await Promise.all([
      h.fake.perform('DELETE', `/guilds/${h.guild.id}/roles/${IDS.roles.member}`, undefined, { actorId }),
      h.fake.perform('DELETE', `/guilds/${h.guild.id}/roles/${IDS.roles.gamer}`, undefined, { actorId }),
      h.fake.perform('DELETE', `/channels/${IDS.channels.general}`, undefined, { actorId }),
      h.fake.perform('DELETE', `/channels/${IDS.channels.rules}`, undefined, { actorId }),
    ]);
    await sleep(400);
    const queue = h.client.services.secur.queues.get(h.guild.id);
    assert.ok(queue.size > 0, 'file déjà vide : scénario non reproduit');
    const rec = await h.slash('backup', [{ name: 'restore', type: 1, options: [{ name: 'id', type: 3, value: id }] }], { as: 'owner', channel: 'staff' });
    assert.ok(!h.isError(rec), h.replyText(rec));
    const go = await h.confirm(rec);
    assert.ok(go && !h.isError(go), go ? h.replyText(go) : 'pas de confirmation');
    for (let i = 0; i < 40 && queue.busy; i += 1) await sleep(250);
    await h.settle({ timeout: 4_000 });

    const named = (map, name) => [...map.values()].filter((x) => x.name === name);
    assert.equal(named(h.fake.roles, 'Joueur').length, 1, '@Joueur en double');
    assert.equal(named(h.fake.roles, 'Membre').length, 1, '@Membre en double');
    assert.equal(named(h.fake.channels, 'général').length, 1, '#général en double');
    assert.equal(named(h.fake.channels, 'règles').length, 1, '#règles en double');
    const [general] = named(h.fake.channels, 'général');
    assert.equal(h.client.services.config.get(h.guild.id).suggestions.channelId, general.id, 'configuration sur un salon disparu');
    const [joueur] = named(h.fake.roles, 'Joueur');
    assert.ok(rolesOf(h, IDS.users.member).includes(joueur.id), 'membre privé du rôle restauré');
    // Une restauration suivante ne trouve aucun homonyme à départager.
    const again = await backup.restore(h.guild, id);
    assert.deepEqual(again.ambiguous, []);
  } finally {
    await h.close();
  }
});

/* -------------------------------------------------------------------- */
/* S24 : mémoires périmées pendant que la file rend les membres            */
/* -------------------------------------------------------------------- */

const { rawMember } = require('./lib/fixtures');
const St = require('../../src/services/secur/structure');

/**
 * Rafale : 3 rôles portés par `members` membres, puis le vocal et sa catégorie. Chaque PUT de
 * membre envoyé par le bot fait avancer de `stepMs` l'horloge des mémoires de Secur (aller-retour
 * et limite de débit de la route) : les salons, en priorité 3, attendent derrière les rôles.
 */
async function ttlScenario(order, stepMs, members = 40) {
  const h = await createHarness();
  try {
    h.configureAll();
    h.configure({ secur: { modules: { roleDelete: { mode: 'on', punish: 'none' }, channelDelete: { mode: 'on', punish: 'none' } } } });
    const roles = [IDS.roles.gamer, IDS.roles.notif, IDS.roles.member];
    for (let i = 0; i < members; i += 1) {
      const user = h.addUser(`porteur${i}`, { ageDays: 500 });
      const raw = rawMember(user, [...roles], 100);
      h.fake.members.set(user.id, raw);
      h.guild.members._add({ ...raw, roles: [...roles] });
    }
    const store = St.storeFor(h.client);
    let offset = 0;
    store.now = () => Date.now() + offset;
    const route = h.fake.routes.find((r) => r.method === 'PUT' && r.re.test(`/guilds/${h.guild.id}/members/1/roles/2`));
    const orig = route.handler;
    route.handler = async (p, call) => {
      if (call.actor == null) {
        offset += stepMs;
        await sleep(2);
      }
      return orig(p, call);
    };
    const attacker = (method, path) => h.fake.perform(method, path, undefined, { actorId: IDS.users.admin });
    for (const id of roles) await attacker('DELETE', `/guilds/${h.guild.id}/roles/${id}`);
    const chans = order === 'voiceFirst' ? [IDS.channels.voice, IDS.channels.catVoice] : [IDS.channels.catVoice, IDS.channels.voice];
    for (const id of chans) await attacker('DELETE', `/channels/${id}`);
    const t0 = Date.now();
    while (Date.now() - t0 < 30_000) {
      await sleep(50);
      const queue = h.client.services.secur.queues.get(h.guild.id);
      if (queue && !queue.busy && Date.now() - t0 > 500) break;
    }
    await h.settle();
    const cat = [...h.fake.channels.values()].find((c) => c.name === 'Vocaux' && c.type === 4);
    const voice = [...h.fake.channels.values()].find((c) => c.name === 'Salon vocal');
    return { cat, voice, elapsed: offset };
  } finally {
    await h.close();
  }
}

test('S24 : vocal supprimé avant sa catégorie, file occupée plus de 120 s par les membres rendus → vocal recréé dans sa catégorie', async () => {
  const { cat, voice, elapsed } = await ttlScenario('voiceFirst', 1_100);
  assert.ok(elapsed > 120_000, `scénario trop court : ${elapsed} ms`);
  assert.ok(cat && voice, 'catégorie ou vocal non recréé');
  assert.equal(voice.parent_id, cat.id, 'vocal recréé hors de sa catégorie');
});

test('S24 : catégorie supprimée d\'abord, file occupée plus de 30 s → vocal recréé dans sa catégorie', async () => {
  const { cat, voice, elapsed } = await ttlScenario('catFirst', 300);
  assert.ok(elapsed > 30_000, `scénario trop court : ${elapsed} ms`);
  assert.ok(cat && voice, 'catégorie ou vocal non recréé');
  assert.equal(voice.parent_id, cat.id, 'vocal recréé hors de sa catégorie');
});
