'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PermissionsBitField, PermissionFlagsBits } = require('discord.js');
const { ScheduledAnnouncementRepository } = require('../src/database/repositories/ScheduledAnnouncementRepository');
const A = require('../src/services/AnnouncementService');
const { occurrence, nextAfter, localToUtc } = require('../src/utils/calendar');
const annonce = require('../src/commands/utility/annonce');
const { GUILD, ROLE, CH, USER, apiError, fakeGuild, fakeClient, fakeChannel } = require('./scheduled.helper');

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const TZ = 'Europe/Paris';

function setup() {
  const guild = fakeGuild();
  const client = fakeClient(guild);
  const repo = new ScheduledAnnouncementRepository(client.db);
  client.repositories = { announcements: repo };
  const service = new A.AnnouncementService({ client, announcements: repo });
  return { guild, client, repo, service };
}

/** Crée une annonce programmée (brouillon rempli puis confirmé). */
function scheduled(repo, { runAt = Date.now() - 1000, repeat = 'none', roleId = null, channelId = CH.general } = {}) {
  const id = repo.createDraft({ guildId: GUILD, channelId, authorId: USER.mod, roleId, repeat, timeZone: TZ, runAt });
  repo.setContent(GUILD, id, { title: 'Soirée jeux', message: 'Rendez-vous à 21 h !', color: 0xff8800 });
  repo.schedule(GUILD, id, runAt);
  return id;
}

test('répétitions : même heure locale malgré le changement d\'heure, fin de mois respectée', () => {
  // 28 mars 2026 10:00 à Paris (UTC+1) → 29 mars 10:00 (UTC+2).
  const anchor = localToUtc({ year: 2026, month: 3, day: 28, hour: 10, minute: 0 }, TZ);
  assert.equal(new Date(anchor).toISOString(), '2026-03-28T09:00:00.000Z');
  assert.equal(new Date(occurrence(anchor, 'daily', TZ, 1)).toISOString(), '2026-03-29T08:00:00.000Z');
  assert.equal(new Date(occurrence(anchor, 'weekly', TZ, 1)).toISOString(), '2026-04-04T08:00:00.000Z');
  const jan31 = localToUtc({ year: 2027, month: 1, day: 31, hour: 18, minute: 30 }, TZ);
  assert.equal(new Date(occurrence(jan31, 'monthly', TZ, 1)).toISOString(), '2027-02-28T17:30:00.000Z');
  assert.equal(new Date(occurrence(jan31, 'monthly', TZ, 2)).toISOString(), '2027-03-31T16:30:00.000Z');
  assert.equal(nextAfter(anchor, 'none', TZ, 0, anchor), null);
  // Panne de 10 jours : on reprend à la prochaine occurrence future, sans rattrapage.
  const next = nextAfter(anchor, 'daily', TZ, 0, anchor + 10 * DAY + HOUR);
  assert.equal(next.runs, 11);
  assert.ok(next.at > anchor + 10 * DAY + HOUR && next.at - (anchor + 10 * DAY + HOUR) < DAY);
});

test('parseAnnounceDate : 14h30, 25/12 18h (année suivante si passée), +2h, invalide', () => {
  const now = Date.parse('2026-12-26T10:00:00Z');
  assert.equal(new Date(annonce.parseAnnounceDate('25/12 18h', TZ, now)).toISOString(), '2027-12-25T17:00:00.000Z');
  assert.equal(new Date(annonce.parseAnnounceDate('31/12 9h15', TZ, now)).toISOString(), '2026-12-31T08:15:00.000Z');
  assert.equal(annonce.parseAnnounceDate('+2h', TZ, now), now + 2 * HOUR);
  assert.equal(new Date(annonce.parseAnnounceDate('14h30', TZ, now)).toISOString(), '2026-12-26T13:30:00.000Z');
  assert.equal(annonce.parseAnnounceDate('31/02 10h', TZ, now), null);
  assert.equal(annonce.parseAnnounceDate('n\'importe quoi', TZ, now), null);
  assert.equal(annonce.canonicalTimeZone('europe/paris'), 'Europe/Paris');
  assert.equal(annonce.canonicalTimeZone('Mars/Olympus'), null);
});

test('mentions : allowedMentions explicite, @everyone et rôle non mentionnable soumis à permission', () => {
  assert.deepEqual(A.mentionOf({ guild_id: GUILD, role_id: null }).allowedMentions, { parse: [] });
  assert.deepEqual(A.mentionOf({ guild_id: GUILD, role_id: GUILD }), { content: '@everyone', allowedMentions: { parse: ['everyone'] } });
  assert.deepEqual(A.mentionOf({ guild_id: GUILD, role_id: ROLE.safe }), { content: `<@&${ROLE.safe}>`, allowedMentions: { parse: [], roles: [ROLE.safe] } });
  const guild = fakeGuild();
  const none = new PermissionsBitField(PermissionFlagsBits.ManageGuild);
  const all = new PermissionsBitField(PermissionFlagsBits.ManageGuild | PermissionFlagsBits.MentionEveryone);
  assert.throws(() => A.assertMentionAllowed(guild, GUILD, none), /@everyone/);
  assert.doesNotThrow(() => A.assertMentionAllowed(guild, GUILD, all));
  assert.throws(() => A.assertMentionAllowed(guild, ROLE.other, none), /pas mentionnable/);
  assert.doesNotThrow(() => A.assertMentionAllowed(guild, ROLE.other, all));
  assert.doesNotThrow(() => A.assertMentionAllowed(guild, ROLE.safe, none));
  assert.throws(() => A.assertMentionAllowed(guild, ROLE.bot, all), /intégration/);
  assert.doesNotThrow(() => A.assertMentionAllowed(guild, null, none));
});

