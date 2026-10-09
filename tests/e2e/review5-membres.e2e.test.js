'use strict';

/**
 * Bout en bout : régressions de la revue n° 5 (économie, mini-jeux, outils des membres)
 * sur le vrai discord.js — /afk et le filtre des pseudos de l'AutoMod, /snipe dans un fil
 * privé, suppression d'un fil (THREAD_DELETE), remboursement d'un rôle acheté, « De retour »
 * après un message filtré, raison d'absence avec un lien.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { PermissionFlagsBits: P } = require('discord.js');
const { createHarness, IDS } = require('./harness');

const opt = (name, type, value) => ({ name, type, value });
const sub = (name, options = []) => [{ name, type: 1, options }];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Messages publiés par le bot dans un salon depuis `mark`. */
function botMessagesIn(h, channelId, mark = 0) {
  return h.fake.messageLog.slice(mark).map((id) => h.message(id)).filter((m) => m && m.channel_id === channelId && m.author.id === h.client.user.id);
}

/** AutoMod réduit aux filtres donnés. */
function onlyFilters(h, keys, extra = {}) {
  const filters = Object.fromEntries(Object.keys(h.client.services.config.get(h.guild.id).automod.filters).map((k) => [k, { enabled: keys.includes(k) }]));
  h.configure({ automod: { enabled: true, filters, newMembers: { enabled: false }, ...extra } });
}

test('/afk et filtre des pseudos : le préfixe [AFK] n\'est jamais pris pour un « dehoist », le pseudo est rendu au retour', async () => {
  const h = await createHarness();
  h.configureAll();
  onlyFilters(h, ['badNames']);
  Object.assign(h.client.services.afk, { delayMs: 5, ttlMs: 60 });
  const automod = h.client.services.automod;
  const nick = () => h.fake.members.get(IDS.users.member)?.nick ?? null;
  const renameLogs = () => [...h.fake.messages.values()].filter((m) => m.channel_id === IDS.channels.logs && /Pseudo renommé/.test(m.embeds?.[0]?.title ?? ''));
  try {
    await h.guild.members.cache.get(IDS.users.member).setNickname('Bob');
    await h.settle();
    assert.equal(nick(), 'Bob');

    await h.slash('afk', [opt('raison', 3, 'Parti déjeuner')], { as: 'member' });
    await sleep(20);
    await h.settle();
    assert.equal(nick(), '[AFK] Bob', 'le préfixe AFK a été remplacé par l\'AutoMod');
    assert.equal(renameLogs().length, 0, 'faux log « Pseudo renommé »');

    // Même sans la tolérance de 60 s (événement tardif, membre précédent inconnu) : le préfixe est ignoré.
    automod.allowedNames.clear();
    const member = h.guild.members.cache.get(IDS.users.member);
    assert.equal(await automod.checkMemberName(member, { source: 'update' }), null);
    // Le nom sous le préfixe reste vérifié : « [AFK] !Bob » posé par /afk est filtré pour « ! ».
    h.client.repositories.afk.setAfkNick(h.guild.id, IDS.users.member, '[AFK] !Bob');
    const fakeMember = { id: member.id, guild: member.guild, user: member.user, nickname: '[AFK] !Bob', permissions: member.permissions, roles: member.roles, manageable: false };
    const r = await automod.checkMemberName(fakeMember, { source: 'update' });
    assert.equal(r?.violation?.check, 'dehoist');
    assert.match(r.violation.detail, /« ! »/);
    h.client.repositories.afk.setAfkNick(h.guild.id, IDS.users.member, '[AFK] Bob');

    await h.userMessage({ as: 'member', content: 'je suis de retour' });
    await sleep(20);
    await h.settle();
    assert.equal(nick(), 'Bob', 'pseudo d\'origine non rendu au retour');
    assert.equal(renameLogs().length, 0);

    // Renommage fait par le bot hors de toute tolérance (exécutant du journal d'audit = le bot) : ignoré.
    automod.allowedNames.clear();
    await h.guild.members.cache.get(IDS.users.member).setNickname('!Bob');
    await sleep(20);
    await h.settle();
    assert.equal(nick(), '!Bob', 'un renommage du bot a été refiltré');
    assert.equal(renameLogs().length, 0);
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});
