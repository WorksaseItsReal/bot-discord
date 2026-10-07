'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { ApplicationCommandOptionType: T } = require('discord.js');
const { CommandHandler } = require('../src/core/CommandHandler');

/**
 * Valide TOUTES les slash commands contre les limites de l'API Discord,
 * pour qu'aucun déploiement ne soit refusé (erreur 50035 « Invalid Form Body »).
 */
const handler = new CommandHandler();
const commands = handler.loadAll(path.join(__dirname, '..', 'src', 'commands'));
const NAME_RE = /^[-_\p{Ll}\p{N}\p{sc=Deva}\p{sc=Thai}]{1,32}$/u;

function checkOptions(cmdName, options, depth = 0) {
  assert.ok(options.length <= 25, `/${cmdName} : plus de 25 options/sous-commandes`);
  const names = new Set();
  let seenOptional = false;
  for (const o of options) {
    assert.match(o.name, NAME_RE, `/${cmdName} : nom d'option invalide « ${o.name} »`);
    assert.ok(!names.has(o.name), `/${cmdName} : option en double « ${o.name} »`);
    names.add(o.name);
    assert.ok(o.description && o.description.length <= 100, `/${cmdName} ${o.name} : description absente ou > 100`);
    if (o.choices) {
      assert.ok(o.choices.length <= 25, `/${cmdName} ${o.name} : plus de 25 choix`);
      for (const c of o.choices) assert.ok(c.name.length <= 100, `/${cmdName} ${o.name} : choix trop long`);
    }
    if (o.autocomplete) assert.ok(!o.choices?.length, `/${cmdName} ${o.name} : autocomplete et choices incompatibles`);
    if (o.type === T.Subcommand || o.type === T.SubcommandGroup) {
      assert.ok(depth < 2, `/${cmdName} : imbrication trop profonde`);
      checkOptions(`${cmdName} ${o.name}`, o.options || [], depth + 1);
    } else {
      // Discord impose les options obligatoires avant les optionnelles.
      if (o.required) assert.ok(!seenOptional, `/${cmdName} : option obligatoire « ${o.name} » après une optionnelle`);
      else seenOptional = true;
    }
  }
}

test('au moins 60 commandes chargées sans erreur', () => {
  assert.ok(commands.size >= 60, `seulement ${commands.size} commandes`);
});

test('chaque fichier de commande est chargé (aucun échec silencieux)', () => {
  const files = CommandHandler.countFiles(path.join(__dirname, '..', 'src', 'commands'));
  assert.deepStrictEqual(handler.failures, [], `échecs : ${handler.failures.map((f) => `${f.file} (${f.reason})`).join(', ')}`);
  assert.strictEqual(commands.size, files, `${commands.size} commande(s) chargée(s) pour ${files} fichier(s)`);
});

test('noms et descriptions de commandes conformes', () => {
  for (const cmd of commands.values()) {
    const json = cmd.data.toJSON();
    assert.match(json.name, NAME_RE, `nom invalide : ${json.name}`);
    assert.ok(json.description && json.description.length <= 100, `/${json.name} : description absente ou > 100`);
    assert.ok(typeof cmd.execute === 'function');
  }
});

test('options conformes (limites Discord, ordre obligatoire/optionnel)', () => {
  for (const cmd of commands.values()) {
    const json = cmd.data.toJSON();
    checkOptions(json.name, json.options || []);
  }
});

test('les commandes avec autocomplétion exportent autocomplete()', () => {
  for (const cmd of commands.values()) {
    const json = JSON.stringify(cmd.data.toJSON());
    if (json.includes('"autocomplete":true')) assert.strictEqual(typeof cmd.autocomplete, 'function', `/${cmd.data.name} sans autocomplete()`);
  }
});

test('contexte : commandes serveur par défaut, MP seulement si déclaré', () => {
  for (const cmd of commands.values()) {
    const json = cmd.data.toJSON();
    assert.ok(Array.isArray(json.contexts) && json.contexts.length >= 1, `/${json.name} sans contexts`);
    assert.strictEqual(json.contexts.includes(1), cmd.guildOnly === false, `/${json.name} : contexte MP incohérent`);
    assert.strictEqual(json.dm_permission, undefined, `/${json.name} : dm_permission déprécié`);
  }
});

test('taille totale du payload de chaque commande < 8000 caractères', () => {
  for (const cmd of commands.values()) {
    const json = cmd.data.toJSON();
    const size = JSON.stringify(json).length;
    assert.ok(size < 8000, `/${json.name} : payload ${size}`);
  }
});

test('chaque catégorie de commande est connue de /help', () => {
  const { CATEGORIES } = require('../src/utils/categories');
  for (const cmd of commands.values()) assert.ok(CATEGORIES[cmd.category], `/${cmd.data.name} : catégorie « ${cmd.category} » inconnue`);
});
