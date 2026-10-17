'use strict';

/**
 * ADM2 — /channel renouveler, bout en bout sur le vrai discord.js : bilan, confirmation forte,
 * recréation à l'identique, report de la configuration et de la base (channelRemap), sticky
 * republié, log, carte publique, retour arrière, double clic, refus, tags de forum, Secur.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness, IDS, EPHEMERAL } = require('./harness');
const { explore } = require('./lib/explore');
const { throwawayChannel } = require('./lib/overrides');

const opt = (name, type, value) => ({ name, type, value });
const renew = (channelId) => [{ name: 'renouveler', type: 1, options: channelId ? [opt('salon', 7, channelId)] : [] }];
const buttonsOf = (m) => (m?.components ?? []).flatMap((r) => r.components ?? []);
const botMessages = (h, mark, pred = () => true) => h.fake.messageLog.slice(mark).map((id) => h.message(id)).filter((m) => m && m.author?.id === h.client.user.id && pred(m));
const titled = (re) => (m) => (m.embeds ?? []).some((e) => re.test(e.title ?? ''));
const creates = (h, mark) => h.fake.calls.slice(mark).filter((c) => c.method === 'POST' && c.route === `/guilds/${h.guild.id}/channels`);
/** Requêtes qui modifient la structure du serveur (salons, serveur) — hors messages et réponses. */
const writes = (h, mark) => h.fake.calls.slice(mark).filter((c) => c.method !== 'GET' && (c.route.startsWith(`/guilds/${h.guild.id}`) || /^\/channels\/\d+(\/permissions\/\d+)?$/.test(c.route)));

async function setup() {
  const h = await createHarness();
  h.configureAll();
  return h;
}

/** Lance /channel renouveler, clique « Renouveler » et ouvre le formulaire. */
async function openForm(h, channelId, { as = 'admin', channel = 'staff' } = {}) {
  const rec = await h.slash('channel', renew(channelId), { as, channel });
  const [plan] = h.messagesOf(rec);
  assert.ok(plan, h.replyText(rec));
  const button = buttonsOf(plan).find((b) => b.custom_id?.startsWith('cmd:channel:renewform:'));
  assert.ok(button, `pas de bouton Renouveler : ${h.replyText(rec)}`);
  const click = await h.click(plan, button.custom_id, { as });
  assert.equal(click.modals.length, 1, h.replyText(click));
  return { rec, plan, click };
}

