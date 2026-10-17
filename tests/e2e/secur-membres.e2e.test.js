'use strict';

/**
 * SEC5 — modules Secur « membres » et « messages », de bout en bout (vrai discord.js, faux
 * Discord, vrais événements de passerelle) : bans (anciens membres / raiders), débannissement non
 * autorisé, prune, bot selon l'inviteur (02 inversée, dans les deux ordres audit / arrivée),
 * déconnexions vocales regroupées, @everyone (supprimé, crosspost ignoré), purges massives.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness, IDS } = require('./harness');
const { explore } = require('./lib/explore');
const { nextId } = require('./lib/ids');
const securVoice = require('../../src/events/securVoice');

const botMessages = (h, mark, pred = () => true) => h.fake.messageLog.slice(mark).map((id) => h.message(id)).filter((m) => m && m.author?.id === h.client.user.id && pred(m));
const titled = (re) => (m) => (m.embeds ?? []).some((e) => re.test(e.title ?? ''));
const incidentCards = (h, mark) => botMessages(h, mark, (m) => titled(/Incident Secur/)(m) && !h.fake.dms.has(m.channel_id));
const rolesOf = (h, id) => h.fake.members.get(id)?.roles ?? [];
const recOf = (h, message) => ({ messages: [message.id], followUps: [], msgMark: h.fake.messageLog.length, modals: [] });

/** Serveur de test : logs Sécurité branchés, AntiRaid coupé (les modules Secur jugent seuls), modules voulus en « on ». */
async function setup(modules = {}, extra = {}) {
  const h = await createHarness();
  h.configure({
    logChannels: { security: IDS.channels.logs },
    antiraid: { enabled: false, banThreshold: 3, kickThreshold: 3 },
    automod: { enabled: false },
    secur: { modules: Object.fromEntries(Object.entries(modules).map(([k, v]) => [k, { mode: 'on', ...v }])) },
    ...extra,
  });
  return h;
}

