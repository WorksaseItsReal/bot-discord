'use strict';

/**
 * Revue n° 6, lot « serveur », bout en bout (vrai discord.js, faux Discord) : restauration de
 * sauvegarde (homonymes, surcharges de membres hors cache), rôles temporaires, /activite,
 * /statistiques, /serverinfo, /voice, vocaux temporaires, /emoji, automatisations, boutique,
 * flux RSS et /jeu.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { ChannelType, PermissionFlagsBits: P, OverwriteType } = require('discord.js');
const { createHarness, IDS } = require('./harness');

const opt = (name, type, value) => ({ name, type, value });
const sub = (name, options = []) => [{ name, type: 1, options }];
const embedText = (m) => (m?.embeds ?? []).flatMap((e) => [e.title, e.description, ...(e.fields ?? []).flatMap((f) => `${f.name}: ${f.value}`)]).filter(Boolean).join(' | ');

async function setup(opts) {
  const h = await createHarness(opts);
  h.configureAll();
  h.configure({ antiraid: { enabled: false } });
  return h;
}

const sees = (h, userId, channelId) => (BigInt(h.permissionsIn(userId, channelId)) & P.ViewChannel) !== 0n;

/* ------------------------------------------------------------------ */
/* R86 : restauration associée par identifiant, jamais par homonyme     */
/* ------------------------------------------------------------------ */

test('R86 : après un raid, « /backup restore permissions » recrée le salon public sans ouvrir son homonyme du staff', async () => {
  const h = await setup();
  try {
    const g = h.guild;
    const staffOw = [{ id: g.id, type: OverwriteType.Role, deny: P.ViewChannel }, { id: IDS.roles.mod, type: OverwriteType.Role, allow: P.ViewChannel }];
    const commu = await g.channels.create({ name: 'Communauté', type: ChannelType.GuildCategory, position: 3 });
    const staffCat = await g.channels.create({ name: 'Staff', type: ChannelType.GuildCategory, position: 4, permissionOverwrites: staffOw });
    const pub = await g.channels.create({ name: 'discussion', type: ChannelType.GuildText, parent: commu.id, position: 10, permissionOverwrites: [] });
    const priv = await g.channels.create({ name: 'discussion', type: ChannelType.GuildText, parent: staffCat.id, position: 11, permissionOverwrites: staffOw });
    await h.settle();
    assert.equal(sees(h, IDS.users.member, priv.id), false);

    const { id } = h.client.services.backup.create(g, h.client.users.cache.get(IDS.users.admin), 'avant raid');
    await pub.delete();
    await h.settle();

    const rec = await h.slash('backup', sub('restore', [opt('id', 3, id), opt('permissions', 5, true)]));
    const go = await h.confirm(rec);
    await h.settle();
    const result = [...h.messagesOf(rec), ...h.messagesOf(go)].map(embedText).filter((t) => /Restauration/.test(t)).join('\n');
    assert.match(result, /Salons recréés: \*\*1\*\*/, result);

    const inCommu = [...h.fake.channels.values()].filter((c) => c.parent_id === commu.id && c.name === 'discussion');
    assert.equal(inCommu.length, 1, 'le salon public supprimé n\'a pas été recréé dans sa catégorie');
    assert.equal(sees(h, IDS.users.member, priv.id), false, 'le salon privé du staff est devenu visible par tous');
    assert.equal(h.fake.channels.get(priv.id).permission_overwrites.length, 2);
  } finally {
    await h.close();
  }
});

test('R86 : « Restaurer + permissions » sans changement n\'échange pas les permissions de deux vocaux homonymes', async () => {
  const h = await setup();
  try {
    const g = h.guild;
    const staffOw = [{ id: g.id, type: OverwriteType.Role, deny: P.ViewChannel }, { id: IDS.roles.mod, type: OverwriteType.Role, allow: P.ViewChannel }];
    const commu = await g.channels.create({ name: 'Communauté', type: ChannelType.GuildCategory, position: 5 });
    const pub = await g.channels.create({ name: 'vocal', type: ChannelType.GuildVoice, parent: commu.id, position: 9, permissionOverwrites: [] });
    const staffCat = await g.channels.create({ name: 'Staff', type: ChannelType.GuildCategory, position: 0, permissionOverwrites: staffOw });
    const priv = await g.channels.create({ name: 'vocal', type: ChannelType.GuildVoice, parent: staffCat.id, position: 0, permissionOverwrites: staffOw });
    await h.settle();

    const { id } = h.client.services.backup.create(g, h.client.users.cache.get(IDS.users.admin), 'instantané');
    const info = await h.slash('backup', sub('info', [opt('id', 3, id)]));
    const click = await h.click(h.message(info.original), `cmd:backup:restore:${id}:perms`);
    await h.confirm(click);
    await h.settle();
    assert.equal(sees(h, IDS.users.member, pub.id), true, 'le vocal public est devenu invisible');
    assert.equal(sees(h, IDS.users.member, priv.id), false, 'le vocal du staff est devenu visible par tous');
    const card = h.messagesOf(click).flatMap((m) => m.embeds ?? []).find((e) => /Restauration/.test(e.title ?? ''));
    assert.match(card?.description ?? '', /Rien à recréer/);
  } finally {
    await h.close();
  }
});

