'use strict';

/**
 * Bout en bout : régressions de la revue n° 6 (lot modération : lockdown, masquage,
 * mute, sanctions, rôles).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { PermissionFlagsBits: P } = require('discord.js');
const { createHarness, IDS } = require('./harness');
const { nextId } = require('./lib/ids');
const { freshMember } = require('./lib/overrides');

const opt = (name, type, value) => ({ name, type, value });
const sub = (name, options = []) => [{ name, type: 1, options }];

const can = (h, userId, channelId, flag = P.SendMessages) => (BigInt(h.permissionsIn(userId, channelId)) & flag) === flag;
const overwritesOf = (h, channelId) => JSON.parse(JSON.stringify(h.fake.channels.get(channelId).permission_overwrites))
  .map(({ id, type, allow, deny }) => ({ id, type, allow, deny }))
  .sort((a, b) => a.id.localeCompare(b.id));

/** Ajoute un salon média (type 16) au serveur de test. */
async function addMedia(h) {
  const id = nextId();
  const media = { id, type: 16, guild_id: h.guild.id, name: 'medias', position: 9, permission_overwrites: [], parent_id: null, flags: 0, topic: null, nsfw: false, rate_limit_per_user: 0, available_tags: [], default_reaction_emoji: null, default_thread_rate_limit_per_user: 0, default_sort_order: null };
  h.fake.channels.set(id, media);
  h.fake.dispatchNow('CHANNEL_CREATE', media, 'salon média');
  await h.settle();
  return id;
}

/** Remplace les surcharges d'un salon (comme un administrateur dans Discord). */
async function setOverwrites(h, channelId, overwrites) {
  const ch = h.fake.channels.get(channelId);
  ch.permission_overwrites = overwrites.map((o) => ({ type: 0, allow: '0', deny: '0', ...o }));
  h.fake.dispatchNow('CHANNEL_UPDATE', { ...ch }, 'surcharges');
  await h.settle();
}

/** Membre sans aucun rôle (arrivé, rôle automatique retiré). */
async function plainMember(h) {
  const user = h.addUser('SansRole', { ageDays: 400 });
  await h.memberJoin(user);
  h.fake.members.get(user.id).roles = [];
  h.fake.dispatchNow('GUILD_MEMBER_UPDATE', { guild_id: h.guild.id, ...h.fake.members.get(user.id) }, 'membre nu');
  await h.settle();
  return user;
}

