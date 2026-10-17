'use strict';

/**
 * SEC4 — modules Secur « Structure », bout en bout (vrai bot, faux Discord) : salons créés,
 * supprimés (recréation avec catégorie, surcharges, enfants, logs rebranchés, épinglé republié)
 * et modifiés, tickets jamais recréés, webhooks (suivi toléré en « on »), paramètres et icône du
 * serveur, emojis et autocollants, whitelist / owners, actions du bot et restauration /backup.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { PermissionFlagsBits: P } = require('discord.js');
const { createHarness, IDS } = require('./harness');
const { explore } = require('./lib/explore');
const cdn = require('../../src/utils/discordCdn');

const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
const botMessages = (h, mark, pred = () => true) => h.fake.messageLog.slice(mark).map((id) => h.message(id)).filter((m) => m && m.author?.id === h.client.user.id && pred(m));
const titled = (re) => (m) => (m.embeds ?? []).some((e) => re.test(e.title ?? ''));
/** Cartes d'incident publiées dans un salon du serveur (hors MP). */
const incidentCards = (h, mark) => botMessages(h, mark, titled(/Incident Secur|Bot non neutralisé/)).filter((m) => !h.fake.dms.has(m.channel_id));
const incidentDms = (h, mark) => botMessages(h, mark, titled(/Incident Secur/)).filter((m) => h.fake.dms.has(m.channel_id));
const incidents = (h) => h.client.repositories.securityIncidents.recent(h.guild.id, 20);
const details = (card) => card.embeds[0].fields.find((f) => /Détails/.test(f.name))?.value ?? '';
const setModules = (h, modules) => h.configure({ secur: { modules } });
const channelNamed = (h, name, type) => [...h.fake.channels.values()].find((c) => c.name === name && (type == null || c.type === type)) ?? null;
const recOf = (h, message) => ({ messages: [message.id], followUps: [], msgMark: h.fake.messageLog.length, modals: [] });
/** Donne des permissions à un rôle du serveur de test (comme si un admin l'avait fait). */
function grant(h, roleKey, ...flags) {
  const role = h.fake.roles.get(IDS.roles[roleKey]);
  role.permissions = (BigInt(role.permissions) | flags.reduce((a, f) => a | f, 0n)).toString();
  h.fake.dispatchNow('GUILD_ROLE_UPDATE', { guild_id: h.guild.id, role });
}
const writesSince = (h, mark, re) => h.fake.calls.slice(mark).filter((c) => c.method !== 'GET' && re.test(`${c.method} ${c.route}`));