test('R86 : la surcharge d\'un rôle reste attachée au même rôle malgré un homonyme', async () => {
  const h = await setup();
  try {
    const g = h.guild;
    const cosmetic = await g.roles.create({ name: 'Équipe', permissions: 0n });
    const staff = await g.roles.create({ name: 'Équipe', permissions: 0n });
    await h.settle();
    await g.members.cache.get(IDS.users.member).roles.add(cosmetic.id);
    await g.members.cache.get(IDS.users.mod).roles.add(staff.id);
    const priv = await g.channels.create({ name: 'coulisses', type: ChannelType.GuildText,
      permissionOverwrites: [{ id: g.id, type: OverwriteType.Role, deny: P.ViewChannel }, { id: staff.id, type: OverwriteType.Role, allow: P.ViewChannel }] });
    await h.settle();
    const svc = h.client.services.backup;
    const { id } = svc.create(g, h.client.users.cache.get(IDS.users.admin), 'instantané');
    const res = await svc.restore(g, id, { syncPermissions: true });
    await h.settle();
    assert.equal(res.permissionsSynced, 0);
    assert.equal(sees(h, IDS.users.member, priv.id), false, 'accès transféré au rôle cosmétique homonyme');
    assert.equal(sees(h, IDS.users.mod, priv.id), true);
  } finally {
    await h.close();
  }
});

test('R86 : un rôle supprimé est recréé même si un homonyme existe, et sa surcharge le suit', async () => {
  const h = await setup();
  try {
    const g = h.guild;
    const cosmetic = await g.roles.create({ name: 'Équipe', permissions: 0n });
    const staff = await g.roles.create({ name: 'Équipe', permissions: 0n });
    await h.settle();
    await g.members.cache.get(IDS.users.member).roles.add(cosmetic.id);
    const priv = await g.channels.create({ name: 'coulisses', type: ChannelType.GuildText,
      permissionOverwrites: [{ id: g.id, type: OverwriteType.Role, deny: P.ViewChannel }, { id: staff.id, type: OverwriteType.Role, allow: P.ViewChannel }] });
    await h.settle();
    const svc = h.client.services.backup;
    const { id } = svc.create(g, h.client.users.cache.get(IDS.users.admin), 'instantané');
    await staff.delete();
    await priv.delete();
    await h.settle();
    const res = await svc.restore(g, id, { syncPermissions: true });
    await h.settle();
    assert.equal(res.roles, 1, 'le rôle supprimé n\'a pas été recréé');
    const equipe = [...g.roles.cache.values()].filter((r) => r.name === 'Équipe');
    assert.equal(equipe.length, 2);
    const recreated = equipe.find((r) => r.id !== cosmetic.id);
    const chan = g.channels.cache.find((c) => c.name === 'coulisses');
    assert.ok(chan, 'salon non recréé');
    assert.ok(chan.permissionOverwrites.cache.has(recreated.id), 'la surcharge ne suit pas le rôle recréé');
    assert.equal(chan.permissionOverwrites.cache.has(cosmetic.id), false, 'surcharge donnée au rôle homonyme');
  } finally {
    await h.close();
  }
});

