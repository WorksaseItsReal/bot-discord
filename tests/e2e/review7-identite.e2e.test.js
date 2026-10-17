'use strict';

/**
 * Revue n° 7, lot « identité », bout en bout (vrai discord.js, faux Discord qui applique les
 * permissions) : le bot invité avec SON lien /invite (rôle = INVITE_PERMISSIONS exactement, pas
 * administrateur) doit pouvoir annuler ce que ses modules Secur détectent.
 *  - S47 : « Gérer les webhooks » manquait au lien d'invitation → le module webhook ne supprimait
 *    pas le webhook créé (50013), et le module everyone en max ne supprimait pas le webhook auteur.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { PermissionFlagsBits: P, PermissionsBitField } = require('discord.js');
const { createHarness, IDS } = require('./harness');
const { INVITE_PERMISSIONS } = require('../../src/commands/utility/invite');
const { defaultGuildConfig } = require('../../src/config/defaults');
const diagnostics = require('../../src/commands/configuration/diagnostics');
const S = require('../../src/utils/secur');

const botMessages = (h, mark, pred = () => true) => h.fake.messageLog.slice(mark).map((id) => h.message(id)).filter((m) => m && m.author?.id === h.client.user.id && pred(m));
/** Cartes d'incident Secur (salon de logs ou MP aux propriétaires). */
const incidentCards = (h, mark) => botMessages(h, mark, (m) => (m.embeds ?? []).some((e) => /Incident Secur/.test(e.title ?? '')));
const cardText = (m) => (m?.embeds ?? []).flatMap((e) => [e.title, e.description, ...(e.fields ?? []).map((f) => `${f.name}: ${f.value}`)]).filter(Boolean).join('\n');
const warnings = (group) => (group?.checks ?? []).filter((c) => c.level !== 'ok');

/** Donne des permissions à un rôle du serveur de test (comme si un admin l'avait fait). */
function grant(h, roleKey, ...flags) {
  const role = h.fake.roles.get(IDS.roles[roleKey]);
  role.permissions = (BigInt(role.permissions) | flags.reduce((a, f) => a | f, 0n)).toString();
  h.fake.dispatchNow('GUILD_ROLE_UPDATE', { guild_id: h.guild.id, role });
}

/** Serveur où le rôle du bot a exactement les permissions du lien /invite. */
async function invitedBot() {
  const h = await createHarness({ botAdministrator: false });
  h.configureAll();
  const bits = new PermissionsBitField(INVITE_PERMISSIONS).bitfield.toString();
  await h.asHuman('owner').editRole(IDS.roles.bot, { permissions: bits });
  await h.settle();
  assert.equal(h.guild.members.me.permissions.has(P.Administrator), false);
  return h;
}

/* ------------------------------------------------------------------ */
/* S47 : « Gérer les webhooks » demandée par /invite                    */
/* ------------------------------------------------------------------ */

test('S47 : bot invité par /invite + « Protection standard » → le webhook créé par un modérateur compromis est supprimé, /diagnostics au vert', async () => {
  const h = await invitedBot();
  try {
    grant(h, 'mod', P.ManageWebhooks);
    h.configure({ secur: { modules: S.presetPatch('on', defaultGuildConfig.secur.modules) } });
    const cfg = h.client.services.config.get(h.guild.id);
    assert.equal(S.moduleMode(cfg, 'webhook'), 'on');
    assert.equal(h.guild.members.me.permissions.has(P.ManageWebhooks), true, 'le lien /invite ne demande pas « Gérer les webhooks »');

    // /diagnostics : la permission est contrôlée dans « Permissions du bot » et le groupe Secur n'avertit plus.
    const groups = diagnostics.analyze(h.guild, cfg);
    const botGroup = groups.find((g) => g.label === 'Permissions du bot');
    assert.ok(botGroup.checks.some((c) => c.text === 'Gérer les webhooks'), '« Gérer les webhooks » absent des contrôles du bot');
    assert.deepEqual(warnings(botGroup).map((c) => c.text), []);
    const secur = groups.find((g) => g.label === 'Secur');
    assert.deepEqual(warnings(secur).map((c) => c.text), [], 'le groupe Secur avertit encore');

    const mark = h.fake.messageLog.length;
    const hook = await h.asHuman('mod').perform('POST', `/channels/${IDS.channels.general}/webhooks`, { name: 'spam' });
    await h.settle();
    assert.equal(h.fake.webhooks.has(hook.id), false, 'webhook créé non supprimé (bot sans « Gérer les webhooks »)');
    const [incident] = h.client.repositories.securityIncidents.recent(h.guild.id, 5);
    assert.deepEqual(incident.modules, ['webhook']);
    assert.equal(incident.undone, 1);
    assert.ok(!h.fake.members.get(IDS.users.mod).roles.includes(IDS.roles.mod), 'modérateur non dérangé');
    const cards = incidentCards(h, mark);
    assert.ok(cards.length >= 1, 'aucune carte d\'incident');
    const text = cards.map(cardText).join('\n');
    assert.doesNotMatch(text, /Webhook non supprimé|Missing Permissions/, text);
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('S47 : bot invité par /invite, module everyone en max → le message @everyone ET le webhook auteur sont supprimés', async () => {
  const h = await invitedBot();
  try {
    const hook = await h.asHuman('admin').perform('POST', `/channels/${IDS.channels.general}/webhooks`, { name: 'alertes' });
    await h.settle();
    h.fake.users.set(hook.id, { id: hook.id, username: 'alertes', discriminator: '0000', avatar: null, bot: true });
    h.configure({ antiraid: { enabled: false }, secur: { modules: { everyone: { mode: 'max' } } } });

    const mark = h.fake.messageLog.length;
    const msg = await h.userMessage({ as: hook.id, channel: 'general', content: '@everyone gratuit !', extra: { webhook_id: hook.id, mention_everyone: true } });
    await h.settle();
    assert.equal(h.fake.messages.has(msg.id), false, 'message @everyone conservé');
    assert.equal(h.fake.webhooks.has(hook.id), false, 'webhook auteur non supprimé en max (bot sans « Gérer les webhooks »)');
    const [incident] = h.client.repositories.securityIncidents.recent(h.guild.id, 5);
    assert.deepEqual(incident.modules, ['everyone']);
    assert.equal(incident.undone, 1);
    assert.equal(incident.undo_failed, 0, incident.outcome);
    const cards = incidentCards(h, mark);
    assert.ok(cards.length >= 1, 'aucune carte d\'incident');
    const text = cards.map(cardText).join('\n');
    assert.doesNotMatch(text, /non supprimé|Missing Permissions/, text);
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});
