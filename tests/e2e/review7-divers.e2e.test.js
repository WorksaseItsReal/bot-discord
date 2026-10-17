'use strict';

/**
 * Revue n° 7, bout en bout (vrai discord.js, faux Discord) : lot « divers » — mode strict au
 * niveau de l'action (S29), protection par rang de /activite, /role et /pseudo (S30, S31),
 * formulaire de /embed délégué (S32), /channel renouveler et alertes de mots-clés (S41), rôle
 * soutien avec un cache froid (S44), présence après une nouvelle IDENTIFY (S45).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { ActivityType, PermissionFlagsBits: P } = require('discord.js');
const { createHarness, IDS } = require('./harness');
const { rawMember } = require('./lib/fixtures');
const { DAY } = require('./lib/ids');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const opt = (name, type, value) => ({ name, type, value });
const sub = (name, options = []) => [{ name, type: 1, options }];
const buttonsOf = (m) => (m?.components ?? []).flatMap((r) => r.components ?? []);
const btn = (m, prefix) => buttonsOf(m).find((c) => c.custom_id?.startsWith(prefix)) ?? null;
const perm = (h, name, options, as = 'owner') => h.slash('permissions', sub(name, options), { as });
const assign = (h, name, n, as = 'owner') => perm(h, 'commande', [opt('nom', 3, name), opt('niveau', 4, n)], as);
const level = (h, n, action, roleId, as = 'owner') => perm(h, 'niveau', [opt('numero', 4, n), opt('action', 3, action), opt('role', 8, roleId)], as);
const nick = (h, id) => h.fake.members.get(id)?.nick ?? null;

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

// ------------------------------------------------------------------ S30 : /activite et /role

test('S30 /activite expulser : un owner de sécurité (rang 4) et un niveau 3 que /kick refuse sont protégés', async () => {
  const h = await createHarness();
  try {
    h.configureAll();
    h.configure({ moderation: { confirmDangerous: false } });
    h.client.repositories.activity.setSince(h.guild.id, Date.now() - 60 * DAY);
    const add = (name) => {
      const user = h.addUser(name, { ageDays: 500 });
      const raw = rawMember(user, [], 100);
      h.fake.members.set(user.id, raw);
      h.guild.members._add(JSON.parse(JSON.stringify(raw)));
      return user.id;
    };
    const owner4 = add('OwnerSecu');
    const lvl3 = add('Veteran');
    const plain = add('Dormeur');
    h.configure({ secur: { owners: [owner4] }, permissions: { levels: { l3: { roles: [IDS.roles.temp] } } } });
    await h.asHuman('owner').addRole(lvl3, IDS.roles.temp);
    const modPerms = BigInt(h.fake.roles.get(IDS.roles.mod).permissions);
    await h.asHuman('owner').editRole(IDS.roles.mod, { permissions: String(modPerms | P.ManageGuild) });
    const svc = h.client.services.permissions;
    assert.equal(svc.rankOf(h.member(owner4)), 4);
    assert.equal(svc.rankOf(h.member(lvl3)), 3);
    assert.equal(svc.rankOf(h.member('mod')), 0);
    assert.ok(h.isError(await h.slash('kick', [opt('membre', 6, owner4)], { as: 'mod' })));
    assert.ok(h.isError(await h.slash('kick', [opt('membre', 6, lvl3)], { as: 'mod' })));

    const list = h.messagesOf(await h.slash('activite', [opt('jours', 4, 30)], { as: 'mod' }))[0];
    const ask = await h.click(list, 'cmd:activite:act:30:kick', { as: 'mod' });
    const kf = btn(h.messagesOf(ask)[0], 'cmd:activite:kickform:30:');
    assert.ok(kf, h.replyText(ask));
    const form = await h.click(h.messagesOf(ask)[0], kf.custom_id, { as: 'mod' });
    await h.submitModal(form, { confirmation: 'EXPULSER', raison: 'ménage' }, { as: 'mod' });
    await h.settle();
    assert.ok(h.fake.members.has(owner4), 'owner de sécurité resté sur le serveur');
    assert.ok(h.fake.members.has(lvl3), 'niveau 3 resté sur le serveur');
    assert.ok(!h.fake.members.has(plain), 'témoin : membre inactif ordinaire expulsé');
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('S30 /role remove et bouton « Retirer » : refusés sur un owner de sécurité, comme /derank', async () => {
  const h = await createHarness();
  try {
    h.configureAll();
    h.configure({ moderation: { confirmDangerous: false }, secur: { owners: [IDS.users.member] } });
    const svc = h.client.services.permissions;
    assert.equal(svc.rankOf(h.member('member')), 4);
    assert.ok(h.isError(await h.slash('derank', [opt('membre', 6, IDS.users.member)], { as: 'admin' })));
    const removed = await h.slash('role', sub('remove', [opt('membre', 6, IDS.users.member), opt('role', 8, IDS.roles.gamer)]), { as: 'admin' });
    assert.ok(h.isError(removed), h.replyText(removed));
    assert.match(h.replyText(removed), /owner de sécurité/);
    assert.ok(h.fake.members.get(IDS.users.member).roles.includes(IDS.roles.gamer));
    // Bouton « Retirer » (cmd:role:take) d'une carte « Rôle ajouté » (ajouter reste permis).
    const added = await h.slash('role', sub('add', [opt('membre', 6, IDS.users.member), opt('role', 8, IDS.roles.notif)]), { as: 'admin' });
    assert.ok(!h.isError(added), h.replyText(added));
    const card = h.messagesOf(added)[0];
    const take = btn(card, 'cmd:role:take:');
    assert.ok(take);
    const clicked = await h.click(card, take.custom_id, { as: 'admin' });
    assert.ok(h.isError(clicked), h.replyText(clicked));
    assert.ok(h.fake.members.get(IDS.users.member).roles.includes(IDS.roles.notif));
    // Témoin : le propriétaire (rang 5) peut retirer le rôle.
    const own = await h.slash('role', sub('remove', [opt('membre', 6, IDS.users.member), opt('role', 8, IDS.roles.gamer)]), { as: 'owner' });
    assert.ok(!h.isError(own), h.replyText(own));
    assert.ok(!h.fake.members.get(IDS.users.member).roles.includes(IDS.roles.gamer));
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

// ------------------------------------------------------------------ S31 : /pseudo délégué

async function pseudoSetup() {
  const h = await createHarness();
  h.configureAll();
  h.configure({ antiraid: { enabled: false } });
  assert.ok(!h.isError(await level(h, 1, 'ajouter', IDS.roles.gamer, 'admin')));
  assert.ok(!h.isError(await assign(h, 'pseudo', 1, 'admin')));
  const perms = BigInt(h.permissionsIn(IDS.users.member, IDS.channels.general));
  assert.ok(!(perms & P.ManageNicknames) && !(perms & P.ModerateMembers), 'member : ni Gérer les pseudos ni staff');
  return h;
}

test('S31 /pseudo délégué : un niveau 1 ne renomme ni un owner de sécurité ni un niveau 3 (cible protégée par rang)', async () => {
  let h = await pseudoSetup();
  try {
    h.configure({ secur: { owners: [IDS.users.target] } });
    const rec = await h.slash('pseudo', [opt('membre', 6, IDS.users.target), opt('pseudo', 3, 'Arnaqueur')], { as: 'member' });
    assert.ok(h.isError(rec), h.replyText(rec));
    assert.match(h.replyText(rec), /owner de sécurité/);
    assert.equal(nick(h, IDS.users.target), null);
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
  h = await pseudoSetup();
  try {
    assert.ok(!h.isError(await level(h, 3, 'ajouter', IDS.roles.temp, 'admin')));
    await h.asHuman('owner').addRole('target', IDS.roles.temp);
    assert.equal(h.client.services.permissions.rankOf(h.member('target')), 3);
    const rec = await h.slash('pseudo', [opt('membre', 6, IDS.users.target), opt('pseudo', 3, 'Escroc')], { as: 'member' });
    assert.ok(h.isError(rec), h.replyText(rec));
    assert.match(h.replyText(rec), /niveau de permissions \(3\)/);
    assert.equal(nick(h, IDS.users.target), null);
    // Témoin : le délégué se renomme lui-même.
    const ok = await h.slash('pseudo', [opt('membre', 6, IDS.users.member), opt('pseudo', 3, 'Bob')], { as: 'member' });
    assert.ok(!h.isError(ok), h.replyText(ok));
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('S31 /pseudo délégué : le filtre des pseudos de l\'AutoMod s\'applique avant le renommage (mot interdit, usurpation du staff)', async () => {
  const h = await pseudoSetup();
  try {
    const words = h.client.services.config.get(h.guild.id).automod.filters.badWords?.words ?? [];
    assert.ok(h.client.services.config.get(h.guild.id).automod.filters.badNames?.enabled);
    const bad = words[0];
    assert.ok(bad, 'un mot interdit configuré');
    let rec = await h.slash('pseudo', [opt('membre', 6, IDS.users.member), opt('pseudo', 3, `Bob ${bad}`)], { as: 'member' });
    assert.ok(h.isError(rec), h.replyText(rec));
    assert.match(h.replyText(rec), /Pseudo refusé/);
    assert.equal(nick(h, IDS.users.member), null);
    rec = await h.slash('pseudo', [opt('membre', 6, IDS.users.target), opt('pseudo', 3, `Gros ${bad}`)], { as: 'member' });
    assert.ok(h.isError(rec), h.replyText(rec));
    assert.equal(nick(h, IDS.users.target), null);
    // Usurpation : le nom affiché du modérateur.
    const modName = h.member('mod').displayName;
    rec = await h.slash('pseudo', [opt('membre', 6, IDS.users.member), opt('pseudo', 3, modName)], { as: 'member' });
    assert.ok(h.isError(rec), h.replyText(rec));
    assert.match(h.replyText(rec), /staff/);
    assert.equal(nick(h, IDS.users.member), null);
    // Témoin : un pseudo correct passe ; un modérateur (staff) garde la main sur le filtre.
    rec = await h.slash('pseudo', [opt('membre', 6, IDS.users.member), opt('pseudo', 3, 'Bob')], { as: 'member' });
    assert.ok(!h.isError(rec), h.replyText(rec));
    assert.equal(nick(h, IDS.users.member), 'Bob');
    rec = await h.slash('pseudo', [opt('membre', 6, IDS.users.target), opt('pseudo', 3, `Gros ${bad}`)], { as: 'mod' });
    assert.ok(!h.isError(rec), h.replyText(rec));
    assert.equal(nick(h, IDS.users.target), `Gros ${bad}`);
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

// ------------------------------------------------------------------ S32 : /embed create délégué

test('S32 /embed create délégué : la soumission du formulaire honore la délégation (embed publié)', async () => {
  const h = await createHarness();
  try {
    h.configureAll();
    assert.ok(!h.isError(await level(h, 1, 'ajouter', IDS.roles.gamer, 'admin')));
    assert.ok(!h.isError(await assign(h, 'embed', 1, 'admin')));
    const perms = BigInt(h.permissionsIn(IDS.users.member, IDS.channels.general));
    assert.ok(!(perms & P.ManageMessages), 'member : pas « Gérer les messages » natif');
    const rec = await h.slash('embed', sub('create'), { as: 'member' });
    assert.equal(rec.modals.length, 1);
    const mark = h.fake.messageLog.length;
    const submit = await h.submitModal(rec, { title: 'Annonce', description: 'Bonjour à tous', color: '', image: '' }, { as: 'member' });
    assert.ok(!h.isError(submit), h.replyText(submit));
    const posted = h.fake.messageLog.slice(mark).map((id) => h.message(id)).find((m) => m?.embeds?.[0]?.title === 'Annonce');
    assert.ok(posted, 'embed publié');
    // Délégation retirée entre l'ouverture et la soumission : refus.
    const again = await h.slash('embed', sub('create'), { as: 'member' });
    assert.ok(!h.isError(await assign(h, 'embed', 0, 'admin')));
    const refused = await h.submitModal(again, { title: 'Encore', description: 'Bonjour', color: '', image: '' }, { as: 'member' });
    assert.ok(h.isError(refused), h.replyText(refused));
    // Mode strict : /embed réservé au niveau 2, un modérateur (rang 0, permission native) est refusé.
    assert.ok(!h.isError(await assign(h, 'embed', 2, 'admin')));
    const modForm = await h.slash('embed', sub('create'), { as: 'mod' });
    assert.equal(modForm.modals.length, 1);
    h.configure({ permissions: { strict: true } });
    const strict = await h.submitModal(modForm, { title: 'Strict', description: 'Bonjour', color: '', image: '' }, { as: 'mod' });
    assert.ok(h.isError(strict), h.replyText(strict));
    assert.match(h.replyText(strict), /niveau 2/);
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

// ------------------------------------------------------------------ S41 : /channel renouveler et alertes

test('S41 /channel renouveler : le salon bloqué des alertes de mots-clés suit le salon (base, bilan et index en mémoire)', async () => {
  const h = await createHarness();
  try {
    h.configureAll();
    h.configure({ automod: { enabled: false } });
    const hl = h.client.services.highlights;
    hl.delayMs = 5;
    const old = IDS.channels.general;
    hl.addWord(h.guild.id, IDS.users.member, 'gadget');
    hl.setBlockedChannels(h.guild.id, IDS.users.member, [old]);
    hl.index(h.guild.id); // index en mémoire déjà construit (bot démarré depuis longtemps)
    const rec = await h.slash('channel', [{ name: 'renouveler', type: 1, options: [{ name: 'salon', type: 7, value: old }] }], { as: 'admin', channel: 'staff' });
    const [plan] = h.messagesOf(rec);
    assert.match(JSON.stringify(plan.embeds), /Alertes de mots-clés/, 'bilan : report annoncé');
    const button = btn(plan, 'cmd:channel:renewform:');
    const form = await h.click(plan, button.custom_id, { as: 'admin' });
    const done = await h.submitModal(form, { confirmation: 'RENOUVELER' }, { as: 'admin' });
    assert.ok(!h.isError(done), h.replyText(done));
    const created = [...h.guild.channels.cache.values()].find((c) => c.name === 'général' && c.id !== old) ?? [...h.guild.channels.cache.values()].find((c) => c.id !== old && c.name === h.fake.channels.get(old)?.name);
    assert.ok(created, 'copie créée');
    assert.ok(!h.fake.channels.has(old), 'original supprimé');
    assert.deepEqual(h.client.repositories.highlights.get(h.guild.id, IDS.users.member).blockedChannels, [created.id]);
    // Un message avec le mot-clé dans la copie : aucune alerte pour le membre qui avait bloqué le salon.
    const dmsBefore = h.fake.messageLog.length;
    await h.userMessage({ as: 'target', channel: created.id, content: 'quelqu\'un a vu le gadget ?' });
    await sleep(60);
    await h.settle();
    const dm = [...h.fake.dms.values()].find((d) => d.recipients[0].id === IDS.users.member);
    const alerted = Boolean(dm && h.fake.messageLog.slice(dmsBefore).some((id) => h.message(id)?.channel_id === dm.id));
    assert.equal(alerted, false, 'alerte envoyée depuis le salon bloqué renouvelé');
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});