test('R86 : sauvegarde ancienne (sans identifiants) et homonymes : rien n\'est choisi au hasard, « à vérifier »', async () => {
  const h = await setup();
  try {
    const g = h.guild;
    const staffOw = [{ id: g.id, type: OverwriteType.Role, deny: P.ViewChannel }];
    const cat = await g.channels.create({ name: 'Salons', type: ChannelType.GuildCategory });
    const a = await g.channels.create({ name: 'bavardage', type: ChannelType.GuildText, parent: cat.id, permissionOverwrites: [] });
    const b = await g.channels.create({ name: 'bavardage', type: ChannelType.GuildText, parent: cat.id, permissionOverwrites: staffOw });
    await h.settle();
    const svc = h.client.services.backup;
    const { id } = svc.create(g, h.client.users.cache.get(IDS.users.admin), 'ancienne');
    // Format ancien : ni identifiants de salons, ni de catégories, ni de rôles.
    const row = h.client.database.db.prepare('SELECT data FROM backups WHERE id = ?').get(id);
    const data = JSON.parse(row.data);
    for (const c of data.channels) {
      delete c.id;
      delete c.parentId;
      for (const o of c.overwrites) delete o.roleId;
    }
    for (const r of data.roles) delete r.id;
    h.client.database.db.prepare('UPDATE backups SET data = ? WHERE id = ?').run(JSON.stringify(data), id);
    const res = await svc.restore(g, id, { syncPermissions: true });
    await h.settle();
    assert.equal(sees(h, IDS.users.member, a.id), true);
    assert.equal(sees(h, IDS.users.member, b.id), false);
    assert.ok(res.ambiguous.includes('#bavardage'), JSON.stringify(res));
    const card = require('../../src/commands/configuration/backup').restoreResultCard({ id, name: 'ancienne' }, res);
    assert.match(JSON.stringify(card.toJSON()), /Homonymes/);
  } finally {
    await h.close();
  }
});

/* ------------------------------------------------------------------ */
/* R87 : surcharges de membres hors cache                               */
/* ------------------------------------------------------------------ */

test('R87 : « Restaurer + permissions » garde la surcharge d\'un membre absent du cache', async () => {
  const h = await setup();
  try {
    const g = h.guild;
    await g.channels.cache.get(IDS.channels.staff).permissionOverwrites.edit(IDS.users.member, { ViewChannel: true }, { type: OverwriteType.Member });
    await h.settle();
    const has = () => g.channels.cache.get(IDS.channels.staff).permissionOverwrites.cache.has(IDS.users.member);
    assert.equal(has(), true);
    const backup = h.client.services.backup;
    const { id } = backup.create(g, h.member('admin').user, 'sauvegarde');
    g.members.cache.delete(IDS.users.member); // toujours sur le serveur, simplement hors cache
    const res = await backup.restore(g, id, { syncPermissions: true });
    await h.settle();
    assert.equal(has(), true, 'surcharge du membre supprimée');
    assert.deepEqual(res.skippedOverwrites, []);
  } finally {
    await h.close();
  }
});

test('R87 : erreur passagère en relisant un membre : sa surcharge actuelle est conservée', async () => {
  const h = await setup();
  try {
    const g = h.guild;
    await g.channels.cache.get(IDS.channels.staff).permissionOverwrites.edit(IDS.users.member, { ViewChannel: true }, { type: OverwriteType.Member });
    await h.settle();
    const backup = h.client.services.backup;
    const { id } = backup.create(g, h.member('admin').user, 'sauvegarde');
    // Depuis la sauvegarde, le staff a aussi ouvert le salon au rôle Modérateur… et le membre est hors cache.
    await g.channels.cache.get(IDS.channels.staff).permissionOverwrites.edit(IDS.roles.everyone, { AddReactions: false });
    await h.settle();
    g.members.cache.delete(IDS.users.member);
    h.fake.inject({ method: 'GET', route: new RegExp(`/members/${IDS.users.member}$`) }, { status: 503, code: 0, times: 5 });
    await backup.restore(g, id, { syncPermissions: true });
    await h.settle();
    assert.equal(g.channels.cache.get(IDS.channels.staff).permissionOverwrites.cache.has(IDS.users.member), true, 'surcharge effacée sur une erreur passagère');
  } finally {
    await h.close();
  }
});

test('R87 : un membre réellement parti (10007) : surcharge ignorée et signalée', async () => {
  const h = await setup();
  try {
    const g = h.guild;
    const ghost = h.addUser('fantome', { ageDays: 500 });
    const backup = h.client.services.backup;
    const { id } = backup.create(g, h.member('admin').user, 'sauvegarde');
    const row = h.client.database.db.prepare('SELECT data FROM backups WHERE id = ?').get(id);
    const data = JSON.parse(row.data);
    const staff = data.channels.find((c) => c.name === g.channels.cache.get(IDS.channels.staff).name);
    staff.overwrites.push({ allow: String(P.ViewChannel), deny: '0', member: ghost.id });
    h.client.database.db.prepare('UPDATE backups SET data = ? WHERE id = ?').run(JSON.stringify(data), id);
    const res = await backup.restore(g, id, { syncPermissions: true });
    await h.settle();
    assert.ok(res.skippedOverwrites.includes(`membre ${ghost.id}`), JSON.stringify(res.skippedOverwrites));
  } finally {
    await h.close();
  }
});

