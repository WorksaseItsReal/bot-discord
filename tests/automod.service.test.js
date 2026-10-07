'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { memoryDb } = require('./db.helper');
const { AutoModService, escalationStep, messageText, mostSevere } = require('../src/services/AutoModService');
const { AutomodEventRepository } = require('../src/database/repositories/AutomodEventRepository');
const { PRESETS } = require('../src/utils/automod/presets');
const { defaultGuildConfig } = require('../src/config/defaults');
const native = require('../src/services/NativeAutoMod');

let seq = 0;
function msg(content, { channelId = 'c1', userId = 'u1', extra = {} } = {}) {
  seq += 1;
  return { id: `m${seq}`, guild: { id: 'g1' }, author: { id: userId, createdTimestamp: 0 }, channel: { id: channelId }, content, ...extra };
}
const svc = (deps = {}) => new AutoModService({ config: {}, logging: {}, moderation: {}, ...deps });

test('spam multi-salons : même message dans 3 salons → violation + copies à supprimer', () => {
  const s = svc();
  const filters = { antiCrossChannel: { enabled: true, channels: 3, windowSeconds: 60, minLength: 12, action: 'timeout', duration: '1h' } };
  const text = 'Free nitro ici https://example.com/claim';
  assert.equal(s.inspect(msg(text, { channelId: 'a' }), filters), null);
  assert.equal(s.inspect(msg(text, { channelId: 'b' }), filters), null);
  const hit = s.inspect(msg(text, { channelId: 'c' }), filters);
  assert.equal(hit.filter, 'antiCrossChannel');
  assert.equal(hit.related.length, 2);
  // Messages courts (« gm ») ignorés : pas de faux positif.
  for (const c of ['x', 'y', 'z']) assert.equal(s.inspect(msg('gm', { channelId: c, userId: 'u2' }), filters), null);
});

test('nouveaux venus : liens bloqués pour un compte récent, pas pour un ancien', () => {
  const s = svc();
  const rules = { enabled: true, accountAgeDays: 7, joinedMinutes: 30, blockLinks: true, blockInvites: true };
  const recent = msg('regarde site.com', { extra: { author: { id: 'n1', createdTimestamp: Date.now() - 3600_000 }, member: { joinedTimestamp: Date.now() - 86400_000 * 30 } } });
  assert.equal(s.inspect(recent, {}, { temporal: false, newMembers: rules })?.filter, 'newMembers');
  const old = msg('regarde site.com', { extra: { author: { id: 'n2', createdTimestamp: 0 }, member: { joinedTimestamp: Date.now() - 86400_000 * 30 } } });
  assert.equal(s.inspect(old, {}, { temporal: false, newMembers: rules }), null);
});

test('messages transférés analysés (contournement par « Transférer »)', () => {
  const snapshots = new Map([['x', { content: 'rejoins discord.gg/arnaque' }]]);
  const m = msg('', { extra: { messageSnapshots: snapshots } });
  assert.match(messageText(m), /discord\.gg\/arnaque/);
  assert.equal(svc().inspect(m, { antiInvite: { enabled: true } })?.filter, 'antiInvite');
});

test('liste blanche : domaine et invitation autorisés, invitation du serveur tolérée', () => {
  const s = svc();
  const filters = {
    antiLink: { enabled: true, allowedDomains: ['youtube.com'] },
    antiInvite: { enabled: true, allowedCodes: ['partenaire'], allowOwnServer: true },
  };
  assert.equal(s.inspect(msg('https://www.youtube.com/watch?v=1'), filters, { temporal: false }), null);
  assert.equal(s.inspect(msg('discord.gg/partenaire'), filters, { temporal: false }), null);
  const own = msg('discord.gg/monserveur', { extra: { guild: { id: 'g1', vanityURLCode: 'monserveur' } } });
  assert.equal(s.inspect(own, filters, { temporal: false }), null);
  assert.equal(s.inspect(msg('https://evil.ru/x'), filters, { temporal: false })?.filter, 'antiLink');
});

