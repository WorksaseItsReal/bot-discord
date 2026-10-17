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
