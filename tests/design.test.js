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

/**
 * Objet littéral passé à `actionButton({ … })`, sur une ou plusieurs lignes : texte entre
 * l'accolade ouvrante et l'accolade fermante correspondante (chaînes et `${}` gérés).
 */
function objectLiteralAt(text, open) {
  let depth = 0;
  let quote = null;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      else if (quote === '`' && c === '$' && text[i + 1] === '{') {
        // ${…} : on saute l'expression en comptant ses accolades.
        let d = 0;
        for (i++; i < text.length; i++) {
          if (text[i] === '{') d++;
          else if (text[i] === '}' && --d === 0) break;
        }
      }
      continue;
    }
    if (c === "'" || c === '"' || c === '`') quote = c;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return text.slice(open + 1, i);
  }
  return null;
}

/** Valeur littérale d'une clé (`command: 'x'`), ou null si elle est calculée ou absente. */
function literalKey(objText, key) {
  const m = new RegExp(`(?:^|[,{\\s])${key}\\s*:\\s*(['"\`])([\\w-]+)\\1`).exec(objText);
  return m ? m[2] : null;
}

/**
 * Routes `cmd:<commande>:<action>` écrites en dur dans une source :
 *  - appels `actionButton({ command: '…', action: '…' })`, même sur plusieurs lignes ;
 *  - customId littéraux ('cmd:x:y', "cmd:x:y:…", `cmd:x:y:${arg}`) — un segment
 *    calculé (`cmd:x:${action}`, `cmd:${cmd}:y`, `cmd:x:y${z}`) est ignoré : pas de faux positif.
 * @returns {Array<{ command: string, action: string, line: number }>}
 */
function literalRoutes(text) {
  const out = [];
  const lineAt = (index) => text.slice(0, index).split('\n').length;
  for (const m of text.matchAll(/actionButton\(\s*\{/g)) {
    const obj = objectLiteralAt(text, m.index + m[0].length - 1);
    if (obj == null) continue;
    const command = literalKey(obj, 'command');
    const action = literalKey(obj, 'action');
    if (command && action) out.push({ command, action, line: lineAt(m.index) });
  }
  for (const m of text.matchAll(/(['"`])cmd:([\w-]+):([\w-]+)(?=:|\1)/g)) {
    out.push({ command: m[2], action: m[3], line: lineAt(m.index) });
  }
  return out;
}

test('literalRoutes : appels multi-lignes, customId littéraux, segments calculés ignorés', () => {
  const sample = [
    'actionButton({',
    "  command: 'ping',",
    "  action: 'refresh',",
    '  label: `Page ${n} {x}`,',
    '});',
    "actionButton({ command: 'tempvoice', action, args: [a] });",
    "new ButtonBuilder().setCustomId('cmd:niveaux:nav');",
    'x.setCustomId(`cmd:sanctions:filter:${userId}`);',
    'x.setCustomId(`cmd:tempvoice:${action}`);',
    'x.setCustomId(`cmd:${name}:go`);',
    'x.setCustomId(`cmd:a:b${suffix}`);',
    "const ok = id.startsWith('cmd:_:delete:');",
  ].join('\n');
  assert.deepStrictEqual(
    literalRoutes(sample).map((r) => `${r.command}.${r.action}@${r.line}`),
    ['ping.refresh@1', 'niveaux.nav@7', 'sanctions.filter@8', '_.delete@12'],
  );
});

test('chaque route cmd:<commande>:<action> écrite en dur vise un handler existant', () => {
  const commands = new CommandHandler().loadAll(path.join(SRC, 'commands'));
  const missing = [];
  let checked = 0;
  for (const { file, text } of files) {
    for (const { command, action, line } of literalRoutes(text)) {
      if (command === '_') continue;
      checked += 1;
      const buttons = commands.get(command)?.buttons;
      const handler = buttons && Object.hasOwn(buttons, action) ? buttons[action] : null;
      if (typeof handler !== 'function') missing.push(`${file}:${line} → ${command}.${action}`);
    }
  }
  assert.ok(checked > 100, `trop peu de routes contrôlées (${checked}) : extraction cassée ?`);
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
