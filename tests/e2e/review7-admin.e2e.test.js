'use strict';

/**
 * Revue 7, lot admin — de bout en bout.
 *  S12 : commandes du bot qui échappaient à Secur (action signée du bot dans le journal d'audit,
 *        donc ignorée) : /unhide et /unlock (refus natif d'@everyone levé), /emoji supprimer,
 *        /voice cleanup et kick, /clear, /annonce @everyone (programmer, « Envoyer maintenant »,
 *        publication à l'échéance). Pré-contrôle avant l'action, signalement après.
 *  S38 : /channel renouveler resynchronise les règles AutoMod natives (exemption, salon d'alerte).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { PermissionFlagsBits: P } = require('discord.js');
const { createHarness, IDS } = require('./harness');

const opt = (name, type, value) => ({ name, type, value });
const sub = (name, options = []) => [{ name, type: 1, options }];
const incidents = (h) => h.client.repositories.securityIncidents.recent(h.guild.id, 20);
const buttonsOf = (m) => (m?.components ?? []).flatMap((r) => r.components ?? []);
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAAABJRU5ErkJggg==';
const BLOCKED = /bloquée par la sécurité/i;

async function setup(modules, extra = {}) {
  const h = await createHarness();
  h.configure({
    logChannels: { security: IDS.channels.logs, moderation: IDS.channels.logs },
    antiraid: { enabled: false },
    automod: { enabled: false },
    tempVoice: { enabled: false },
    secur: { modules },
    ...extra,
  });
  return h;
}

const everyoneOverwrite = (h, channelId) => h.guild.channels.cache.get(channelId).permissionOverwrites.cache.get(IDS.roles.everyone);
const overwriteCalls = (h, mark, channelId) => h.fake.calls.slice(mark).filter((c) => ['PUT', 'DELETE'].includes(c.method) && c.route === `/channels/${channelId}/permissions/${IDS.roles.everyone}`);

// ---------------------------------------------------------------- S12 : /unhide, /unlock

test('S12 /unhide : refus natif de « Voir le salon » levé par un admin non whitelisté (channelUpdate actif) → refus d\'emblée, salon intact ; whitelisté → ouvert', async () => {
  const h = await setup({ channelUpdate: { mode: 'on' } });
  try {
    const member = () => h.guild.members.cache.get(IDS.users.member);
    const staff = () => h.guild.channels.cache.get(IDS.channels.staff);
    assert.equal(staff().permissionsFor(member()).has(P.ViewChannel), false, 'précondition : #staff privé');
    const mark = h.fake.calls.length;
    const rec = await h.slash('unhide', [opt('salon', 7, IDS.channels.staff)], { as: 'admin' });
    await h.settle();
    assert.equal(h.isError(rec), true, 'unhide accepté sans contrôle Secur');
    assert.match(h.replyText(rec), BLOCKED);
    assert.equal(overwriteCalls(h, mark, IDS.channels.staff).length, 0, 'surcharge modifiée malgré le refus');
    assert.equal(staff().permissionsFor(member()).has(P.ViewChannel), false, '#staff ouvert à tous');

    // Admin whitelisté : exempté en mode « on » → ouvert, sans incident.
    h.configure({ whitelist: { users: [IDS.users.admin], roles: [] } });
    const ok = await h.slash('unhide', [opt('salon', 7, IDS.channels.staff)], { as: 'admin' });
    await h.settle();
    assert.equal(h.isError(ok), false, h.replyText(ok));
    assert.equal(staff().permissionsFor(member()).has(P.ViewChannel), true);
    assert.equal(incidents(h).length, 0);
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('S12 /unhide et /unlock : lever un /hide ou un /lock du bot reste permis (non contrôlé) à un modérateur non whitelisté', async () => {
  const h = await setup({ channelUpdate: { mode: 'on' } });
  try {
    const member = () => h.guild.members.cache.get(IDS.users.member);
    const general = () => h.guild.channels.cache.get(IDS.channels.general);
    for (const [on, off, flag] of [['hide', 'unhide', P.ViewChannel], ['lock', 'unlock', P.SendMessages]]) {
      const a = await h.slash(on, [opt('salon', 7, IDS.channels.general)], { as: 'admin' });
      assert.equal(h.isError(a), false, `/${on} : ${h.replyText(a)}`);
      await h.settle();
      assert.equal(general().permissionsFor(member()).has(flag), false, `/${on} sans effet`);
      const b = await h.slash(off, [opt('salon', 7, IDS.channels.general)], { as: 'admin' });
      await h.settle();
      assert.equal(h.isError(b), false, `/${off} refusé alors qu'il lève l'action du bot : ${h.replyText(b)}`);
      assert.equal(general().permissionsFor(member()).has(flag), true, `/${off} sans effet`);
    }
    assert.equal(h.client.services.secur.windowSum(h.guild.id, IDS.users.admin, 'channelUpdate'), 0);
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('S12 /unlock : refus natif d\'écrire dans #règles (aucun état sauvegardé) → refus d\'emblée, salon toujours en lecture seule', async () => {
  const h = await setup({ channelUpdate: { mode: 'on' } });
  try {
    await h.asHuman('owner').perform('PUT', `/channels/${IDS.channels.rules}/permissions/${IDS.roles.everyone}`, { type: 0, allow: '0', deny: String(P.SendMessages) });
    await h.settle();
    const canWrite = () => h.guild.channels.cache.get(IDS.channels.rules).permissionsFor(h.guild.members.cache.get(IDS.users.member)).has(P.SendMessages);
    assert.equal(canWrite(), false);
    const mark = h.fake.calls.length;
    const rec = await h.slash('unlock', [opt('salon', 7, IDS.channels.rules)], { as: 'admin' });
    await h.settle();
    assert.equal(h.isError(rec), true, 'unlock accepté sans contrôle Secur');
    assert.match(h.replyText(rec), BLOCKED);
    assert.equal(overwriteCalls(h, mark, IDS.channels.rules).length, 0);
    assert.equal(canWrite(), false, '#règles rouvert');
    assert.ok(everyoneOverwrite(h, IDS.channels.rules)?.deny?.has(P.SendMessages));
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

// ---------------------------------------------------------------- S12 : /emoji supprimer

test('S12 /emoji supprimer (expressions actif, seuil 3) : les suppressions via le bot sont comptées, la 3e est refusée avant Discord', async () => {
  const h = await setup({ expressions: { mode: 'on' } });
  try {
    const owner = h.asHuman('owner');
    for (let i = 0; i < 4; i += 1) await owner.perform('POST', `/guilds/${h.guild.id}/emojis`, { name: `emo_${i}`, image: PNG });
    await h.settle();
    const count = () => (h.fake.guild.emojis ?? []).length;
    const start = count();
    const results = [];
    for (let i = 0; i < 3; i += 1) {
      const rec = await h.slash('emoji', sub('supprimer', [opt('emoji', 3, `emo_${i}`)]), { as: 'admin' });
      if (!h.isError(rec)) await h.confirm(rec);
      await h.settle();
      results.push(h.isError(rec) ? h.replyText(rec) : 'ok');
    }
    assert.deepEqual(results.slice(0, 2), ['ok', 'ok'], results.join(' | '));
    assert.match(results[2], BLOCKED, 'la 3e suppression aurait dû être refusée');
    assert.equal(start - count(), 2, 'emojis supprimés');
    assert.ok(h.fake.guild.emojis.some((e) => e.name === 'emo_2'), 'emoji supprimé malgré le refus');
    assert.equal(h.client.services.secur.windowSum(h.guild.id, IDS.users.admin, 'expressions'), 2, 'suppressions via le bot non signalées');
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

// ---------------------------------------------------------------- S12 : /voice

test('S12 /voice cleanup (voiceKick actif, seuil 5) : 7 déconnexions refusées d\'emblée ; /voice kick d\'un membre accepté et compté', async () => {
  const h = await setup({ voiceKick: { mode: 'on' } });
  try {
    const extra = [];
    for (let i = 0; i < 7; i += 1) extra.push(h.addUser(`V${i}`));
    for (const u of extra) await h.memberJoin(u);
    for (const u of extra) await h.voice(u.id, 'voice');
    const inVoice = () => [...h.fake.voiceStates.values()].filter((s) => s.channel_id === IDS.channels.voice).length;
    assert.equal(inVoice(), 7);
    const rec = await h.slash('voice', sub('cleanup', [opt('salon', 7, IDS.channels.voice)]), { as: 'mod' });
    await h.settle();
    assert.equal(h.isError(rec), true, 'cleanup accepté sans contrôle Secur');
    assert.match(h.replyText(rec), BLOCKED);
    assert.equal(inVoice(), 7, 'membres déconnectés malgré le refus');

    const one = await h.slash('voice', sub('kick', [opt('membre', 6, extra[0].id)]), { as: 'mod' });
    await h.settle();
    assert.equal(h.isError(one), false, h.replyText(one));
    assert.equal(inVoice(), 6);
    assert.equal(h.client.services.secur.windowSum(h.guild.id, IDS.users.mod, 'voiceKick'), 1, 'déconnexion via le bot non signalée');
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

// ---------------------------------------------------------------- S12 : /clear

test('S12 /clear (messagePurge actif, seuil 2 purges ≥ 20) : 1re purge comptée, 2e refusée avant Discord ; petite purge non concernée', async () => {
  const h = await setup({ messagePurge: { mode: 'on' } });
  try {
    for (let i = 0; i < 70; i += 1) await h.userMessage({ as: 'member', channel: 'general', content: `message ${i}` });
    const inGeneral = () => [...h.fake.messages.values()].filter((m) => m.channel_id === IDS.channels.general && m.author?.id === IDS.users.member).length;
    const before = inGeneral();
    const first = await h.slash('clear', [opt('nombre', 4, 30)], { as: 'mod', channel: 'general' });
    await h.settle();
    assert.equal(h.isError(first), false, h.replyText(first));
    assert.equal(h.client.services.secur.windowSum(h.guild.id, IDS.users.mod, 'messagePurge'), 1, 'purge via le bot non signalée');
    const afterFirst = inGeneral();
    assert.ok(before - afterFirst >= 20);
    const second = await h.slash('clear', [opt('nombre', 4, 30)], { as: 'mod', channel: 'general' });
    await h.settle();
    assert.equal(h.isError(second), true, '2e purge acceptée sans contrôle Secur');
    assert.match(h.replyText(second), BLOCKED);
    assert.equal(inGeneral(), afterFirst, 'messages purgés malgré le refus');
    // Sous minMessages (20) : pas une purge pour Secur.
    const small = await h.slash('clear', [opt('nombre', 4, 5)], { as: 'mod', channel: 'general' });
    await h.settle();
    assert.equal(h.isError(small), false, h.replyText(small));
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

// ---------------------------------------------------------------- S12 : /annonce @everyone

test('S12 /annonce @everyone (everyone actif) : refusée à la programmation, à « Envoyer maintenant » et à l\'échéance (annonce désactivée, rien publié)', async () => {
  const h = await setup({ everyone: { mode: 'on' } });
  try {
    const findButton = (m, prefix) => buttonsOf(m).find((c) => c.custom_id?.startsWith(prefix));
    // 1) Programmation refusée (comme /embed texte notifier_tous).
    const rec = await h.slash('annonce', sub('programmer', [opt('salon', 7, IDS.channels.general), opt('date', 3, '+2h'), opt('role', 8, IDS.roles.everyone)]), { as: 'admin' });
    assert.equal(h.isError(rec), true, 'programmation @everyone acceptée sans contrôle Secur');
    assert.match(h.replyText(rec), BLOCKED);

    // 2) Programmée module coupé, puis module activé : « Envoyer maintenant » refusé.
    h.configure({ secur: { modules: { everyone: { mode: 'off' } } } });
    const rec2 = await h.slash('annonce', sub('programmer', [opt('salon', 7, IDS.channels.general), opt('date', 3, '+2h'), opt('role', 8, IDS.roles.everyone)]), { as: 'admin' });
    assert.equal(h.isError(rec2), false, h.replyText(rec2));
    const preview = await h.submitModal(rec2, { titre: 'Annonce', message: 'Venez tous', couleur: '', image: '' });
    const pm = h.message(preview.original);
    await h.click(pm, findButton(pm, 'cmd:annonce:confirm:').custom_id, { as: 'admin' });
    h.configure({ secur: { modules: { everyone: { mode: 'on' } } } });
    const list = await h.slash('annonce', sub('liste'), { as: 'admin' });
    const lm = h.message(list.original);
    const mark = h.fake.calls.length;
    const sendRec = await h.click(lm, findButton(lm, 'cmd:annonce:asend:').custom_id, { as: 'admin' });
    await h.settle();
    assert.equal(h.isError(sendRec), true, '« Envoyer maintenant » @everyone accepté sans contrôle Secur');
    const posts = () => h.fake.calls.slice(mark).filter((c) => c.method === 'POST' && c.route === `/channels/${IDS.channels.general}/messages`);
    assert.equal(posts().length, 0, '@everyone publié malgré le refus');

    // 3) À l'échéance : l'auteur n'est pas autorisé par Secur → annonce désactivée, rien publié.
    const repo = h.client.repositories.announcements;
    const row = repo.list(h.guild.id, { limit: 5, offset: 0 }).find((r) => r.role_id === IDS.roles.everyone && r.status === 'scheduled');
    assert.ok(row, 'annonce programmée introuvable');
    repo.skipTo(row.id, { nextRun: Date.now() - 1_000, runs: 0 });
    h.client.services.secur.refusals?.clear?.();
    await h.client.services.announcements.processDue();
    await h.settle();
    assert.equal(posts().length, 0, '@everyone publié par le scheduler malgré Secur');
    assert.equal(repo.byId(row.id).status, 'disabled');
    assert.match(repo.byId(row.id).last_error ?? '', /sécurité/);
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('S12 /annonce @everyone : auteur whitelisté → publiée à l\'échéance (contrôle sans effet sur un exempté)', async () => {
  const h = await setup({ everyone: { mode: 'on' } }, { whitelist: { users: [IDS.users.admin], roles: [] } });
  try {
    const repo = h.client.repositories.announcements;
    const id = repo.createDraft({ guildId: h.guild.id, channelId: IDS.channels.general, authorId: IDS.users.admin, roleId: IDS.roles.everyone, timeZone: 'Europe/Paris', runAt: Date.now() + 3_600_000 });
    repo.setContent(h.guild.id, id, { title: 'Annonce', message: 'Venez tous' });
    repo.schedule(h.guild.id, id, Date.now() - 1_000);
    const mark = h.fake.calls.length;
    await h.client.services.announcements.processDue();
    await h.settle();
    const post = h.fake.calls.slice(mark).find((c) => c.method === 'POST' && c.route === `/channels/${IDS.channels.general}/messages`);
    assert.ok(post, 'annonce d\'un auteur whitelisté non publiée');
    assert.deepEqual(post.body.allowed_mentions?.parse, ['everyone']);
    assert.equal(incidents(h).length, 0);
    // Seul « problème » relevé : le @everyone voulu de l'annonce.
    assert.equal(h.problems().massMentions.length, 1, h.formatProblems());
    h.resetProblems();
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});
