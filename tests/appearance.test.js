'use strict';

/**
 * Apparence du bot par serveur : thème par MARQUAGE (card() de ton « marque », jamais par valeur
 * de couleur), saisie de la couleur, validation du pseudo et de la bio du profil par serveur.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { EmbedBuilder, PermissionsBitField } = require('discord.js');
const { card, status, TONES, fitEmbeds } = require('../src/utils/ui');
const E = require('../src/utils/embeds');
const { normalizeOptions } = require('../src/core/interactionSafety');
const { logCard } = require('../src/services/LoggingService');
const { StickyService } = require('../src/services/StickyService');
const P = require('../src/services/BotProfileService');
const { defaultGuildConfig } = require('../src/config/defaults');
const { memoryDb } = require('./db.helper');
const { BotSettingsRepository } = require('../src/database/repositories/BotSettingsRepository');

const RED = 0xff0000;
const GUILD = '111111111111111111';
/** Installe un résolveur (serveur GUILD → rouge) pendant `fn`, puis restaure l'état précédent. */
function withTheme(fn, resolver = (id) => (id === GUILD ? RED : null)) {
  const before = E.getThemeResolver();
  E.setThemeResolver(resolver);
  try {
    return fn();
  } finally {
    E.setThemeResolver(before);
  }
}

test('marquage : seules les cartes de ton « marque » (ou sans ton) sont thémables', () => {
  assert.equal(E.isThemable(card({ title: 'x' })), true, 'ton absent');
  assert.equal(E.isThemable(card({ tone: 'brand', title: 'x' })), true);
  assert.equal(E.isThemable(card({ tone: 0x5865f2, title: '/couleur' })), false, 'couleur numérique explicite');
  assert.equal(E.isThemable(card({ tone: TONES.brand, title: 'même valeur, numérique' })), false);
  for (const tone of ['success', 'danger', 'warning', 'info', 'caution', 'neutral', 'celebrate', 'gold', 'fun']) {
    assert.equal(E.isThemable(card({ tone, title: tone })), false, tone);
  }
  assert.equal(E.isThemable(status.fail('Erreur')), false);
  assert.equal(E.isThemable(status.ok('Succès')), false);
  assert.equal(E.isThemable(new EmbedBuilder().setTitle('brut').setColor(TONES.brand)), false);
  // Cartes neutres d'information qui le demandent : logs d'information, message épinglé.
  assert.equal(E.isThemable(logCard({ category: 'members', title: 'Arrivée' })), true);
  assert.equal(E.isThemable(logCard({ category: 'members', tone: 'info', title: 'Arrivée' })), true);
  assert.equal(E.isThemable(logCard({ category: 'moderation', tone: 'danger', title: 'Ban' })), false);
  assert.equal(E.isThemable(card({ tone: 0x123456, themable: true })), false, 'une couleur numérique n\'est jamais thémée');
});

test('sanitizeEmbeds / fitEmbeds : couleur du thème sur les seules cartes marquées du serveur', () => {
  withTheme(() => {
    const brand = card({ title: 'Infos' });
    const picked = card({ tone: 0x5865f2, title: 'Couleur choisie' });
    const raw = new EmbedBuilder().setTitle('Embed de membre').setColor(0x00ff00);
    const error = status.fail('Refusé');
    const [a, b, c, d] = E.sanitizeEmbeds([brand, picked, raw, error], { guildId: GUILD });
    assert.equal(a.color, RED);
    assert.equal(b.color, 0x5865f2);
    assert.equal(c.color, 0x00ff00);
    assert.equal(d.color, TONES.danger);
    // Autre serveur sans thème, MP (pas de serveur), objets JSON : rien ne change.
    assert.equal(E.sanitizeEmbeds([brand], { guildId: '222222222222222222' })[0].color, TONES.brand);
    assert.equal(E.sanitizeEmbeds([brand])[0].color, TONES.brand);
    assert.equal(E.sanitizeEmbeds([brand.toJSON()], { guildId: GUILD })[0].color, TONES.brand);
    assert.equal(fitEmbeds(brand, { guildId: GUILD })[0].color, RED);
    assert.equal(fitEmbeds([brand])[0].color, TONES.brand);
  });
  // Sans résolveur : rien ne change.
  const before = E.getThemeResolver();
  E.setThemeResolver(null);
  try {
    assert.equal(E.sanitizeEmbeds([card({ title: 'x' })], { guildId: GUILD })[0].color, TONES.brand);
  } finally {
    E.setThemeResolver(before);
  }
  // Valeurs invalides ou résolveur qui lève : ignorés ; noir → 0x010101.
  for (const [value, expected] of [[0, 0x010101], [-1, TONES.brand], [0x1000000, TONES.brand], ['#ff0000', TONES.brand], [1.5, TONES.brand], [null, TONES.brand]]) {
    withTheme(() => assert.equal(E.sanitizeEmbeds([card({ title: 'x' })], { guildId: GUILD })[0].color, expected, String(value)), () => value);
  }
  withTheme(() => assert.equal(E.sanitizeEmbeds([card({ title: 'x' })], { guildId: GUILD })[0].color, TONES.brand), () => {
    throw new Error('base fermée');
  });
});