/* ------------------------------------------------------------------ */
/* R102 : rôle vocal / boost devenu sensible toujours retiré            */
/* ------------------------------------------------------------------ */

const memberRoles = (h, as) => h.fake.members.get(IDS.users[as] ?? as)?.roles ?? [];
async function openAutomations(h, view, as = 'admin') {
  const rec = await h.slash('automatisations', [], { as });
  return h.click(h.messagesOf(rec)[0], 'cmd:automatisations:nav', { values: [view], as });
}
/** Surcharge sur #général : le rôle peut mentionner @everyone (il devient « sensible »). */
async function makeSensitive(h, roleId) {
  const ch = h.fake.channels.get(IDS.channels.general);
  ch.permission_overwrites = [...ch.permission_overwrites, { id: roleId, type: 0, allow: String(P.MentionEveryone), deny: '0' }];
  h.fake.dispatchNow('CHANNEL_UPDATE', ch, 'surcharge sensible');
  await h.settle();
}

test('R102 : rôle vocal devenu sensible : plus donné, mais toujours retiré à la déconnexion et à la désactivation', async () => {
  const h = await setup();
  try {
    const temp = IDS.roles.temp;
    const view = await openAutomations(h, 'voice');
    const global = await h.click(h.messagesOf(view)[0], 'cmd:automatisations:vrrole', { values: [temp] });
    await h.click(h.messagesOf(global)[0], 'cmd:automatisations:toggle:voice:on:voice');
    await h.voice('member', 'voice');
    await h.settle();
    assert.ok(memberRoles(h, 'member').includes(temp));
    await makeSensitive(h, temp);
    await h.voice('member', null);
    await h.settle();
    assert.equal(memberRoles(h, 'member').includes(temp), false, 'rôle sensible conservé hors vocal');
    // Plus jamais donné tant qu'il est sensible.
    await h.voice('member', 'voice');
    await h.settle();
    assert.equal(memberRoles(h, 'member').includes(temp), false, 'rôle sensible attribué');
  } finally {
    await h.close();
  }
});

test('R102 : désactivation du rôle vocal : un rôle devenu sensible est retiré aux porteurs', async () => {
  const h = await setup();
  try {
    const temp = IDS.roles.temp;
    const view = await openAutomations(h, 'voice');
    const global = await h.click(h.messagesOf(view)[0], 'cmd:automatisations:vrrole', { values: [temp] });
    await h.click(h.messagesOf(global)[0], 'cmd:automatisations:toggle:voice:on:voice');
    await h.voice('member', 'voice');
    await h.settle();
    assert.ok(memberRoles(h, 'member').includes(temp));
    await makeSensitive(h, temp);
    const v2 = await openAutomations(h, 'voice');
    await h.click(h.messagesOf(v2)[0], 'cmd:automatisations:toggle:voice:off:voice');
    await h.settle();
    assert.equal(memberRoles(h, 'member').includes(temp), false, 'rôle sensible conservé après désactivation');
  } finally {
    await h.close();
  }
});

test('R102 : fin de boost : le rôle de remerciement devenu sensible est retiré', async () => {
  const h = await setup();
  try {
    const temp = IDS.roles.temp;
    h.configure({ automations: { boost: { enabled: true, roleId: temp, channelId: null } } });
    const svc = h.client.services.automations;
    const member = h.guild.members.cache.get(IDS.users.member);
    await member.roles.add(temp);
    await h.settle();
    await makeSensitive(h, temp);
    const fresh = h.guild.members.cache.get(IDS.users.member);
    const before = Object.create(fresh);
    Object.defineProperty(before, 'premiumSinceTimestamp', { value: Date.now() - 1000 });
    Object.defineProperty(before, 'premiumSince', { value: new Date(Date.now() - 1000) });
    await svc.handleMemberUpdate(before, fresh);
    await h.settle();
    assert.equal(memberRoles(h, 'member').includes(temp), false, 'rôle de boost sensible conservé après la fin du boost');
  } finally {
    await h.close();
  }
});
