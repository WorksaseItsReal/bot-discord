'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Collection, PermissionFlagsBits, PermissionsBitField } = require('discord.js');
const embedbuilder = require('../src/components/embedbuilder');
const rolemenuComponent = require('../src/components/rolemenu');
const rolemenu = require('../src/commands/roles/rolemenu');
const massrole = require('../src/commands/roles/massrole');
const voice = require('../src/commands/voice/voice');
const projet = require('../src/commands/projects/projet');
const ticket = require('../src/commands/tickets/ticket');
const modmail = require('../src/commands/tickets/modmail');
const health = require('../src/commands/configuration/health');
const custom = require('../src/commands/configuration/custom');
const inrole = require('../src/commands/information/inrole');
const embed = require('../src/commands/utility/embed');
const projectFormat = require('../src/utils/projectFormat');
const { CooldownManager } = require('../src/core/cooldowns');

const A = '111111111111111111';
const perms = (granted) => ({ has: (flags) => [flags].flat().every((f) => granted.includes(f)) });

// ---------------------------------------------------------------- /embed (modal)

function modalInteraction({ granted = [PermissionFlagsBits.ManageMessages], channelPerms = [] } = {}) {
  const sent = [];
  const values = { title: 'T', description: 'D', color: '#ff0000', image: '' };
  return {
    sent,
    isModalSubmit: () => true,
    memberPermissions: perms(granted),
    member: { id: A },
    fields: { getTextInputValue: (k) => values[k] },
    channel: { toString: () => '#salon', permissionsFor: () => perms(channelPerms), send: async (p) => { sent.push(p); return { url: 'https://discord.com/x' }; } },
    reply: async () => {},
  };
}

test('/embed (modal) : « Gérer les messages » et droits du salon revérifiés avant publication', async () => {
  const noManage = modalInteraction({ granted: [] });
  await assert.rejects(embedbuilder.execute(noManage), /Gérer les messages/);
  const noEmbed = modalInteraction({ channelPerms: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] });
  await assert.rejects(embedbuilder.execute(noEmbed), /permission d'envoyer/);
  assert.equal(noManage.sent.length + noEmbed.sent.length, 0);
  const ok = modalInteraction({ channelPerms: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks] });
  await embedbuilder.execute(ok);
  assert.equal(ok.sent[0].embeds[0].toJSON().color, 0xff0000);
});

test('parseColor : une seule implémentation (projectFormat), réexportée par /embed', () => {
  assert.equal(embed.parseColor, projectFormat.parseColor);
  assert.equal(embed.parseColor('#5865F2'), 0x5865f2);
  assert.equal(embed.parseColor(''), null);
});

// ---------------------------------------------------------------- /massrole

test('massrole : édite via l\'interaction puis via le message après 14 minutes', async () => {
  let now = 0;
  const calls = [];
  const message = { edit: async (p) => calls.push(['message', p]) };
  const interaction = {
    createdTimestamp: 0,
    fetchReply: async () => message,
    editReply: async (p) => calls.push(['interaction', p]),
  };
  const edit = massrole.replyEditor(interaction, () => now);
  await edit(1);
  now = 13 * 60_000;
  await edit(2);
  now = 14 * 60_000 + 1;
  await edit(3);
  assert.deepEqual(calls, [['interaction', 1], ['interaction', 2], ['message', 3]]);
});

test('massrole : une seule exécution à la fois par serveur', async () => {
  const role = { id: 'r', position: 1, managed: false, toString: () => '<@&r>' };
  let release;
  const guild = {
    id: 'g-massrole',
    ownerId: A,
    members: { me: { roles: { highest: { position: 10 } } }, fetch: () => new Promise((r) => { release = r; }) },
  };
  const interaction = () => ({
    guild,
    user: { id: A },
    member: { roles: { highest: { position: 10 } } },
    createdTimestamp: Date.now(),
    options: { getString: (k) => (k === 'action' ? 'add' : null), getRole: () => role },
    deferReply: async () => {},
    fetchReply: async () => ({ edit: async () => {} }),
    editReply: async () => {},
  });
  const first = massrole.execute(interaction());
  await new Promise((r) => setImmediate(r));
  await assert.rejects(massrole.execute(interaction()), /déjà en cours/);
  release(new Collection());
  await first;
  assert.equal(massrole.running.has('g-massrole'), false, 'verrou libéré');
});

// ---------------------------------------------------------------- menus de rôles

test('menus de rôles : liste partagée des permissions interdites (commande + composant)', async () => {
  const { FORBIDDEN_PERMISSIONS, hasForbiddenPermissions } = rolemenu;
  for (const name of ['Administrator', 'ManageGuild', 'ManageRoles', 'BanMembers', 'KickMembers', 'ModerateMembers', 'ManageChannels',
    'ManageMessages', 'MentionEveryone', 'ManageWebhooks', 'ManageNicknames', 'ManageGuildExpressions', 'ViewAuditLog']) {
    assert.ok(FORBIDDEN_PERMISSIONS.includes(PermissionFlagsBits[name]), name);
    assert.equal(hasForbiddenPermissions({ permissions: new PermissionsBitField(PermissionFlagsBits[name]) }), true, name);
  }
  assert.equal(hasForbiddenPermissions({ permissions: new PermissionsBitField(PermissionFlagsBits.SendMessages) }), false);

  // Le composant refuse un rôle devenu « modérateur » après la création du menu.
  const banRole = { id: 'r1', managed: false, position: 1, permissions: new PermissionsBitField(PermissionFlagsBits.BanMembers) };
  const replies = [];
  const added = [];
  const interaction = {
    isStringSelectMenu: () => true,
    deferReply: async () => {},
    reply: async (p) => replies.push(p),
    message: { id: 'm' },
    guildId: 'g',
    values: ['r1'],
    guild: { roles: { cache: new Collection([['r1', banRole]]) }, members: { me: { roles: { highest: { position: 10 } } } } },
    member: { roles: { cache: new Collection(), add: async (id) => added.push(id) } },
  };
  const client = { repositories: { roleMenus: { getByMessage: () => ({ guild_id: 'g', data: { roles: [{ roleId: 'r1' }] } }) } } };
  await rolemenuComponent.execute(interaction, client);
  assert.deepEqual(added, []);
  assert.ok(JSON.stringify(replies[0].embeds[0].toJSON()).includes('Impossibles à modifier'));
});

