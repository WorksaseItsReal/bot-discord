'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { hardenInteraction } = require('../src/core/interactionSafety');
const { componentExistsOnMessage } = require('../src/events/interactionCreate');
const cmd = require('../src/components/cmd');
const { assertInvoker, snowflake } = require('../src/utils/buttonGuard');
const { actionButton } = require('../src/utils/ui');

/** Fausse interaction de bouton reproduisant les règles de discord.js 14.27. */
function fakeButton() {
  const calls = [];
  const i = {
    deferred: false,
    replied: false,
    isRepliable: () => true,
    async reply(o) { if (this.deferred || this.replied) throw new Error('acknowledged'); this.replied = true; calls.push(['reply', o]); return {}; },
    async deferReply() { this.deferred = true; calls.push(['deferReply']); },
    async editReply(o) { calls.push(['editReply', o]); return {}; },
    async followUp(o) { calls.push(['followUp', o]); return {}; },
    async fetchReply() { return {}; },
    async update(o) { this.replied = true; calls.push(['update', o]); return {}; },
    async deferUpdate() { this.deferred = true; calls.push(['deferUpdate']); return {}; },
  };
  return { i, calls };
}

test('après deferUpdate, une carte d\'erreur part en followUp (le message public n\'est pas écrasé)', async () => {
  const { i, calls } = fakeButton();
  hardenInteraction(i);
  await i.deferUpdate();
  await i.reply({ content: 'erreur', ephemeral: true });
  assert.deepStrictEqual(calls.map((c) => c[0]), ['deferUpdate', 'followUp']);
  // editReply reste l'outil pour modifier le message du bouton.
  await i.editReply({ content: 'maj' });
  assert.strictEqual(calls[2][0], 'editReply');
});

test('après update, une nouvelle réponse part aussi en followUp', async () => {
  const { i, calls } = fakeButton();
  hardenInteraction(i);
  await i.update({ content: 'x' });
  await i.reply({ content: 'erreur', ephemeral: true });
  assert.deepStrictEqual(calls.map((c) => c[0]), ['update', 'followUp']);
});

test('editReply sans réponse préalable conserve ephemeral', async () => {
  const { i, calls } = fakeButton();
  hardenInteraction(i);
  i.reply = i.reply; // déjà durci
  await i.editReply({ content: 'secret', ephemeral: true });
  const sent = calls[0][1];
  assert.ok(sent.flags & 64, 'le flag Ephemeral doit être présent');
});

test('un customId absent du message cliqué est refusé', () => {
  const message = { components: [{ components: [{ customId: 'cmd:ping:refresh:1' }] }] };
  const ok = { isMessageComponent: () => true, customId: 'cmd:ping:refresh:1', message };
  const forged = { isMessageComponent: () => true, customId: 'cmd:_:delete:2', message };
  assert.strictEqual(componentExistsOnMessage(ok), true);
  assert.strictEqual(componentExistsOnMessage(forged), false);
  assert.strictEqual(componentExistsOnMessage({ isMessageComponent: () => false }), true, 'les formulaires ne sont pas concernés');
});

test('routeur : arguments de chemin refusés, clés héritées jamais résolues', async () => {
  assert.strictEqual(cmd.isSafeArg('../members/1'), false);
  assert.strictEqual(cmd.isSafeArg('123456789012345678'), true);
  const client = { commands: new Map([['ping', { guildOnly: false, buttons: {} }]]) };
  const interaction = { customId: 'cmd:ping:constructor', inGuild: () => true };
  await assert.rejects(() => cmd.execute(interaction, client), /plus disponible/);
});

test('assertInvoker échoue fermé, snowflake valide les identifiants', () => {
  assert.throws(() => assertInvoker({ user: { id: '1' } }, undefined));
  assert.throws(() => assertInvoker({ user: { id: '1' } }, '2'));
  assert.doesNotThrow(() => assertInvoker({ user: { id: '1' } }, '1'));
  assert.strictEqual(snowflake('123456789012345678'), '123456789012345678');
  assert.throws(() => snowflake('../members/1'));
  assert.throws(() => snowflake(undefined));
});

test('actionButton refuse « : » dans les arguments', () => {
  assert.throws(() => actionButton({ command: 'custom', action: 'test', args: ['faq:fr'], label: 'x' }));
});
