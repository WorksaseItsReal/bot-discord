'use strict';

/**
 * Report d'un salon vers un autre (configuration + base) : salon recréé par Secur (SEC4) après
 * une suppression, ou renouvelé par /channel renouveler (ADM2). Source UNIQUE de ce traitement.
 *
 * Chaque colonne *channel_id* de la base est CLASSÉE (vérifié par tests/channel-remap.test.js) :
 *  - carry   : reportée sur le nouveau salon (message_id lié remis à NULL : le message est perdu) ;
 *  - lost    : le message publié est perdu (menu de rôles, starboard, giveaway, suggestion), signalé ;
 *  - never   : salon jamais recréé (ticket, ModMail, vocal temporaire, entretien) ;
 *  - history : historique, laissé tel quel (où s'est produit un événement passé).
 * Configuration : remplacement profond des valeurs EXACTEMENT égales (_corruptBackup ignoré).
 *
 * Toutes les requêtes filtrent sur guild_id ; les noms de tables et de colonnes viennent de la
 * table figée ci-dessous (jamais d'une saisie).
 */
const COLUMNS = Object.freeze({
  'feeds.channel_id': 'carry',
  'scheduled_announcements.channel_id': 'carry',
  'auto_thread_counters.channel_id': 'carry',
  'activity_daily.channel_id': 'carry',
  'sticky_messages.channel_id': 'carry',
  'application_forms.panel_channel_id': 'carry',
  'application_forms.review_channel_id': 'carry',
  'projects.channel_id': 'carry',
  'lock_state.channel_id': 'carry',
  'timed_channel_actions.channel_id': 'carry',
  'reminders.channel_id': 'carry',
  'role_menus.channel_id': 'lost',
  'starboard.channel_id': 'lost',
  'giveaways.channel_id': 'lost',
  'suggestions.channel_id': 'lost',
  'tickets.channel_id': 'never',
  'modmail_threads.channel_id': 'never',
  'temp_voice.channel_id': 'never',
  'applications.interview_channel_id': 'never',
  'automod_events.channel_id': 'history',
  'reports.channel_id': 'history',
  'reports.card_channel_id': 'history',
  'applications.card_channel_id': 'history',
  'sanctions.log_channel_id': 'history',
  'security_incidents.alert_channel_id': 'history',
  'security_grants.card_channel_id': 'history',
});

/**
 * Colonnes LISTES de salons (tableau JSON de chaînes) : l'identifiant est remplacé DANS la liste,
 * toujours reporté (alertes de mots-clés : salons bloqués par le membre). Une donnée illisible
 * n'est jamais réécrite. Vérifié par tests/review7-divers.test.js (colonnes « …channels »).
 */
const JSON_LISTS = Object.freeze(['highlights.blocked_channels']);

/** Colonnes de message remises à NULL quand le salon est reporté (le message n'existe plus). */
const RESETS = Object.freeze({
  'sticky_messages.channel_id': ['last_message_id'],
  'application_forms.panel_channel_id': ['panel_message_id'],
  'projects.channel_id': ['message_id'],
});

const LABELS = Object.freeze({
  role_menus: 'menus de rôles',
  starboard: 'messages du starboard',
  giveaways: 'giveaways',
  suggestions: 'suggestions',
  tickets: 'tickets',
  modmail_threads: 'conversations ModMail',
  temp_voice: 'vocaux temporaires',
  applications: 'entretiens de candidature',
});

const quote = (name) => `"${String(name).replace(/"/g, '""')}"`;

function tableExists(db, table) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

/** Colonnes classées, regroupées par politique. Pur. */
function columnsBy(policy) {
  return Object.entries(COLUMNS).filter(([, p]) => p === policy).map(([key]) => {
    const [table, column] = key.split('.');
    return { key, table, column, resets: RESETS[key] ?? [] };
  });
}

/** Chemins (« a.b.0 ») des valeurs exactement égales à `value` dans un objet. Pur. */
function findPaths(obj, value, prefix = []) {
  const out = [];
  if (obj === value) return [prefix.join('.')];
  if (obj && typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) {
      if (!prefix.length && k === '_corruptBackup') continue;
      out.push(...findPaths(v, value, [...prefix, k]));
    }
  }
  return out;
}

/** Copie profonde où chaque valeur exactement égale à `from` devient `to` (_corruptBackup ignoré). Pur. */
function replaceDeep(obj, from, to, top = true) {
  if (obj === from) return to;
  if (Array.isArray(obj)) return obj.map((v) => replaceDeep(v, from, to, false));
  if (obj && typeof obj === 'object') {
    return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, top && k === '_corruptBackup' ? v : replaceDeep(v, from, to, false)]));
  }
  return obj;
}

/** Remplace la valeur d'un chemin (« a.b.0 ») si elle vaut encore `expected`. Pur (copie). */
function setPath(obj, pathStr, expected, value) {
  const keys = pathStr.split('.');
  const root = JSON.parse(JSON.stringify(obj ?? {}));
  let cur = root;
  for (let i = 0; i < keys.length - 1; i += 1) {
    if (cur == null || typeof cur !== 'object') return root;
    cur = cur[keys[i]];
  }
  const last = keys[keys.length - 1];
  if (cur && typeof cur === 'object' && cur[last] === expected) cur[last] = value;
  return root;
}

