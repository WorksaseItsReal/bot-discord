'use strict';

/**
 * Bout en bout : régressions de la revue n° 6, lot « cœur », sur le vrai discord.js —
 * purge complète d'un serveur quitté (30 jours après GUILD_DELETE), rattrapage d'un serveur
 * quitté pendant un arrêt du bot.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness, IDS } = require('./harness');
const { leavesOf, runLeaf } = require('./lib/explore');
const { OVERRIDES } = require('./lib/overrides');

const DAY = 86_400_000;

/** Tables portant une colonne guild_id. */
function guildTables(db) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all().map((r) => r.name)
    .filter((t) => db.prepare(`PRAGMA table_info("${t}")`).all().some((c) => c.name === 'guild_id'));
}

/** Lignes du serveur, par table (tables vides omises). */
function rowsOf(db, guildId) {
  return Object.fromEntries(guildTables(db).map((t) => [t, db.prepare(`SELECT COUNT(*) AS n FROM "${t}" WHERE guild_id = ?`).get(guildId).n]).filter(([, n]) => n > 0));
}

test('R2 : serveur quitté depuis 30 jours → toutes ses données purgées (commandes réelles), état vierge au retour', async () => {
  const h = await createHarness();
  h.configureAll();
  try {
    const gid = h.guild.id;
    const want = [
      ['warn', []], ['reminder', ['create']], ['afk', []], ['anniversaire', ['definir']], ['projet', ['creer']],
      ['alertes', ['ajouter']], ['custom', ['create']], ['backup', ['create']], ['suggestion', ['create']],
      ['giveaway', ['start']], ['sanctions', ['note']], ['ticket', ['create']],
    ];
    for (let i = 0; i < 3; i++) await h.userMessage({ as: 'member', content: `bonjour tout le monde ${i}` });
    for (const [name, path] of want) {
      const cmd = h.client.commands.get(name);
      const leaf = cmd && leavesOf(cmd.data.toJSON()).find((l) => l.path.join(' ') === path.join(' '));
      if (!leaf) continue;
      const key = [name, ...leaf.path].join(' ');
      const as = ['afk', 'anniversaire', 'alertes'].includes(name) ? 'member' : 'admin';
      await runLeaf(h, name, leaf, { overrides: OVERRIDES[key] ?? {}, as });
    }
    await h.settle();
    await h.client.services.activity?.flush?.();
    const db = h.client.database.raw;
    const before = rowsOf(db, gid);
    for (const t of ['sanctions', 'afk', 'birthdays', 'highlights', 'projects', 'activity_daily']) assert.ok(before[t] > 0, `préparation : aucune ligne dans ${t} (${JSON.stringify(before)})`);
    assert.equal(h.client.services.afk.isAfk(gid, IDS.users.member), true);

    // Le bot est retiré du serveur ; 31 jours plus tard, passage réel du scheduler.
    h.fake.dispatchNow('GUILD_DELETE', { id: gid, unavailable: false }, 'guildDelete');
    await h.settle();
    assert.equal(h.client.guilds.cache.has(gid), false);
    h.client.services.config.markLeft(gid, Date.now() - 31 * DAY);
    await h.client.services.scheduler.tick();

    assert.deepEqual(rowsOf(db, gid), {}, `données du serveur quitté conservées après la purge (avant : ${JSON.stringify(before)})`);
    assert.equal(h.client.services.afk.isAfk(gid, IDS.users.member), false, 'cache des absences encore chargé');
    // Rappel du membre : toujours là, détaché du serveur (livré en MP).
    const reminders = h.client.repositories.reminders.listByUser(IDS.users.admin);
    assert.ok(reminders.length > 0 && reminders.every((r) => r.guild_id === null && r.channel_id === null));
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('R3 : serveur quitté pendant un arrêt du bot → daté au premier passage du scheduler, puis purgé', async () => {
  const h = await createHarness();
  try {
    const ghost = '999999999999999999';
    h.client.services.config.update(ghost, { suggestions: { channelId: '1' } });
    h.client.repositories.sanctions.create({ guildId: ghost, userId: IDS.users.target, moderatorId: IDS.users.admin, type: 'warn', reason: 'x' });
    assert.equal(h.client.guilds.cache.has(ghost), false);
    await h.client.services.scheduler.tick();
    const leftAt = h.client.repositories.guildConfig.get(ghost)?._leftAt;
    assert.equal(typeof leftAt, 'number', 'serveur quitté hors ligne jamais daté (donc jamais purgé)');
    // Le serveur du harnais (présent) n'est pas daté.
    assert.equal(h.client.repositories.guildConfig.get(h.guild.id)?._leftAt, undefined);
    // 30 jours plus tard : purgé.
    h.client.services.config.markLeft(ghost, Date.now() - 31 * DAY);
    h.client.services.scheduler.lastPurgeAt = 0;
    await h.client.services.scheduler.tick();
    assert.deepEqual(rowsOf(h.client.database.raw, ghost), {});
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});
