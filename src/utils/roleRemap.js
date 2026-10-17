'use strict';

/**
 * Report d'un rôle recréé par Secur (roleDelete) dans la BASE ; la configuration est rebranchée à
 * part (structure.replugConfig). Pendant de channelRemap pour les rôles.
 *
 * Chaque colonne de rôle de la base est CLASSÉE (vérifié par tests/review7-secur-modules.test.js) :
 *  - carry   : identifiant reporté sur le rôle recréé (UPDATE OR IGNORE : index uniques) ;
 *  - json    : liste JSON d'identifiants, la valeur exacte est remplacée ;
 *  - lost    : message publié qui garde l'ancien identifiant (menu de rôles) : compté, signalé ;
 *  - history : historique (accès de whitelist accordés), laissé tel quel ;
 *  - other   : pas un identifiant de rôle.
 *
 * Toutes les requêtes filtrent sur guild_id ; les noms de tables et de colonnes viennent de la
 * table figée ci-dessous (jamais d'une saisie).
 */
const COLUMNS = Object.freeze({
  'temp_roles.role_id': 'carry',
  'birthdays.role_id': 'carry',
  'economy_items.role_id': 'carry',
  'giveaways.required_role': 'carry',
  'giveaways.forbidden_role': 'carry',
  'feeds.role_id': 'carry',
  'scheduled_announcements.role_id': 'carry',
  'application_forms.ping_role_id': 'carry',
  'application_forms.role_ids': 'json',
  'automod_quarantines.roles': 'json',
  'security_incidents.removed_roles': 'json',
  'role_menus.data': 'lost',
  'security_grants.role_id': 'history',
  'project_members.role': 'other',
  'birthdays.role_until': 'other',
});

const quote = (name) => `"${String(name).replace(/"/g, '""')}"`;

function columnExists(db, table, column) {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)) return false;
  return db.prepare(`PRAGMA table_info(${quote(table)})`).all().some((c) => c.name === column);
}

function columnsBy(policy) {
  return Object.entries(COLUMNS).filter(([, p]) => p === policy).map(([key]) => {
    const [table, column] = key.split('.');
    return { table, column };
  });
}

/**
 * Reporte `oldId` sur `newId` dans les colonnes « carry » et « json » d'un serveur (une
 * transaction) et compte les menus de rôles publiés qui gardent l'ancien identifiant.
 * @returns {{ carried: number, lostMenus: number }}
 */
function remapRole(db, guildId, oldId, newId) {
  const out = { carried: 0, lostMenus: 0 };
  if (!db || !guildId || !oldId || !newId || oldId === newId) return out;
  const params = { g: String(guildId), old: String(oldId), new: String(newId), oldq: `"${oldId}"`, newq: `"${newId}"` };
  db.transaction(() => {
    for (const { table, column } of columnsBy('carry')) {
      if (!columnExists(db, table, column)) continue;
      out.carried += db.prepare(`UPDATE OR IGNORE ${quote(table)} SET ${quote(column)} = @new WHERE guild_id = @g AND ${quote(column)} = @old`).run(params).changes;
    }
    for (const { table, column } of columnsBy('json')) {
      if (!columnExists(db, table, column)) continue;
      out.carried += db.prepare(`UPDATE ${quote(table)} SET ${quote(column)} = REPLACE(${quote(column)}, @oldq, @newq) WHERE guild_id = @g AND instr(${quote(column)}, @oldq) > 0`).run(params).changes;
    }
    for (const { table, column } of columnsBy('lost')) {
      if (!columnExists(db, table, column)) continue;
      out.lostMenus += db.prepare(`SELECT COUNT(*) AS n FROM ${quote(table)} WHERE guild_id = @g AND instr(${quote(column)}, @oldq) > 0`).get(params).n;
    }
  })();
  return out;
}

module.exports = { COLUMNS, remapRole };