test('#général (sticky, flux, annonce programmée, logs Messages, salon système) : tout est reporté, sticky republié, log publié', async () => {
  const h = await setup();
  try {
    const old = IDS.channels.general;
    h.configure({ logChannels: { messages: old } });
    const generalChannel = h.client.channels.cache.get(old);
    await h.client.services.sticky.set({ guildId: h.guild.id, channel: generalChannel, title: 'Règles', content: 'Soyez courtois.', threshold: 3, authorId: IDS.users.admin });
    const feed = h.client.repositories.feeds.create({ guildId: h.guild.id, channelId: old, url: 'https://example.com/flux.xml', title: 'Blog' });
    const draft = h.client.repositories.announcements.createDraft({ guildId: h.guild.id, channelId: old, authorId: IDS.users.admin, timeZone: 'Europe/Paris', runAt: Date.now() + 3_600_000 });
    const raw = h.fake.channels.get(old);
    raw.rate_limit_per_user = 30;
    raw.nsfw = true;
    raw.permission_overwrites = [{ id: IDS.roles.muted, type: 0, allow: '0', deny: String(1n << 11n) }];
    h.fake.dispatchNow('CHANNEL_UPDATE', raw);
    await h.settle();

    const { rec, plan, click } = await openForm(h, old);
    assert.ok(plan.flags & EPHEMERAL, 'bilan public');
    const planText = JSON.stringify(plan.embeds[0]);
    for (const word of ['Flux', 'Annonces programmées', 'sticky', 'logChannels.messages', 'Salon système']) assert.ok(planText.includes(word), `bilan sans « ${word} »`);
    assert.match(planText, /messages, fils/);
    assert.ok(rec.ackType != null);

    const mark = h.fake.messageLog.length;
    const callMark = h.fake.calls.length;
    const done = await h.submitModal(click, { confirmation: 'renouveler' });
    assert.ok(!h.isError(done), h.replyText(done));
    assert.ok(!h.fake.channels.has(old), 'original non supprimé');
    const [post] = creates(h, callMark);
    assert.ok(post, 'aucune création');
    const created = [...h.fake.channels.values()].find((c) => c.name === 'général' && c.id !== old);
    assert.ok(created, 'copie absente');
    assert.equal(created.parent_id, IDS.channels.catGeneral);
    assert.equal(created.topic, 'Discussion générale');
    assert.equal(created.rate_limit_per_user, 30);
    assert.equal(created.nsfw, true);
    assert.deepEqual(created.permission_overwrites.map((o) => [o.id, o.deny]), [[IDS.roles.muted, String(1n << 11n)]]);

    const cfg = h.client.services.config.get(h.guild.id);
    assert.equal(cfg.logChannels.messages, created.id, 'logs Messages non reportés');
    assert.equal(cfg.suggestions.channelId, created.id);
    assert.equal(cfg.welcome.join.channelId, created.id);
    assert.equal(h.client.repositories.feeds.byId(feed.id ?? feed).channel_id, created.id, 'flux non reporté');
    assert.equal(h.client.repositories.announcements.byId(draft.id ?? draft).channel_id, created.id, 'annonce non reportée');
    assert.equal(h.fake.guild.system_channel_id, created.id, 'salon système non rebranché');
    // Sticky : ligne reportée ET republiée dans la copie.
    assert.equal(h.client.services.sticky.get(created.id)?.content, 'Soyez courtois.');
    assert.ok(botMessages(h, mark, (m) => m.channel_id === created.id && titled(/Règles/)(m)).length, 'sticky non republié');
    // Log du renouvellement (catégorie Salons).
    assert.ok(botMessages(h, mark, (m) => m.channel_id === IDS.channels.logs && titled(/Salon renouvelé/)(m)).length, 'log absent');
    assert.match(h.replyText(done), /Salon renouvelé/);
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('salon courant : carte publique dans le nouveau salon ; double clic → une seule exécution ; délai de 30 s', async () => {
  const h = await setup();
  try {
    const id = await throwawayChannel(h, 'bavardage');
    const { click } = await openForm(h, null, { channel: id });
    const mark = h.fake.messageLog.length;
    const callMark = h.fake.calls.length;
    const [a, b] = await Promise.all([h.submitModal(click, { confirmation: 'RENOUVELER' }), h.submitModal(click, { confirmation: 'RENOUVELER' })]);
    await h.settle();
    assert.equal(creates(h, callMark).length, 1, 'deux renouvellements pour un double clic');
    assert.equal([a, b].filter((r) => h.isError(r)).length, 1, 'le second clic n\'est pas refusé');
    const created = [...h.fake.channels.values()].find((c) => c.name === 'bavardage');
    assert.ok(created && created.id !== id);
    assert.ok(botMessages(h, mark, (m) => m.channel_id === created.id && titled(/Salon renouvelé/)(m)).length, 'carte publique absente');
    // Délai par serveur : un autre salon tout de suite → refusé avant toute requête.
    const other = await throwawayChannel(h, 'autre');
    const writeMark = h.fake.calls.length;
    h.client.cooldowns.release(`channel:${IDS.users.admin}`); // délai propre à la commande (2 s), pas celui du serveur
    const again = await h.slash('channel', renew(other), { channel: 'staff', keepCooldowns: true });
    assert.ok(h.isError(again));
    assert.match(h.replyText(again), /réessayez dans/);
    assert.deepEqual(writes(h, writeMark), []);
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('DELETE en échec : retour arrière complet (copie supprimée, configuration et base identiques)', async () => {
  const h = await setup();
  try {
    const id = await throwawayChannel(h, 'fragile');
    h.configure({ logChannels: { voice: id } });
    const feed = h.client.repositories.feeds.create({ guildId: h.guild.id, channelId: id, url: 'https://example.com/a.xml' });
    const before = JSON.stringify(h.client.services.config.get(h.guild.id));
    const channelsBefore = h.fake.channels.size;
    const { click } = await openForm(h, id);
    h.fake.inject({ method: 'DELETE', route: `/channels/${id}` }, { status: 403, code: 50013, message: 'Missing Permissions' });
    const done = await h.submitModal(click, { confirmation: 'RENOUVELER' });
    assert.ok(h.isError(done), h.replyText(done));
    assert.match(h.replyText(done), /rien n'a changé/);
    assert.ok(h.fake.channels.has(id), 'original supprimé');
    assert.equal(h.fake.channels.size, channelsBefore, 'copie restée');
    assert.equal(JSON.stringify(h.client.services.config.get(h.guild.id)), before, 'configuration modifiée');
    assert.equal(h.client.repositories.feeds.byId(feed.id ?? feed).channel_id, id, 'flux resté sur la copie');
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('refus : salon des règles, ticket ouvert, giveaway actif, compteur, membre sans permission, confirmation erronée', async () => {
  const h = await setup();
  try {
    const db = h.client.database.db;
    const mark = h.fake.calls.length;
    const rules = await h.slash('channel', renew(IDS.channels.rules), { channel: 'staff' });
    assert.match(h.replyText(rules), /règles/);
    const ticket = await throwawayChannel(h, 'ticket-0001');
    db.prepare('INSERT INTO tickets (guild_id, channel_id, user_id, status, created_at) VALUES (?, ?, ?, ?, ?)').run(h.guild.id, ticket, IDS.users.member, 'open', Date.now());
    assert.match(h.replyText(await h.slash('channel', renew(ticket), { channel: 'staff' })), /ticket ouvert/);
    const gw = await throwawayChannel(h, 'concours');
    db.prepare('INSERT INTO giveaways (guild_id, channel_id, message_id, prize, winners, host_id, ends_at, ended, created_at) VALUES (?, ?, ?, ?, 1, ?, ?, 0, ?)').run(h.guild.id, gw, '1', 'Nitro', IDS.users.admin, Date.now() + 86_400_000, Date.now());
    assert.match(h.replyText(await h.slash('channel', renew(gw), { channel: 'staff' })), /giveaway/);
    h.configure({ statsCounters: { counters: { members: { enabled: true, channelId: IDS.channels.voice } } } });
    assert.match(h.replyText(await h.slash('channel', renew(IDS.channels.voice), { channel: 'staff' })), /compteur/);
    const target = await throwawayChannel(h, 'cible');
    const denied = await h.slash('channel', renew(target), { as: 'member', channel: 'general' });
    assert.ok(h.isError(denied));
    assert.match(h.replyText(denied), /Gérer les salons/);
    assert.deepEqual(writes(h, mark), [], 'requête envoyée malgré un refus');

    // Confirmation erronée : rien n'est touché ; le bouton d'un autre est refusé.
    const { click, plan } = await openForm(h, target);
    const wrong = await h.submitModal(click, { confirmation: 'oui' });
    assert.match(h.replyText(wrong), /Confirmation incorrecte/);
    assert.ok(h.fake.channels.has(target));
    const button = buttonsOf(plan).find((b) => b.custom_id.startsWith('cmd:channel:renewform:'));
    assert.ok(h.isError(await h.click(plan, button.custom_id, { as: 'mod' })), 'bouton d\'un autre accepté');
    assert.deepEqual(creates(h, mark), []);
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('forum : tags conservés (sans identifiant), réaction et tri par défaut recopiés', async () => {
  const h = await setup();
  try {
    const raw = h.fake.channels.get(IDS.channels.forum);
    raw.available_tags = [{ id: '900000000000000001', name: 'Bug', moderated: false, emoji_id: null, emoji_name: '🐛' }, { id: '900000000000000002', name: 'Idée', moderated: true, emoji_id: null, emoji_name: null }];
    raw.default_reaction_emoji = { emoji_id: null, emoji_name: '👍' };
    raw.default_sort_order = 1;
    raw.topic = 'Lignes directrices';
    h.fake.dispatchNow('CHANNEL_UPDATE', raw);
    await h.settle();
    const { click } = await openForm(h, IDS.channels.forum);
    const callMark = h.fake.calls.length;
    const done = await h.submitModal(click, { confirmation: 'RENOUVELER' });
    assert.ok(!h.isError(done), h.replyText(done));
    const [post] = creates(h, callMark);
    assert.equal(post.body.type, 15);
    assert.deepEqual(post.body.available_tags.map((t) => [t.name, t.moderated, t.emoji_name, 'id' in t]), [['Bug', false, '🐛', false], ['Idée', true, null, false]]);
    assert.deepEqual(post.body.default_reaction_emoji, { emoji_id: null, emoji_name: '👍' });
    assert.equal(post.body.default_sort_order, 1);
    assert.equal(post.body.topic, 'Lignes directrices');
    assert.ok(!h.fake.channels.has(IDS.channels.forum));
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('Secur : module channelDelete en « on » → administrateur non whitelisté refusé AVANT toute requête', async () => {
  const h = await setup();
  try {
    const secur = h.client.services.secur;
    if (!secur.registry.has('channelDelete')) secur.registry.register({ key: 'channelDelete', auditTypes: [12], classify: () => ({ weight: 1, record: null }) });
    h.configure({ secur: { modules: { channelDelete: { mode: 'on', limit: 1, windowSeconds: 30 } } } });
    const id = await throwawayChannel(h, 'protege');
    const mark = h.fake.calls.length;
    const rec = await h.slash('channel', renew(id), { channel: 'staff' });
    assert.ok(h.isError(rec));
    assert.match(h.replyText(rec), /Action bloquée par la sécurité/);
    assert.deepEqual(writes(h, mark), [], 'requête envoyée malgré le refus');
    assert.ok(h.fake.channels.has(id));
    // Les autres sous-commandes de gestion sont pré-contrôlées de la même façon.
    const del = await h.slash('channel', [{ name: 'supprimer', type: 1, options: [opt('salon', 7, id)] }], { channel: 'staff' });
    assert.match(h.replyText(del), /Action bloquée par la sécurité/);
    assert.ok(h.fake.channels.has(id));
    // Le propriétaire (exempté) peut renouveler.
    const owner = await openForm(h, id, { as: 'owner' });
    const done = await h.submitModal(owner.click, { confirmation: 'RENOUVELER' });
    assert.ok(!h.isError(done), h.replyText(done));
    assert.ok(!h.fake.channels.has(id));
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('exploration du bilan (administrateur, puis membre) : aucune violation', async () => {
  const h = await setup();
  try {
    const id = await throwawayChannel(h, 'explore');
    const rec = await h.slash('channel', renew(id), { channel: 'staff' });
    const stats = await explore(h, rec, { budget: 12 });
    assert.ok(stats.buttons >= 1 && stats.modals >= 1, JSON.stringify(stats));
    const id2 = await throwawayChannel(h, 'explore-2');
    const rec2 = await h.slash('channel', renew(id2), { channel: 'staff' });
    await explore(h, rec2, { as: 'member', budget: 6 });
    assert.ok(h.fake.channels.has(id2), 'un membre a renouvelé un salon');
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});