function storedConfig(config, guildId) {
  const repo = config?.repo;
  if (!repo) return null;
  return (typeof repo.read === 'function' ? repo.read(guildId).data : repo.get?.(guildId)) ?? null;
}

/** Écrit la configuration stockée complète (le patch contient toutes les clés : il la remplace). */
function writeConfig(config, guildId, stored) {
  config.update(guildId, stored);
}

/**
 * Génération des listes JSON de salons, par serveur : incrémentée à chaque report. Un index en
 * mémoire construit depuis ces listes (alertes de mots-clés) se reconstruit quand elle change.
 */
const listGenerations = new Map();

/** Génération courante des listes JSON de salons d'un serveur (0 au départ). */
function listGeneration(guildId) {
  return listGenerations.get(guildId) ?? 0;
}

/** Liste JSON lue, ou null si illisible. Pur. */
function parseList(raw) {
  try {
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list : null;
  } catch {
    return null;
  }
}

/**
 * Lignes (rowid, liste) du serveur dont la liste JSON `table.column` contient `channelId`
 * (préfiltre LIKE, puis lecture réelle de la liste).
 */
function listRows(db, table, column, guildId, channelId) {
  return db.prepare(`SELECT rowid AS rid, ${quote(column)} AS raw FROM ${quote(table)} WHERE guild_id = ? AND instr(${quote(column)}, ?) > 0`)
    .all(guildId, channelId)
    .map((r) => ({ rid: r.rid, list: parseList(r.raw) }))
    .filter((r) => r.list?.includes(channelId));
}

/** Remplace `oldId` par `newId` dans les listes JSON de salons du serveur. @returns {Record<string, number>} lignes modifiées par table */
function remapLists(db, guildId, oldId, newId) {
  const out = {};
  for (const key of JSON_LISTS) {
    const [table, column] = key.split('.');
    if (!tableExists(db, table)) continue;
    const update = db.prepare(`UPDATE ${quote(table)} SET ${quote(column)} = ? WHERE rowid = ? AND guild_id = ?`);
    for (const { rid, list } of listRows(db, table, column, guildId, oldId)) {
      const next = [...new Set(list.map((id) => (id === oldId ? newId : id)))];
      if (update.run(JSON.stringify(next), rid, guildId).changes) out[table] = (out[table] ?? 0) + 1;
    }
  }
  if (Object.keys(out).length) listGenerations.set(guildId, listGeneration(guildId) + 1);
  return out;
}

/** Lignes perdues / jamais recréées d'un salon (rapport). */
function countAffected(db, guildId, channelId, policy) {
  const out = {};
  for (const { table, column } of columnsBy(policy)) {
    if (!tableExists(db, table)) continue;
    const n = db.prepare(`SELECT COUNT(*) AS n FROM ${quote(table)} WHERE guild_id = ? AND ${quote(column)} = ?`).get(guildId, channelId).n;
    if (n) out[table] = (out[table] ?? 0) + n;
  }
  return out;
}

/**
 * Report EN PLACE (une transaction), fait AVANT la suppression du salon (ADM2) : les colonnes
 * « carry » et la configuration passent de `oldId` à `newId`.
 * @param {import('better-sqlite3').Database} db
 * @param {import('../services/ConfigService').ConfigService} config
 * @param {{ resetMessages?: boolean }} [opts] resetMessages : messages liés remis à NULL (défaut)
 * @returns {{ configPaths: string[], carried: Record<string, number>, lost: Record<string, number>, never: Record<string, number> }}
 */
function remapInPlace(db, config, guildId, oldId, newId, { resetMessages = true } = {}) {
  const run = db.transaction(() => {
    const report = { configPaths: [], carried: {}, lost: countAffected(db, guildId, oldId, 'lost'), never: countAffected(db, guildId, oldId, 'never') };
    for (const { table, column, resets } of columnsBy('carry')) {
      if (!tableExists(db, table)) continue;
      const extra = (resetMessages ? resets : []).map((c) => `, ${quote(c)} = NULL`).join('');
      const n = db.prepare(`UPDATE OR IGNORE ${quote(table)} SET ${quote(column)} = ?${extra} WHERE guild_id = ? AND ${quote(column)} = ?`).run(newId, guildId, oldId).changes;
      if (n) report.carried[table] = (report.carried[table] ?? 0) + n;
    }
    for (const [table, n] of Object.entries(remapLists(db, guildId, oldId, newId))) report.carried[table] = (report.carried[table] ?? 0) + n;
    const stored = storedConfig(config, guildId);
    if (stored) {
      report.configPaths = findPaths(stored, oldId);
      if (report.configPaths.length) writeConfig(config, guildId, replaceDeep(stored, oldId, newId));
    }
    return report;
  });
  return run();
}

/**
 * Instantané d'un salon AVANT tout nettoyage (écouteur `prepend` de SEC4) : chemins de
 * configuration et lignes complètes des tables « carry » (les écouteurs peuvent les supprimer,
 * ex. StickyService). @returns {{ guildId, channelId, configPaths: string[], rows: Record<string, object[]>, lost, never }}
 */
