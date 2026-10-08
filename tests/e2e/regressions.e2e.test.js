'use strict';

/**
 * Bout en bout : non-régressions des bugs trouvés par le harnais, invariants d'état
 * (verrouillages restaurés à l'identique) et auto-tests du harnais lui-même.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { PermissionFlagsBits: P, EmbedBuilder } = require('discord.js');
const { createHarness, IDS } = require('./harness');

const opt = (name, type, value) => ({ name, type, value });
const sub = (name, options = []) => [{ name, type: 1, options }];
const SEND = String(P.SendMessages);

/** État fonctionnel des salons (une surcharge vide 0/0 équivaut à son absence). */
function channelState(h) {
  return JSON.stringify([...h.fake.channels.values()].map((c) => [
    c.id,
    c.rate_limit_per_user ?? 0,
    (c.permission_overwrites ?? []).filter((o) => o.allow !== '0' || o.deny !== '0').map((o) => [o.id, o.allow, o.deny]).sort(),
  ]));
}

/** Commande puis, si une confirmation s'affiche, clic sur « Confirmer ». */
async function run(h, name, options = [], ctx = {}) {
  const rec = await h.slash(name, options, ctx);
  await h.confirm(rec);
  await h.settle();
  assert.ok(!h.isError(rec), `/${name} : ${h.replyText(rec)}`);
  return rec;
}

/** #général : @everyone a l'autorisation EXPLICITE d'écrire (à restaurer telle quelle). */
async function withExplicitAllow(h) {
  const general = h.fake.channels.get(IDS.channels.general);
  general.permission_overwrites = [{ id: IDS.roles.everyone, type: 0, allow: SEND, deny: '0' }];
  h.fake.dispatchNow('CHANNEL_UPDATE', general, 'préparation');
  await h.settle();
}
const everyoneOverwrite = (h) => h.fake.channels.get(IDS.channels.general).permission_overwrites.find((o) => o.id === IDS.roles.everyone);

