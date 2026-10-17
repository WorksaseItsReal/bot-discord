'use strict';

/**
 * ADM2 — /membres liste, bout en bout : /membres nu inchangé, listes réservées (admins,
 * modérateurs) refusées à un membre et accordées à un modérateur (commande ET boutons de page),
 * bots, boosters (tri), vocal filtré selon le lecteur, rôle (/inrole), pagination sur un gros
 * serveur, délai entre deux listes, jamais de ping.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { ChannelType, OverwriteType, PermissionFlagsBits: P } = require('discord.js');
const { createHarness, IDS, EPHEMERAL } = require('./harness');
const { explore } = require('./lib/explore');

const opt = (name, type, value) => ({ name, type, value });
const liste = (value, extra = []) => [opt('liste', 3, value), ...extra];
const buttonsOf = (m) => (m?.components ?? []).flatMap((r) => r.components ?? []);
const embedText = (h, rec) => JSON.stringify(h.messagesOf(rec)[0]?.embeds?.[0] ?? {});

async function setup(opts) {
  const h = await createHarness(opts);
  h.configureAll();
  h.configure({ antiraid: { enabled: false } });
  return h;
}

/** Modifie un membre côté Discord (GUILD_MEMBER_UPDATE réel). */
async function patchMember(h, userId, patch) {
  const m = h.fake.members.get(userId);
  Object.assign(m, patch);
  h.fake.dispatchNow('GUILD_MEMBER_UPDATE', { ...m, guild_id: h.guild.id });
  await h.settle();
}

