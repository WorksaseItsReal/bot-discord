'use strict';

/**
 * ADM2 — listes de /membres (src/utils/memberLists.js) : humains et bots administrateurs, bots de
 * confiance, modérateurs, bots par date d'ajout, tri des boosters, vocal filtré selon le lecteur,
 * pagination sur 1 000 membres, accès réservé.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { PermissionFlagsBits: P, PermissionsBitField } = require('discord.js');
const { collect, buildListPage, canViewRestricted, pageCount, PER_PAGE, LIST_TYPES } = require('../src/utils/memberLists');
const membres = require('../src/commands/information/membres');

const DAY = 86_400_000;
function fakeMember(id, { name = `m${id}`, bot = false, perms = 0n, joined = 0, boost = null } = {}) {
  return {
    id,
    displayName: name,
    user: { id, username: name.toLowerCase(), bot },
    permissions: new PermissionsBitField(perms),
    joinedTimestamp: joined,
    premiumSinceTimestamp: boost,
    toString: () => `<@${id}>`,
  };
}
const guild = { id: 'g', ownerId: '1', name: 'Serveur' };

test('admins : propriétaire d\'abord, humains puis bots, bots de confiance signalés ; modérateurs sans les admins', () => {
  const members = [
    fakeMember('3', { name: 'Zoé', perms: P.Administrator }),
    fakeMember('9', { name: 'Robot', bot: true, perms: P.Administrator }),
    fakeMember('1', { name: 'Owner', perms: P.Administrator }),
    fakeMember('4', { name: 'Modo', perms: P.BanMembers | P.ManageMessages }),
    fakeMember('5', { name: 'Membre' }),
    fakeMember('8', { name: 'BotModo', bot: true, perms: P.KickMembers }),
  ];
  const admins = collect('admins', { guild, members, trustedBots: ['9'] });
  assert.deepEqual(admins.rows.map((r) => r.slice(0, 5)), ['<@1> ', '<@3> ', '<@9> ']);
  assert.match(admins.rows[0], /propriétaire/);
  assert.match(admins.rows[2], /bot · ✅ de confiance/);
  assert.deepEqual(admins.counts, { humans: 2, bots: 1, trusted: 1 });
  const mods = collect('moderateurs', { guild, members, trustedBots: [] });
  assert.deepEqual(mods.rows.map((r) => r.slice(0, 5)), ['<@8> ', '<@4> ']);
  assert.match(mods.rows[1], /⛔🧹/);
  assert.deepEqual(mods.counts, { humans: 1, bots: 1 });
});

test('bots par date d\'ajout (le plus récent d\'abord) ; boosters du plus ancien au plus récent', () => {
  const now = Date.now();
  const members = [
    fakeMember('1', { bot: true, joined: now - 10 * DAY }),
    fakeMember('2', { bot: true, joined: now - DAY }),
    fakeMember('3', { boost: now - DAY }),
    fakeMember('4', { boost: now - 300 * DAY }),
    fakeMember('5'),
  ];
  assert.deepEqual(collect('bots', { guild, members }).rows.map((r) => r.slice(0, 5)), ['<@2> ', '<@1> ']);
  const boosters = collect('boosters', { guild, members });
  assert.deepEqual(boosters.rows.map((r) => r.slice(0, 5)), ['<@4> ', '<@3> ']);
  assert.match(boosters.rows[0], /depuis <t:\d+:D>/);
});

test('vocal : seuls les salons que le LECTEUR voit sont nommés, les autres connectés seulement comptés', () => {
  const viewer = { id: 'v' };
  const open = { id: 'c1', rawPosition: 0, toString: () => '<#c1>', permissionsFor: () => new PermissionsBitField(P.ViewChannel) };
  const closed = { id: 'c2', rawPosition: 1, toString: () => '<#c2>', permissionsFor: () => new PermissionsBitField(0n) };
  const a = fakeMember('a');
  const b = fakeMember('b');
  const voiceStates = [
    { id: 'a', channelId: 'c1', channel: open, member: a, selfMute: true },
    { id: 'b', channelId: 'c2', channel: closed, member: b },
    { id: 'x', channelId: null },
  ];
  const data = collect('vocal', { guild, voiceStates, viewer });
  assert.equal(data.rows.length, 1);
  assert.match(data.rows[0], /<@a> · 🔊 <#c1> · 🔇/);
  assert.equal(data.hidden, 1);
  const page = JSON.stringify(buildListPage('vocal', data, 0, { guildName: 'Serveur' }).toJSON());
  assert.ok(!page.includes('<#c2>') && !page.includes('<@b>'), 'salon ou membre invisible révélé');
  assert.match(page, /1 autre\(s\) connecté\(s\)/);
  // Sans lecteur connu : rien n'est nommé.
  assert.equal(collect('vocal', { guild, voiceStates, viewer: null }).rows.length, 0);
});

test('pagination : 1 000 bots → 50 pages de 20 lignes, page hors bornes ramenée, limites d\'une carte respectées', () => {
  const members = Array.from({ length: 1000 }, (_, i) => fakeMember(String(100000 + i), { bot: true, joined: i, name: `Bot ${'*_'.repeat(10)} ${i}` }));
  const data = collect('bots', { guild, members });
  assert.equal(pageCount(data.rows.length), 50);
  assert.equal(PER_PAGE, 20);
  for (const index of [0, 49, 120]) {
    const embed = buildListPage('bots', data, index, { guildName: 'Serveur', partial: true }).toJSON();
    assert.ok(embed.description.length <= 4096);
    assert.equal((embed.description.match(/<@\d+>/g) ?? []).length, 20);
    assert.match(embed.footer.text, new RegExp(`Page ${Math.min(index, 49) + 1}/50`));
    assert.match(embed.description, /incomplète/);
  }
  assert.equal(pageCount(0), 1);
  assert.match(JSON.stringify(buildListPage('boosters', collect('boosters', { guild, members: [] }), 0).toJSON()), /Personne/);
});

test('accès : admins et modérateurs réservés à Exclure temporairement OU Gérer le serveur ; options de /membres', () => {
  assert.equal(canViewRestricted(new PermissionsBitField(P.ModerateMembers)), true);
  assert.equal(canViewRestricted(new PermissionsBitField(P.ManageGuild)), true);
  assert.equal(canViewRestricted(new PermissionsBitField(P.Administrator)), true);
  assert.equal(canViewRestricted(new PermissionsBitField(P.KickMembers)), false);
  assert.equal(canViewRestricted(null), false);
  assert.ok(LIST_TYPES.admins.restricted && LIST_TYPES.moderateurs.restricted && !LIST_TYPES.bots.restricted);
  assert.ok(LIST_TYPES.vocal.ephemeral && LIST_TYPES.admins.ephemeral && !LIST_TYPES.boosters.ephemeral);
  const json = membres.data.toJSON();
  assert.deepEqual(json.options.map((o) => o.name), ['liste', 'role']);
  assert.ok(json.options.every((o) => !o.required), '/membres sans option doit rester possible');
  assert.deepEqual(json.options[0].choices.map((c) => c.value), ['admins', 'moderateurs', 'bots', 'boosters', 'vocal', 'role']);
  assert.equal(json.default_member_permissions ?? null, null);
});
