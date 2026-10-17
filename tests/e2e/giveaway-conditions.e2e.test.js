'use strict';

/**
 * Bout en bout : conditions de participation aux giveaways (niveau minimum, invitations
 * minimum, ancienneté sur le serveur) sur le vrai discord.js : affichées sur la carte,
 * vérifiées à l'inscription (refus clair) ET au tirage (un participant qui ne les remplit
 * plus n'est pas tiré).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness, IDS } = require('./harness');
const { levelFromXp, totalXpForLevel } = require('../../src/services/LevelService');

const opt = (name, type, value) => ({ name, type, value });
const sub = (name, options = []) => [{ name, type: 1, options }];
const embedText = (msg) => (msg?.embeds ?? []).flatMap((e) => [e.title, e.description, ...(e.fields ?? []).flatMap((f) => [f.name, f.value])]).filter(Boolean).join('\n');

test('giveaway : niveau, invitations et ancienneté minimum vérifiés à l\'inscription et au tirage', async () => {
  const h = await createHarness();
  h.configureAll();
  const guildId = h.guild.id;
  const levels = h.client.repositories.levels;
  const joins = h.client.repositories.inviteJoins;
  const setLevel = (userId, level) => levels.setXp(guildId, userId, totalXpForLevel(level), levelFromXp);
  const invite = (inviterId) => joins.recordJoin({ guildId, userId: h.addUser(`Invité ${Math.random().toString(36).slice(2, 6)}`).id, inviterId });
  try {
    const mark = h.fake.messageLog.length;
    const created = await h.slash('giveaway', sub('create', [
      opt('recompense', 3, 'Nitro'), opt('duree', 3, '1h'), opt('gagnants', 4, 1),
      opt('niveau_min', 4, 3), opt('invitations_min', 4, 1), opt('anciennete_min', 4, 30),
    ]));
    assert.match(h.replyText(created), /Giveaway #1 lancé/, h.replyText(created));
    const g = h.client.repositories.giveaways.get(1);
    assert.deepEqual([g.min_level, g.min_invites, g.min_days], [3, 1, 30]);
    const card = h.fake.messageLog.slice(mark).map((id) => h.message(id)).find((m) => m?.components?.[0]?.components?.[0]?.custom_id === 'giveaway:enter:1');
    assert.ok(card, 'carte du giveaway absente');
    const text = embedText(card);
    assert.match(text, /Niveau minimum : \*\*3\*\*/);
    assert.match(text, /Invitations minimum : \*\*1\*\*/);
    assert.match(text, /depuis au moins \*\*30 jours\*\*/);

    // Niveau insuffisant, puis invitations insuffisantes : refus clairs, rien d'enregistré.
    let rec = await h.click(card, 'giveaway:enter:1', { as: 'member' });
    assert.ok(h.isError(rec));
    assert.match(h.replyText(rec), /niveau 3.*vous êtes niveau \*\*0\*\*/s);
    setLevel(IDS.users.member, 3);
    rec = await h.click(card, 'giveaway:enter:1', { as: 'member' });
    assert.match(h.replyText(rec), /au moins \*\*1 invitation\*\*/);
    assert.equal(h.client.repositories.giveaways.countEntries(1), 0);
    invite(IDS.users.member);
    rec = await h.click(card, 'giveaway:enter:1', { as: 'member' });
    assert.ok(!h.isError(rec), h.replyText(rec));
    assert.match(h.replyText(rec), /Participation enregistrée/);

    // Arrivé aujourd'hui : refusé (ancienneté), avec la date à laquelle il pourra participer.
    const newcomer = h.addUser('Nouveau', { ageDays: 500 });
    await h.memberJoin(newcomer);
    setLevel(newcomer.id, 10);
    invite(newcomer.id);
    rec = await h.click(card, 'giveaway:enter:1', { as: newcomer.id });
    assert.ok(h.isError(rec));
    assert.match(h.replyText(rec), /depuis au moins \*\*30 jours\*\*.*<t:\d+:R>/s);

    // Au tirage : un participant qui ne remplit plus la condition de niveau n'est pas tiré.
    setLevel(IDS.users.target, 5);
    invite(IDS.users.target);
    rec = await h.click(card, 'giveaway:enter:1', { as: 'target' });
    assert.ok(!h.isError(rec), h.replyText(rec));
    assert.equal(h.client.repositories.giveaways.countEntries(1), 2);
    levels.resetMember(guildId, IDS.users.member);
    for (let i = 0; i < 5; i += 1) {
      // Tirage aléatoire : la seule personne éligible doit gagner à chaque fois.
      const winners = await h.client.services.giveaways.end(1, { reroll: i > 0, guildId }).catch((err) => err);
      if (i === 0) assert.deepEqual(winners, [IDS.users.target]);
      else assert.ok(winners instanceof Error, 'reroll : aucun autre participant ne remplit les conditions');
    }

    // Liste : conditions affichées.
    await h.slash('giveaway', sub('create', [opt('recompense', 3, 'Rôle VIP'), opt('duree', 3, '1h'), opt('anciennete_min', 4, 7)]));
    const list = await h.slash('giveaway', sub('list'));
    assert.match(embedText(h.messagesOf(list)[0]), /depuis au moins \*\*7 jours\*\*/);

    // Niveaux désactivés : avertissement à la création.
    h.configure({ levels: { enabled: false } });
    const warned = await h.slash('giveaway', sub('create', [opt('recompense', 3, 'Badge'), opt('duree', 3, '1h'), opt('niveau_min', 4, 2)]));
    assert.match(h.replyText(warned), /niveaux est désactivé/);
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});