test('fils : un fil d\'un salon ignoré est ignoré ; les modérateurs sont immunisés', () => {
  const s = svc();
  const cfg = { ignoredChannels: ['parent'], ignoredRoles: [] };
  assert.ok(s.isExempt({ channel: { id: 'thread', parentId: 'parent' }, member: { permissions: { has: () => false }, roles: { cache: { some: () => false } } } }, cfg));
  assert.ok(s.isExempt({ channel: { id: 'x' }, member: { permissions: { has: () => true } } }, cfg));
  assert.ok(!s.isExempt({ channel: { id: 'x' }, member: { permissions: { has: () => false }, roles: { cache: { some: () => false } } } }, cfg));
});

test('sévérité : timeout long > timeout court > avertissement > suppression', () => {
  const best = mostSevere([
    { action: 'delete' },
    { action: 'timeout', duration: '5m' },
    { action: 'warn' },
    { action: 'timeout', duration: '1h' },
  ]);
  assert.equal(best.duration, '1h');
  const steps = defaultGuildConfig.automod.escalation.steps;
  assert.equal(escalationStep(steps, 2), null);
  assert.equal(escalationStep(steps, 4).duration, '10m');
  assert.equal(escalationStep(steps, 9).action, 'kick');
});

test('sanctions progressives : la 3e infraction monte en timeout (journal persistant)', async () => {
  const { db } = memoryDb();
  const events = new AutomodEventRepository(db);
  const calls = [];
  const moderation = {
    timeout: async (...a) => { calls.push(['timeout', a[4]]); return { id: 9 }; },
    record: async () => ({ id: 1 }),
  };
  const config = {
    get: () => ({
      automod: {
        enabled: true, ignoredChannels: [], ignoredRoles: [], notify: 'none',
        escalation: { enabled: true, windowMinutes: 30, steps: [{ count: 3, action: 'timeout', duration: '10m' }] },
        filters: { antiLink: { enabled: true, action: 'delete' } },
      },
    }),
  };
  const logs = [];
  const s = new AutoModService({ config, logging: { send: async (...a) => logs.push(a) }, moderation, events });
  const make = () => ({
    ...msg('https://spam.example'),
    guild: { id: 'g1', members: { me: { id: 'bot' } }, channels: { cache: new Map() } },
    author: { id: 'u9', bot: false, createdTimestamp: 0, toString: () => '<@u9>' },
    member: { permissions: { has: () => false }, roles: { cache: { some: () => false } } },
    channel: { id: 'c1', toString: () => '<#c1>' },
    delete: async () => {},
  });
  await s.handleMessage(make());
  await s.handleMessage(make());
  assert.equal(calls.length, 0);
  await s.handleMessage(make());
  assert.deepEqual(calls, [['timeout', 600_000]]);
  assert.equal(events.countRecent('g1', 'u9', 0), 3);
  const detail = logs[2][2].toJSON().fields.find((f) => f.name.includes('Détail')).value;
  assert.match(detail, /Sanction progressive : 3 infractions/);
  assert.equal(events.stats('g1', 0).byFilter[0].filter, 'antiLink');
  // L'action FINALE (timeout d'escalade) est celle enregistrée pour les statistiques.
  assert.ok(events.stats('g1', 0).byAction.some((a) => a.action === 'timeout'));
});

test('suppression impossible signalée dans le log', async () => {
  const config = { get: () => ({ automod: { enabled: true, ignoredChannels: [], ignoredRoles: [], filters: { antiZalgo: { enabled: true } } } }) };
  const logs = [];
  const s = new AutoModService({ config, logging: { send: async (...a) => logs.push(a) }, moderation: {} });
  await s.handleMessage({
    ...msg('h̸̢̛̛̙͎e̶̢̧̛l̴̡̛̛l̸̨̧̛o̸̢̧̢'),
    guild: { id: 'g1', members: { me: { id: 'bot' } } },
    author: { id: 'u1', bot: false, toString: () => '<@u1>' },
    member: { permissions: { has: () => false }, roles: { cache: { some: () => false } } },
    channel: { id: 'c1', toString: () => '<#c1>' },
    delete: async () => { throw new Error('perm'); },
  });
  assert.match(logs[0][2].toJSON().description, /pas pu le supprimer/);
});

test('préréglages : uniquement des clés connues de la configuration', () => {
  const known = defaultGuildConfig.automod;
  for (const [name, p] of Object.entries(PRESETS)) {
    for (const key of Object.keys(p.patch)) assert.ok(key in known, `${name} : ${key}`);
    for (const f of Object.keys(p.patch.filters)) assert.ok(f in known.filters, `${name} : filtre ${f}`);
    assert.ok(!('words' in (p.patch.filters.badWords ?? {})), 'les listes ne sont jamais écrasées');
  }
});