// ---------------------------------------------------------------- /voice move

test('/voice move : Connect et Déplacer des membres exigés sur le salon cible', async () => {
  const moved = [];
  const target = { id: 'v2', toString: () => '<#v2>', permissionsFor: () => perms([PermissionFlagsBits.MoveMembers]) };
  const member = { id: A, voice: { channel: { id: 'v1' }, setChannel: async (c) => moved.push(c) } };
  const interaction = {
    user: { id: 'mod', tag: 'mod' },
    member: { id: 'mod' },
    guild: { members: { fetch: async () => member, me: {} } },
    options: { getSubcommand: () => 'move', getUser: () => ({ id: A }), getChannel: () => target },
    reply: async () => {},
  };
  await assert.rejects(voice.execute(interaction), /ne pouvez pas déplacer/);
  assert.equal(moved.length, 0);
  target.permissionsFor = () => perms([PermissionFlagsBits.MoveMembers, PermissionFlagsBits.Connect]);
  await voice.execute(interaction);
  assert.deepEqual(moved, [target]);
});

// ---------------------------------------------------------------- /projet liste (bouton)

test('projet : arguments du bouton de liste validés (statut connu, identifiant Discord)', async () => {
  const client = { services: { projects: { list: () => [] } }, users: { cache: new Map() } };
  const interaction = { user: { id: 'owner' }, guild: { id: 'g', name: 'S' }, update: async () => {} };
  await assert.rejects(projet.buttons.list(interaction, client, ['owner', '0', 'constructor', '-', 'r']), /statut/);
  await assert.rejects(projet.buttons.list(interaction, client, ['owner', '0', '-', '12ab', 'r']), /membre/);
  await projet.buttons.list(interaction, client, ['owner', '0', 'en_cours', A, 'r']);
});

// ---------------------------------------------------------------- rôles support / staff

test('ticket / modmail setup : @everyone et rôles d\'intégration refusés', async () => {
  const guild = { id: 'g' };
  const setup = (role) => ({
    guild,
    member: { permissions: perms([PermissionFlagsBits.ManageGuild]) },
    options: { getSubcommand: () => 'setup', getChannel: () => null, getRole: () => role, getInteger: () => null, getBoolean: () => null },
    reply: async () => {},
  });
  const client = { services: { tickets: {}, modmail: {}, config: { update: () => assert.fail('aucune écriture'), get: () => ({}) } } };
  for (const role of [{ id: 'g', name: '@everyone' }, { id: 'r', name: 'Bot', managed: true }]) {
    await assert.rejects(ticket.execute(setup(role), client), /@everyone|intégration/);
    await assert.rejects(modmail.execute(setup(role), client), /@everyone|intégration/);
  }
});

// ---------------------------------------------------------------- /health

test('/health : réservé à « Gérer le serveur »', async () => {
  assert.equal(health.data.toJSON().default_member_permissions, String(PermissionFlagsBits.ManageGuild));
  await assert.rejects(health.execute({ memberPermissions: perms([]), user: { id: A } }, {}), /Gérer le serveur/);
});

// ---------------------------------------------------------------- membres (roleinfo / inrole)

test('membres : pas de téléchargement si le cache est complet, cooldown par serveur sinon', async () => {
  let fetches = 0;
  const guild = (size, memberCount) => ({ id: 'g', memberCount, members: { cache: { size }, fetch: async () => { fetches += 1; } } });
  const client = { cooldowns: new CooldownManager() };
  assert.deepEqual(await inrole.ensureMembers(guild(10, 10), client), { partial: false });
  assert.equal(fetches, 0);
  assert.deepEqual(await inrole.ensureMembers(guild(5, 10), client), { partial: false });
  assert.deepEqual(await inrole.ensureMembers(guild(5, 10), client), { partial: true });
  assert.equal(fetches, 1);
  const pages = inrole.buildPages({ name: 'R', color: 0, toString: () => '<@&r>' }, [{ id: A, user: { username: 'a' } }], { partial: true });
  assert.ok(pages[0].toJSON().description.includes('incomplète'));
});

// ---------------------------------------------------------------- /custom

test('/custom : noms de tag (lettres unicode, chiffres, _ et -) et option embed retirée', () => {
  assert.equal(custom.normalizeTagName('Règle Numéro_1'), 'règle-numéro_1');
  assert.equal(custom.normalizeTagName('日本'), '日本');
  for (const bad of ['a:b', 'x/y', '--', '%41', 'a'.repeat(33), '']) assert.throws(() => custom.normalizeTagName(bad), /invalide/, bad);
  const create = custom.data.toJSON().options.find((o) => o.name === 'create');
  assert.deepEqual(create.options.map((o) => o.name), ['nom', 'contenu']);
});
