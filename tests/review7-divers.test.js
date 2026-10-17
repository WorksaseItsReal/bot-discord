'use strict';

/**
 * Revue n° 7, tests unitaires : lot « divers » — report des salons bloqués des alertes de
 * mots-clés (S41), contrôle strict des actions de modération (S29).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { memoryDb } = require('./db.helper');
const { GuildConfigRepository } = require('../src/database/repositories/GuildConfigRepository');
const { HighlightRepository } = require('../src/database/repositories/HighlightRepository');
const { ConfigService } = require('../src/services/ConfigService');
const channelRemap = require('../src/utils/channelRemap');

const G = '100000000000000001';
const OTHER = '100000000000000002';
const OLD = '200000000000000001';
const NEW = '200000000000000002';
const KEEP = '200000000000000003';
const U1 = '300000000000000001';
const U2 = '300000000000000002';
const U3 = '300000000000000003';

function world() {
  const { db } = memoryDb();
  const config = new ConfigService(new GuildConfigRepository(db));
  const highlights = new HighlightRepository(db);
  highlights.save({ guildId: G, userId: U1, words: ['gadget'], blockedChannels: [KEEP, OLD], blockedUsers: [] });
  highlights.save({ guildId: G, userId: U2, words: ['bot'], blockedChannels: [KEEP], blockedUsers: [] });
  highlights.save({ guildId: OTHER, userId: U1, words: ['gadget'], blockedChannels: [OLD], blockedUsers: [] });
  // Donnée abîmée : jamais lue comme une liste, jamais réécrite.
  db.prepare("INSERT INTO highlights (guild_id, user_id, words, blocked_channels, updated_at) VALUES (?, ?, '[]', ?, 0)").run(G, U3, `pas du json ${OLD}`);
  return { db, config, highlights };
}

// ------------------------------------------------------------------ S41

test('S41 chaque colonne de LISTE de salons (…_channels) est classée dans channelRemap', () => {
  const { db } = memoryDb();
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
  const missing = [];
  for (const t of tables) {
    for (const c of db.prepare(`PRAGMA table_info("${t}")`).all()) {
      if (/channels$/.test(c.name) && !channelRemap.JSON_LISTS.includes(`${t}.${c.name}`)) missing.push(`${t}.${c.name}`);
    }
  }
  assert.deepEqual(missing, []);
});

test('S41 remapInPlace (/channel renouveler) : le salon bloqué des alertes de mots-clés suit le salon, autre serveur et donnée abîmée intacts', () => {
  const { db, config, highlights } = world();
  const report = channelRemap.remapInPlace(db, config, G, OLD, NEW);
  assert.deepEqual(highlights.get(G, U1).blockedChannels, [KEEP, NEW]);
  assert.deepEqual(highlights.get(G, U2).blockedChannels, [KEEP]);
  assert.deepEqual(highlights.get(OTHER, U1).blockedChannels, [OLD], 'autre serveur intact');
  assert.equal(db.prepare('SELECT blocked_channels FROM highlights WHERE guild_id = ? AND user_id = ?').get(G, U3).blocked_channels, `pas du json ${OLD}`);
  assert.equal(report.carried.highlights, 1);
  // Inverse (annulation après un échec) : état d'origine.
  channelRemap.remapInPlace(db, config, G, NEW, OLD);
  assert.deepEqual(highlights.get(G, U1).blockedChannels, [KEEP, OLD]);
});

test('S41 capture puis restore (salon recréé par Secur) : le salon bloqué passe au nouveau salon ; la capture le compte', () => {
  const { db, config, highlights } = world();
  const bundle = channelRemap.capture(db, config, G, OLD);
  assert.equal(bundle.rows['highlights.blocked_channels']?.length, 1);
  const out = channelRemap.restore(bundle, NEW);
  assert.ok(out.updated >= 1);
  assert.deepEqual(highlights.get(G, U1).blockedChannels, [KEEP, NEW]);
  assert.deepEqual(highlights.get(OTHER, U1).blockedChannels, [OLD]);
});

test('S41 un salon déjà présent dans la liste n\'y figure pas deux fois', () => {
  const { db, config, highlights } = world();
  highlights.save({ guildId: G, userId: U2, words: ['bot'], blockedChannels: [NEW, OLD], blockedUsers: [] });
  channelRemap.remapInPlace(db, config, G, OLD, NEW);
  assert.deepEqual(highlights.get(G, U2).blockedChannels, [NEW]);
});
