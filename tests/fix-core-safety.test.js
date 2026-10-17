'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { MessageFlags } = require('discord.js');
const { hardenInteraction, isAcknowledged, safeRespondPrivately } = require('../src/core/interactionSafety');
const { reportError } = require('../src/events/interactionCreate');
const interactionCreate = require('../src/events/interactionCreate');
const { UserError } = require('../src/core/errors');
const { describeApiError } = require('../src/core/apiErrors');
const cmd = require('../src/components/cmd');

const tick = () => new Promise((r) => setTimeout(r, 5));

/**
 * Fausse interaction de commande proche de discord.js : `deferred`/`replied`
 * ne sont levés qu'APRÈS la réponse (simulée) de l'API.
 */
function fakeCommand({ button = false } = {}) {
  const calls = [];
  const i = {
    deferred: false,
    replied: false,
    ephemeral: null,
    isRepliable: () => true,
    async reply(o) {
      if (this.deferred || this.replied) throw Object.assign(new Error('already acknowledged'), { code: 40060 });
      calls.push(['reply', o]);
      await tick();
      this.replied = true;
      return {};
    },
    async deferReply(o) {
      if (this.deferred || this.replied) throw Object.assign(new Error('already acknowledged'), { code: 40060 });
      calls.push(['deferReply', o]);
      await tick();
      this.deferred = true;
      this.ephemeral = Boolean((o?.flags ?? 0) & MessageFlags.Ephemeral);
    },
    async editReply(o) { calls.push(['editReply', o]); this.replied = true; return {}; },
    async followUp(o) { calls.push(['followUp', o]); return {}; },
    async deleteReply() { calls.push(['deleteReply']); },
    async fetchReply() { return {}; },
  };
  if (button) {
    i.update = async (o) => { calls.push(['update', o]); await tick(); i.replied = true; return {}; };
    i.deferUpdate = async () => { calls.push(['deferUpdate']); await tick(); i.deferred = true; return {}; };
  }
  return { i, calls };
}

test('apiErrors : 50027 et 10015 sont des interactions mortes', () => {
  assert.equal(describeApiError({ code: 50027 }).deadInteraction, true);
  assert.equal(describeApiError({ code: 10015 }).deadInteraction, true);
  assert.equal(describeApiError({ code: 50013 }).deadInteraction, false);
});

test('interactionSafety : acquittement en cours visible immédiatement (isAcknowledged)', async () => {
  const { i } = fakeCommand();
  hardenInteraction(i);
  assert.equal(isAcknowledged(i), false);
  const p = i.deferReply();
  // Pas encore revenu de l'API : discord.js n'a pas levé `deferred`, mais la couche le sait.
  assert.equal(i.deferred, false);
  assert.equal(isAcknowledged(i), true);
  await p;
  assert.equal(isAcknowledged(i), true);
});

test('interactionSafety : un reply concurrent attend le premier et devient followUp', async () => {
  const { i, calls } = fakeCommand();
  hardenInteraction(i);
  await Promise.all([i.reply({ content: 'a' }), i.reply({ content: 'b' })]);
  assert.deepEqual(calls.map((c) => c[0]), ['reply', 'followUp']);
});

test('interactionSafety : editReply concurrent à deferReply devient une édition', async () => {
  const { i, calls } = fakeCommand();
  hardenInteraction(i);
  await Promise.all([i.deferReply(), i.editReply({ content: 'x' })]);
  assert.deepEqual(calls.map((c) => c[0]), ['deferReply', 'editReply']);
});

test('interactionSafety : un acquittement en échec libère le drapeau', async () => {
  const { i } = fakeCommand();
  i.deferReply = async () => { await tick(); throw Object.assign(new Error('Unknown interaction'), { code: 10062 }); };
  hardenInteraction(i);
  await assert.rejects(i.deferReply(), { code: 10062 });
  assert.equal(isAcknowledged(i), false);
});

test('interactionSafety : fallback orphelin ignoré si un acquittement est en cours', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const calls = [];
  let release;
  const i = {
    deferred: false,
    replied: false,
    customId: 'collector:xyz',
    isRepliable: () => true,
    isAutocomplete: () => false,
    isChatInputCommand: () => false,
    isContextMenuCommand: () => false,
    isButton: () => true,
    isAnySelectMenu: () => false,
    isModalSubmit: () => false,
    async reply(o) { calls.push(['reply', o]); this.replied = true; },
    async deferReply() {},
    async editReply() {},
    async followUp(o) { calls.push(['followUp', o]); },
    async fetchReply() {},
    async update() {},
    deferUpdate() { calls.push(['deferUpdate']); return new Promise((r) => { release = () => { this.deferred = true; r(); }; }); },
  };
  await interactionCreate.execute({ componentHandler: { resolve: () => null } }, i);
  const pending = i.deferUpdate(); // collector local : acquittement en vol
  t.mock.timers.tick(3_000); // le minuteur orphelin se déclenche pendant le vol
  await Promise.resolve();
  release();
  await pending;
  assert.deepEqual(calls.map((c) => c[0]), ['deferUpdate']);
});

