'use strict';

/**
 * Revue n° 7, bout en bout (vrai discord.js, faux Discord) : lot « divers » — mode strict au
 * niveau de l'action (S29), protection par rang de /activite, /role et /pseudo (S30, S31),
 * formulaire de /embed délégué (S32), /channel renouveler et alertes de mots-clés (S41), rôle
 * soutien avec un cache froid (S44), présence après une nouvelle IDENTIFY (S45).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { ActivityType } = require('discord.js');
const { createHarness, IDS } = require('./harness');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ S44 : rôle soutien, cache froid

/**
 * Serveur de 207 membres, rôle « communautaire » existant porté par 50 membres côté Discord.
 * `cold` : redémarrage (seuls le bot, l'admin et le propriétaire en cache).
 */
async function supportSetup({ cold }) {
  const h = await createHarness({ big: true });
  h.configureAll();
  const ROLE = [...h.guild.roles.cache.values()].find((r) => /^Rôle/.test(r.name) && r.members.size > 0).id;
  const crowd = [...h.fake.members.values()].filter((m) => !m.user.bot && m.user.id !== IDS.users.admin && m.user.id !== IDS.users.owner).slice(0, 50);
  for (const m of crowd) {
    if (!m.roles.includes(ROLE)) m.roles.push(ROLE);
    h.guild.members.cache.get(m.user.id)?._patch({ roles: m.roles, user: m.user });
  }
  const holders = () => [...h.fake.members.values()].filter((m) => m.roles.includes(ROLE)).length;
  if (cold) for (const id of [...h.guild.members.cache.keys()]) if (![IDS.users.admin, IDS.users.bot, IDS.users.owner].includes(id)) h.guild.members.cache.delete(id);
  const dash = await h.slash('automatisations');
  const view = await h.click(h.messagesOf(dash)[0], 'cmd:automatisations:nav', { values: ['support'] });
  return { h, ROLE, holders, view: h.messagesOf(view)[0] };
}

