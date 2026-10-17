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

/* ------------------------------------------------------------------ */
/* R111 : « Tout effacer » acquitté avant la suppression                */
/* ------------------------------------------------------------------ */

test('R111 : « Oui, tout effacer » acquitte (deferUpdate) avant de supprimer, puis affiche le résultat', async () => {
  const h = await setup();
  try {
    await h.userMessage({ as: 'member', content: 'Bonjour' });
    h.client.services.activity.flush();
    const rec = await h.slash('statistiques', [], { as: 'admin' });
    const settings = await h.click(h.messagesOf(rec)[0], 'cmd:statistiques:nav', { values: ['reglages'] });
    const view = await h.click(h.messagesOf(settings)[0], 'cmd:statistiques:go:wipe:30');
    const wipe = await h.click(h.messagesOf(view)[0], 'cmd:statistiques:wipe');
    await h.settle();
    assert.equal(wipe.ackType, 6, `acquittement attendu avant la suppression (type ${wipe.ackType})`);
    assert.match(JSON.stringify(h.messagesOf(wipe).map((m) => m.embeds)), /Statistiques effacées/);
    assert.equal(h.client.repositories.activity.totals(h.guild.id, '2000-01-01').messages, 0);
  } finally {
    await h.close();
  }
});

/* ------------------------------------------------------------------ */
/* R6 / R96 : /emoji                                                    */
/* ------------------------------------------------------------------ */

test('R6 : /emoji renommer acquitte avant d\'appeler Discord (limite de débit sur la route des emojis)', async () => {
  const h = await setup();
  try {
    h.fake.inject({ method: 'PATCH', route: /^\/guilds\/\d+\/emojis\/\d+$/ }, { status: 429, retryAfter: 400, times: 1 });
    const rec = await h.slash('emoji', sub('renommer', [opt('emoji', 3, 'gadget'), opt('nom', 3, 'gadget_lent')]));
    await h.settle();
    assert.ok(rec.ackedAt != null);
    assert.ok(rec.ackedAt - rec.createdAt < 300, `acquittée après ${rec.ackedAt - rec.createdAt} ms (après l'appel à Discord)`);
    assert.equal(rec.ackType, 5);
    assert.match(h.replyText(rec), /Emoji renommé/);
    assert.equal(h.guild.emojis.cache.get(IDS.emoji).name, 'gadget_lent');
  } finally {
    await h.close();
  }
});

test('R96 : /emoji info ne révèle pas le nom d\'un autre serveur du bot dont l\'auteur n\'est pas membre', async () => {
  const h = await setup();
  try {
    const secretGuild = '990000000000000001';
    const secretEmoji = '990000000000000002';
    h.client.guilds._add({ id: secretGuild, name: 'Serveur très secret', features: [], roles: [], channels: [], members: [],
      emojis: [{ id: secretEmoji, name: 'secret', roles: [], require_colons: true, managed: false, animated: false, available: true }] });
    const rec = await h.slash('emoji', sub('info', [opt('emoji', 3, `<:secret:${secretEmoji}>`)]), { as: 'member' });
    assert.doesNotMatch(h.replyText(rec), /Serveur très secret/, 'nom d\'un serveur privé révélé');
    // Emoji du serveur courant : origine affichée.
    const own = await h.slash('emoji', sub('info', [opt('emoji', 3, `<:gadget:${IDS.emoji}>`)]), { as: 'member' });
    assert.match(h.replyText(own), new RegExp(h.guild.name));
  } finally {
    await h.close();
  }
});

/* ------------------------------------------------------------------ */
/* R93 : /serverinfo « Salons »                                          */
/* ------------------------------------------------------------------ */

test('R93 : /serverinfo « Salons » ne liste pas les catégories privées à un membre (la gestion les voit)', async () => {
  const h = await setup();
  try {
    const g = h.guild;
    const cat = await g.channels.create({ name: 'Enquête interne', type: ChannelType.GuildCategory, permissionOverwrites: [{ id: g.id, type: OverwriteType.Role, deny: P.ViewChannel }] });
    await g.channels.create({ name: 'preuves', type: ChannelType.GuildText, parent: cat.id });
    await h.settle();
    const rec = await h.slash('serverinfo', [], { as: 'member' });
    const click = await h.click(h.messagesOf(rec)[0], 'cmd:serverinfo:channels', { as: 'member' });
    assert.doesNotMatch(JSON.stringify(h.messagesOf(click)[0].embeds), /Enquête interne/, 'catégorie privée montrée à un membre');
    const adm = await h.slash('serverinfo', [], { as: 'admin' });
    const admClick = await h.click(h.messagesOf(adm)[0], 'cmd:serverinfo:channels', { as: 'admin' });
    assert.match(JSON.stringify(h.messagesOf(admClick)[0].embeds), /Enquête interne/);
  } finally {
    await h.close();
  }
});

/* ------------------------------------------------------------------ */
/* R94 : /voice respecte les surcharges du vocal concerné               */
/* ------------------------------------------------------------------ */