test('carte publiée : titre, couleur de l\'auteur, image ; le contenu ne pingue que la mention prévue', () => {
  const payload = A.announcementPayload({ guild_id: GUILD, role_id: ROLE.safe, title: 'Titre', message: '@everyone venez', color: 0x123456, image: 'https://exemple.com/a.png' });
  assert.equal(payload.content, `<@&${ROLE.safe}>`);
  assert.equal(payload.embeds[0].color, 0x123456);
  assert.equal(payload.embeds[0].image.url, 'https://exemple.com/a.png');
  assert.deepEqual(payload.allowedMentions, { parse: [], roles: [ROLE.safe] });
});

test('processDue : envoi unique publié puis terminé ; brouillons abandonnés purgés', async () => {
  const { guild, repo, service, client } = setup();
  const id = scheduled(repo, { roleId: ROLE.safe });
  const stale = repo.createDraft({ guildId: GUILD, channelId: CH.general, authorId: USER.mod, timeZone: TZ, runAt: Date.now() + HOUR, now: Date.now() - 2 * DAY });
  await service.processDue();
  const ch = guild.channels.cache.get(CH.general);
  assert.equal(ch.sent.length, 1);
  assert.equal(ch.sent[0].content, `<@&${ROLE.safe}>`);
  assert.equal(repo.get(GUILD, id).status, 'done');
  assert.equal(repo.get(GUILD, stale), null);
  await service.processDue();
  assert.equal(ch.sent.length, 1, 'jamais publiée deux fois');
  assert.equal(client.logs.length, 0);
});

test('processDue : répétition quotidienne reprogrammée à la même heure', async () => {
  const { repo, service } = setup();
  const runAt = Date.now() - 1000;
  const id = scheduled(repo, { runAt, repeat: 'daily' });
  await service.processDue();
  const row = repo.get(GUILD, id);
  assert.equal(row.status, 'scheduled');
  assert.equal(row.runs, 1);
  assert.equal(row.sent_count, 1);
  assert.equal(row.next_run, occurrence(runAt, 'daily', TZ, 1));
});

test('processDue : salon supprimé ou permission retirée → désactivée + log ; erreur transitoire → réessai', async () => {
  const { guild, repo, service, client } = setup();
  const missing = scheduled(repo, { channelId: '400000000000000099' });
  await service.processDue();
  assert.equal(repo.get(GUILD, missing).status, 'disabled');
  assert.match(repo.get(GUILD, missing).last_error, /supprimé/);
  assert.equal(client.logs[0].category, 'server');
  assert.match(client.logs[0].embed.title, /désactivée/);

  guild.channels.cache.set(CH.general, fakeChannel(CH.general, { perms: PermissionFlagsBits.ViewChannel }));
  const noperm = scheduled(repo);
  await service.processDue();
  assert.equal(repo.get(GUILD, noperm).status, 'disabled');

  const flaky = fakeChannel(CH.general, { fail: apiError(500) });
  guild.channels.cache.set(CH.general, flaky);
  const retry = scheduled(repo);
  await service.processDue();
  assert.equal(repo.get(GUILD, retry).status, 'scheduled');
  assert.ok(repo.get(GUILD, retry).last_error);
  flaky.fail = apiError(50013);
  await service.processDue();
  assert.equal(repo.get(GUILD, retry).status, 'disabled', 'erreur définitive');
});

test('sendNow : publie sans décaler la répétition ; envoi unique terminé', async () => {
  const { guild, repo, service } = setup();
  const weekly = scheduled(repo, { runAt: Date.now() + DAY, repeat: 'weekly' });
  const before = repo.get(GUILD, weekly).next_run;
  await service.sendNow(guild, weekly, { id: USER.mod });
  assert.equal(repo.get(GUILD, weekly).next_run, before);
  assert.equal(repo.get(GUILD, weekly).status, 'scheduled');
  const once = scheduled(repo, { runAt: Date.now() + DAY });
  await service.sendNow(guild, once, { id: USER.mod });
  assert.equal(repo.get(GUILD, once).status, 'done');
  await assert.rejects(service.sendNow(guild, once, { id: USER.mod }), /plus programmée/);
  assert.equal(guild.channels.cache.get(CH.general).sent.length, 2);
});

test('channelIssue : salon vocal refusé', () => {
  const guild = fakeGuild();
  assert.match(A.channelIssue(guild, CH.voice), /textuel/);
  assert.equal(A.channelIssue(guild, CH.general), null);
});
