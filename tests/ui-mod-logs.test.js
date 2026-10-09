'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { TONES } = require('../src/utils/ui');
const { LoggingService, logCard, fitList } = require('../src/services/LoggingService');
const pseudo = require('../src/commands/moderation/pseudo');
const messageUpdate = require('../src/events/messageUpdate');
const messageDelete = require('../src/events/messageDelete');
const guildMemberAdd = require('../src/events/guildMemberAdd');

const user = { id: '42', username: 'bob', bot: false, createdTimestamp: Date.now(), toString: () => '<@42>', displayAvatarURL: () => 'https://cdn/a.png' };

/** Client minimal qui capture les envois de LoggingService.send. */
function captureClient() {
  const sent = [];
  return {
    sent,
    services: {
      logging: { send: async (guildId, category, embed, components) => sent.push({ guildId, category, embed: embed.toJSON(), components }) },
      automod: { handleMessage: async () => {} },
      antiraid: { handleJoin: async () => {} },
    },
  };
}

test('logCard : section « Logs · … », miniature et pied « ID : … »', () => {
  const e = logCard({ category: 'messages', tone: 'danger', title: 'X', user }).toJSON();
  assert.ok(e.author.name.includes('Logs · Messages'));
  assert.equal(e.color, TONES.danger);
  assert.equal(e.thumbnail.url, 'https://cdn/a.png');
  assert.ok(e.footer.text.includes('ID : 42'));
});

test('LoggingService.send reste compatible et accepte des composants', async () => {
  const payloads = [];
  const channel = { isTextBased: () => true, send: async (p) => payloads.push(p) };
  const svc = new LoggingService({ channels: { fetch: async () => channel } }, { get: () => ({ logChannels: { messages: 'c' } }) });
  const embed = logCard({ category: 'messages', title: 'X' });
  await svc.send('g', 'messages', embed);
  await svc.send('g', 'messages', embed, [{ type: 1, components: [] }]);
  assert.equal(payloads[0].components, undefined);
  assert.equal(payloads[1].components.length, 1);
  await svc.send('g', 'members', embed); // non configuré : ignoré sans erreur
  assert.equal(payloads.length, 2);
});

test('message modifié : carte info + bouton « Aller au message »', async () => {
  const client = captureClient();
  const channel = { toString: () => '<#c>' };
  const guild = { id: 'g' };
  await messageUpdate.execute(
    client,
    { partial: false, content: 'avant' },
    { guild, author: user, partial: false, content: 'après', channel, url: 'https://discord.com/channels/g/c/m' },
  );
  const [log] = client.sent;
  assert.equal(log.category, 'messages');
  assert.equal(log.embed.color, TONES.info);
  const button = log.components[0].toJSON().components[0];
  assert.equal(button.url, 'https://discord.com/channels/g/c/m');
  assert.equal(button.label, 'Aller au message');
});

test('message supprimé (danger) et arrivée (success, compte récent signalé)', async () => {
  const client = captureClient();
  await messageDelete.execute(client, { guild: { id: 'g' }, author: user, channel: { toString: () => '<#c>' }, content: 'coucou', createdTimestamp: Date.now(), attachments: new Map() });
  assert.equal(client.sent[0].embed.color, TONES.danger);
  await guildMemberAdd.execute(client, { id: '42', user, guild: { id: 'g', memberCount: 10 } });
  const join = client.sent[1].embed;
  assert.equal(join.color, TONES.success);
  assert.ok(join.fields.some((f) => f.name.includes('Compte récent')));
});

test('fitList ne coupe jamais une mention', () => {
  const items = Array.from({ length: 200 }, (_, i) => `<@&${100000000000000000 + i}>`);
  const out = fitList(items, 1000);
  assert.ok(out.length <= 1000);
  assert.match(out, /\+\d+$/);
});

test('/pseudo : bouton « Annuler » omis si l\'ancien pseudo ne tient pas dans le customId', () => {
  const ok = pseudo.undoButton('123456789012345678', 'Ancien:pseudo');
  // base64url : ni « % » ni « : » (refusés par le routeur / séparateur d'arguments).
  assert.equal(ok.toJSON().custom_id, `cmd:pseudo:undo:123456789012345678:${Buffer.from('Ancien:pseudo').toString('base64url')}`);
  assert.equal(pseudo.undoButton('123456789012345678', '🎉'.repeat(16)), null);
  assert.ok(pseudo.undoButton('123456789012345678', null));
});
