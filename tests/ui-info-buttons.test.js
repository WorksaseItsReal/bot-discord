'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { CommandHandler } = require('../src/core/CommandHandler');
const { TONES } = require('../src/utils/ui');

/**
 * Cartes et boutons des commandes d'information, utilitaires et fun
 * (rendus purs + handlers de boutons avec des interactions factices).
 */

const OWNER = '111111111111111111';
const OTHER = '222222222222222222';
const isUserError = (e) => e?.isUserError === true;

const json = (payload) => ({
  embeds: (payload.embeds || []).map((e) => (typeof e.toJSON === 'function' ? e.toJSON() : e)),
  rows: (payload.components || []).map((r) => (typeof r.toJSON === 'function' ? r.toJSON() : r)),
});
const ids = (payload) => json(payload).rows.flatMap((r) => r.components.map((c) => c.custom_id).filter(Boolean));

/** Vérifie les limites Discord des composants d'un rendu. */
function assertComponentLimits(payload) {
  const { rows } = json(payload);
  assert.ok(rows.length <= 5, 'au plus 5 rangées');
  for (const r of rows) {
    assert.ok(r.components.length <= 5, 'au plus 5 boutons par rangée');
    for (const c of r.components) if (c.custom_id) assert.ok(c.custom_id.length <= 100, `customId trop long : ${c.custom_id}`);
  }
}

/** Interaction de bouton factice : enregistre la mise à jour. */
function fakeButton(userId, message = null) {
  const it = { user: { id: userId }, message, updated: null, replied: null };
  it.update = async (p) => {
    it.updated = p;
  };
  it.reply = async (p) => {
    it.replied = p;
  };
  return it;
}

test('/8ball : Redemander relit la question et garde 🗑️', async () => {
  const ball = require('../src/commands/fun/8ball');
  const first = ball.render('Vais-je réussir ?', OWNER);
  assertComponentLimits(first);
  assert.deepEqual(ids(first), [`cmd:8ball:again:${OWNER}:2`, `cmd:_:delete:${OWNER}`]);
  const message = { embeds: json(first).embeds };
  assert.equal(ball.questionFrom(message), 'Vais-je réussir ?');

  await assert.rejects(ball.buttons.again(fakeButton(OTHER, message), null, [OWNER, '2']), isUserError);
  await assert.rejects(ball.buttons.again(fakeButton(OWNER, { embeds: [] }), null, [OWNER, '2']), isUserError);

  const it = fakeButton(OWNER, message);
  await ball.buttons.again(it, null, [OWNER, '2']);
  const out = json(it.updated);
  assert.equal(out.embeds[0].color, TONES.fun);
  assert.equal(out.embeds[0].fields[0].value, 'Vais-je réussir ?');
  assert.match(out.embeds[0].description, /Tentative n° 2/);
  assert.deepEqual(ids(it.updated), [`cmd:8ball:again:${OWNER}:3`, `cmd:_:delete:${OWNER}`]);
});

test('/choisir : la liste affichée se relit à l\'identique', async () => {
  const choisir = require('../src/commands/fun/choisir');
  const options = ['pizza', '› sushi', '**gras**', '➜ **piège**'];
  for (const choice of options) assert.deepEqual(choisir.parseDisplayed(choisir.formatOptions(options, choice)), options);
  assert.equal(choisir.parseDisplayed('liste tronquée…'), null);
  assert.deepEqual(choisir.parseOptions(' a | b, a ,, c '), ['a', 'b', 'c']);

  const first = choisir.render(options, OWNER);
  const message = { embeds: json(first).embeds };
  const it = fakeButton(OWNER, message);
  await choisir.buttons.again(it, null, [OWNER, '2']);
  const field = json(it.updated).embeds[0].fields[0];
  assert.deepEqual(choisir.parseDisplayed(field.value), options);
  assert.ok(ids(it.updated).includes(`cmd:_:delete:${OWNER}`));

  await assert.rejects(choisir.buttons.again(fakeButton(OTHER, message), null, [OWNER]), isUserError);
  await assert.rejects(choisir.buttons.again(fakeButton(OWNER, { embeds: [] }), null, [OWNER]), isUserError);

  // Liste trop longue pour un champ : pas de bouton (il ne pourrait pas la relire).
  const many = Array.from({ length: 200 }, (_, i) => `option-${i}`);
  assert.deepEqual(ids(choisir.render(many, OWNER)), [`cmd:_:delete:${OWNER}`]);
});