test('S44 rôle soutien : cache froid → la liste complète est relue avant de compter, le rôle déjà porté est refusé (aucun retrait)', async () => {
  const { h, ROLE, holders, view } = await supportSetup({ cold: true });
  try {
    const before = holders();
    assert.ok(before >= 50);
    assert.ok(h.guild.members.cache.size < h.guild.memberCount, 'cache froid');
    const rec = await h.click(view, 'cmd:automatisations:surole', { values: [ROLE] });
    assert.ok(h.isError(rec), h.replyText(rec));
    assert.match(h.replyText(rec), new RegExp(`\\*\\*${before}\\*\\* membre\\(s\\) ont déjà le rôle`));
    assert.equal(h.client.services.config.get(h.guild.id).support?.roleId ?? null, null, 'rôle non enregistré');
    // Activer ensuite : « Choisissez d'abord le rôle », rien n'est retiré.
    const on = await h.click(view, 'cmd:automatisations:sutoggle:on');
    assert.ok(h.isError(on));
    await sleep(100);
    await h.settle();
    assert.equal(holders(), before);
    assert.equal(h.fake.calls.filter((c) => c.method === 'DELETE' && c.route.endsWith(`/roles/${ROLE}`)).length, 0);
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('S44 rôle soutien : liste des membres illisible (cache froid) → refus explicite, rien enregistré', async () => {
  const { h, ROLE, view } = await supportSetup({ cold: true });
  try {
    h.guild.members.fetch = async () => {
      throw new Error('GuildMembersTimeout');
    };
    const rec = await h.click(view, 'cmd:automatisations:surole', { values: [ROLE] });
    assert.ok(h.isError(rec), h.replyText(rec));
    assert.match(h.replyText(rec), /liste des membres/i);
    assert.equal(h.client.services.config.get(h.guild.id).support?.roleId ?? null, null);
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('S44 rôle soutien : rôle choisi vide puis donné à la main, cache froid → « Activer » refuse au lieu de le retirer à tous', async () => {
  const h = await createHarness({ big: true });
  try {
    h.configureAll();
    const ROLE = IDS.roles.temp;
    const dash = await h.slash('automatisations');
    let rec = await h.click(h.messagesOf(dash)[0], 'cmd:automatisations:nav', { values: ['support'] });
    rec = await h.click(h.messagesOf(rec)[0], 'cmd:automatisations:surole', { values: [ROLE] });
    assert.ok(!h.isError(rec), h.replyText(rec));
    const view = h.messagesOf(rec)[0];
    // Rôle donné à la main à 12 membres pendant que la fonction est désactivée, puis redémarrage.
    const crowd = [...h.fake.members.values()].filter((m) => !m.user.bot && m.user.id !== IDS.users.admin && m.user.id !== IDS.users.owner).slice(0, 12);
    for (const m of crowd) m.roles.push(ROLE);
    for (const id of [...h.guild.members.cache.keys()]) if (![IDS.users.admin, IDS.users.bot, IDS.users.owner].includes(id)) h.guild.members.cache.delete(id);
    const on = await h.click(view, 'cmd:automatisations:sutoggle:on');
    assert.ok(h.isError(on), h.replyText(on));
    assert.match(h.replyText(on), /\*\*12\*\* membre\(s\)/);
    assert.equal(h.client.services.config.get(h.guild.id).support.enabled, false);
    await sleep(100);
    await h.settle();
    assert.equal([...h.fake.members.values()].filter((m) => m.roles.includes(ROLE)).length, 12);
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('S44 témoin : cache chaud, rôle dédié vide → choisi et activé sans relire la liste', async () => {
  const h = await createHarness();
  try {
    h.configureAll();
    const fetches = [];
    const original = h.guild.members.fetch.bind(h.guild.members);
    h.guild.members.fetch = (...args) => {
      fetches.push(args);
      return original(...args);
    };
    const dash = await h.slash('automatisations');
    let rec = await h.click(h.messagesOf(dash)[0], 'cmd:automatisations:nav', { values: ['support'] });
    rec = await h.click(h.messagesOf(rec)[0], 'cmd:automatisations:surole', { values: [IDS.roles.temp] });
    assert.match(h.replyText(rec), /Rôle soutien : /);
    assert.equal(fetches.length, 0, 'cache complet : pas de relecture');
    rec = await h.click(h.messagesOf(rec)[0], 'cmd:automatisations:sutoggle:on');
    assert.match(h.replyText(rec), /activé/);
    assert.equal(h.problemCount(), 0, h.formatProblems());
    await h.client.services.supportRole.stop();
  } finally {
    await h.close();
  }
});

// ------------------------------------------------------------------ S45 : présence après IDENTIFY

test('S45 présence : nouvelle IDENTIFY (shardReady après le démarrage) → l\'activité imposée par /bot est réappliquée tout de suite', async () => {
  const h = await createHarness();
  try {
    h.client.services.botProfile.setActivity({ type: ActivityType.Playing, text: 'Inspecter le serveur' }, IDS.users.owner);
    const packets = [];
    const send = h.client.ws._ws.send;
    h.client.ws._ws.send = (shardId, packet) => {
      packets.push(packet);
      return send(shardId, packet);
    };
    // Session perdue puis rouverte : Discord repart de la présence par défaut.
    h.client.emit('shardReady', 0, new Set());
    await h.settle();
    const presence = packets.filter((p) => p?.op === 3);
    assert.equal(presence.length, 1, 'une mise à jour de présence');
    assert.equal(presence[0].d.activities?.[0]?.name, 'Inspecter le serveur');
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('S45 témoin : premier shardReady (client pas encore prêt) → rien, clientReady s\'en charge', async () => {
  const h = await createHarness();
  try {
    const packets = [];
    const send = h.client.ws._ws.send;
    h.client.ws._ws.send = (shardId, packet) => {
      packets.push(packet);
      return send(shardId, packet);
    };
    const isReady = h.client.isReady;
    h.client.isReady = () => false;
    h.client.emit('shardReady', 0, new Set());
    await h.settle();
    h.client.isReady = isReady;
    assert.equal(packets.filter((p) => p?.op === 3).length, 0);
  } finally {
    await h.close();
  }
});