test('salon créé par un modérateur en « on » → supprimé, modérateur dérangé, une seule alerte ; boutons de la carte refusés à un membre', async () => {
  const h = await createHarness();
  try {
    h.configureAll();
    grant(h, 'mod', P.ManageChannels);
    setModules(h, { channelCreate: { mode: 'on' } });
    const mark = h.fake.messageLog.length;
    const created = await h.asHuman('mod').createChannel('raid-spam');
    await h.settle();
    assert.equal(h.fake.channels.has(created.id), false, 'salon créé non supprimé');
    assert.ok(!h.fake.members.get(IDS.users.mod).roles.includes(IDS.roles.mod), 'modérateur non dérangé');
    const cards = incidentCards(h, mark);
    assert.equal(cards.length, 1, `${cards.length} carte(s) d'incident`);
    const [incident] = incidents(h);
    assert.equal(incident.executor_id, IDS.users.mod);
    assert.deepEqual(incident.modules, ['channelCreate']);
    assert.equal(incident.punishment, 'derank');
    assert.equal(incident.undone, 1);
    await explore(h, recOf(h, cards[0]), { as: 'member', budget: 6 });
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('trois salons supprimés dont une catégorie → recréés (nom, catégorie, surcharges, enfants) ; logs Sécurité rebranchés ; épinglé réinséré et republié', async () => {
  const h = await createHarness();
  try {
    h.configureAll();
    setModules(h, { channelDelete: { mode: 'on', limit: 3, windowSeconds: 30 } });
    const g = h.guild;
    // Message épinglé (sticky) dans #règles.
    await h.client.services.sticky.set({ guildId: g.id, channel: g.channels.cache.get(IDS.channels.rules), content: 'Lisez les règles avant de poster.', threshold: 3 });
    await h.settle();
    const createMark = h.fake.calls.length;
    const mark = h.fake.messageLog.length;
    // Ordre volontairement défavorable : un enfant, la catégorie, puis un enfant devenu orphelin.
    for (const key of ['rules', 'catGeneral', 'logs']) await h.asHuman('admin').deleteChannel(IDS.channels[key]);
    await h.settle();
    await h.waitFor(() => channelNamed(h, 'logs', 0) && channelNamed(h, 'règles', 0) && channelNamed(h, 'Général', 4), { timeout: 3_000 });

    const cat = channelNamed(h, 'Général', 4);
    const rules = channelNamed(h, 'règles', 0);
    const logs = channelNamed(h, 'logs', 0);
    assert.ok(cat && rules && logs, 'salons non recréés');
    assert.notEqual(cat.id, IDS.channels.catGeneral);
    assert.equal(rules.parent_id, cat.id, '#règles hors de sa catégorie');
    assert.equal(logs.parent_id, cat.id, '#logs (orphelin) hors de sa catégorie');
    // Surcharges du salon des logs (staff seulement) recréées.
    const ow = Object.fromEntries(logs.permission_overwrites.map((o) => [o.id, o]));
    assert.equal(BigInt(ow[IDS.roles.everyone].deny) & P.ViewChannel, P.ViewChannel, '@everyone voit #logs');
    assert.equal(BigInt(ow[IDS.roles.mod].allow) & P.ViewChannel, P.ViewChannel);
    // Enfants restés sur le serveur rattachés à la catégorie recréée.
    for (const key of ['general', 'announcements', 'modLog', 'staff', 'forum']) assert.equal(h.fake.channels.get(IDS.channels[key]).parent_id, cat.id, `${key} non rattaché`);
    // Une recréation par salon, la catégorie d'abord.
    const posts = writesSince(h, createMark, /^POST \/guilds\/\d+\/channels$/);
    assert.equal(posts.length, 3, `${posts.length} création(s) de salon`);
    assert.equal(posts[0].body.type, 4, 'catégorie recréée après ses enfants');
    // Configuration : logs et salon d'alerte rebranchés (débranchés par le nettoyage de channelEvents).
    const cfg = h.client.services.config.get(g.id);
    assert.equal(cfg.logChannels.security, logs.id, 'logs Sécurité non rebranchés');
    assert.equal(cfg.logChannels.moderation, logs.id);
    assert.equal(cfg.antiraid.alertChannel, logs.id, 'salon d\'alerte non reporté');
    // Épinglé : ligne réinsérée sur le nouveau salon et message republié.
    const row = h.client.services.sticky.get(rules.id);
    assert.ok(row, 'épinglé non réinséré');
    assert.equal(h.client.services.sticky.get(IDS.channels.rules), null);
    assert.ok(botMessages(h, mark, (m) => m.channel_id === rules.id && (m.embeds ?? []).some((e) => /Lisez les règles/.test(e.description ?? ''))).length, 'épinglé non republié');
    // Incident : auteur dérangé, 3 annulations, pertes dites dans l'alerte (MP : salon d'alerte supprimé).
    const [incident, ...more] = incidents(h);
    assert.equal(more.length, 0, 'plusieurs incidents');
    assert.equal(incident.punishment, 'derank');
    assert.equal(incident.undone, 3, `annulations : ${incident.undone} (échecs ${incident.undo_failed}) — ${incident.outcome}`);
    assert.match(incident.outcome, /Salons recréés : 3/);
    assert.match(incident.outcome, /messages, fils et liens perdus/);
    assert.ok(incidentDms(h, mark).length >= 1, 'propriétaire non prévenu');
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('ticket supprimé à la main → jamais recréé (alerte et sanction quand même)', async () => {
  const h = await createHarness();
  try {
    h.configureAll();
    setModules(h, { channelDelete: { mode: 'on' } });
    const g = h.guild;
    const ticket = await g.channels.create({ name: 'ticket-0042', parent: IDS.channels.catTickets });
    h.client.repositories.tickets.create({ guildId: g.id, channelId: ticket.id, userId: IDS.users.member });
    await h.settle();
    const mark = h.fake.calls.length;
    await h.asHuman('admin').deleteChannel(ticket.id);
    await h.settle();
    assert.deepEqual(writesSince(h, mark, /^POST \/guilds\/\d+\/channels$/), [], 'ticket recréé');
    const [incident] = incidents(h);
    assert.equal(incident.punishment, 'derank');
    assert.match(incident.outcome, /jamais recréé : c'était un ticket/);
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('salon modifié : en « on », nom rétabli et sujet ignoré ; surcharge Administrateur et refus d\'@everyone rétablis par PUT exact ; en « max », sujet rétabli', async () => {
  const h = await createHarness();
  try {
    h.configureAll();
    grant(h, 'mod', P.ManageChannels, P.ManageRoles);
    setModules(h, { channelUpdate: { mode: 'on', limit: 10, windowSeconds: 30 } });
    const general = IDS.channels.general;
    const staff = IDS.channels.staff;
    // Sujet seul : bénin en « on » → rien.
    await h.asHuman('mod').editChannel(general, { topic: 'Nouveau sujet' });
    assert.equal(incidents(h).length, 0, 'sujet compté en « on »');
    // Nom, surcharge Administrateur pour le membre, retrait du refus « Voir » d'@everyone sur #staff.
    const mark = h.fake.calls.length;
    await h.asHuman('mod').editChannel(general, { name: 'pirate' });
    await h.asHuman('mod').perform('PUT', `/channels/${general}/permissions/${IDS.users.member}`, { type: 1, allow: String(P.Administrator), deny: '0' });
    await h.asHuman('mod').perform('PUT', `/channels/${staff}/permissions/${IDS.roles.everyone}`, { type: 0, allow: '0', deny: '0' });
    await h.settle();
    assert.equal(incidents(h).length, 0, 'sous la limite (10) : rien');
    setModules(h, { channelUpdate: { mode: 'on', limit: 3, windowSeconds: 30 } });
    await h.asHuman('mod').editChannel(general, { nsfw: true });
    await h.settle();
    const [incident] = incidents(h);
    assert.ok(incident, 'aucun incident à la limite');
    const ch = h.fake.channels.get(general);
    assert.equal(ch.name, 'général', 'nom non rétabli');
    assert.equal(ch.nsfw, false, 'NSFW non rétabli');
    assert.equal(ch.topic, 'Nouveau sujet', 'sujet (bénin) modifié en « on »');
    assert.equal(ch.permission_overwrites.some((o) => o.id === IDS.users.member), false, 'surcharge Administrateur laissée');
    const ev = h.fake.channels.get(staff).permission_overwrites.find((o) => o.id === IDS.roles.everyone);
    assert.equal(BigInt(ev.deny) & P.ViewChannel, P.ViewChannel, 'refus d\'@everyone non rétabli');
    const writes = writesSince(h, mark, /permissions/).filter((c) => !c.actor);
    assert.ok(writes.length >= 2 && writes.every((c) => c.method === 'PUT' || c.method === 'DELETE'), 'surcharges rétablies autrement que par PUT / DELETE exact');
    assert.ok(writesSince(h, mark, /^PUT \/channels\/\d+\/permissions\//).some((c) => !c.actor && c.body?.deny === String(P.ViewChannel)), 'PUT exact du refus d\'@everyone');
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }

  const m = await createHarness();
  try {
    m.configureAll();
    grant(m, 'mod', P.ManageChannels);
    setModules(m, { channelUpdate: { mode: 'max' } });
    await m.asHuman('mod').editChannel(IDS.channels.general, { topic: 'Sujet pirate' });
    await m.settle();
    assert.equal(m.fake.channels.get(IDS.channels.general).topic, 'Discussion générale', 'sujet non rétabli en « max »');
    assert.equal(incidents(m).length, 1);
    assert.equal(m.problemCount(), 0, m.formatProblems());
  } finally {
    await m.close();
  }
});

test('webhooks : suivi d\'un salon d\'annonces toléré en « on » ; webhook créé → supprimé ; en « max », le suivi est supprimé aussi', async () => {
  const h = await createHarness();
  try {
    h.configureAll();
    setModules(h, { webhook: { mode: 'on' } });
    const g = h.guild.id;
    const follow = await h.asHuman('admin').perform('POST', `/channels/${IDS.channels.announcements}/followers`, { webhook_channel_id: IDS.channels.general });
    await h.settle();
    assert.ok(h.fake.webhooks.has(follow.webhook_id), 'webhook de suivi supprimé en « on »');
    assert.equal(incidents(h).length, 0, 'suivi compté en « on »');
    const hook = await h.asHuman('admin').perform('POST', `/channels/${IDS.channels.general}/webhooks`, { name: 'spam' });
    await h.settle();
    assert.equal(h.fake.webhooks.has(hook.id), false, 'webhook non supprimé');
    assert.ok(h.fake.webhooks.has(follow.webhook_id));
    const [incident] = incidents(h);
    assert.deepEqual(incident.modules, ['webhook']);
    assert.equal(incident.undone, 1);
    assert.ok(h.fake.calls.some((c) => c.method === 'DELETE' && c.route === `/webhooks/${hook.id}` && !c.actor));
    assert.ok(!h.fake.members.get(IDS.users.admin).roles.includes(IDS.roles.admin));
    assert.ok(g);
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }

  const m = await createHarness();
  try {
    m.configureAll();
    setModules(m, { webhook: { mode: 'max' } });
    const follow = await m.asHuman('admin').perform('POST', `/channels/${IDS.channels.announcements}/followers`, { webhook_channel_id: IDS.channels.general });
    await m.settle();
    assert.equal(m.fake.webhooks.has(follow.webhook_id), false, 'suivi gardé en « max »');
    assert.equal(incidents(m).length, 1);
    assert.equal(m.problemCount(), 0, m.formatProblems());
  } finally {
    await m.close();
  }
});

test('serveur renommé et vérification baissée → rétablis ; URL personnalisée : alerte seule', async () => {
  const h = await createHarness();
  try {
    h.configureAll();
    setModules(h, { serverUpdate: { mode: 'on' } });
    const mark = h.fake.messageLog.length;
    await h.asHuman('admin').editGuild({ name: 'Serveur piraté', verification_level: 0, vanity_url_code: 'pirate' });
    await h.settle();
    assert.equal(h.fake.guild.name, 'Serveur de test', 'nom non rétabli');
    assert.equal(h.fake.guild.verification_level, 1, 'vérification non rétablie');
    assert.equal(h.guild.name, 'Serveur de test');
    const [incident] = incidents(h);
    assert.deepEqual(incident.modules, ['serverUpdate']);
    assert.match(incident.outcome, /Paramètres du serveur rétablis : nom, niveau de vérification/);
    assert.match(incident.outcome, /Alerte seule .*URL personnalisée/);
    const [card] = incidentCards(h, mark);
    assert.match(details(card), /URL personnalisée/);
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('icône du serveur changée : rétablie avec discordCdn injecté ; avec CDN_NETWORK=off, alerte seule', async () => {
  const saved = { http: cdn.transport.http };
  const fetched = [];
  cdn.transport.http = async (url) => {
    fetched.push(url);
    return { status: 200, ok: true, url, headers: new Headers({ 'content-type': 'image/png', 'content-length': String(PNG.length) }), body: PNG };
  };
  const OLD = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
  const run = async (network) => {
    const h = await createHarness();
    try {
      h.configureAll();
      h.client.config.cdnNetwork = network;
      h.fake.guild.icon = OLD;
      h.fake.dispatchNow('GUILD_UPDATE', { ...h.fake.guild, roles: [...h.fake.roles.values()] });
      setModules(h, { serverUpdate: { mode: 'on' } });
      const mark = h.fake.calls.length;
      await h.asHuman('admin').editGuild({ icon: `data:image/png;base64,${PNG.toString('base64')}AA==`.replace('AA==', '') });
      await h.settle();
      const restore = writesSince(h, mark, /^PATCH \/guilds\/\d+$/).filter((c) => !c.actor);
      const [incident] = incidents(h);
      assert.ok(incident, 'aucun incident');
      return { h, restore, incident };
    } catch (e) {
      await h.close();
      throw e;
    }
  };
  try {
    const on = await run(true);
    try {
      assert.equal(on.restore.length, 1, 'icône non rétablie');
      assert.match(on.restore[0].body.icon, /^data:image\/png;base64,/);
      assert.ok(fetched.some((u) => u.includes(`/icons/${on.h.guild.id}/${OLD}.png`)), `ancien hash non demandé au CDN : ${fetched.join(', ')}`);
      assert.equal(on.h.problemCount(), 0, on.h.formatProblems());
    } finally {
      await on.h.close();
    }
    fetched.length = 0;
    const off = await run(false);
    try {
      assert.equal(off.restore.length, 0, 'icône modifiée malgré CDN_NETWORK=off');
      assert.equal(fetched.length, 0);
      assert.match(off.incident.outcome, /icône non rétablie .*désactivé.*alerte seule/);
      assert.equal(off.h.problemCount(), 0, off.h.formatProblems());
    } finally {
      await off.h.close();
    }
  } finally {
    cdn.transport.http = saved.http;
  }
});

test('emojis et autocollant supprimés : alerte et sanction (CDN coupé) ; ré-upload au mieux avec discordCdn injecté', async () => {
  const seed = (h) => {
    h.fake.guild.emojis.push({ id: '900000000000000001', name: 'alpha', roles: [], require_colons: true, managed: false, animated: false, available: true }, { id: '900000000000000002', name: 'beta', roles: [], require_colons: true, managed: false, animated: false, available: true });
    h.fake.dispatchNow('GUILD_EMOJIS_UPDATE', { guild_id: h.guild.id, emojis: h.fake.guild.emojis });
    return h.fake.seedStickers([{ name: 'gadget_sticker', tags: 'gadget' }])[0];
  };
  const h = await createHarness();
  try {
    h.configureAll();
    setModules(h, { expressions: { mode: 'on' } });
    const sticker = seed(h);
    const g = h.guild.id;
    const mark = h.fake.messageLog.length;
    for (const id of [IDS.emoji, '900000000000000001', '900000000000000002']) await h.asHuman('admin').perform('DELETE', `/guilds/${g}/emojis/${id}`);
    await h.settle();
    const [incident] = incidents(h);
    assert.ok(incident, '3 emojis supprimés : aucun incident');
    assert.equal(incident.punishment, 'derank');
    assert.match(incident.outcome, /Emojis et autocollants : 0 ré-uploadé\(s\), 3 non restauré\(s\)/);
    assert.equal(incidentCards(h, mark).length, 1);
    assert.equal(h.fake.guild.emojis.length, 0);
    assert.ok(h.guild.stickers.cache.has(sticker.id), 'autocollant de départ absent du cache');
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }

  const saved = cdn.transport.http;
  cdn.transport.http = async (url) => ({ status: 200, ok: true, url, headers: new Headers({ 'content-type': 'image/png' }), body: PNG });
  const m = await createHarness();
  try {
    m.configureAll();
    m.client.config.cdnNetwork = true;
    setModules(m, { expressions: { mode: 'on' } });
    const sticker = seed(m);
    const g = m.guild.id;
    await m.asHuman('admin').perform('DELETE', `/guilds/${g}/emojis/900000000000000001`);
    await m.asHuman('admin').perform('DELETE', `/guilds/${g}/stickers/${sticker.id}`);
    await m.asHuman('admin').perform('DELETE', `/guilds/${g}/emojis/900000000000000002`);
    await m.settle();
    const [incident] = incidents(m);
    assert.ok(incident);
    assert.match(incident.outcome, /3 ré-uploadé\(s\)/, incident.outcome);
    assert.deepEqual(m.fake.guild.emojis.map((e) => e.name).sort(), ['alpha', 'beta', 'gadget']);
    assert.deepEqual(m.fake.guild.stickers.map((s) => s.name), ['gadget_sticker']);
    assert.equal(m.problemCount(), 0, m.formatProblems());
  } finally {
    cdn.transport.http = saved;
    await m.close();
  }
});

test('whitelist et owners : rien en « on » pour un whitelisté, annulé en « max » ; propriétaire jamais touché', async () => {
  const h = await createHarness();
  try {
    h.configureAll();
    grant(h, 'mod', P.ManageChannels);
    h.configure({ whitelist: { users: [IDS.users.mod] } });
    setModules(h, { channelCreate: { mode: 'on' } });
    const kept = await h.asHuman('mod').createChannel('salon-legitime');
    await h.settle();
    assert.ok(h.fake.channels.has(kept.id), 'salon d\'un whitelisté supprimé en « on »');
    assert.equal(incidents(h).length, 0);
    setModules(h, { channelCreate: { mode: 'max' } });
    const owned = await h.asHuman('owner').createChannel('salon-du-proprietaire');
    await h.settle();
    assert.ok(h.fake.channels.has(owned.id), 'salon du propriétaire supprimé');
    assert.equal(incidents(h).length, 0, 'propriétaire sanctionné');
    const removed = await h.asHuman('mod').createChannel('salon-en-max');
    await h.settle();
    assert.equal(h.fake.channels.has(removed.id), false, 'salon d\'un whitelisté gardé en « max »');
    assert.equal(incidents(h).length, 1);
    assert.ok(!h.fake.members.get(IDS.users.mod).roles.includes(IDS.roles.mod));
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('aucun faux positif : actions du bot lui-même et restauration /backup, tous les modules en « max »', async () => {
  const h = await createHarness();
  try {
    h.configureAll();
    const all = Object.fromEntries(h.client.services.secur.registry.keys().map((k) => [k, { mode: 'max' }]));
    setModules(h, all);
    const g = h.guild;
    const { id } = h.client.services.backup.create(g, h.member('admin').user, 'avant');
    await g.channels.cache.get(IDS.channels.rules).delete('test');
    await g.roles.cache.get(IDS.roles.gamer).delete('test');
    await g.channels.create({ name: 'bot-salon' });
    await g.channels.cache.get(IDS.channels.general).edit({ name: 'renomme-par-le-bot' });
    await h.settle();
    await h.client.services.backup.restore(g, id, { syncPermissions: true });
    await h.settle();
    assert.equal(incidents(h).length, 0, 'incident sur une action du bot ou une restauration /backup');
    assert.ok(channelNamed(h, 'règles', 0), 'restauration /backup incomplète');
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});