test('ban : 3 bans d\'anciens membres → auteur dérangé (une carte) ; bans de raiders arrivés à l\'instant → rien', async () => {
  const h = await setup({ ban: { limit: null } });
  try {
    // Raiders : arrivés à l'instant (AntiRaid coupé : seule la mémoire des départs de Secur les reconnaît).
    let mark = h.fake.messageLog.length;
    for (let i = 0; i < 3; i += 1) {
      const raider = h.addUser(`Raider${i}`, { ageDays: 400 });
      await h.memberJoin(raider);
      await h.asHuman('mod').ban(raider.id);
    }
    assert.equal(incidentCards(h, mark).length, 0, 'bans de raiders récents sanctionnés');
    assert.ok(rolesOf(h, IDS.users.mod).includes(IDS.roles.mod));

    // Anciens membres (et un utilisateur hors serveur) : la limite héritée (banThreshold 3) est atteinte.
    mark = h.fake.messageLog.length;
    const outsider = h.addUser('AncienMembre', { ageDays: 900 });
    for (const id of [IDS.users.member, IDS.users.target, outsider.id]) await h.asHuman('mod').ban(id);
    const cards = incidentCards(h, mark);
    assert.equal(cards.length, 1, `${cards.length} carte(s) d'incident`);
    assert.deepEqual(rolesOf(h, IDS.users.mod), [], 'auteur des bans non dérangé');
    const [incident] = h.client.repositories.securityIncidents.recent(h.guild.id, 5);
    assert.deepEqual(incident.modules, ['ban']);
    assert.ok(h.fake.bans.has(IDS.users.member), 'annulation du ban désactivée par défaut : le ban reste');
    // Boutons de la carte explorés par un administrateur qui n'est pas owner : « Rendre les rôles » refusé.
    await explore(h, recOf(h, cards[0]), { as: 'admin', budget: 6 });
    assert.deepEqual(rolesOf(h, IDS.users.mod), [], 'rôles rendus par un non-owner');
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('unban : débannissement non autorisé → rebanni par le bot et auteur dérangé', async () => {
  const h = await setup({ unban: {} });
  try {
    const user = h.addUser('Banni', { ageDays: 900 });
    await h.asHuman('owner').ban(user.id);
    assert.ok(h.fake.bans.has(user.id));
    const mark = h.fake.messageLog.length;
    await h.asHuman('mod').perform('DELETE', `/guilds/${h.guild.id}/bans/${user.id}`);
    await h.settle();
    assert.ok(h.fake.bans.has(user.id), 'débannissement non annulé');
    const reban = h.fake.calls.filter((c) => c.method === 'PUT' && c.route === `/guilds/${h.guild.id}/bans/${user.id}`);
    assert.equal(reban.length, 2, 'ban du propriétaire puis rebannissement du bot');
    assert.deepEqual(rolesOf(h, IDS.users.mod), []);
    assert.equal(incidentCards(h, mark).length, 1);
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('prune : une entrée de 742 membres (audit 21) en « on » → sanction immédiate, aucune alerte historique en double', async () => {
  const h = await setup({ kick: { limit: null } }, { antiraid: { enabled: true, joinThreshold: 1000, kickThreshold: 3, punishExecutor: 'strip' } });
  try {
    const mark = h.fake.messageLog.length;
    await h.auditEntry({ action_type: 21, target_id: null, user_id: IDS.users.mod, options: { delete_member_days: '7', members_removed: '742' } }, { label: 'prune de 742 membres' });
    assert.deepEqual(rolesOf(h, IDS.users.mod), [], 'auteur du prune non sanctionné');
    const cards = incidentCards(h, mark);
    assert.equal(cards.length, 1);
    assert.match(cards[0].embeds[0].fields.find((f) => /Actions/.test(f.name)).value, /×\*\*742\*\*/);
    assert.equal(botMessages(h, mark, titled(/Activité destructrice/)).length, 0, 'chemin historique ET module Secur');
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('bot : ajouté par un modérateur → bot expulsé, inviteur dérangé (audit avant OU après l\'arrivée) ; par un admin whitelisté → conservé (02 inversée)', async () => {
  const h = await setup({ bot: {} }, { whitelist: { users: [IDS.users.admin], roles: [] } });
  try {
    // A) Admin whitelisté : le bot reste.
    const legit = h.addUser('BotLegitime', { bot: true, ageDays: 900 });
    await h.auditEntry({ action_type: 28, target_id: legit.id, user_id: IDS.users.admin });
    await h.memberJoin(legit);
    assert.ok(h.fake.members.has(legit.id), 'bot ajouté par un admin whitelisté expulsé');

    // B) Modérateur, entrée d'audit AVANT l'arrivée du bot : expulsé dès son arrivée.
    const mark = h.fake.messageLog.length;
    const evil = h.addUser('BotNuke', { bot: true, ageDays: 900 });
    await h.auditEntry({ action_type: 28, target_id: evil.id, user_id: IDS.users.mod });
    await h.memberJoin(evil);
    assert.equal(h.fake.members.has(evil.id), false, 'bot ajouté par un modérateur toujours là');
    assert.deepEqual(rolesOf(h, IDS.users.mod), [], 'inviteur non dérangé');
    assert.equal(incidentCards(h, mark).length, 1);

    // C) Arrivée PUIS entrée d'audit (ordre habituel), par un autre non-exempté.
    h.fake.members.get(IDS.users.mod).roles = [IDS.roles.mod, IDS.roles.member];
    h.fake.dispatchNow('GUILD_MEMBER_UPDATE', { ...h.fake.members.get(IDS.users.mod), guild_id: h.guild.id });
    await h.settle();
    const other = h.addUser('BotSpam', { bot: true, ageDays: 900 });
    await h.memberJoin(other);
    assert.ok(h.fake.members.has(other.id));
    await h.auditEntry({ action_type: 28, target_id: other.id, user_id: IDS.users.target });
    assert.equal(h.fake.members.has(other.id), false, 'bot non expulsé après l\'entrée d\'audit');
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('voiceKick : entrée 27 regroupée (count 6) lue après une déconnexion → sanction ; aucune lecture si le module est coupé', async () => {
  const h = await setup({});
  const delay = securVoice.timing.delayMs;
  securVoice.timing.delayMs = 10;
  try {
    const reads = () => h.fake.calls.filter((c) => c.method === 'GET' && c.route === `/guilds/${h.guild.id}/audit-logs`).length;
    await h.voice('member', 'voice');
    await h.voice('member', null);
    await new Promise((r) => setTimeout(r, 40));
    await h.settle();
    assert.equal(reads(), 0, 'journal d\'audit lu alors que le module est coupé');

    h.configure({ secur: { modules: { voiceKick: { mode: 'on' } } } });
    const mark = h.fake.messageLog.length;
    await h.voice('member', 'voice');
    // Discord regroupe : une seule entrée 27 dont le compte vaut 6 (aucun événement d'audit émis).
    h.fake.auditLog.unshift({ id: nextId(), action_type: 27, target_id: null, user_id: IDS.users.mod, changes: [], options: { count: '6' } });
    await h.asHuman('mod').perform('PATCH', `/guilds/${h.guild.id}/members/${IDS.users.member}`, { channel_id: null });
    const done = await h.waitFor(() => h.client.repositories.securityIncidents.recent(h.guild.id, 5).length > 0, { timeout: 2_000 });
    assert.ok(done, 'déconnexions regroupées non sanctionnées');
    assert.ok(reads() >= 1, 'type 27 lu');
    const [incident] = h.client.repositories.securityIncidents.recent(h.guild.id, 5);
    assert.equal(incident.actions, 6);
    assert.deepEqual(incident.modules, ['voiceKick']);
    assert.deepEqual(rolesOf(h, IDS.users.mod), []);
    assert.equal(incidentCards(h, mark).length, 1);
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    securVoice.timing.delayMs = delay;
    await h.close();
  }
});

test('everyone : @everyone d\'un membre qui en a la permission → message supprimé, aucune sanction (punish none) ; crosspost d\'un salon suivi → rien', async () => {
  const h = await setup({ everyone: {} });
  try {
    const mark = h.fake.messageLog.length;
    const msg = await h.userMessage({ as: 'mod', channel: 'general', content: '@everyone réunion !' });
    assert.equal(h.fake.messages.has(msg.id), false, 'message @everyone conservé');
    assert.ok(rolesOf(h, IDS.users.mod).includes(IDS.roles.mod), 'punish none : l\'auteur ne doit pas être sanctionné');
    const cards = incidentCards(h, mark);
    assert.equal(cards.length, 1);
    assert.match(cards[0].embeds[0].fields.find((f) => /Sanction/.test(f.name)).value, /Aucune/);

    // Crosspost publié par le webhook de suivi d'un salon d'annonces : ignoré.
    const hook = nextId();
    h.fake.users.set(hook, { id: hook, username: 'Annonces', discriminator: '0000', avatar: null, bot: true });
    const cross = await h.userMessage({ as: hook, channel: 'general', content: '@everyone nouvelle vidéo', extra: { flags: 2, webhook_id: hook, mention_everyone: true } });
    assert.ok(h.fake.messages.has(cross.id), 'crosspost supprimé');

    // Exempté (whitelist, mode on) : rien.
    h.configure({ whitelist: { users: [IDS.users.member], roles: [] } });
    const kept = await h.userMessage({ as: 'member', channel: 'general', content: '@here pause' });
    assert.ok(h.fake.messages.has(kept.id), 'message d\'un whitelisté supprimé');
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('messagePurge : purge de 50 messages ×2 → sanction ; purge de 10 (sous minMessages) ignorée', async () => {
  const h = await setup({ messagePurge: {} });
  try {
    const mark = h.fake.messageLog.length;
    const purge = (count) => h.auditEntry({ action_type: 73, target_id: IDS.channels.general, user_id: IDS.users.mod, options: { count: String(count) } }, { label: `purge de ${count} messages` });
    await purge(10);
    await purge(50);
    assert.ok(rolesOf(h, IDS.users.mod).includes(IDS.roles.mod), 'sanction avant la limite (2)');
    await purge(50);
    assert.deepEqual(rolesOf(h, IDS.users.mod), []);
    assert.equal(incidentCards(h, mark).length, 1);
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});
