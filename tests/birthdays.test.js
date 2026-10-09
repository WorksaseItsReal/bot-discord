'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { BirthdayRepository } = require('../src/database/repositories/BirthdayRepository');
const B = require('../src/services/BirthdayService');
const { isBirthdayOn, nextBirthday, celebratedDay, localParts, localToUtc, formatDayMonth } = require('../src/utils/calendar');
const anniversaire = require('../src/commands/utility/anniversaire');
const { GUILD, ROLE, CH, USER, fakeMember, fakeGuild, fakeClient } = require('./scheduled.helper');

const TZ = 'Europe/Paris';

function setup({ hour = 0 } = {}) {
  const guild = fakeGuild();
  const client = fakeClient(guild);
  const repo = new BirthdayRepository(client.db);
  client.repositories = { birthdays: repo };
  const service = new B.BirthdayService({ client, birthdays: repo, config: client.services.config });
  client.services.config.update(GUILD, { birthdays: { enabled: true, channelId: CH.general, roleId: ROLE.safe, timeZone: TZ, hour } });
  const member = fakeMember(guild, USER.a);
  guild.members.cache.set(member.id, member);
  return { guild, client, repo, service, member };
}

/** Midi (heure de Paris) d'une date. */
const parisNoon = (year, month, day) => localToUtc({ year, month, day, hour: 12 }, TZ);

test('29 février fêté le 28 les années non bissextiles ; prochains anniversaires triés', () => {
  const leapling = { day: 29, month: 2 };
  assert.equal(celebratedDay(29, 2, 2027), 28);
  assert.equal(celebratedDay(29, 2, 2028), 29);
  assert.ok(isBirthdayOn(leapling, { year: 2027, month: 2, day: 28 }));
  assert.ok(!isBirthdayOn(leapling, { year: 2028, month: 2, day: 28 }));
  assert.ok(isBirthdayOn(leapling, { year: 2028, month: 2, day: 29 }));
  assert.deepEqual(nextBirthday(leapling, { year: 2027, month: 1, day: 10 }), { year: 2027, month: 2, day: 28, inDays: 49 });
  assert.equal(nextBirthday({ day: 10, month: 1 }, { year: 2027, month: 1, day: 10 }).inDays, 0);
  assert.equal(nextBirthday({ day: 9, month: 1 }, { year: 2027, month: 1, day: 10 }).year, 2028);
  const sorted = B.upcoming([{ user_id: '2', day: 1, month: 3 }, { user_id: '1', day: 15, month: 1 }], { year: 2027, month: 1, day: 10 });
  assert.deepEqual(sorted.map((e) => e.row.user_id), ['1', '2']);
  assert.equal(formatDayMonth(1, 5), '1er mai');
});

test('âge : jamais affiché sans accord ; la ligne {age} disparaît ; @everyone neutralisé', () => {
  assert.equal(B.shownAge({ year: 2000, show_age: 0 }, 2026), null);
  assert.equal(B.shownAge({ year: null, show_age: 1 }, 2026), null);
  assert.equal(B.shownAge({ year: 2000, show_age: 1 }, 2026), 26);
  const hidden = B.renderBirthday(B.DEFAULT_MESSAGE, { id: USER.a, name: 'Alice', server: 'S', age: null });
  assert.ok(!/ans aujourd/.test(hidden) && !/\{age\}/.test(hidden));
  assert.match(hidden, new RegExp(`<@${USER.a}>`));
  assert.match(B.renderBirthday(B.DEFAULT_MESSAGE, { id: USER.a, name: 'Alice', server: 'S', age: 26 }), /26 ans/);
  assert.ok(!/@everyone/.test(B.renderBirthday('@everyone {pseudo}', { id: null, name: '@here', server: 'S', age: null }).replace(/@​/g, '')));
  assert.deepEqual(B.unknownVariables('{membre} {prenom} {age}'), ['prenom']);
});