test('/de : Relancer encode la notation et refuse les arguments invalides', async () => {
  const de = require('../src/commands/fun/de');
  const { parseDice } = require('../src/utils/random');
  const dice = parseDice('3d8-2');
  assert.equal(de.notationOf(dice), '3d8-2');
  const out = de.render(dice, OWNER, () => 0.999);
  assertComponentLimits(out);
  assert.equal(ids(out)[0], `cmd:de:roll:${OWNER}:3d8-2`);
  assert.match(json(out).embeds[0].description, /# 22/);

  await assert.rejects(de.buttons.roll(fakeButton(OWNER), null, [OWNER, '9999d6']), isUserError);
  await assert.rejects(de.buttons.roll(fakeButton(OWNER), null, [OWNER]), isUserError);
  await assert.rejects(de.buttons.roll(fakeButton(OTHER), null, [OWNER, '1d6']), isUserError);
  const it = fakeButton(OWNER);
  await de.buttons.roll(it, null, [OWNER, '1d20']);
  assert.deepEqual(ids(it.updated), [`cmd:de:roll:${OWNER}:1d20`, `cmd:_:delete:${OWNER}`]);
});

test('/pileface : Relancer garde le pari', async () => {
  const pf = require('../src/commands/fun/pileface');
  const out = json(pf.render('pile', OWNER, () => 0.1));
  assert.match(out.embeds[0].description, /PILE/);
  assert.ok(out.embeds[0].fields.some((f) => f.value.includes('Gagné')));
  await assert.rejects(pf.buttons.flip(fakeButton(OWNER), null, [OWNER, 'tranche']), isUserError);
  const it = fakeButton(OWNER);
  await pf.buttons.flip(it, null, [OWNER, '-']);
  assert.deepEqual(ids(it.updated), [`cmd:pileface:flip:${OWNER}:-`, `cmd:_:delete:${OWNER}`]);
});

test('/pfc : boutons persistants, score conservé entre les manches', async () => {
  const pfc = require('../src/commands/fun/pfc');
  const board = pfc.renderBoard(OWNER);
  assertComponentLimits(board);
  assert.deepEqual(ids(board), [
    `cmd:pfc:play:${OWNER}:pierre:0-0-0`,
    `cmd:pfc:play:${OWNER}:feuille:0-0-0`,
    `cmd:pfc:play:${OWNER}:ciseaux:0-0-0`,
    `cmd:_:delete:${OWNER}`,
  ]);
  const result = pfc.renderResult(OWNER, 'pierre', 'ciseaux', [1, 0, 2]);
  assert.equal(json(result).embeds[0].color, TONES.success);
  assert.deepEqual(ids(result), [`cmd:pfc:again:${OWNER}:2-0-2`, `cmd:_:delete:${OWNER}`]);
  assert.deepEqual(pfc.parseScore('nimporte'), [0, 0, 0]);

  await assert.rejects(pfc.buttons.play(fakeButton(OWNER), null, [OWNER, 'lézard', '0-0-0']), isUserError);
  await assert.rejects(pfc.buttons.play(fakeButton(OTHER), null, [OWNER, 'pierre', '0-0-0']), isUserError);
  const it = fakeButton(OWNER);
  await pfc.buttons.again(it, null, [OWNER, '3-1-0']);
  assert.match(json(it.updated).embeds[0].description, /3\*\* victoires/);
});

test('/couleur : « Autre couleur » seulement pour une couleur aléatoire', async () => {
  const couleur = require('../src/commands/utility/couleur');
  const fixed = json(couleur.render(0xff0000));
  assert.equal(fixed.embeds[0].color, 0xff0000);
  assert.equal(fixed.rows.length, 0);
  assert.equal(couleur.readableText(255, 255, 255), 'Noir');
  assert.equal(couleur.readableText(0, 0, 0), 'Blanc');
  assert.deepEqual(ids(couleur.render(0x123456, { random: true, ownerId: OWNER })), [`cmd:couleur:random:${OWNER}`, `cmd:_:delete:${OWNER}`]);
  await assert.rejects(couleur.buttons.random(fakeButton(OTHER), null, [OWNER]), isUserError);
});

test('/tag : le contenu est rendu dans une carte neutre', () => {
  const { tagCard } = require('../src/commands/utility/tag');
  const e = tagCard('regles', 'Soyez gentils, <@1>.').toJSON();
  assert.equal(e.color, TONES.neutral);
  assert.equal(e.description, 'Soyez gentils, <@1>.');
  assert.match(e.title, /regles/);
  assert.match(e.author.name, /Utilitaires/);
  assert.equal(tagCard('vide', '').toJSON().description, '*Ce tag est vide.*');
});

test('/reminder : liste avec boutons d\'annulation et handler défensif', async () => {
  const reminder = require('../src/commands/utility/reminder');
  const now = Date.now();
  const list = Array.from({ length: 12 }, (_, i) => ({ id: i + 1, remind_at: now + i * 60_000, message: `Rappel ${i + 1}` }));
  const out = reminder.renderList(list, OWNER);
  assertComponentLimits(out);
  assert.equal(ids(out).length, 10);
  assert.equal(ids(out)[0], `cmd:reminder:cancel:${OWNER}:1:l`);
  assert.equal(json(reminder.renderList([], OWNER)).embeds[0].color, TONES.info);

  const store = [...list];
  const client = {
    repositories: {
      reminders: {
        delete: (id, userId) => {
          const i = store.findIndex((r) => r.id === id);
          if (i < 0 || userId !== OWNER) return false;
          store.splice(i, 1);
          return true;
        },
        listByUser: () => store,
      },
    },
  };
  await assert.rejects(reminder.buttons.cancel(fakeButton(OTHER), client, [OWNER, '1', 'l']), isUserError);
  await assert.rejects(reminder.buttons.cancel(fakeButton(OWNER), client, [OWNER, 'abc', 'l']), isUserError);
  await assert.rejects(reminder.buttons.cancel(fakeButton(OWNER), client, [OWNER, '999', 'c']), isUserError);
  const it = fakeButton(OWNER);
  await reminder.buttons.cancel(it, client, [OWNER, '1', 'l']);
  assert.equal(store.length, 11);
  assert.ok(!ids(it.updated).includes(`cmd:reminder:cancel:${OWNER}:1:l`));
  const done = fakeButton(OWNER);
  await reminder.buttons.cancel(done, client, [OWNER, '2', 'c']);
  assert.equal(json(done.updated).embeds[0].color, TONES.success);
  assert.equal(json(done.updated).rows.length, 0);
});

test('/avatar : bascule serveur/global seulement si les deux existent', async () => {
  const avatar = require('../src/commands/information/avatar');
  const url = (o = {}) => `https://cdn.example/a.${o.extension ?? 'png'}?size=${o.size}`;
  const user = { id: OWNER, username: 'bob', avatar: 'a_hash', displayAvatarURL: url, toString: () => `<@${OWNER}>` };
  const plain = avatar.render({ user, member: null, mode: 'g', ownerId: OWNER });
  assertComponentLimits(plain);
  assert.ok(!ids(plain).some((id) => id.startsWith('cmd:avatar:')));
  assert.equal(json(plain).rows.flatMap((r) => r.components).filter((c) => c.url).length, 4, 'PNG, JPG, WEBP, GIF');

  const member = { avatar: 'guildhash', displayName: 'Bobby', displayColor: 0, displayAvatarURL: url };
  const both = avatar.render({ user, member, mode: 'g', ownerId: OWNER });
  assert.equal(ids(both)[0], `cmd:avatar:show:${OWNER}:${OWNER}:s`);
  await assert.rejects(avatar.buttons.show(fakeButton(OWNER), {}, [OWNER, 'pas-un-id', 's']), isUserError);
  await assert.rejects(avatar.buttons.show(fakeButton(OTHER), {}, [OWNER, OWNER, 's']), isUserError);
});

test('/help : accueil, catégories et fiches de toutes les commandes', () => {
  const help = require('../src/commands/information/help');
  const commands = new CommandHandler().loadAll(path.join(__dirname, '..', 'src', 'commands'));
  const client = { commands, user: { username: 'Gadget', displayAvatarURL: () => 'https://cdn.example/bot.png' } };
  const grouped = help.groupByCategory(commands);
  const home = help.homeEmbed(client, grouped).toJSON();
  assert.equal(home.color, TONES.brand);
  assert.ok(home.fields.length <= 25);
  for (const [key, cmds] of grouped) {
    const e = help.categoryEmbed(key, cmds).toJSON();
    assert.ok(e.description.length <= 4096);
  }
  for (const cmd of commands.values()) {
    const e = help.commandDetailEmbed(cmd).toJSON();
    assert.ok(e.fields.length <= 25, `/${cmd.data.name}`);
    assert.ok(e.fields.every((f) => f.value.length <= 1024 && f.value.length > 0), `/${cmd.data.name}`);
  }
});

test('/timestamp et /inrole : cartes conformes', () => {
  const ts = require('../src/commands/utility/timestamp').render(Date.UTC(2026, 0, 1), 'Europe/Paris').toJSON();
  assert.equal(ts.color, TONES.info);
  assert.ok(ts.fields.some((f) => f.value.includes('<t:1767225600:R>')));

  const { buildPages } = require('../src/commands/information/inrole');
  const role = { name: 'Staff', color: 0xff8800, hexColor: '#ff8800', toString: () => '<@&1>' };
  const members = Array.from({ length: 45 }, (_, i) => ({ id: String(i), user: { username: `m${i}`, bot: i % 10 === 0 }, toString: () => `<@${i}>` }));
  const pages = buildPages(role, members);
  assert.equal(pages.length, 3);
  const first = pages[0].toJSON();
  assert.equal(first.color, 0xff8800);
  assert.ok(first.fields.some((f) => f.name.includes('Bots') && f.value === '**5**'));
});