test('/membres sans option : compteur inchangé (titre, champs, Actualiser)', async () => {
  const h = await setup();
  try {
    const rec = await h.slash('membres', [], { as: 'member' });
    const [msg] = h.messagesOf(rec);
    assert.match(msg.embeds[0].title, /Membres de Serveur de test/);
    assert.ok(!(msg.flags & EPHEMERAL));
    assert.ok(buttonsOf(msg).some((b) => b.custom_id === `cmd:membres:refresh:${IDS.users.member}`));
    assert.deepEqual(msg.embeds[0].fields.map((f) => f.name.replace(/^\S+\s+/, '')).slice(0, 2), ['Total', 'En ligne']);
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('liste admins : refusée à un membre, accordée à un modérateur (éphémère, bots et bots de confiance signalés) ; modérateurs ; bots', async () => {
  const h = await setup();
  try {
    h.configure({ secur: { trustedBots: [IDS.users.bot] } });
    const denied = await h.slash('membres', liste('admins'), { as: 'member' });
    assert.ok(h.isError(denied));
    assert.match(h.replyText(denied), /réservée à la modération/);
    const rec = await h.slash('membres', liste('admins'), { as: 'mod' });
    const [msg] = h.messagesOf(rec);
    assert.ok(msg.flags & EPHEMERAL, 'liste des administrateurs publique');
    assert.equal(msg.content ?? '', '', 'contenu hors embed (ping possible)');
    const text = embedText(h, rec);
    assert.ok(text.includes(`<@${IDS.users.admin}>`) && text.includes(`<@${IDS.users.owner}>`) && text.includes(`<@${IDS.users.bot}>`), text);
    assert.ok(!text.includes(`<@${IDS.users.mod}>`), 'modérateur listé comme administrateur');
    assert.match(text, /propriétaire/);
    assert.match(text, /de confiance/);

    const mods = await h.slash('membres', liste('moderateurs'), { as: 'mod' });
    const modsText = embedText(h, mods);
    assert.ok(modsText.includes(`<@${IDS.users.mod}>`) && !modsText.includes(`<@${IDS.users.admin}>`), modsText);
    assert.ok(h.isError(await h.slash('membres', liste('moderateurs'), { as: 'member' })));

    const bots = await h.slash('membres', liste('bots'), { as: 'member' });
    const botsText = embedText(h, bots);
    assert.ok(botsText.includes(`<@${IDS.users.bot}>`) && botsText.includes(`<@${IDS.users.otherBot}>`), botsText);
    assert.match(botsText, /ajouté <t:\d+:R>/);
    assert.ok(!(h.messagesOf(bots)[0].flags & EPHEMERAL));
    assert.ok(!botsText.includes('de confiance'), 'réglage de sécurité révélé dans une liste publique');
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('boosters triés par ancienneté ; vocal filtré selon le lecteur ; rôle délégué à /inrole ; options incohérentes ; délai de 10 s', async () => {
  const h = await setup();
  try {
    await patchMember(h, IDS.users.member, { premium_since: new Date(Date.now() - 10 * 86_400_000).toISOString() });
    await patchMember(h, IDS.users.target, { premium_since: new Date(Date.now() - 400 * 86_400_000).toISOString() });
    const boosters = embedText(h, await h.slash('membres', liste('boosters'), { as: 'member' }));
    assert.ok(boosters.indexOf(`<@${IDS.users.target}>`) < boosters.indexOf(`<@${IDS.users.member}>`) && boosters.includes(`<@${IDS.users.member}>`), boosters);

    const priv = await h.guild.channels.create({ name: 'Direction', type: ChannelType.GuildVoice, permissionOverwrites: [{ id: h.guild.id, type: OverwriteType.Role, deny: P.ViewChannel }, { id: IDS.users.target, type: OverwriteType.Member, allow: P.ViewChannel | P.Connect }] });
    await h.settle();
    await h.voice('mod', 'voice');
    await h.voice('target', priv.id);
    const memberView = await h.slash('membres', liste('vocal'), { as: 'member' });
    assert.ok(h.messagesOf(memberView)[0].flags & EPHEMERAL);
    const mv = embedText(h, memberView);
    assert.ok(mv.includes(`<@${IDS.users.mod}>`), mv);
    assert.ok(!mv.includes(`<@${IDS.users.target}>`) && !mv.includes(priv.id), 'occupant d\'un salon invisible révélé');
    assert.match(mv, /1 autre\(s\) connecté\(s\)/);
    const adminView = embedText(h, await h.slash('membres', liste('vocal'), { as: 'admin' }));
    assert.ok(adminView.includes(`<@${IDS.users.target}>`) && adminView.includes(priv.id), adminView);

    const role = await h.slash('membres', liste('role', [opt('role', 8, IDS.roles.gamer)]), { as: 'member' });
    assert.match(h.replyText(role), /Membres avec Joueur/);
    const roleOnly = await h.slash('membres', [opt('role', 8, IDS.roles.gamer)], { as: 'member' });
    assert.match(h.replyText(roleOnly), /Membres avec Joueur/);
    assert.match(h.replyText(await h.slash('membres', liste('role'), { as: 'member' })), /Choisissez le rôle/);
    assert.match(h.replyText(await h.slash('membres', liste('bots', [opt('role', 8, IDS.roles.gamer)]), { as: 'member' })), /ne sert qu'avec/);

    // Délai : deux listes coup sur coup (délais du bot conservés).
    await h.slash('membres', liste('bots'), { as: 'admin' });
    h.client.cooldowns.release(`membres:${IDS.users.admin}`); // délai propre à la commande (2 s)
    const again = await h.slash('membres', liste('bots'), { as: 'admin', keepCooldowns: true });
    assert.match(h.replyText(again), /Patientez/);
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('gros serveur : 31 modérateurs paginés par 20 ; boutons de page réservés et revérifiés ; exploration', async () => {
  const h = await setup({ big: true });
  try {
    const crowd = Object.keys(h.users).filter((k) => k.startsWith('crowd')).slice(0, 30).map((k) => h.users[k].id);
    for (const id of crowd) await patchMember(h, id, { roles: [...h.fake.members.get(id).roles, IDS.roles.mod] });
    const rec = await h.slash('membres', liste('moderateurs'), { as: 'mod' });
    const [msg] = h.messagesOf(rec);
    assert.match(msg.embeds[0].footer?.text ?? '', /Page 1\/2/);
    const next = buttonsOf(msg).find((b) => b.custom_id === `cmd:membres:list:moderateurs:1:${IDS.users.mod}`);
    assert.ok(next, JSON.stringify(buttonsOf(msg).map((b) => b.custom_id)));
    const page2 = await h.click(msg, next.custom_id, { as: 'mod' });
    assert.ok(!h.isError(page2), h.replyText(page2));
    assert.match(h.message(msg.id).embeds[0].footer?.text ?? '', /Page 2\/2/);
    // Bouton d'un autre : refusé ; permission perdue entre-temps : refusée au clic.
    assert.ok(h.isError(await h.click(msg, next.custom_id, { as: 'admin' })));
    await patchMember(h, IDS.users.mod, { roles: [IDS.roles.member] });
    const lost = await h.click(h.message(msg.id), `cmd:membres:list:moderateurs:0:${IDS.users.mod}`, { as: 'mod' });
    assert.match(h.replyText(lost), /réservée à la modération/);
    await patchMember(h, IDS.users.mod, { roles: [IDS.roles.mod, IDS.roles.member] });
    const fresh = await h.slash('membres', liste('moderateurs'), { as: 'mod' });
    const stats = await explore(h, fresh, { as: 'mod', budget: 8 });
    assert.ok(stats.buttons >= 1);
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});