test('safeRespondPrivately : deferReply public → suppression + followUp éphémère', async () => {
  const { i, calls } = fakeCommand();
  hardenInteraction(i);
  await i.deferReply();
  assert.equal(await safeRespondPrivately(i, { embeds: [{ description: 'non' }], ephemeral: true }), true);
  assert.deepEqual(calls.map((c) => c[0]), ['deferReply', 'deleteReply', 'followUp']);
  const flags = calls[2][1].flags;
  assert.ok(flags & MessageFlags.Ephemeral, 'followUp éphémère');
});

test('safeRespondPrivately : deferReply éphémère → simple édition', async () => {
  const { i, calls } = fakeCommand();
  hardenInteraction(i);
  await i.deferReply({ ephemeral: true });
  await safeRespondPrivately(i, { embeds: [{ description: 'non' }], ephemeral: true });
  assert.deepEqual(calls.map((c) => c[0]), ['deferReply', 'editReply']);
});

test('safeRespondPrivately : deferReply public déjà édité → followUp sans suppression', async () => {
  const { i, calls } = fakeCommand();
  hardenInteraction(i);
  await i.deferReply();
  await i.editReply({ embeds: [{ description: 'ok' }] });
  await safeRespondPrivately(i, { embeds: [{ description: 'non' }], ephemeral: true });
  assert.deepEqual(calls.map((c) => c[0]), ['deferReply', 'editReply', 'followUp']);
});

test('reportError : UserError après deferReply public ne remplace pas le message public', async () => {
  const { i, calls } = fakeCommand();
  hardenInteraction(i);
  await i.deferReply();
  const client = { stats: { errors: 0 } };
  await reportError(client, i, new UserError('Interdit.'), '/x');
  assert.deepEqual(calls.map((c) => c[0]), ['deferReply', 'deleteReply', 'followUp']);
});

test('reportError : la confirmation en attente est toujours remplacée par l\'erreur', async () => {
  const { i, calls } = fakeCommand();
  hardenInteraction(i);
  await i.deferReply();
  i.pendingConfirmation = { message: { id: 'm1' } };
  await reportError({ stats: { errors: 0 } }, i, new UserError('Interdit.'), '/x');
  const last = calls.at(-1);
  assert.equal(last[0], 'editReply');
  assert.equal(last[1].message, 'm1');
});

test('reportError : 50027 (jeton expiré) n\'essaie pas de répondre', async () => {
  const { i, calls } = fakeCommand();
  hardenInteraction(i);
  await reportError({ stats: { errors: 0 } }, i, Object.assign(new Error('Invalid Webhook Token'), { code: 50027 }), '/x');
  assert.deepEqual(calls, []);
});

test('cmd 🗑️ : deleteReply d\'abord, message.delete() en secours', async () => {
  const owner = '123456789012345678';
  const make = (deleteReply) => {
    const calls = [];
    const i = {
      customId: `cmd:_:delete:${owner}`,
      user: { id: owner },
      memberPermissions: null,
      async deferUpdate() { calls.push('deferUpdate'); },
      async deleteReply() { calls.push('deleteReply'); return deleteReply(); },
      message: { async delete() { calls.push('message.delete'); } },
    };
    return { i, calls };
  };
  const ok = make(async () => {});
  await cmd.execute(ok.i, { commands: new Map() });
  assert.deepEqual(ok.calls, ['deferUpdate', 'deleteReply']);

  const fallback = make(async () => { throw new Error('Unknown Webhook'); });
  await cmd.execute(fallback.i, { commands: new Map() });
  assert.deepEqual(fallback.calls, ['deferUpdate', 'deleteReply', 'message.delete']);

  const none = make(async () => { throw new Error('x'); });
  none.i.message.delete = async () => { throw new Error('Missing Access'); };
  await assert.rejects(cmd.execute(none.i, { commands: new Map() }), { name: 'UserError' });
});

test('interactionSafety : update tardif après une RÉPONSE modifie le message du bouton, pas la réponse', async () => {
  const { i, calls } = fakeCommand({ button: true });
  const edits = [];
  i.message = { editable: true, flags: { has: () => false }, edit: async (o) => { edits.push(o); return {}; } };
  hardenInteraction(i);
  await i.reply({ content: 'Ce bouton a expiré.', flags: MessageFlags.Ephemeral });
  await i.update({ content: 'vue à jour' });
  assert.ok(!calls.some(([k]) => k === 'editReply'), 'la carte d\'erreur n\'est pas écrasée');
  assert.equal(edits.length, 1);
});

test('interactionSafety : update après deferUpdate passe toujours par editReply', async () => {
  const { i, calls } = fakeCommand({ button: true });
  hardenInteraction(i);
  await i.deferUpdate();
  await i.update({ content: 'vue à jour' });
  assert.ok(calls.some(([k]) => k === 'editReply'));
});