test('R11 /lockall verrouille aussi les conférences et les salons média, /unlockall les restaure à l\'identique', async () => {
  const h = await createHarness();
  h.configureAll();
  h.configure({ moderation: { confirmDangerous: false } });
  try {
    const media = await addMedia(h);
    const plain = await plainMember(h);
    const before = { stage: overwritesOf(h, IDS.channels.stage), media: overwritesOf(h, media) };
    assert.ok(can(h, plain.id, IDS.channels.stage) && can(h, plain.id, media));

    const rec = await h.slash('lockall', [], { as: 'admin' });
    assert.ok(!h.isError(rec), h.replyText(rec));
    assert.equal(can(h, plain.id, IDS.channels.stage), false, 'chat de la conférence encore ouvert pendant le lockdown');
    assert.equal(can(h, plain.id, media), false, 'salon média encore ouvert pendant le lockdown');
    assert.equal(can(h, plain.id, media, P.SendMessagesInThreads), false, 'posts du salon média encore ouverts');

    const off = await h.slash('unlockall', [], { as: 'admin' });
    assert.ok(!h.isError(off), h.replyText(off));
    assert.deepEqual(overwritesOf(h, IDS.channels.stage), before.stage);
    assert.deepEqual(overwritesOf(h, media), before.media);
    assert.ok(can(h, plain.id, IDS.channels.stage) && can(h, plain.id, media));

    // /lock et /unlock proposent ces salons dans leur option `salon`.
    for (const name of ['lock', 'unlock']) {
      const types = h.client.commands.get(name).data.toJSON().options.find((o) => o.name === 'salon').channel_types;
      assert.ok(types.includes(13) && types.includes(16), `/${name} : ${types}`);
    }
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('R11 lockdown : les surcharges de rôle qui autorisent l\'écriture sont neutralisées puis restaurées exactement (staff et bot épargnés)', async () => {
  const h = await createHarness();
  h.configureAll();
  h.configure({ moderation: { confirmDangerous: false } });
  try {
    const general = IDS.channels.general;
    await setOverwrites(h, general, [
      { id: IDS.roles.member, allow: String(P.SendMessages | P.AttachFiles), deny: String(P.AddReactions) },
      { id: IDS.roles.gamer, allow: String(P.CreatePublicThreads), deny: '0' },
      { id: IDS.roles.mod, allow: String(P.SendMessages), deny: '0' },
      { id: IDS.roles.bot, allow: String(P.SendMessages), deny: '0' },
    ]);
    const before = overwritesOf(h, general);
    assert.ok(can(h, IDS.users.target, general));

    const rec = await h.slash('lockall', [], { as: 'admin' });
    assert.ok(!h.isError(rec), h.replyText(rec));
    assert.equal(can(h, IDS.users.target, general), false, 'un membre « Membre » écrit toujours grâce à la surcharge de son rôle');
    assert.equal(can(h, IDS.users.member, general, P.CreatePublicThreads), false, 'un « Joueur » peut encore ouvrir un fil');
    assert.ok(can(h, IDS.users.target, general, P.AttachFiles), 'les autres autorisations du rôle ne doivent pas changer');
    assert.ok(can(h, IDS.users.mod, general), 'la surcharge du rôle de modération doit être conservée');
    const botOw = h.fake.channels.get(general).permission_overwrites.find((o) => o.id === IDS.roles.bot);
    assert.equal(botOw.allow, String(P.SendMessages), 'surcharge du bot modifiée');

    // Arrivée pendant le lockdown : le rôle automatique ne rouvre pas l'écriture.
    const raider = h.addUser('Raider', { ageDays: 400 });
    await h.memberJoin(raider);
    assert.ok(h.fake.members.get(raider.id).roles.includes(IDS.roles.member));
    assert.equal(can(h, raider.id, general), false, 'un raider arrivé pendant le lockdown écrit grâce au rôle automatique');

    const off = await h.slash('unlockall', [], { as: 'admin' });
    assert.ok(!h.isError(off), h.replyText(off));
    assert.deepEqual(overwritesOf(h, general), before, 'surcharges non restaurées à l\'identique');
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('R11 lockdown : une surcharge de rôle modifiée à la main pendant le verrouillage n\'est pas écrasée à la levée', async () => {
  const h = await createHarness();
  h.configureAll();
  h.configure({ moderation: { confirmDangerous: false } });
  try {
    const general = IDS.channels.general;
    await setOverwrites(h, general, [{ id: IDS.roles.member, allow: String(P.SendMessages), deny: '0' }]);
    await h.slash('lockall', [], { as: 'admin' });
    // Un administrateur décide entre-temps que le rôle Membre ne doit plus écrire ici.
    const ch = h.fake.channels.get(general);
    ch.permission_overwrites = ch.permission_overwrites.map((o) => (o.id === IDS.roles.member ? { ...o, deny: String(P.SendMessages) } : o));
    h.fake.dispatchNow('CHANNEL_UPDATE', { ...ch }, 'décision manuelle');
    await h.settle();
    await h.slash('unlockall', [], { as: 'admin' });
    const ow = h.fake.channels.get(general).permission_overwrites.find((o) => o.id === IDS.roles.member);
    assert.equal(ow.deny, String(P.SendMessages));
    assert.equal(ow.allow, '0');
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('R11 /lock duree échu pendant un lockdown : les surcharges de rôle neutralisées restent mémorisées et sont restaurées par /unlockall', async () => {
  const h = await createHarness();
  h.configureAll();
  h.configure({ moderation: { confirmDangerous: false } });
  try {
    const general = IDS.channels.general;
    await setOverwrites(h, general, [{ id: IDS.roles.member, allow: String(P.SendMessages), deny: '0' }]);
    const before = overwritesOf(h, general);
    await h.slash('lock', [{ name: 'salon', type: 7, value: general }, { name: 'duree', type: 3, value: '1h' }], { as: 'admin' });
    assert.equal(can(h, IDS.users.target, general), false);
    await h.slash('lockall', [], { as: 'admin' });
    h.client.database.db.prepare('UPDATE timed_channel_actions SET expires_at = ? WHERE active = 1').run(Date.now() - 1000);
    await h.client.services.timedLocks.processDue();
    await h.settle();
    assert.equal(can(h, IDS.users.target, general), false, 'salon rouvert pendant le lockdown');
    await h.slash('unlockall', [], { as: 'admin' });
    assert.deepEqual(overwritesOf(h, general), before, 'surcharge du rôle Membre perdue après la levée');
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('R12 tempban échu dont la levée a échoué : /sanctions remove et clear refusent, la fiche propose « Lever »', async () => {
  const h = await createHarness();
  h.configureAll();
  h.configure({ moderation: { confirmDangerous: false } });
  try {
    const victim = await freshMember(h, 'Victime');
    await h.slash('tempban', [opt('membre', 6, victim), opt('duree', 3, '1h')], { as: 'mod' });
    assert.ok(h.fake.bans.has(victim));
    const db = h.client.database.db;
    const row = db.prepare("SELECT id FROM sanctions WHERE user_id = ? AND type = 'tempban'").get(victim);
    db.prepare('UPDATE sanctions SET expires_at = ? WHERE id = ?').run(Date.now() - 1000, row.id);
    // Débannissement automatique refusé une fois (permission retirée un moment).
    h.fake.inject({ method: 'DELETE', route: /\/bans\// }, { status: 403, code: 50013, times: 1 });
    await h.client.services.scheduler.tick();
    await h.settle();
    assert.ok(h.fake.bans.has(victim));

    const rm = await h.slash('sanctions', sub('remove', [opt('id', 4, row.id)]), { as: 'mod' });
    assert.ok(h.isError(rm), `suppression acceptée : ${h.replyText(rm)}`);
    assert.match(h.replyText(rm), /levée|lever/i);
    const clear = await h.slash('sanctions', sub('clear', [opt('membre', 6, victim)]), { as: 'admin' });
    assert.ok(h.isError(clear), `casier effacé : ${h.replyText(clear)}`);
    assert.ok(db.prepare('SELECT id FROM sanctions WHERE id = ?').get(row.id), 'ligne supprimée');

    const view = await h.slash('sanctions', sub('voir', [opt('id', 4, row.id)]), { as: 'mod' });
    assert.match(h.replyText(view), /en attente/i);
    const card = h.messagesOf(view)[0];
    const liftId = `cmd:sanctions:lift:${row.id}`;
    assert.ok(h.findComponent(card, liftId), 'bouton « Lever » absent de la fiche d\'une sanction échue non levée');
    const lifted = await h.click(card, liftId, { as: 'mod' });
    assert.ok(!h.isError(lifted), h.replyText(lifted));
    assert.equal(h.fake.bans.has(victim), false, 'toujours banni après « Lever »');
    assert.equal(db.prepare('SELECT active FROM sanctions WHERE id = ?').get(row.id).active, 0);
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('R14 deux /warn simultanés n\'appliquent qu\'une fois le palier d\'escalade', async () => {
  const h = await createHarness();
  h.configureAll();
  h.configure({ strikes: { enabled: true, thresholds: [{ strikes: 3, action: 'ban', duration: null }] }, moderation: { dmOnSanction: true } });
  h.fake.latency = 25;
  try {
    const target = IDS.users.target;
    h.client.services.strikes.add(h.guild.id, target, 2);
    const opts = [opt('membre', 6, target), opt('raison', 3, 'spam')];
    await Promise.all([
      h.slash('warn', opts, { as: 'admin', label: 'warn admin' }),
      h.slash('warn', opts, { as: 'mod', label: 'warn mod' }),
    ]);
    await h.settle();
    const rows = h.client.repositories.sanctions.listByUser(h.guild.id, target, 50);
    assert.equal(rows.filter((r) => r.type === 'warn').length, 2);
    assert.equal(rows.filter((r) => r.escalation_step === 3).length, 1, rows.map((r) => `${r.type} step=${r.escalation_step}`).join(' | '));
    assert.equal(h.fake.calls.filter((c) => c.method === 'PUT' && /\/bans\//.test(c.route)).length, 1);
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('R18 lockdown avec un bot sans Administrateur : le bot garde l\'écriture (logs, alertes), garde retirée à la levée', async () => {
  const h = await createHarness({ botAdministrator: false });
  h.configureAll();
  const logs = IDS.channels.rules; // salon public utilisé comme salon de logs
  h.configure({ logChannels: Object.fromEntries(['moderation', 'security', 'members', 'messages'].map((k) => [k, logs])), moderation: { confirmDangerous: false } });
  try {
    const before = overwritesOf(h, logs);
    const mark = h.fake.messageLog.length;
    const rec = await h.slash('lockall', [], { as: 'admin' });
    assert.ok(!h.isError(rec), h.replyText(rec));
    assert.equal(can(h, IDS.users.target, logs), false, 'salon non verrouillé');
    assert.ok(can(h, h.client.user.id, logs), 'le bot ne peut plus écrire dans son salon de logs');
    const posted = h.fake.messageLog.slice(mark).map((id) => h.message(id)).filter((m) => m?.channel_id === logs);
    assert.ok(posted.length >= 1, 'carte « Lockdown activé » perdue');
    const mark2 = h.fake.messageLog.length;
    await h.slash('warn', [opt('membre', 6, IDS.users.target), opt('raison', 3, 'test')], { as: 'admin' });
    assert.ok(h.fake.messageLog.slice(mark2).map((id) => h.message(id)).some((m) => m?.channel_id === logs), 'log du /warn perdu pendant le lockdown');

    await h.slash('unlockall', [], { as: 'admin' });
    assert.deepEqual(overwritesOf(h, logs), before, 'garde du bot laissée après la levée');
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('R15 /hide avec un bot sans Administrateur : le bot garde la vue du salon, /unhide fonctionne et rend l\'état d\'origine', async () => {
  const h = await createHarness({ botAdministrator: false });
  h.configureAll();
  try {
    const ch = IDS.channels.rules;
    const before = overwritesOf(h, ch);
    const r1 = await h.slash('hide', [opt('salon', 7, ch)], { as: 'admin' });
    assert.ok(!h.isError(r1), h.replyText(r1));
    assert.equal(can(h, IDS.users.target, ch, P.ViewChannel), false, 'salon toujours visible');
    assert.ok(can(h, h.client.user.id, ch, P.ViewChannel), 'le bot ne voit plus le salon');
    const r2 = await h.slash('unhide', [opt('salon', 7, ch)], { as: 'admin' });
    assert.ok(!h.isError(r2), h.replyText(r2));
    assert.ok(can(h, IDS.users.target, ch, P.ViewChannel));
    assert.deepEqual(overwritesOf(h, ch), before);
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('R19 /hide et /lock simultanés sur un salon : aucun refus n\'écrase l\'autre', async () => {
  const h = await createHarness();
  h.configureAll();
  h.fake.latency = 20;
  try {
    const ch = h.guild.channels.cache.get(IDS.channels.rules);
    const lockdown = h.client.services.lockdown;
    await Promise.all([lockdown.lockChannel(ch, null, 'lock'), lockdown.hideChannel(ch, 'hide')]);
    await h.settle();
    const ev = h.fake.channels.get(ch.id).permission_overwrites.find((o) => o.id === IDS.roles.everyone);
    assert.ok(BigInt(ev.deny) & P.SendMessages, 'refus d\'écrire écrasé');
    assert.ok(BigInt(ev.deny) & P.ViewChannel, 'refus de voir écrasé');
    await Promise.all([lockdown.unlockChannel(ch, 'unlock'), lockdown.unhideChannel(ch, 'unhide')]);
    await h.settle();
    assert.deepEqual(h.fake.channels.get(ch.id).permission_overwrites, []);
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('R23 /hide sur une catégorie masque aussi ses salons synchronisés ; /unhide restaure exactement chacun', async () => {
  const h = await createHarness();
  h.configureAll();
  try {
    const cat = IDS.channels.catGeneral;
    const synced = [IDS.channels.general, IDS.channels.rules, IDS.channels.announcements, IDS.channels.forum];
    const own = IDS.channels.staff; // surcharges propres : non synchronisé, laissé tel quel
    const all = [cat, ...synced, own];
    const before = Object.fromEntries(all.map((id) => [id, overwritesOf(h, id)]));
    const rec = await h.slash('hide', [opt('salon', 7, cat)], { as: 'admin' });
    assert.ok(!h.isError(rec), h.replyText(rec));
    for (const id of synced) assert.equal(can(h, IDS.users.target, id, P.ViewChannel), false, `salon ${id} encore visible`);
    assert.deepEqual(overwritesOf(h, own), before[own]);
    assert.ok(h.guild.channels.cache.get(IDS.channels.general).permissionsLocked, 'salon désynchronisé de sa catégorie');
    const un = await h.slash('unhide', [opt('salon', 7, cat)], { as: 'admin' });
    assert.ok(!h.isError(un), h.replyText(un));
    for (const id of all) assert.deepEqual(overwritesOf(h, id), before[id], `salon ${id} non restauré`);
    assert.equal(h.client.services.lockdown.locks.list(h.guild.id, 'hide').length, 0);
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('R16 rôle Muted : conférences et salons média couverts, création de fils, parole demandée et partage d\'écran refusés', async () => {
  const h = await createHarness();
  h.configureAll();
  try {
    const media = await addMedia(h);
    const rec = await h.slash('mute', [opt('membre', 6, IDS.users.target), opt('raison', 3, 'spam')], { as: 'admin' });
    assert.ok(!h.isError(rec), h.replyText(rec));
    const target = IDS.users.target;
    const denied = [
      [IDS.channels.general, ['SendMessages', 'SendMessagesInThreads', 'CreatePublicThreads', 'CreatePrivateThreads']],
      [IDS.channels.announcements, ['SendMessages', 'CreatePublicThreads']],
      [IDS.channels.stage, ['SendMessages', 'Speak', 'RequestToSpeak', 'AddReactions']],
      [IDS.channels.voice, ['SendMessages', 'Speak', 'Stream']],
      [media, ['SendMessages', 'SendMessagesInThreads', 'AddReactions']],
    ];
    for (const [channel, flags] of denied) {
      for (const flag of flags) assert.equal(can(h, target, channel, P[flag]), false, `${flag} encore permis dans ${channel}`);
    }
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('R32 bot retiré pendant un lockdown puis réinvité : plus de lockdown fantôme, /lockdown disable ne rouvre pas un salon passé en lecture seule', async () => {
  const h = await createHarness();
  h.configureAll();
  try {
    const G = h.guild.id;
    const lockdown = h.client.services.lockdown;
    await lockdown.enable(h.guild, h.guild.members.me, 'AntiRaid automatique', { log: false, wait: true });
    assert.ok(lockdown.status(h.guild) > 0);
    require('../../src/events/guildDelete').execute(h.client, { id: G, name: 'x', available: true });
    assert.equal(h.client.repositories.locks.list(G).length, 0, 'états de verrouillage conservés après le départ');
    // Pendant l'absence : refus retirés à la main, #annonces passé en lecture seule.
    for (const ch of h.fake.channels.values()) {
      if (ch.guild_id !== G || !Array.isArray(ch.permission_overwrites)) continue;
      ch.permission_overwrites = ch.permission_overwrites.filter((o) => o.id !== G);
      if (ch.id === IDS.channels.announcements) ch.permission_overwrites.push({ id: G, type: 0, allow: '0', deny: P.SendMessages.toString() });
      h.fake.dispatchNow('CHANNEL_UPDATE', { ...ch }, `état manuel ${ch.name}`);
    }
    await h.settle();
    const st = await h.slash('lockdown', sub('status'), { as: 'admin' });
    assert.match(h.replyText(st), /Aucun salon/);
    await h.slash('lockdown', sub('disable'), { as: 'admin' });
    assert.equal(can(h, IDS.users.target, IDS.channels.announcements), false, '#annonces rouvert par un état périmé');
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('R32 salon déverrouillé à la main pendant un lockdown : statut recalculé, état oublié, nouveau verrouillage sur l\'état réel', async () => {
  const h = await createHarness();
  h.configureAll();
  h.configure({ moderation: { confirmDangerous: false } });
  try {
    const G = h.guild.id;
    const lockdown = h.client.services.lockdown;
    await h.slash('lockall', [], { as: 'admin' });
    const locked = lockdown.status(h.guild);
    assert.ok(locked > 1);
    // Un administrateur rouvre #annonces à la main (refus retirés) puis y autorise explicitement l'écriture.
    const ann = h.fake.channels.get(IDS.channels.announcements);
    ann.permission_overwrites = [{ id: G, type: 0, allow: String(P.SendMessages), deny: '0' }];
    h.fake.dispatchNow('CHANNEL_UPDATE', { ...ann }, 'déverrouillage manuel');
    await h.settle();
    assert.equal(lockdown.status(h.guild), locked - 1, 'salon rouvert à la main encore compté comme verrouillé');
    // /lock sur ce salon : l'état d'origine mémorisé est l'état réel (écriture autorisée), pas l'ancien.
    await h.slash('lock', [opt('salon', 7, IDS.channels.announcements)], { as: 'admin' });
    await h.slash('unlock', [opt('salon', 7, IDS.channels.announcements)], { as: 'admin' });
    const ow = h.fake.channels.get(IDS.channels.announcements).permission_overwrites.find((o) => o.id === G);
    assert.equal(ow?.allow, String(P.SendMessages), 'état d\'origine périmé restauré');
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('R20 deux /mute simultanés sans rôle Muted : un seul rôle créé, les deux membres démutables', async () => {
  const h = await createHarness();
  h.configureAll();
  h.fake.latency = 20;
  try {
    await Promise.all([
      h.slash('mute', [opt('membre', 6, IDS.users.target), opt('duree', 3, '10m')], { as: 'admin', label: 'mute target' }),
      h.slash('mute', [opt('membre', 6, IDS.users.member), opt('duree', 3, '10m')], { as: 'owner', label: 'mute member' }),
    ]);
    await h.settle();
    h.fake.latency = 0;
    const muted = [...h.fake.roles.values()].filter((r) => r.name === 'Muted');
    assert.equal(muted.length, 1, `${muted.length} rôles « Muted » créés`);
    for (const who of ['target', 'member']) {
      await h.slash('unmute', [opt('membre', 6, IDS.users[who])], { as: 'admin' });
      assert.ok(!h.fake.members.get(IDS.users[who]).roles.includes(muted[0].id), `${who} toujours muet`);
    }
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('R22 rôle Muted retiré par /role remove ou /massrole remove : le mute est levé en base, pas de réapplication au retour', async () => {
  const h = await createHarness();
  h.configureAll();
  try {
    const gid = h.guild.id;
    const sanctions = h.client.repositories.sanctions;
    await h.slash('mute', [opt('membre', 6, IDS.users.target), opt('raison', 3, 'spam')], { as: 'admin' });
    await h.slash('mute', [opt('membre', 6, IDS.users.member), opt('raison', 3, 'spam')], { as: 'admin' });
    const muted = h.client.services.moderation.mutedRole(h.guild);
    const r = await h.slash('role', sub('remove', [opt('membre', 6, IDS.users.target), opt('role', 8, muted.id)]), { as: 'admin' });
    assert.ok(!h.isError(r), h.replyText(r));
    assert.equal(sanctions.activeMute(gid, IDS.users.target), null, 'mute toujours actif après /role remove');
    const user = h.fake.users.get(IDS.users.target);
    await h.memberLeave(IDS.users.target);
    await h.memberJoin(user);
    assert.ok(!h.fake.members.get(IDS.users.target).roles.includes(muted.id), 'rôle Muted remis au retour');

    const m = await h.slash('massrole', [opt('action', 3, 'remove'), opt('role', 8, muted.id)], { as: 'admin' });
    assert.ok(!h.isError(m), h.replyText(m));
    await h.confirm(m);
    await h.waitFor(() => !h.fake.members.get(IDS.users.member).roles.includes(muted.id), { timeout: 3_000 });
    assert.equal(sanctions.activeMute(gid, IDS.users.member), null, 'mute toujours actif après /massrole remove');
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});
