'use strict';

/**
 * ADM2 — /voice, bout en bout : régression de la preuve « voice-overwrite-bypass » (aucune action
 * dans un vocal fermé à l'auteur, aucun PATCH), /voice rassembler (deux salons sources, salon privé
 * jamais vidé, exécutions simultanées, bouton « Renvoyer chacun », double clic, expiration).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { ChannelType, OverwriteType, PermissionFlagsBits: P } = require('discord.js');
const { createHarness, IDS } = require('./harness');
const { explore } = require('./lib/explore');

const opt = (name, type, value) => ({ name, type, value });
const sub = (name, options = []) => [{ name, type: 1, options }];
const buttonsOf = (m) => (m?.components ?? []).flatMap((r) => r.components ?? []);
/** PATCH vocaux (déplacement, déconnexion, micro) envoyés pour un membre. */
const voicePatches = (h, mark, userId = null) => h.fake.calls.slice(mark).filter((c) => c.method === 'PATCH' && /\/guilds\/\d+\/members\/\d+$/.test(c.route)
  && (!userId || c.route.endsWith(`/${userId}`)) && c.body && ('channel_id' in c.body || 'mute' in c.body));
const where = (h, key) => h.fake.voiceStates.get(IDS.users[key] ?? key)?.channel_id ?? null;

async function setup() {
  const h = await createHarness();
  h.configureAll();
  // Plusieurs arrivées et déplacements rapprochés : l'AntiRaid et les vocaux temporaires sont hors sujet.
  h.configure({ antiraid: { enabled: false }, tempVoice: { enabled: false } });
  return h;
}

async function voiceChannel(h, name, permissionOverwrites = []) {
  const ch = await h.guild.channels.create({ name, type: ChannelType.GuildVoice, parent: IDS.channels.catVoice, permissionOverwrites });
  await h.settle();
  return ch;
}