test('AutoMod natif : règles conformes aux limites Discord', () => {
  const rules = native.desiredRules({ filters: { badWords: { enabled: true, words: ['Con', 'x'.repeat(61), 'arnaque*'] }, antiMassMention: { enabled: true, limit: 99 }, antiSpam: { enabled: true } }, ignoredRoles: Array(30).fill('1') }, '42');
  const kw = rules.find((r) => r.name === native.NAMES.keywords);
  assert.deepEqual(kw.triggerMetadata.keywordFilter, ['con', 'arnaque*']);
  assert.equal(rules.find((r) => r.name === native.NAMES.mentions).triggerMetadata.mentionTotalLimit, 50);
  assert.ok(rules.every((r) => r.exemptRoles.length <= 20 && r.actions.length === 2));
  assert.equal(native.desiredRules({ filters: {} }).length, 0, 'aucune règle sans filtre actif');
  const m = native.desiredRules({ filters: { antiMassMention: { enabled: true, limit: 5 } } });
  assert.equal(m[0].triggerMetadata.mentionTotalLimit, 4, 'aligné : le bot sanctionne à 5, Discord bloque au-delà de 4');
});

test('giveaways : les gagnants sont mémorisés pour exclure tous les anciens lors d\'une relance', () => {
  const { db } = memoryDb();
  const { GiveawayRepository } = require('../src/database/repositories/GiveawayRepository');
  const repo = new GiveawayRepository(db);
  const id = repo.create({ guildId: 'g', channelId: 'c', messageId: null, prize: 'P', winners: 1, hostId: 'h', requiredRole: null, forbiddenRole: null, endsAt: Date.now() });
  repo.addWinners(id, ['a']);
  repo.addWinners(id, ['b', 'a']);
  assert.deepEqual(repo.winners(id).sort(), ['a', 'b']);
});

test('revue : GIF Tenor et liste blanche respectés pour les nouveaux venus ; messages système ignorés', async () => {
  const s = svc();
  const rules = { enabled: true, accountAgeDays: 7, joinedMinutes: 30, blockLinks: true, blockInvites: true };
  const fresh = (content) => msg(content, { extra: { author: { id: 'n1', createdTimestamp: Date.now() } } });
  assert.equal(s.inspect(fresh('https://tenor.com/view/chat-123'), { antiLink: { allowedDomains: [] } }, { temporal: false, newMembers: rules }), null);
  assert.equal(s.inspect(fresh('https://youtube.com/x'), { antiLink: { allowedDomains: ['youtube.com'] } }, { temporal: false, newMembers: rules }), null);
  assert.equal(s.inspect(fresh('https://evil.ru/x'), { antiLink: {} }, { temporal: false, newMembers: rules })?.filter, 'newMembers');
  const config = { get: () => { throw new Error('ne doit pas être lu'); } };
  await new AutoModService({ config, logging: {}, moderation: {} }).handleMessage({ guild: { id: 'g' }, author: { bot: false }, system: true });
});

test('revue : sous-domaines Discord/Tenor tolérés par l\'anti-liens', () => {
  const s = svc();
  const filters = { antiLink: { enabled: true, allowedDomains: [] } };
  for (const t of ['https://ptb.discord.com/channels/1/2/3', 'https://media.tenor.com/x.gif', 'https://cdn.discordapp.com/a.png']) {
    assert.equal(s.inspect(msg(t), filters, { temporal: false }), null, t);
  }
});

test('revue : copies multi-salons conservées même si un filtre plus sévère l\'emporte', () => {
  const s = svc();
  const filters = {
    antiCrossChannel: { enabled: true, channels: 2, windowSeconds: 60, minLength: 5, action: 'delete' },
    antiInvite: { enabled: true, action: 'timeout', duration: '1h' },
  };
  s.inspect(msg('rejoins discord.gg/arnaque vite', { channelId: 'a', userId: 'x9' }), filters);
  const hit = s.inspect(msg('rejoins discord.gg/arnaque vite', { channelId: 'b', userId: 'x9' }), filters);
  assert.equal(hit.filter, 'antiInvite');
  assert.equal(hit.related.length, 1);
});
