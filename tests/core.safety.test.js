'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { MessageFlags, EmbedBuilder } = require('discord.js');
const { normalizeOptions, hardenInteraction, safeRespond } = require('../src/core/interactionSafety');
const { describeApiError } = require('../src/core/apiErrors');
const { CooldownManager } = require('../src/core/cooldowns');
const { missingPermissions } = require('../src/utils/permissionNames');

test('normalizeOptions convertit ephemeral et fetchReply', () => {
  const { options, fetch } = normalizeOptions({ content: 'x', ephemeral: true, fetchReply: true });
  assert.strictEqual(fetch, true);
  assert.strictEqual(options.ephemeral, undefined);
  assert.strictEqual(options.fetchReply, undefined);
  assert.strictEqual(options.flags & MessageFlags.Ephemeral, MessageFlags.Ephemeral);
});

test('normalizeOptions transforme tout texte brut en embed et ignore ephemeral:false', () => {
  const fromString = normalizeOptions('salut').options;
  assert.strictEqual(fromString.content, undefined);
  assert.strictEqual(fromString.embeds[0].description, 'salut');
  const { options } = normalizeOptions({ content: 'x', ephemeral: false });
  assert.strictEqual(options.flags, undefined);
  assert.strictEqual(options.embeds.length, 1);
  // Un texte accompagnant des embeds (mention qui notifie) est conservé.
  const withEmbed = normalizeOptions({ content: '<@1>', embeds: [{ description: 'a' }] }).options;
  assert.strictEqual(withEmbed.content, '<@1>');
});

test('bouton 🗑️ ajouté à la dernière rangée, une seule fois', () => {
  const { withDeleteButton } = require('../src/events/interactionCreate');
  const out = withDeleteButton({ embeds: [{}], components: [{ type: 1, components: [{ type: 2, custom_id: 'a' }] }] }, 'u1');
  assert.strictEqual(out.components.length, 1);
  assert.strictEqual(out.components[0].components[1].custom_id, 'cmd:_:delete:u1');
  assert.strictEqual(withDeleteButton(out, 'u1'), out, 'pas de doublon');
  const full = { embeds: [{}], components: [{ type: 1, components: [{ type: 3, custom_id: 'menu' }] }] };
  assert.strictEqual(withDeleteButton(full, 'u1').components.length, 2, 'menu déroulant → nouvelle rangée');
});

test('normalizeOptions tronque les embeds trop longs', () => {
  const big = new EmbedBuilder().setDescription('a'.repeat(4000)).addFields({ name: 'f', value: 'b'.repeat(1000) }, { name: 'g', value: 'c'.repeat(1000) });
  const { options } = normalizeOptions({ embeds: [big, { description: 'd'.repeat(4000) }] });
  const total = options.embeds.reduce((n, e) => n + (e.description?.length || 0) + (e.fields || []).reduce((m, f) => m + f.name.length + f.value.length, 0), 0);
  assert.ok(total <= 6000, `total ${total}`);
});

/** Fausse interaction minimale reproduisant les règles de Discord. */
function fakeInteraction() {
  const calls = [];
  const i = {
    deferred: false,
    replied: false,
    isRepliable: () => true,
    async reply(o) {
      if (this.deferred || this.replied) throw new Error('already acknowledged');
      this.replied = true;
      calls.push(['reply', o]);
      return o?.withResponse ? { resource: { message: { id: 'm1' } } } : {};
    },
    async deferReply(o) {
      if (this.deferred || this.replied) throw new Error('already acknowledged');
      this.deferred = true;
      calls.push(['deferReply', o]);
    },
    async editReply(o) {
      if (!this.deferred && !this.replied) throw new Error('not replied');
      calls.push(['editReply', o]);
      return { id: 'm1' };
    },
    async followUp(o) {
      if (!this.deferred && !this.replied) throw new Error('not replied');
      calls.push(['followUp', o]);
      return { id: 'm2' };
    },
    async fetchReply() {
      return { id: 'm1' };
    },
  };
  return { i, calls };
}

test('hardenInteraction : reply après deferReply devient editReply', async () => {
  const { i, calls } = fakeInteraction();
  hardenInteraction(i);
  await i.deferReply({ ephemeral: true });
  await i.reply({ content: 'ok', ephemeral: true });
  assert.deepStrictEqual(calls.map((c) => c[0]), ['deferReply', 'editReply']);
  assert.strictEqual(calls[1][1].flags, undefined, 'editReply ne doit pas porter Ephemeral');
});

test('hardenInteraction : second reply devient followUp, double defer ignoré', async () => {
  const { i, calls } = fakeInteraction();
  hardenInteraction(i);
  await i.reply('a');
  await i.reply('b');
  await i.deferReply();
  assert.deepStrictEqual(calls.map((c) => c[0]), ['reply', 'followUp']);
});

test('hardenInteraction : editReply/followUp sans réponse deviennent reply ; fetchReply renvoie un message', async () => {
  const { i, calls } = fakeInteraction();
  hardenInteraction(i);
  const msg = await i.editReply({ content: 'x' });
  assert.strictEqual(calls[0][0], 'reply');
  assert.strictEqual(msg.id, 'm1');
  const { i: j } = fakeInteraction();
  hardenInteraction(j);
  const m = await j.reply({ content: 'x', fetchReply: true });
  assert.strictEqual(m.id, 'm1');
});

test('hardenInteraction est idempotent et safeRespond ne lève jamais', async () => {
  const { i } = fakeInteraction();
  hardenInteraction(i);
  const patched = i.reply;
  hardenInteraction(i);
  assert.strictEqual(i.reply, patched);
  const broken = { isRepliable: () => true, deferred: false, replied: false, reply: async () => { throw new Error('boom'); }, deferReply() {}, editReply() {}, followUp() {}, fetchReply() {} };
  assert.strictEqual(await safeRespond(broken, { content: 'x' }), false);
});

test('describeApiError traduit les codes Discord courants', () => {
  assert.match(describeApiError({ code: 50013 }).friendly, /permissions/);
  assert.strictEqual(describeApiError({ code: 10062 }).deadInteraction, true);
  assert.ok(describeApiError({ status: 503 }).friendly);
  assert.strictEqual(describeApiError(new Error('x')).friendly, null);
});

test('CooldownManager bloque puis libère', () => {
  const c = new CooldownManager();
  assert.strictEqual(c.hit('k', 1000, 0), 0);
  assert.strictEqual(c.hit('k', 1000, 400), 600);
  assert.strictEqual(c.hit('k', 1000, 1000), 0);
  c.release('k');
  assert.strictEqual(c.hit('k', 1000, 1001), 0);
  assert.strictEqual(c.hit('x', 0), 0);
});

test('missingPermissions liste les permissions manquantes (admin = tout)', () => {
  const { PermissionFlagsBits: P } = require('discord.js');
  assert.deepStrictEqual(missingPermissions(P.SendMessages, [P.SendMessages, P.BanMembers]), ['BanMembers']);
  assert.deepStrictEqual(missingPermissions(P.Administrator, [P.BanMembers]), []);
});
