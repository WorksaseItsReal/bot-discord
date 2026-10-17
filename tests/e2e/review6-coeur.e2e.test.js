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

/** Embeds publiés dans un salon depuis `mark`, par titre. */
function published(h, channelId, title, mark) {
  return h.fake.messageLog.slice(mark).map((id) => h.message(id)).filter((m) => m?.channel_id === channelId && m.embeds?.[0]?.title === title);
}

test('R4 : constructeur d\'embed (formulaire) acquitté avant la publication, même sous limite de débit', async () => {
  const h = await createHarness();
  h.configureAll();
  try {
    const open = await h.slash('embed', [{ name: 'create', type: 1, options: [] }], { as: 'admin' });
    assert.equal(open.modals?.length, 1);
    h.resetProblems();
    const general = IDS.channels.general;
    h.fake.inject({ method: 'POST', route: `/channels/${general}/messages` }, { status: 429, retryAfter: 3200, times: 1 });
    const mark = h.fake.messageLog.length;
    const rec = await h.submitModal(open, { title: 'Annonce', description: 'Réunion ce soir', color: '', image: '' }, { as: 'admin' });
    await h.waitFor(() => published(h, general, 'Annonce', mark).length > 0, { timeout: 6000 });
    assert.ok(rec.ackType != null && rec.ackedAt - rec.createdAt < 3000, `acquittement après ${rec.ackedAt - rec.createdAt} ms`);
    assert.equal(published(h, general, 'Annonce', mark).length, 1);
    assert.match(h.replyText(rec), /Embed envoyé/);
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('R5 : /embed send acquitté avant la publication, même sous limite de débit', async () => {
  const h = await createHarness();
  h.configureAll();
  try {
    const general = IDS.channels.general;
    h.fake.inject({ method: 'POST', route: `/channels/${general}/messages` }, { status: 429, retryAfter: 3200, times: 1 });
    const mark = h.fake.messageLog.length;
    const rec = await h.slash('embed', [{ name: 'send', type: 1, options: [{ name: 'titre', type: 3, value: 'Annonce directe' }, { name: 'description', type: 3, value: 'Texte' }] }], { as: 'admin' });
    await h.waitFor(() => published(h, general, 'Annonce directe', mark).length > 0, { timeout: 6000 });
    assert.ok(rec.ackType != null && rec.ackedAt - rec.createdAt < 3000, `acquittement après ${rec.ackedAt - rec.createdAt} ms`);
    assert.equal(published(h, general, 'Annonce directe', mark).length, 1);
    assert.match(h.replyText(rec), /Embed envoyé/);
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('R7 : une exception synchrone d\'un écouteur (niveaux) n\'empêche pas l\'AutoMod de filtrer le message', async () => {
  const h = await createHarness();
  h.configureAll();
  try {
    h.client.services.levels.handleMessage = () => {
      throw Object.assign(new Error('database or disk is full'), { code: 'SQLITE_FULL' });
    };
    const before = h.fake.calls.length;
    await h.userMessage({ as: 'member', content: 'ceci est un mot interdit' });
    await h.settle();
    const deleted = h.fake.calls.slice(before).some((c) => c.method === 'DELETE' && /\/messages\/\d+$/.test(c.route));
    assert.equal(deleted, true, 'message interdit non filtré : la chaîne d\'écouteurs a été coupée');
    // L'erreur est journalisée (attendu), sans rejet non géré.
    assert.equal(h.unhandled.length, 0, h.formatProblems());
    assert.ok(h.problems().errors.some((e) => /messageCreate/.test(e) && /disk is full/.test(e)), 'erreur de l\'écouteur non journalisée');
  } finally {
    await h.close();
  }
});

test('R8 : clic sur un panneau après le retrait du bot → refus propre, aucune erreur inattendue ni écriture', async () => {
  const h = await createHarness();
  h.configureAll();
  try {
    const sug = await h.slash('suggestion', [{ name: 'create', type: 1, options: [{ name: 'contenu', type: 3, value: 'Ajouter un salon musique' }] }], { as: 'member' });
    const card = h.fake.messageLog.slice(sug.msgMark ?? 0).map((id) => h.message(id)).find((m) => m?.author?.id === h.client.user.id && (m.components ?? []).length && !(m.flags & 64));
    assert.ok(card, `carte de suggestion introuvable : ${h.replyText(sug)}`);
    const button = card.components.flatMap((r) => r.components).find((c) => c.custom_id && !c.custom_id.startsWith('cmd:_:'));
    h.fake.dispatchNow('GUILD_DELETE', { id: h.guild.id, unavailable: false }, 'guildDelete');
    await h.settle();
    h.resetProblems();
    const errorsBefore = h.client.stats.errors;
    const votes = () => h.client.database.raw.prepare('SELECT COUNT(*) AS n FROM suggestion_votes').get().n;
    const votesBefore = votes();
    const rec = await h.click(card, button.custom_id, { as: 'admin' });
    assert.ok(h.isError(rec), 'aucun refus');
    assert.match(h.replyText(rec), /membre de ce serveur/);
    assert.equal(h.client.stats.errors, errorsBefore, 'compté comme erreur inattendue');
    assert.equal(votes(), votesBefore, 'écriture en base pour un serveur quitté');
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('R9 : un appel refusé par les vérifications préalables ne libère pas le cooldown de l\'appel précédent', async () => {
  const { buildOptions, wrapPath } = require('./lib/explore');
  const h = await createHarness({ botAdministrator: false });
  h.configureAll();
  try {
    // Salon où le bot ne peut pas créer de sondage (« Envoyer des sondages » refusé au bot).
    const ch = h.fake.channels.get(IDS.channels.rules);
    ch.permission_overwrites = [...(ch.permission_overwrites ?? []), { id: IDS.users.bot, type: 1, allow: '0', deny: String(1n << 49n) }];
    h.client.channels.cache.get(IDS.channels.rules)?._patch?.({ permission_overwrites: ch.permission_overwrites });
    const leaf = leavesOf(h.client.commands.get('sondage').data.toJSON())[0];
    const options = wrapPath(leaf.path, await buildOptions(h, 'sondage', leaf.options, OVERRIDES.sondage ?? {}));
    h.client.cooldowns.expiries.clear();
    const first = await h.slash('sondage', options, { as: 'member', keepCooldowns: true });
    assert.ok(!h.isError(first), h.replyText(first));
    const refused = await h.slash('sondage', options, { as: 'member', channel: 'rules', keepCooldowns: true });
    assert.ok(h.isError(refused) || /Doucement/.test(h.replyText(refused)), h.replyText(refused));
    const again = await h.slash('sondage', options, { as: 'member', keepCooldowns: true });
    assert.match(h.replyText(again), /Doucement/, `cooldown contourné : ${h.replyText(again)}`);
  } finally {
    await h.close();
  }
});