test('régression (preuve) : mute, kick et cleanup refusés dans un vocal qui refuse la permission à l\'auteur — AUCUN PATCH', async () => {
  const h = await setup();
  try {
    const raw = h.fake.channels.get(IDS.channels.voice);
    raw.permission_overwrites = [{ id: IDS.roles.mod, type: 0, allow: '0', deny: String(P.ViewChannel | P.Connect | P.MoveMembers | P.MuteMembers) }];
    h.fake.dispatchNow('CHANNEL_UPDATE', raw);
    await h.voice('target', 'voice');
    const mark = h.fake.calls.length;
    for (const [name, options] of [['mute', [opt('membre', 6, IDS.users.target)]], ['kick', [opt('membre', 6, IDS.users.target)]], ['cleanup', [opt('salon', 7, IDS.channels.voice)]]]) {
      const rec = await h.slash('voice', sub(name, options), { as: 'mod', channel: 'general' });
      assert.ok(h.isError(rec), `/voice ${name} : ${h.replyText(rec).slice(0, 120)}`);
    }
    assert.deepEqual(voicePatches(h, mark), [], 'action envoyée à Discord dans un vocal fermé au modérateur');
    assert.equal(where(h, 'target'), IDS.channels.voice);
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('/voice rassembler : deux salons sources, salon privé de l\'auteur jamais vidé (occupants non révélés), puis « Renvoyer chacun »', async () => {
  const h = await setup();
  try {
    const a = await voiceChannel(h, 'Salle A');
    const b = await voiceChannel(h, 'Salle B');
    const priv = await voiceChannel(h, 'Direction', [
      { id: IDS.roles.mod, type: OverwriteType.Role, deny: P.ViewChannel | P.MoveMembers | P.Connect },
      { id: IDS.users.owner, type: OverwriteType.Member, allow: P.ViewChannel | P.Connect },
    ]);
    await h.voice('mod', 'voice');
    await h.voice('member', a.id);
    await h.voice('target', b.id);
    await h.voice('owner', priv.id);
    const rec = await h.slash('voice', sub('rassembler'), { as: 'mod', channel: 'general' });
    assert.ok(!h.isError(rec), h.replyText(rec));
    assert.equal(where(h, 'member'), IDS.channels.voice);
    assert.equal(where(h, 'target'), IDS.channels.voice);
    assert.equal(where(h, 'owner'), priv.id, 'salon fermé à l\'auteur vidé');
    const [summary] = h.messagesOf(rec);
    const text = JSON.stringify(summary.embeds[0]);
    assert.match(text, /Membres rassemblés/);
    assert.ok(!text.includes('Direction') && !text.includes(IDS.users.owner) && !text.includes('Propriétaire'), 'occupants du salon privé révélés');
    assert.match(summary.embeds[0].fields.find((f) => /Salons ignorés/.test(f.name)).value, /1/);

    // « Renvoyer chacun » : réservé à l'auteur, chacun retourne dans son salon d'origine, une seule fois.
    const scatter = buttonsOf(summary).find((c) => c.custom_id?.startsWith('cmd:voice:scatter:'));
    assert.ok(scatter, 'bouton Renvoyer absent');
    assert.ok(h.isError(await h.click(summary, scatter.custom_id, { as: 'admin' })), 'bouton d\'un autre accepté');
    // Double clic : deux interactions parties avant la mise à jour du message → un seul renvoi.
    const mark = h.fake.calls.length;
    const clicks = await Promise.all([h.click(summary, scatter.custom_id, { as: 'mod' }), h.click(summary, scatter.custom_id, { as: 'mod' })]);
    await h.settle();
    const [back] = clicks.filter((r) => !h.isError(r));
    assert.ok(back, clicks.map((r) => h.replyText(r)).join(' / '));
    assert.match(clicks.filter((r) => h.isError(r)).map((r) => h.replyText(r)).join(''), /expiré|déjà en cours/);
    assert.equal(where(h, 'member'), a.id);
    assert.equal(where(h, 'target'), b.id);
    assert.equal(voicePatches(h, mark).length, 2, 'renvoi exécuté deux fois');
    assert.ok(!buttonsOf(h.message(summary.id)).some((c) => c.custom_id?.startsWith('cmd:voice:scatter:')), 'bouton Renvoyer resté');
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('/voice rassembler : deux exécutions simultanées → une seule ; renvoi revérifié (membre parti entre-temps)', async () => {
  const h = await setup();
  try {
    const a = await voiceChannel(h, 'Salle A');
    await h.voice('admin', 'voice');
    await h.voice('member', a.id);
    await h.voice('target', a.id);
    const mark = h.fake.calls.length;
    const [r1, r2] = await Promise.all([
      h.slash('voice', sub('rassembler', [opt('vers', 7, IDS.channels.voice)]), { as: 'admin', channel: 'general' }),
      h.slash('voice', sub('rassembler', [opt('vers', 7, IDS.channels.voice)]), { as: 'mod', channel: 'general' }),
    ]);
    await h.settle();
    assert.equal([r1, r2].filter((r) => h.isError(r)).length, 1, `${h.replyText(r1)} / ${h.replyText(r2)}`);
    assert.match(h.replyText(h.isError(r1) ? r1 : r2), /déjà en cours/);
    assert.equal(voicePatches(h, mark).length, 2, 'membres déplacés deux fois');
    // Le membre change lui-même de salon : il n'est pas ramené de force.
    const ok = h.isError(r1) ? r2 : r1;
    const as = ok === r1 ? 'admin' : 'mod';
    await h.voice('member', 'hub');
    const [summary] = h.messagesOf(ok);
    const button = buttonsOf(summary).find((c) => c.custom_id?.startsWith('cmd:voice:scatter:'));
    const back = await h.click(summary, button.custom_id, { as });
    assert.match(h.replyText(back), /renvoyé/);
    assert.equal(where(h, 'member'), IDS.channels.hub, 'membre parti ramené de force');
    assert.equal(where(h, 'target'), a.id);
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('/voice rassembler : refus clairs (pas en vocal, source = cible, membre sans permission) ; bouton après redémarrage expiré ; exploration', async () => {
  const h = await setup();
  try {
    const noVoice = await h.slash('voice', sub('rassembler'), { as: 'mod' });
    assert.match(h.replyText(noVoice), /Rejoignez un salon vocal/);
    const same = await h.slash('voice', sub('rassembler', [opt('vers', 7, IDS.channels.voice), opt('depuis', 7, IDS.channels.voice)]), { as: 'mod' });
    assert.match(h.replyText(same), /identiques/);
    const denied = await h.slash('voice', sub('rassembler', [opt('vers', 7, IDS.channels.voice)]), { as: 'member' });
    assert.ok(h.isError(denied));

    // Bots ignorés par défaut, inclus sur demande.
    const a = await voiceChannel(h, 'Salle A');
    await h.voice('otherBot', a.id);
    await h.voice('member', a.id);
    const rec = await h.slash('voice', sub('rassembler', [opt('vers', 7, IDS.channels.voice)]), { as: 'admin' });
    assert.equal(where(h, 'otherBot'), a.id, 'bot déplacé sans l\'option');
    assert.match(JSON.stringify(h.messagesOf(rec)[0].embeds[0]), /bot/);
    await h.slash('voice', sub('rassembler', [opt('vers', 7, IDS.channels.voice), opt('bots', 5, true)]), { as: 'admin' });
    assert.equal(where(h, 'otherBot'), IDS.channels.voice);

    // Lots perdus (redémarrage) : le bouton répond « expiré ».
    const [summary] = h.messagesOf(rec);
    const button = buttonsOf(summary).find((c) => c.custom_id?.startsWith('cmd:voice:scatter:'));
    h.client.commands.get('voice')._batches.clear();
    assert.match(h.replyText(await h.click(summary, button.custom_id, { as: 'admin' })), /expiré/);

    // Exploration d'un nouveau bilan (administrateur, puis membre).
    await h.voice('member', a.id);
    const fresh = await h.slash('voice', sub('rassembler', [opt('vers', 7, IDS.channels.voice)]), { as: 'admin' });
    await explore(h, fresh, { as: 'member', budget: 5 });
    assert.equal(where(h, 'member'), IDS.channels.voice, 'un membre a renvoyé les autres');
    const stats = await explore(h, fresh, { budget: 6 });
    assert.ok(stats.buttons >= 1);
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});
