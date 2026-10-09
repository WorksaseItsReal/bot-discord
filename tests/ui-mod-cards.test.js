'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { TONES } = require('../src/utils/ui');
const { sanctionCard, settleComponents, TYPE_LABELS } = require('../src/services/ModerationService');
const { channelCard, serverLockCard } = require('../src/services/LockdownService');
const { describeThreshold } = require('../src/services/StrikeService');
const { SchedulerService } = require('../src/services/SchedulerService');
const { buttonRows, actionButton, deleteButton } = require('../src/utils/ui');

const user = { id: '111111111111111111', username: 'bob', toString: () => '<@111111111111111111>', displayAvatarURL: () => 'https://cdn/avatar.png' };
const mod = { id: '222222222222222222' };
const guild = { id: 'g1', name: 'Mon Serveur', iconURL: () => 'https://cdn/icon.png' };

const json = (e) => e.toJSON();
const fieldNames = (e) => json(e).fields.map((f) => f.name);

test('carte de sanction : ton par sévérité et section Modération', () => {
  const expected = { warn: 'warning', mute: 'caution', timeout: 'caution', kick: 'caution', ban: 'danger', tempban: 'danger', unban: 'success', unmute: 'success', untimeout: 'success' };
  for (const [type, tone] of Object.entries(expected)) {
    const e = json(sanctionCard({ type, user, moderator: mod, durationMs: type === 'tempban' || type === 'timeout' ? 60_000 : null }));
    assert.equal(e.color, TONES[tone], type);
    assert.ok(e.author.name.includes('Modération'), type);
    assert.ok(TYPE_LABELS[type], type);
  }
});

test('carte de bannissement : Membre / Modérateur / Durée / Raison + pied « Sanction #id »', () => {
  const e = json(sanctionCard({ id: 12, type: 'ban', user, moderator: mod, reason: 'Spam' }));
  assert.match(e.title, /Membre banni/);
  assert.ok(e.description.includes('<@111111111111111111>'));
  const names = e.fields.map((f) => f.name);
  assert.deepEqual(names, ['👤 Membre', '🛡️ Modérateur', '⏱️ Durée', '📝 Raison']);
  assert.equal(e.fields[2].value, 'Définitive');
  assert.equal(e.fields[3].value, 'Spam');
  assert.ok(e.footer.text.includes('Sanction #12'));
  assert.equal(e.thumbnail.url, 'https://cdn/avatar.png');
});

test('durée + expiration (timestamp Discord) pour les sanctions temporaires', () => {
  const expiresAt = Date.now() + 3_600_000;
  const e = json(sanctionCard({ type: 'timeout', user, moderator: mod, durationMs: 3_600_000, expiresAt }));
  const duration = e.fields.find((f) => f.name.includes('Durée'));
  assert.ok(duration.value.includes('1h'));
  assert.ok(duration.value.includes(`<t:${Math.floor(expiresAt / 1000)}:R>`));
});

test('DM : même ton, section = nom du serveur, modérateur non révélé', () => {
  const e = json(sanctionCard({ type: 'kick', user, moderator: mod, reason: 'Flood', guild, audience: 'dm' }));
  assert.equal(e.color, TONES.caution);
  assert.ok(e.author.name.includes('Mon Serveur'));
  assert.match(e.title, /expulsé/);
  assert.ok(!fieldNames(sanctionCard({ type: 'kick', user, moderator: mod, guild, audience: 'dm' })).some((n) => n.includes('Modérateur')));
  assert.equal(e.thumbnail.url, 'https://cdn/icon.png');
});

test('levée de sanction : pas de champ Raison vide, utilisateur inconnu accepté', () => {
  const e = json(sanctionCard({ type: 'unban', userId: '333333333333333333', moderator: mod }));
  assert.ok(!e.fields.some((f) => f.name.includes('Raison')));
  assert.ok(e.description.includes('<@333333333333333333>'));
});

test('settleComponents fige le bouton cliqué et garde les autres (🗑️)', () => {
  const rows = buttonRows(
    actionButton({ command: 'unban', action: 'revoke', args: ['1'], label: 'Débannir' }),
    deleteButton('9'),
  );
  const out = settleComponents({ components: rows }, 'cmd:unban:revoke:1', 'Débanni par Alice');
  const [settled, del] = out[0].components;
  assert.equal(settled.disabled, true);
  assert.equal(settled.label, 'Débanni par Alice');
  assert.equal(del.custom_id, 'cmd:_:delete:9');
  assert.ok(!del.disabled);
});

test('cartes de salon et de lockdown', () => {
  const channel = { id: 'c1', toString: () => '<#c1>' };
  assert.equal(json(channelCard('lock', channel, mod)).color, TONES.caution);
  assert.equal(json(channelCard('unlock', channel, mod)).color, TONES.success);
  const on = json(serverLockCard({ enabled: true, count: 3, moderator: mod }));
  assert.equal(on.color, TONES.danger);
  assert.ok(on.description.includes('**3** salons'));
  const off = json(serverLockCard({ enabled: false, count: 0, moderator: 'x' }));
  assert.ok(off.description.includes('Aucun salon'));
});

test('paliers de strikes lisibles', () => {
  assert.equal(describeThreshold({ strikes: 3, action: 'mute', duration: '1h' }), '3 strikes → Timeout (1h)');
  assert.equal(describeThreshold(null), null);
});

test('rappel : carte section Utilitaires', () => {
  const e = json(SchedulerService.reminderCard({ id: 4, message: 'Boire de l\'eau', created_at: Date.now() }));
  assert.equal(e.color, TONES.info);
  assert.ok(e.author.name.includes('Utilitaires'));
  assert.equal(e.description, 'Boire de l\'eau');
  assert.ok(e.footer.text.includes('Rappel #4'));
});