function capture(db, config, guildId, channelId) {
  const rows = {};
  for (const { table, column } of columnsBy('carry')) {
    if (!tableExists(db, table)) continue;
    const list = db.prepare(`SELECT * FROM ${quote(table)} WHERE guild_id = ? AND ${quote(column)} = ?`).all(guildId, channelId);
    if (list.length) rows[`${table}.${column}`] = list;
  }
  for (const key of JSON_LISTS) {
    const [table, column] = key.split('.');
    if (!tableExists(db, table)) continue;
    const list = listRows(db, table, column, guildId, channelId);
    if (list.length) rows[key] = list.map((r) => ({ rowid: r.rid }));
  }
  const stored = storedConfig(config, guildId);
  const bundle = {
    guildId,
    channelId,
    configPaths: stored ? findPaths(stored, channelId) : [],
    rows,
    lost: countAffected(db, guildId, channelId, 'lost'),
    never: countAffected(db, guildId, channelId, 'never'),
  };
  // Références non énumérables : restore(bundle, newId) suffit (contrat SEC4 / ADM2).
  Object.defineProperty(bundle, 'db', { value: db, enumerable: false });
  Object.defineProperty(bundle, 'config', { value: config, enumerable: false });
  return bundle;
}

/** Colonnes de la clé primaire d'une table. */
function primaryKey(db, table) {
  return db.prepare(`PRAGMA table_info(${quote(table)})`).all().filter((c) => c.pk).sort((a, b) => a.pk - b.pk).map((c) => c.name);
}

/**
 * Restauration après recréation du salon (`newId`) : les lignes capturées encore présentes sont
 * mises à jour, celles effacées par les écouteurs sont RÉINSÉRÉES (messages liés à NULL), puis
 * les chemins de configuration qui valent encore l'ancien salon passent au nouveau.
 * @param {ReturnType<typeof capture>} bundle
 * @param {string} newId
 * @param {{ db?: object, config?: object }} [deps] par défaut, ceux de capture()
 * @returns {{ updated: number, reinserted: number, configPaths: string[] }}
 */
function restore(bundle, newId, { db = bundle?.db, config = bundle?.config } = {}) {
  if (!bundle || !db) throw new Error('channelRemap.restore : instantané ou base manquant.');
  const { guildId, channelId } = bundle;
  const run = db.transaction(() => {
    let updated = 0;
    let reinserted = 0;
    for (const [key, list] of Object.entries(bundle.rows ?? {})) {
      if (COLUMNS[key] !== 'carry') continue;
      const [table, column] = key.split('.');
      if (!tableExists(db, table)) continue;
      const pk = primaryKey(db, table);
      const resets = RESETS[key] ?? [];
      for (const row of list) {
        const next = { ...row, [column]: newId };
        for (const c of resets) next[c] = null;
        const where = pk.length ? pk.map((c) => `${quote(c)} = ?`).join(' AND ') : null;
        const exists = where ? db.prepare(`SELECT 1 FROM ${quote(table)} WHERE ${where} AND guild_id = ?`).get(...pk.map((c) => row[c]), guildId) : null;
        if (exists) {
          const cols = [column, ...resets];
          updated += db.prepare(`UPDATE OR IGNORE ${quote(table)} SET ${cols.map((c) => `${quote(c)} = ?`).join(', ')} WHERE ${where} AND guild_id = ?`)
            .run(...cols.map((c) => next[c]), ...pk.map((c) => row[c]), guildId).changes;
        } else {
          const cols = Object.keys(next);
          reinserted += db.prepare(`INSERT OR IGNORE INTO ${quote(table)} (${cols.map(quote).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
            .run(...cols.map((c) => next[c])).changes;
        }
      }
    }
    // Listes JSON de salons : l'ancien identifiant (salon supprimé) est remplacé là où il reste.
    for (const n of Object.values(remapLists(db, guildId, channelId, newId))) updated += n;
    let stored = storedConfig(config, guildId);
    const paths = [];
    if (stored) {
      for (const p of bundle.configPaths ?? []) {
        const before = JSON.stringify(stored);
        stored = setPath(stored, p, channelId, newId);
        if (JSON.stringify(stored) !== before) paths.push(p);
      }
      if (paths.length) writeConfig(config, guildId, stored);
    }
    return { updated, reinserted, configPaths: paths };
  });
  return run();
}

/** Texte français des pertes d'un salon recréé (rapport des cartes). Pur. */
function lossSummary({ lost = {}, never = {} } = {}) {
  const parts = [];
  for (const [table, n] of Object.entries(lost)) parts.push(`${n} ${LABELS[table] ?? table} perdu(s)`);
  for (const [table, n] of Object.entries(never)) parts.push(`${n} ${LABELS[table] ?? table} non recréé(s)`);
  return parts.join(' · ');
}

module.exports = { COLUMNS, RESETS, JSON_LISTS, listGeneration, remapInPlace, capture, restore, lossSummary, findPaths, replaceDeep };