test('themed (envoi direct d\'un builder, logs) : copie recolorée, carte d\'origine intacte', () => {
  const { themed } = require('../src/utils/ui');
  withTheme(() => {
    const brand = logCard({ category: 'members', title: 'Arrivée' });
    const copy = themed(brand, GUILD);
    assert.notEqual(copy, brand);
    assert.equal(copy.toJSON().color, RED);
    assert.equal(brand.toJSON().color, TONES.info, 'original non modifié');
    const danger = logCard({ category: 'moderation', tone: 'danger', title: 'Ban' });
    assert.equal(themed(danger, GUILD), danger);
    assert.equal(themed(brand, null), brand);
    assert.equal(themed(brand, '222222222222222222'), brand);
  });
});

test('réponses d\'interaction : normalizeOptions thème avec le serveur de l\'interaction', () => {
  withTheme(() => {
    const { options } = normalizeOptions({ embeds: [card({ title: 'x' }), status.warn('Attention')] }, { guildId: GUILD });
    assert.equal(options.embeds[0].color, RED);
    assert.equal(options.embeds[1].color, TONES.warning);
    assert.equal(normalizeOptions({ embeds: [card({ title: 'x' })] }).options.embeds[0].color, TONES.brand);
    // Texte brut mis en forme : carte neutre, jamais thémée.
    assert.equal(normalizeOptions('bonjour', { guildId: GUILD }).options.embeds[0].color, TONES.neutral);
  });
});

test('message épinglé : carte thémée par le serveur de la ligne', () => {
  withTheme(() => {
    const sticky = new StickyService({ client: {}, sticky: { all: () => [] } });
    const payload = sticky.render({ guild_id: GUILD, channel_id: '1', title: 'Règles', content: 'Soyez gentils.' });
    assert.equal(payload.embeds[0].color, RED);
    assert.equal(sticky.render({ guild_id: '222222222222222222', channel_id: '1', content: 'x' }).embeds[0].color, TONES.info);
  });
});

test('parseThemeColor : hex, rgb, noms, « défaut » ; noir → 0x010101 ; saisies invalides refusées', () => {
  assert.equal(P.parseThemeColor('#FF0000'), 0xff0000);
  assert.equal(P.parseThemeColor('ff8800'), 0xff8800);
  assert.equal(P.parseThemeColor('#f80'), 0xff8800);
  assert.equal(P.parseThemeColor('0x5865F2'), 0x5865f2);
  assert.equal(P.parseThemeColor('rgb(88, 101, 242)'), 0x5865f2);
  assert.equal(P.parseThemeColor('255,0,0'), 0xff0000);
  assert.equal(P.parseThemeColor('Rouge'), P.NAMED_COLORS.rouge);
  assert.equal(P.parseThemeColor('blurple'), 0x5865f2);
  assert.equal(P.parseThemeColor('#000000'), 0x010101);
  assert.equal(P.parseThemeColor('noir'), 0x010101);
  for (const reset of ['défaut', 'defaut', 'Default', 'aucun']) assert.equal(P.parseThemeColor(reset), null, reset);
  for (const bad of ['', '#12345', 'rgb(256, 0, 0)', 'arc-en-ciel', '#GGGGGG', 'constructor', '__proto__']) {
    assert.throws(() => P.parseThemeColor(bad), (err) => err.isUserError, bad);
  }
  assert.equal(P.colorHex(0xff8800), '#FF8800');
  assert.equal(P.colorHex(null), null);
});

test('appearance : bloc dédié des valeurs par défaut, juste après locale', () => {
  assert.deepEqual(defaultGuildConfig.appearance, { color: null });
  const keys = Object.keys(defaultGuildConfig);
  assert.equal(keys[keys.indexOf('locale') + 1], 'appearance');
});

test('profil par serveur : pseudo (usurpation, mots interdits, mentions, longueur) et bio', () => {
  const cfg = { automod: { filters: { badWords: { enabled: false, words: ['interdit'] } } } };
  assert.equal(P.validateNick('  Gadget   Bot ', cfg), 'Gadget Bot');
  for (const bad of ['Discord Staff', 'Admin du serveur', 'Modérateur', 'mot interdit ici', '@everyone', '<@123456789012345678>', 'x'.repeat(33), '   ']) {
    assert.throws(() => P.validateNick(bad, cfg), (err) => err.isUserError, bad);
  }
  assert.equal(P.validateBio('Je réponds à vos questions sur ce serveur.', cfg), 'Je réponds à vos questions sur ce serveur.');
  for (const bad of ['Rejoignez discord.gg/arnaque', 'Coucou @everyone', 'Nitro gratuit : https://discord-gift.ru/free', 'un mot interdit', 'Bot officiel du staff Discord', 'x'.repeat(191), '']) {
    assert.throws(() => P.validateBio(bad, cfg), (err) => err.isUserError, bad);
  }
  // Nom global (console /bot).
  assert.equal(P.validateUsername('Inspecteur Gadget'), 'Inspecteur Gadget');
  for (const bad of ['a', 'x'.repeat(33), 'Discord Bot', 'nom@bot', 'everyone']) assert.throws(() => P.validateUsername(bad), (err) => err.isUserError, bad);
});

