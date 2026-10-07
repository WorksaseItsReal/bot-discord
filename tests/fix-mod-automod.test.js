'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const c = require('../src/utils/automodChecks');
const { AutoModService, mostSevere, DUPLICATE_WINDOW_MS } = require('../src/services/AutoModService');

const msg = (content) => ({ guild: { id: 'g1' }, author: { id: 'u1' }, content });
const svc = (deps = {}) => new AutoModService({ config: {}, logging: {}, moderation: {}, ...deps });

test('M6 mots interdits : mots entiers, insensible à la casse, frontières Unicode, échappement', () => {
  assert.equal(c.containsBadWord('Quel CON !', ['con']), true);
  assert.equal(c.containsBadWord('un bon conseil', ['con']), false);
  assert.equal(c.containsBadWord('il a déconné', ['con']), false);
  assert.equal(c.containsBadWord('con2', ['con']), false);
  assert.equal(c.containsBadWord('Élan', ['élan']), true);
  assert.equal(c.containsBadWord('a.b', ['a.b']), true);
  assert.equal(c.containsBadWord('axb', ['a.b']), false);
  assert.equal(c.containsBadWord('un mot-clé ici', ['mot-clé']), true);
  assert.equal(c.containsBadWord('rien', ['', null]), false);
});

test('M6 RegExp des mots interdits compilée une fois par liste', () => {
  const words = ['foo', 'bar'];
  assert.equal(c.badWordRegex(words), c.badWordRegex(words));
  assert.notEqual(c.badWordRegex(words), c.badWordRegex(['foo', 'bar']));
});

test('M6 mentions : @everyone et @here comptent', () => {
  assert.equal(c.countMentions('@everyone @here <@1> <@!2> <@&3>'), 5);
  assert.equal(c.isMassMention('@everyone @here @everyone', { limit: 3 }), true);
  assert.equal(c.countMentions('mail@everyonex.com'), 0);
});

test('M6 doublon : seulement dans une fenêtre de 30 s', (t) => {
  const s = svc();
  const filters = { antiDuplicate: { enabled: true, action: 'delete' } };
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  assert.equal(s.inspect(msg('salut'), filters), null);
  now += DUPLICATE_WINDOW_MS + 1;
  assert.equal(s.inspect(msg('salut'), filters), null);
  now += 1000;
  assert.equal(s.inspect(msg('salut'), filters)?.reason, 'Message dupliqué');
});

test('M6 spam compté avant les doublons ; la violation la plus sévère l\'emporte', () => {
  const s = svc();
  const filters = {
    antiDuplicate: { enabled: true, action: 'delete' },
    antiSpam: { enabled: true, limit: 3, windowSeconds: 60, action: 'timeout', duration: '5m' },
  };
  assert.equal(s.inspect(msg('x'), filters), null);
  assert.equal(s.inspect(msg('x'), filters)?.action, 'delete'); // doublon, mais spam compté (2)
  const hit = s.inspect(msg('x'), filters); // doublon + spam : timeout plus sévère
  assert.equal(hit.action, 'timeout');
  assert.equal(hit.reason, 'Spam détecté');
});

test('M6 un filtre de contenu ne masque plus le comptage du spam', () => {
  const s = svc();
  const filters = {
    antiLink: { enabled: true, action: 'delete' },
    antiSpam: { enabled: true, limit: 3, windowSeconds: 60, action: 'timeout' },
  };
  s.inspect(msg('https://a.b'), filters);
  s.inspect(msg('https://a.b'), filters);
  assert.equal(s.inspect(msg('https://a.b'), filters).action, 'timeout');
});

test('mostSevere : timeout > warn > delete, premier à égalité', () => {
  assert.equal(mostSevere([]), null);
  assert.equal(mostSevere([{ action: 'delete', reason: 'a' }, { action: 'warn', reason: 'b' }, { action: 'delete', reason: 'c' }]).reason, 'b');
  assert.equal(mostSevere([{ action: 'warn', reason: 'a' }, { action: 'warn', reason: 'b' }]).reason, 'a');
});

function automodWorld({ action, timeoutImpl }) {
  const logs = [];
  const calls = { timeout: [], record: [], strikes: [] };
  const moderation = {
    timeout: async (...a) => { calls.timeout.push(a); if (timeoutImpl) return timeoutImpl(); return { id: 41 }; },
    record: async (...a) => { calls.record.push(a); return { id: 42 }; },
  };
  const strikes = { add: (g, u, n) => { calls.strikes.push([g, u, n]); return { count: 2 }; } };
  const config = {
    get: () => ({ automod: { enabled: true, ignoredChannels: [], ignoredRoles: [], filters: { antiLink: { enabled: true, action, duration: '10m' } } } }),
  };
  const service = new AutoModService({ config, logging: { send: async (...a) => logs.push(a) }, moderation, strikes });
  const message = {
    guild: { id: 'g1', members: { me: { id: 'bot' } } },
    author: { id: 'u1', bot: false, toString: () => '<@u1>' },
    member: { permissions: { has: () => false }, roles: { cache: { some: () => false } } },
    channel: { id: 'c1', toString: () => '<#c1>' },
    content: 'https://spam.example',
    delete: async () => {},
  };
  return { service, message, calls, logs };
}

test('AutoMod : timeout enregistré comme sanction via ModerationService', async () => {
  const w = automodWorld({ action: 'timeout' });
  await w.service.handleMessage(w.message);
  assert.equal(w.calls.timeout.length, 1);
  const [, member, moderator, reason, ms] = w.calls.timeout[0];
  assert.equal(member, w.message.member);
  assert.equal(moderator.id, 'bot');
  assert.equal(reason, 'AutoMod: Lien interdit');
  assert.equal(ms, 600_000);
  const action = w.logs[0][2].toJSON().fields.find((f) => f.name.includes('Action')).value;
  assert.match(action, /sanction #41/);
});

test('AutoMod : avertissement → sanction + strike', async () => {
  const w = automodWorld({ action: 'warn' });
  await w.service.handleMessage(w.message);
  assert.equal(w.calls.record.length, 1);
  assert.deepEqual(w.calls.strikes, [['g1', 'u1', 1]]);
  const action = w.logs[0][2].toJSON().fields.find((f) => f.name.includes('Action')).value;
  assert.match(action, /sanction #42 · 2 strikes/);
});

test('AutoMod : timeout impossible signalé, pas de bouton « Retirer le timeout »', async () => {
  const w = automodWorld({ action: 'timeout', timeoutImpl: () => { throw new Error('hiérarchie'); } });
  await w.service.handleMessage(w.message);
  const ids = w.logs[0][3].flatMap((r) => r.toJSON().components.map((b) => b.custom_id));
  assert.deepEqual(ids, ['cmd:sanctions:history:u1']);
});