async function privateVoice(h) {
  const g = h.guild;
  const priv = await g.channels.create({
    name: 'Direction', type: ChannelType.GuildVoice,
    permissionOverwrites: [
      { id: g.id, type: OverwriteType.Role, deny: P.ViewChannel },
      { id: IDS.roles.mod, type: OverwriteType.Role, deny: P.ViewChannel | P.MoveMembers | P.Connect | P.MuteMembers },
      { id: IDS.users.target, type: OverwriteType.Member, allow: P.ViewChannel | P.Connect },
    ],
  });
  await h.settle();
  await h.voice('target', priv.id);
  return priv;
}
const voiceCalls = (h) => h.fake.calls.filter((c) => c.method === 'PATCH' && c.route?.includes(`/members/${IDS.users.target}`) && c.body && ('channel_id' in c.body || 'mute' in c.body));

test('R94 : /voice kick, move, mute et cleanup refusés dans un vocal fermé au modérateur', async () => {
  const h = await setup();
  try {
    const priv = await privateVoice(h);
    for (const [name, options] of [
      ['kick', [opt('membre', 6, IDS.users.target)]],
      ['disconnect', [opt('membre', 6, IDS.users.target)]],
      ['move', [opt('membre', 6, IDS.users.target), opt('salon', 7, IDS.channels.voice)]],
      ['mute', [opt('membre', 6, IDS.users.target)]],
      ['cleanup', [opt('salon', 7, priv.id)]],
    ]) {
      const rec = await h.slash('voice', sub(name, options), { as: 'mod' });
      await h.settle();
      assert.ok(h.isError(rec) || /Vous ne pouvez pas|Aucun membre/.test(h.replyText(rec)), `/voice ${name} : ${h.replyText(rec).slice(0, 120)}`);
    }
    assert.deepEqual(voiceCalls(h), [], 'action envoyée à Discord dans un vocal fermé au modérateur');
    assert.equal(h.member('target').voice.channelId, priv.id);
  } finally {
    await h.close();
  }
});

test('R94 : bouton « Ramener » revérifie les droits dans le vocal où se trouve le membre', async () => {
  const h = await setup();
  try {
    const g = h.guild;
    const salle2 = await g.channels.create({ name: 'Salle 2', type: ChannelType.GuildVoice });
    await h.settle();
    await h.voice('target', IDS.channels.voice);
    // Un administrateur déplace la cible : la carte offre « Ramener » (vers le vocal d'origine).
    const moved = await h.slash('voice', sub('move', [opt('membre', 6, IDS.users.target), opt('salon', 7, salle2.id)]), { as: 'admin' });
    await h.settle();
    assert.match(h.replyText(moved), /Membre déplacé/);
    // La cible rejoint ensuite un vocal fermé au modérateur, qui clique « Ramener ».
    const priv = await privateVoice(h);
    const before = voiceCalls(h).length;
    const click = await h.click(h.messagesOf(moved)[0], `cmd:voice:moveback:${IDS.users.target}:${IDS.channels.voice}:${IDS.users.admin}`, { as: 'mod' });
    await h.settle();
    assert.ok(h.isError(click), h.replyText(click).slice(0, 120));
    assert.equal(voiceCalls(h).length, before, 'déplacement depuis un vocal fermé au modérateur');
    assert.equal(h.member('target').voice.channelId, priv.id);
  } finally {
    await h.close();
  }
});

/* ------------------------------------------------------------------ */
/* R103 : boutique, prix changé entre l'affichage et le clic            */
/* ------------------------------------------------------------------ */

test('R103 : achat refusé (rien débité) si le prix a changé depuis l\'affichage de la boutique', async () => {
  const h = await setup();
  try {
    h.configure({ economy: { enabled: true } });
    const svc = h.client.services.economy;
    svc.adminAdjust(h.guild.id, IDS.users.member, 'set', 50_000, IDS.users.admin);
    const item = svc.addItem(h.guild.id, { name: 'Ticket VIP', price: 100, kind: 'item' });
    const shop = await h.slash('eco', sub('boutique'), { as: 'member' });
    const buy = h.messagesOf(shop)[0].components.flatMap((r) => r.components).find((c) => c.custom_id?.startsWith(`cmd:eco:buy:${item.id}:`));
    svc.updateItem(h.guild.id, item.id, { name: 'Ticket VIP', price: 40_000, description: null, stock: null, emoji: null });
    const click = await h.click(h.messagesOf(shop)[0], buy.custom_id, { as: 'member' });
    assert.ok(h.isError(click), h.replyText(click).slice(0, 160));
    assert.match(h.replyText(click), /prix/);
    assert.equal(svc.account(h.guild.id, IDS.users.member).balance, 50_000, 'débité d\'un prix jamais affiché');
    // Boutique actualisée : achat au nouveau prix affiché.
    const fresh = await h.slash('eco', sub('boutique'), { as: 'member' });
    const buy2 = h.messagesOf(fresh)[0].components.flatMap((r) => r.components).find((c) => c.custom_id?.startsWith(`cmd:eco:buy:${item.id}:`));
    const ok = await h.click(h.messagesOf(fresh)[0], buy2.custom_id, { as: 'member' });
    assert.ok(!h.isError(ok), h.replyText(ok).slice(0, 160));
    assert.equal(svc.account(h.guild.id, IDS.users.member).balance, 10_000);
  } finally {
    await h.close();
  }
});