test('pièce jointe image : type annoncé et taille vérifiés AVANT le téléchargement', () => {
  assert.doesNotThrow(() => P.assertImageAttachment({ contentType: 'image/png', size: 1024 }));
  assert.doesNotThrow(() => P.assertImageAttachment({ contentType: 'image/jpeg; charset=binary', size: 1024 }));
  assert.throws(() => P.assertImageAttachment({ contentType: 'image/png', size: 9 * 1024 * 1024 }), /trop lourde \(9\.0 Mo\)/);
  assert.throws(() => P.assertImageAttachment({ contentType: 'image/svg+xml', size: 10 }), /PNG, JPEG, GIF ou WebP/);
  assert.throws(() => P.assertImageAttachment({ contentType: 'application/x-msdownload', size: 10 }), /PNG/);
  assert.throws(() => P.assertImageAttachment(null), /joignez/);
});

test('erreurs de Discord sur le profil : limites de débit et refus traduits', () => {
  assert.match(P.translateProfileError({ status: 429 }).message, /trop de modifications/);
  assert.match(P.translateProfileError({ code: 50035, message: 'Invalid Form Body\nusername[USERNAME_RATE_LIMIT]: You are changing your username too fast.' }).message, /trop de modifications/);
  assert.match(P.translateProfileError({ code: 50035, message: 'Invalid Form Body\nusername[USERNAME_ALREADY_TAKEN]' }).message, /refuse ce nom/);
  assert.match(P.translateProfileError({ code: 50035, message: 'Invalid Form Body\navatar[BINARY_TYPE_MAX_SIZE]' }).message, /refuse cette image/);
  const other = new Error('autre');
  assert.equal(P.translateProfileError(other), other);
});

test('BotSettingsRepository (migration #29) : valeurs JSON globales, sans guild_id', () => {
  const { manager, db } = memoryDb();
  try {
    const columns = db.prepare('PRAGMA table_info(bot_settings)').all().map((c) => c.name);
    assert.deepEqual(columns, ['key', 'value', 'updated_at', 'updated_by']);
    assert.ok(db.prepare('SELECT 1 FROM _migrations WHERE id = 29').get(), 'migration #29 appliquée');
    const repo = new BotSettingsRepository(db);
    assert.equal(repo.get('presence'), null);
    repo.set('presence', { activity: { type: 0, text: 'x' }, status: 'idle' }, '42', 1000);
    assert.deepEqual(repo.get('presence'), { activity: { type: 0, text: 'x' }, status: 'idle' });
    assert.deepEqual(repo.entry('presence'), { value: { activity: { type: 0, text: 'x' }, status: 'idle' }, updatedAt: 1000, updatedBy: '42' });
    db.prepare('UPDATE bot_settings SET value = ? WHERE key = ?').run('{abîmé', 'presence');
    assert.equal(repo.get('presence'), null, 'JSON illisible → null');
    assert.equal(repo.delete('presence'), true);
    assert.equal(repo.delete('presence'), false);
  } finally {
    manager.close();
  }
});

test('profil : la permission « Changer de pseudo » est exigée pour le pseudo seulement', async () => {
  const edits = [];
  const guild = (perms) => ({
    members: {
      me: { permissions: new PermissionsBitField(perms) },
      editMe: async (body) => edits.push(body),
    },
  });
  const svc = new P.BotProfileService({ client: {}, settings: null });
  await assert.rejects(svc.applyGuildProfile(guild([]), { nick: 'Gadget' }), /Changer de pseudo/);
  await svc.applyGuildProfile(guild([]), { bio: 'Salut' }, { reason: 'test' });
  await svc.applyGuildProfile(guild(['ChangeNickname']), { nick: null, avatar: Buffer.from('x'), banner: undefined }, { reason: 'test' });
  assert.deepEqual(edits[0], { bio: 'Salut', reason: 'test' });
  assert.deepEqual(Object.keys(edits[1]).sort(), ['avatar', 'nick', 'reason']);
  assert.equal(edits[1].nick, null);
  assert.ok(Buffer.isBuffer(edits[1].avatar), 'jamais de chaîne passée à editMe');
  assert.equal(await svc.applyGuildProfile(guild([]), {}), null, 'rien à changer : aucun appel');
  assert.equal(edits.length, 2);
});
