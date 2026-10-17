'use strict';

/**
 * channelRemap (SEC1, partagé avec SEC4 et ADM2) : report d'un salon vers un autre dans la
 * configuration et la base.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { memoryDb } = require('./db.helper');
const { GuildConfigRepository } = require('../src/database/repositories/GuildConfigRepository');
const { ConfigService } = require('../src/services/ConfigService');
const { COLUMNS, remapInPlace, capture, restore, lossSummary } = require('../src/utils/channelRemap');

const G = '100000000000000001';
const OTHER = '100000000000000002';
const OLD = '200000000000000001';
const NEW = '200000000000000002';
const OTHER_CH = '200000000000000003';

const tables = (db) => db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name);
const columnsOf = (db, t) => db.prepare(`PRAGMA table_info("${t}")`).all();

/** Une ligne par table pour le serveur `guildId` : colonnes *channel_id* = `channelId`. */
function seed(db, guildId, channelId, n) {
  const all = tables(db).filter((t) => t !== '_migrations');
  const fk = (t) => db.prepare(`PRAGMA foreign_key_list("${t}")`).all().length > 0;
  for (const t of [...all.filter((x) => !fk(x)), ...all.filter(fk)]) {
    const cols = columnsOf(db, t);
    const values = cols.map((c) => {
      if (c.name === 'guild_id') return guildId;
      if (/channel_id$/.test(c.name)) return channelId;
      if (/INT|REAL|NUM/i.test(c.type)) return n;
      return `${c.name}-${n}`;
    });
    db.prepare(`INSERT INTO "${t}" (${cols.map((c) => `"${c.name}"`).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...values);
  }
}

/** État complet de la base et de la configuration stockée (comparaison). */
function dump(db) {
  return JSON.stringify(tables(db).filter((t) => t !== '_migrations' && t !== 'guild_config').map((t) => [t, db.prepare(`SELECT * FROM "${t}"`).all().map((r) => JSON.stringify(r)).sort()]))
    + JSON.stringify(db.prepare('SELECT guild_id, data FROM guild_config ORDER BY guild_id').all());
}

function worldOf() {
  const { db } = memoryDb();
  const config = new ConfigService(new GuildConfigRepository(db));
  seed(db, G, OLD, 1);
  seed(db, OTHER, OTHER_CH, 2); // un AUTRE serveur : jamais touché
  // guild_config a été semé brut : on repart d'une configuration propre.
  db.prepare('DELETE FROM guild_config').run();
  config.update(G, { logChannels: { security: OLD, messages: 'autre' }, logs: { ignoredChannels: [OLD, '300'] }, antiraid: { alertChannel: OLD } });
  db.prepare('UPDATE guild_config SET data = json_set(data, \'$._corruptBackup\', json(?)) WHERE guild_id = ?').run(JSON.stringify({ raw: OLD }), G);
  config.cache.clear();
  return { db, config };
}

test('chaque colonne *channel_id* de TOUTES les tables est classée (reportée, perdue, jamais recréée ou historique)', () => {
  const { db } = memoryDb();
  const unclassified = [];
  for (const t of tables(db)) {
    for (const c of columnsOf(db, t)) if (/channel_id/.test(c.name) && !COLUMNS[`${t}.${c.name}`]) unclassified.push(`${t}.${c.name}`);
  }
  assert.deepEqual(unclassified, [], 'classez la colonne dans COLUMNS (src/utils/channelRemap.js)');
  for (const key of Object.keys(COLUMNS)) {
    const [t, c] = key.split('.');
    assert.ok(columnsOf(db, t).some((x) => x.name === c), `${key} : colonne inexistante`);
  }
});

test('remapInPlace puis son inverse → état identique (base et configuration) ; autre serveur et _corruptBackup intacts', () => {
  const { db, config } = worldOf();
  const before = dump(db);
  const report = remapInPlace(db, config, G, OLD, NEW, { resetMessages: false });
  assert.ok(report.carried.feeds && report.carried.sticky_messages && report.carried.projects, JSON.stringify(report.carried));
  assert.deepEqual(report.configPaths.sort(), ['antiraid.alertChannel', 'logChannels.security', 'logs.ignoredChannels.0']);
  assert.equal(config.get(G).logChannels.security, NEW);
  assert.deepEqual(config.get(G).logs.ignoredChannels, [NEW, '300']);
  assert.equal(db.prepare('SELECT channel_id FROM feeds WHERE guild_id = ?').get(OTHER).channel_id, OTHER_CH, 'autre serveur modifié');
  assert.equal(db.prepare('SELECT channel_id FROM tickets WHERE guild_id = ?').get(G).channel_id, OLD, 'ticket reporté');
  assert.equal(JSON.parse(db.prepare('SELECT data FROM guild_config WHERE guild_id = ?').get(G).data)._corruptBackup.raw, OLD, '_corruptBackup modifié');
  remapInPlace(db, config, G, NEW, OLD, { resetMessages: false });
  assert.equal(dump(db), before);
});

test('remapInPlace (par défaut) : messages liés remis à NULL ; pertes et salons jamais recréés signalés', () => {
  const { db, config } = worldOf();
  const report = remapInPlace(db, config, G, OLD, NEW);
  assert.equal(db.prepare('SELECT last_message_id FROM sticky_messages WHERE guild_id = ?').get(G).last_message_id, null);
  assert.equal(db.prepare('SELECT panel_message_id FROM application_forms WHERE guild_id = ?').get(G).panel_message_id, null);
  assert.equal(db.prepare('SELECT message_id FROM projects WHERE guild_id = ?').get(G).message_id, null);
  assert.deepEqual(Object.keys(report.lost).sort(), ['giveaways', 'role_menus', 'starboard', 'suggestions']);
  assert.deepEqual(Object.keys(report.never).sort(), ['applications', 'modmail_threads', 'temp_voice', 'tickets']);
  assert.match(lossSummary(report), /menus de rôles perdu/);
  assert.match(lossSummary(report), /tickets non recréé/);
  // Historique laissé tel quel.
  assert.equal(db.prepare('SELECT log_channel_id FROM sanctions WHERE guild_id = ?').get(G).log_channel_id, OLD);
});

test('capture puis restore : lignes effacées par les écouteurs (sticky) réinsérées, autres mises à jour, configuration reportée', () => {
  const { db, config } = worldOf();
  const bundle = capture(db, config, G, OLD);
  assert.ok(bundle.rows['sticky_messages.channel_id']?.length === 1);
  assert.deepEqual(bundle.configPaths.sort(), ['antiraid.alertChannel', 'logChannels.security', 'logs.ignoredChannels.0']);
  assert.equal(JSON.stringify(bundle).includes('"db"'), false, 'références internes énumérables');
  // Nettoyages des écouteurs (StickyService, LogSetupService…) après la suppression du salon.
  db.prepare('DELETE FROM sticky_messages WHERE guild_id = ? AND channel_id = ?').run(G, OLD);
  config.update(G, { logChannels: { security: null } });
  const res = restore(bundle, NEW);
  assert.equal(res.reinserted, 1, 'ligne sticky non réinsérée');
  assert.ok(res.updated >= 5, `${res.updated} ligne(s) mise(s) à jour`);
  const sticky = db.prepare('SELECT * FROM sticky_messages WHERE guild_id = ?').get(G);
  assert.equal(sticky.channel_id, NEW);
  assert.equal(sticky.last_message_id, null);
  assert.equal(db.prepare('SELECT channel_id FROM feeds WHERE guild_id = ?').get(G).channel_id, NEW);
  // Chemin effacé entre-temps (salon des logs débranché) : laissé tel quel ; les autres reportés.
  assert.equal(config.get(G).logChannels.security, null);
  assert.equal(config.get(G).antiraid.alertChannel, NEW);
  assert.deepEqual(res.configPaths.sort(), ['antiraid.alertChannel', 'logs.ignoredChannels.0']);
  // Restauration rejouée : rien de plus.
  assert.equal(restore(bundle, NEW).reinserted, 0);
});