test('processDue : un message par jour et par membre, rôle porté 24 h puis retiré', async () => {
  const { guild, client, repo, service, member } = setup();
  const now = parisNoon(2026, 7, 14);
  repo.set({ guildId: GUILD, userId: USER.a, day: 14, month: 7, year: 1990, showAge: true });
  repo.set({ guildId: GUILD, userId: USER.b, day: 15, month: 7 }); // demain
  await service.processDue({ now });
  const ch = guild.channels.cache.get(CH.general);
  assert.equal(ch.sent.length, 1);
  assert.equal(ch.sent[0].content, `<@${USER.a}>`);
  assert.deepEqual(ch.sent[0].allowedMentions, { parse: [], users: [USER.a] });
  assert.match(ch.sent[0].embeds[0].toJSON().description, /36 ans/);
  assert.ok(member.roles.cache.has(ROLE.safe));
  const row = repo.get(GUILD, USER.a);
  assert.equal(row.last_celebrated, '2026-07-14');
  assert.equal(row.role_id, ROLE.safe);

  // Redémarrage (cache perdu) : la date mémorisée en base empêche un second message.
  service.invalidate(GUILD);
  await service.processDue({ now: now + 3_600_000 });
  assert.equal(ch.sent.length, 1);

  await service.processDue({ now: row.role_until + 1000 });
  assert.ok(!member.roles.cache.has(ROLE.safe), 'rôle retiré après 24 h');
  assert.equal(repo.get(GUILD, USER.a).role_until, null);
  assert.equal(client.logs.length, 0);
});

test('processDue : membre parti ignoré, heure d\'envoi et désactivation respectées', async () => {
  const { guild, client, repo, service } = setup({ hour: 9 });
  repo.set({ guildId: GUILD, userId: USER.b, day: 14, month: 7 }); // absent du serveur
  repo.set({ guildId: GUILD, userId: USER.a, day: 14, month: 7 });
  const early = localToUtc({ year: 2026, month: 7, day: 14, hour: 8 }, TZ);
  await service.processDue({ now: early });
  const ch = guild.channels.cache.get(CH.general);
  assert.equal(ch.sent.length, 0, 'avant 9 h : rien');
  await service.processDue({ now: early + 2 * 3_600_000 });
  assert.equal(ch.sent.length, 1);
  assert.equal(repo.get(GUILD, USER.b).last_celebrated, null, 'membre parti : rien mémorisé');
  client.services.config.update(GUILD, { birthdays: { enabled: false } });
  repo.set({ guildId: GUILD, userId: USER.a, day: 15, month: 7 });
  service.invalidate(GUILD);
  await service.processDue({ now: parisNoon(2026, 7, 15) });
  assert.equal(ch.sent.length, 1, 'désactivé : rien');
});

test('processDue : 29 février fêté le 28 en année non bissextile ; salon inutilisable signalé une fois', async () => {
  const { guild, client, repo, service, member } = setup();
  repo.set({ guildId: GUILD, userId: USER.a, day: 29, month: 2 });
  guild.channels.cache.delete(CH.general);
  await service.processDue({ now: parisNoon(2027, 2, 28) });
  assert.ok(member.roles.cache.has(ROLE.safe), 'rôle donné même sans salon');
  assert.equal(repo.get(GUILD, USER.a).last_celebrated, '2027-02-28');
  assert.equal(client.logs.length, 1);
  assert.match(client.logs[0].embed.title, /non annoncés/);
});

test('date locale du serveur selon le fuseau', () => {
  const instant = Date.parse('2026-07-14T23:30:00Z');
  assert.equal(localParts(instant, 'Europe/Paris').day, 15);
  assert.equal(localParts(instant, 'America/Montreal').day, 14);
});

test('/anniversaire : sous-commandes et boutons', () => {
  const json = anniversaire.data.toJSON();
  assert.deepEqual(json.options.map((o) => o.name), ['definir', 'retirer', 'liste', 'config']);
  assert.equal(json.default_member_permissions, undefined, 'ouverte à tous ; config revérifie « Gérer le serveur »');
  for (const a of ['page', 'ctoggle', 'cchannel', 'crole', 'cmessage', 'cmessagesubmit', 'ctime', 'ctimesubmit', 'cpreview', 'crefresh']) assert.equal(typeof anniversaire.buttons[a], 'function', a);
  assert.equal(anniversaire.inDaysLabel(1), 'demain');
});