test('régression : un /lock posé pendant un lockdown survit à sa levée (LockdownService.lockChannel)', async () => {
  const h = await createHarness();
  try {
    await withExplicitAllow(h);
    await run(h, 'lockdown', sub('enable'));
    await run(h, 'lock', [opt('salon', 7, IDS.channels.general)]);
    await run(h, 'lockdown', sub('disable'));
    const during = everyoneOverwrite(h);
    assert.ok(BigInt(during.deny) & P.SendMessages, 'la levée du lockdown a déverrouillé un salon verrouillé à la main');
    assert.equal(h.client.services.lockdown.status(h.guild), 0, 'le salon verrouillé à la main compte encore dans le lockdown');
    await run(h, 'unlock', [opt('salon', 7, IDS.channels.general)]);
    const after = everyoneOverwrite(h);
    assert.equal(after.allow, SEND, '/unlock n\'a pas restauré l\'autorisation explicite d\'origine');
    assert.equal(after.deny, '0');
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('invariants : verrouillages et masquages restaurent exactement l\'état d\'origine', async () => {
  const h = await createHarness();
  h.configure({ moderation: { confirmDangerous: false } });
  try {
    await withExplicitAllow(h);
    const lock = (channel) => [opt('salon', 7, channel)];
    const scenarios = [
      ['lock / unlock', [['lock']], [['unlock']]],
      ['hide / unhide', [['hide']], [['unhide']]],
      ['lock / unlock (vocal)', [['lock', lock(IDS.channels.voice)]], [['unlock', lock(IDS.channels.voice)]]],
      ['lock / unlock (forum)', [['lock', lock(IDS.channels.forum)]], [['unlock', lock(IDS.channels.forum)]]],
      ['hide / unhide (catégorie)', [['hide', lock(IDS.channels.catGeneral)]], [['unhide', lock(IDS.channels.catGeneral)]]],
      ['lockall / unlockall', [['lockall']], [['unlockall']]],
      ['lockdown', [['lockdown', sub('enable')]], [['lockdown', sub('disable')]]],
      ['slowmode', [['slowmode', [opt('duree', 3, '10s')]]], [['slowmode', [opt('duree', 3, '0')]]]],
      ['lock puis lockdown', [['lock'], ['lockdown', sub('enable')]], [['lockdown', sub('disable')], ['unlock']]],
      ['lockdown puis lock', [['lockdown', sub('enable')], ['lock']], [['lockdown', sub('disable')], ['unlock']]],
      ['lockall puis lockdown', [['lockall'], ['lockdown', sub('enable')]], [['lockdown', sub('disable')], ['unlockall']]],
      ['hide puis lockdown', [['hide'], ['lockdown', sub('enable')]], [['lockdown', sub('disable')], ['unhide']]],
    ];
    for (const [label, apply, revert] of scenarios) {
      const before = channelState(h);
      for (const [name, options] of apply) await run(h, name, options);
      assert.notEqual(channelState(h), before, `${label} : aucun effet`);
      for (const [name, options] of revert) await run(h, name, options);
      assert.equal(channelState(h), before, `${label} : état d'origine non restauré`);
    }
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('invariants : sanctions levées et rôles rendus', async () => {
  const h = await createHarness();
  h.configure({ moderation: { confirmDangerous: false, mutedRoleId: IDS.roles.muted } });
  const members = () => JSON.stringify([...h.fake.members.values()].map((m) => [m.user.id, [...m.roles].sort(), m.nick, m.communication_disabled_until ?? null]));
  try {
    const target = opt('membre', 6, IDS.users.target);
    for (const [label, apply, revert] of [
      ['mute', ['mute', [target, opt('duree', 3, '1h')]], ['unmute', [target]]],
      ['timeout', ['timeout', [target, opt('duree', 3, '10m')]], ['untimeout', [target]]],
      ['pseudo', ['pseudo', [target, opt('pseudo', 3, 'Temporaire')]], ['pseudo', [target]]],
      ['rôle', ['role', sub('add', [target, opt('role', 8, IDS.roles.gamer)])], ['role', sub('remove', [target, opt('role', 8, IDS.roles.gamer)])]],
    ]) {
      const before = members();
      await run(h, ...apply);
      assert.notEqual(members(), before, `${label} : aucun effet`);
      await run(h, ...revert);
      assert.equal(members(), before, `${label} : état d'origine non restauré`);
    }
    const banned = h.addUser('Banni', { ageDays: 300 });
    await h.memberJoin(banned);
    await run(h, 'ban', [opt('membre', 6, banned.id)]);
    assert.ok(h.fake.bans.has(banned.id));
    await run(h, 'unban', [opt('user_id', 3, banned.id)]);
    assert.ok(!h.fake.bans.has(banned.id));
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('bot sans Administrateur, privé d\'écriture dans #général et d\'accès à #logs : erreurs expliquées', async () => {
  const h = await createHarness({ botAdministrator: false, restrictBot: true });
  h.configureAll();
  try {
    const embed = await h.slash('embed', sub('send', [opt('titre', 3, 'Annonce'), opt('description', 3, 'Texte')]));
    assert.ok(h.isError(embed), 'publication refusée par Discord non signalée');
    assert.match(h.replyText(embed), /permission/i);
    const rolemenu = await h.slash('rolemenu', [opt('titre', 3, 'Rôles'), opt('role1', 8, IDS.roles.notif)]);
    assert.ok(h.isError(rolemenu));
    assert.equal(h.client.repositories.roleMenus.list?.(h.guild.id)?.length ?? 0, 0, 'menu de rôles orphelin en base');
    await h.slash('warn', [opt('membre', 6, IDS.users.target), opt('raison', 3, 'log impossible')], { as: 'mod' });
    await h.userMessage({ as: 'member', content: 'message journalisé nulle part' });
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('auto-test du harnais : limites, double acquittement, texte suspect, logs d\'erreur', async () => {
  const h = await createHarness();
  try {
    const channel = h.client.channels.cache.get(IDS.channels.general);
    await assert.rejects(channel.send({ embeds: [new EmbedBuilder().setTitle('x'.repeat(200)).setDescription('y'.repeat(4096)).addFields({ name: 'z', value: 'w'.repeat(1024) }, { name: 'z', value: 'w'.repeat(1024) })] }), { code: 50035 });
    await assert.rejects(channel.send({ content: 'a'.repeat(2001) }), { code: 50035 });
    await assert.rejects(channel.send({ content: 'x', components: [{ type: 1, components: [{ type: 2, style: 1, custom_id: 'c'.repeat(101), label: 'ok' }] }] }), { code: 50035 });
    await assert.rejects(channel.send({}), (err) => err.code === 50006 || /empty/i.test(err.message));
    await channel.send({ content: 'Bonjour undefined' });
    const p = h.problems();
    assert.equal(p.violations.length, 4, p.violations.join('\n'));
    assert.match(p.violations[0], /total 6\d{3} caractères > 6000/);
    assert.equal(p.suspicious.length, 1);

    // Double acquittement d'une interaction : refusé comme par Discord (40060) et consigné.
    h.resetProblems();
    const rec = await h.slash('ping');
    await assert.rejects(h.client.rest.post(`/interactions/${rec.id}/${rec.token}/callback`, { body: { type: 4, data: { content: 'x' } }, auth: false }), { code: 40060 });
    assert.equal(h.problems().violations.length, 1);

    // Erreur du bot, permission manquante, dépréciation : relevées.
    h.resetProblems();
    h.client.emit('error', new Error('boum'));
    process.emitWarning('option obsolète', 'DeprecationWarning');
    await new Promise((r) => setImmediate(r));
    assert.equal(h.problems().errors.length, 1);
    assert.equal(h.problems().deprecations.length, 1);
    h.resetProblems();
  } finally {
    await h.close();
  }
});

test('erreurs Discord injectées (50013, 10008, 500) sur la première requête de chaque commande : gérées', async () => {
  const { leavesOf, runLeaf } = require('./lib/explore');
  const { OVERRIDES } = require('./lib/overrides');
  const h = await createHarness();
  h.configureAll();
  const notInteraction = (c) => !c.route.startsWith('/interactions/') && !c.route.startsWith('/webhooks/');
  try {
    let injected = 0;
    for (const [status, code] of [[403, 50013], [404, 10008], [500, 0]]) {
      for (const [name, command] of h.client.commands) {
        for (const leaf of leavesOf(command.data.toJSON())) {
          const before = h.fake.calls.length;
          h.fake.injections.length = 0;
          h.fake.inject({ match: notInteraction }, { status, code });
          const rec = await runLeaf(h, name, leaf, { overrides: OVERRIDES[[name, ...leaf.path].join(' ')] ?? {} });
          assert.ok(rec.ackType != null, `/${name} ${leaf.path.join(' ')} non acquittée après l'erreur ${code || status}`);
          if (h.fake.calls.slice(before).some((c) => c.status === status)) injected += 1;
        }
      }
    }
    h.fake.injections.length = 0;
    assert.ok(injected > 100, `${injected} erreurs effectivement injectées`);
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});
