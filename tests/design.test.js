'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { CommandHandler } = require('../src/core/CommandHandler');
const { card, field, alignInline, actionButton, TONES } = require('../src/utils/ui');

/**
 * Garde-fous du système de design (docs/DESIGN.md).
 */
const SRC = path.join(__dirname, '..', 'src');

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return walk(full);
    return e.name.endsWith('.js') ? [full] : [];
  });
}
const files = walk(SRC).map((f) => ({ file: path.relative(SRC, f), text: fs.readFileSync(f, 'utf8') }));

/** Seuls ces fichiers peuvent construire des embeds « à la main ». */
const RAW_EMBED_ALLOWED = new Set([
  'utils/ui.js',
  path.join('commands', 'utility', 'embed.js'), // embeds libres créés par les utilisateurs
  path.join('components', 'embedbuilder.js'),
].map((p) => path.normalize(p)));

test('aucun EmbedBuilder ni setColor hors du système de design', () => {
  const offenders = files
    .filter(({ file }) => !RAW_EMBED_ALLOWED.has(path.normalize(file)))
    .filter(({ text }) => /new EmbedBuilder\(|\.setColor\(/.test(text))
    .map(({ file }) => file);
  assert.deepStrictEqual(offenders, [], `Utilisez card()/status de utils/ui.js dans : ${offenders.join(', ')}`);
});

test('aucune réponse d\'interaction en texte brut', () => {
  const offenders = files
    .filter(({ text }) => /\.(reply|editReply|followUp|update)\(\s*['"`]/.test(text))
    .map(({ file }) => file);
  assert.deepStrictEqual(offenders, []);
});

test('chaque actionButton vise une action existante', () => {
  const commands = new CommandHandler().loadAll(path.join(SRC, 'commands'));
  const re = /actionButton\(\{\s*command:\s*'([\w-]+)',\s*action:\s*'([\w-]+)'/g;
  const missing = [];
  for (const { file, text } of files) {
    for (const [, command, action] of text.matchAll(re)) {
      if (command === '_') continue;
      const handler = commands.get(command)?.buttons?.[action];
      if (typeof handler !== 'function') missing.push(`${file} → ${command}.${action}`);
    }
  }
  assert.deepStrictEqual(missing, []);
});

test('card() : couleur par ton, champs alignés par 3, limites respectées', () => {
  const json = card({
    tone: 'danger',
    section: 'moderation',
    title: 'x'.repeat(300),
    description: ['a', null, 'b'],
    fields: [field('👤', 'A', '1'), field('🛡️', 'B', ''), null, { name: 'Long', value: 'v'.repeat(2000) }],
  }).toJSON();
  assert.strictEqual(json.color, TONES.danger);
  assert.strictEqual(json.title.length, 256);
  assert.strictEqual(json.description, 'a\nb');
  assert.strictEqual(json.fields.length, 4, '2 inline + 1 espaceur + 1 large');
  assert.strictEqual(json.fields[1].value, '—');
  assert.ok(json.fields[3].value.length <= 1024);
  assert.ok(json.author.name.includes('Modération'));
  assert.ok(json.footer.text);
});

test('alignInline ne complète que les groupes de 2', () => {
  const f = (inline) => ({ name: 'n', value: 'v', inline });
  assert.strictEqual(alignInline([f(true), f(true), f(true)]).length, 3);
  assert.strictEqual(alignInline([f(true), f(true), f(false)]).length, 4);
  assert.strictEqual(alignInline([f(true), f(false)]).length, 2);
});

test('actionButton refuse un customId trop long', () => {
  assert.throws(() => actionButton({ command: 'x', action: 'y', args: ['z'.repeat(100)], label: 'a' }));
  assert.strictEqual(actionButton({ command: 'ping', action: 'refresh', args: ['1'], label: 'a' }).toJSON().custom_id, 'cmd:ping:refresh:1');
});
