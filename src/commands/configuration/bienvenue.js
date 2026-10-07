'use strict';

const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChannelType,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ChannelSelectMenuBuilder,
  RoleSelectMenuBuilder,
} = require('discord.js');
const { card, field, wide, ICONS, status, actionButton, buttonRows, ButtonStyle, subtext } = require('../../utils/ui');
const { truncate } = require('../../utils/embeds');
const { requirePermission } = require('../../services/ModerationService');
const {
  VARIABLES,
  SAMPLE_VARS,
  MAX_AUTO_ROLES,
  renderTemplate,
  unknownVariables,
  parseColor,
  colorHex,
  parseImageUrl,
  roleIssue,
  dangerousPermissions,
  channelState,
  memberVars,
  messageCard,
  messagePayload,
  panelCard,
} = require('../../services/WelcomeService');
const { UserError } = require('../../core/errors');

/**
 * /bienvenue : tableau de bord unique (éphémère) de l'accueil des membres.
 * Vues : home · join · leave · roles · verify · preview
 * Bouton public persistant du panneau : cmd:bienvenue:verify (sans permission requise).
 */

const TEXT_TYPES = [ChannelType.GuildText, ChannelType.GuildAnnouncement];
const KINDS = { join: 'Message de bienvenue', leave: 'Message de départ' };
const CHANNEL_STATE = {
  ok: ['🟢', 'Prêt'],
  unset: ['⚪', 'Aucun salon'],
  missing: ['❌', 'Salon introuvable'],
  noperm: ['🔒', 'Je ne peux pas y écrire'],
};
const stateText = (state) => CHANNEL_STATE[state].join(' ');
const CHANNEL_HINTS = {
  unset: 'Choisissez un salon ci-dessous.',
  missing: 'Le salon a été supprimé : choisissez-en un autre.',
  noperm: 'Donnez-moi **Voir le salon**, **Envoyer des messages** et **Intégrer des liens** dans ce salon.',
};

/** Interrupteurs « on/off » (et le mode de vérification) : clé de bouton → chemin de config. */
const SWITCHES = {
  'join.enabled': ['join', 'enabled'],
  'join.mention': ['join', 'mention'],
  'join.dm': ['join', 'dm'],
  'leave.enabled': ['leave', 'enabled'],
  'verification.enabled': ['verification', 'enabled'],
  'verification.captcha': ['verification', 'captcha'],
};

const NAV = [
  { value: 'home', label: 'Accueil', emoji: '🏠', description: 'Vue d\'ensemble de l\'accueil des membres' },
  { value: 'join', label: 'Message de bienvenue', emoji: '👋', description: 'Salon, texte, mention et MP' },
  { value: 'leave', label: 'Message de départ', emoji: '🚪', description: 'Salon et texte du départ' },
  { value: 'roles', label: 'Rôles automatiques', emoji: ICONS.role, description: 'Rôles donnés aux humains et aux bots' },
  { value: 'verify', label: 'Vérification', emoji: ICONS.shield, description: 'Bouton anti-robot, rôle, âge minimal' },
  { value: 'preview', label: 'Aperçu et test', emoji: '🧪', description: 'Voir le rendu, envoyer un test' },
];

const guard = (interaction) => requirePermission(interaction, 'ManageGuild');
const cfgOf = (client, guildId) => client.services.config.get(guildId).welcome;
const onOff = (on) => (on ? '🟢 Activé' : '🔴 Désactivé');
const homeButton = () => actionButton({ command: 'bienvenue', action: 'go', args: ['home'], label: 'Accueil', emoji: '🏠' });

function navRow(current) {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('cmd:bienvenue:nav')
      .setPlaceholder('Aller à…')
      .addOptions(NAV.map((o) => ({ ...o, default: o.value === current }))),
  );
}

/** Bouton on/off : la valeur CIBLE est dans les arguments (jamais d'inversion à l'aveugle). */
function switchButton(key, on, labels = ['Activer', 'Désactiver']) {
  return on
    ? actionButton({ command: 'bienvenue', action: 'set', args: [key, 'off'], label: labels[1], emoji: '🔴', style: ButtonStyle.Danger })
    : actionButton({ command: 'bienvenue', action: 'set', args: [key, 'on'], label: labels[0], emoji: '🟢', style: ButtonStyle.Success });
}

function channelMenu(customId, guild, channelId, placeholder) {
  const menu = new ChannelSelectMenuBuilder().setCustomId(customId).setPlaceholder(placeholder).setChannelTypes(...TEXT_TYPES).setMinValues(0).setMaxValues(1);
  if (channelId && guild.channels?.cache?.has(channelId)) menu.setDefaultChannels(channelId);
  return new ActionRowBuilder().addComponents(menu);
}

function roleMenu(customId, guild, ids, max, placeholder) {
  const menu = new RoleSelectMenuBuilder().setCustomId(customId).setPlaceholder(placeholder).setMinValues(0).setMaxValues(max);
  const shown = (ids ?? []).filter((id) => !guild.roles?.cache || guild.roles.cache.has(id)).slice(0, max);
  if (shown.length) menu.setDefaultRoles(...shown);
  return new ActionRowBuilder().addComponents(menu);
}

/** « @Rôle · ⚠️ … » : problème bloquant ou permissions sensibles. */
function roleLine(guild, id) {
  const role = guild.roles?.cache?.get(id);
  const issue = guild.roles?.cache ? roleIssue(role, guild) : null;
  if (issue) return `❌ <@&${id}> · *${issue}*`;
  const danger = dangerousPermissions(role);
  return danger.length ? `${ICONS.warning} <@&${id}> · confère ${danger.slice(0, 3).join(', ')}${danger.length > 3 ? '…' : ''}` : `${ICONS.role} <@&${id}>`;
}

/** Modèle affiché tel quel (police fixe). */
const templateBlock = (text) => `\`\`\`\n${truncate(String(text ?? '').replace(/`/g, 'ˋ') || ' ', 900)}\n\`\`\``;

// ---------------------------------------------------------------- vues

function homeView(client, guild, notice) {
  const cfg = cfgOf(client, guild.id);
  const join = channelState(guild, cfg.join.channelId);
  const leave = channelState(guild, cfg.leave.channelId);
  const v = cfg.verification;
  const problems = [
    cfg.join.enabled && join !== 'ok' ? `👋 Bienvenue : ${CHANNEL_STATE[join][1].toLowerCase()}.` : null,
    cfg.leave.enabled && leave !== 'ok' ? `🚪 Départ : ${CHANNEL_STATE[leave][1].toLowerCase()}.` : null,
    [...cfg.autoRoles.humans, ...cfg.autoRoles.bots].some((id) => roleIssue(guild.roles?.cache?.get(id), guild)) ? `${ICONS.role} Certains rôles automatiques ne peuvent pas être attribués.` : null,
    v.enabled && !v.panelMessageId ? `${ICONS.shield} Vérification active, mais le panneau n'est pas publié.` : null,
  ].filter(Boolean);
  const on = [cfg.join.enabled, cfg.leave.enabled, v.enabled].filter(Boolean).length;
  return {
    embeds: [
      card({
        tone: problems.length ? 'warning' : on ? 'success' : 'info',
        section: { emoji: '👋', label: 'Bienvenue' },
        icon: '👋',
        title: 'Bienvenue · Tableau de bord',
        description: [
          notice ? `${notice}\n` : null,
          'Accueillez les nouveaux membres : message de bienvenue, départ, rôles automatiques et vérification anti-robot.',
          '',
          `${cfg.join.enabled ? '🟢' : '🔴'} 👋 **Message de bienvenue** · ${cfg.join.channelId ? `<#${cfg.join.channelId}>` : '*Aucun salon*'}${cfg.join.dm ? ' · MP' : ''}`,
          `${cfg.leave.enabled ? '🟢' : '🔴'} 🚪 **Message de départ** · ${cfg.leave.channelId ? `<#${cfg.leave.channelId}>` : '*Aucun salon*'}`,
          `${cfg.autoRoles.humans.length + cfg.autoRoles.bots.length ? '🟢' : '⚪'} ${ICONS.role} **Rôles automatiques** · ${cfg.autoRoles.humans.length} humain(s) · ${cfg.autoRoles.bots.length} bot(s)`,
          `${v.enabled ? '🟢' : '🔴'} ${ICONS.shield} **Vérification** · ${v.roleId ? `<@&${v.roleId}>` : '*Aucun rôle*'}${v.captcha ? ' · question anti-robot' : ''}`,
          problems.length ? `\n${ICONS.warning} **À corriger**\n${problems.join('\n')}` : null,
        ],
        footer: 'Choisissez une section dans le menu',
      }),
    ],
    components: [
      navRow('home'),
      ...buttonRows(
        actionButton({ command: 'bienvenue', action: 'preview', args: ['join'], label: 'Aperçu', emoji: '👁️', style: ButtonStyle.Primary }),
        actionButton({ command: 'bienvenue', action: 'go', args: ['preview'], label: 'Aperçu et test', emoji: '🧪' }),
        actionButton({ command: 'bienvenue', action: 'go', args: ['home'], label: 'Actualiser', emoji: ICONS.refresh }),
      ),
    ],
  };
}

function messageView(client, guild, kind, notice) {
  const cfg = cfgOf(client, guild.id);
  const msg = cfg[kind];
  const state = channelState(guild, msg.channelId);
  const isJoin = kind === 'join';
  const unknown = unknownVariables(`${msg.title} ${msg.description}`);
  return {
    embeds: [
      card({
        tone: msg.enabled ? (state === 'ok' ? 'success' : 'warning') : 'neutral',
        section: { emoji: '👋', label: 'Bienvenue' },
        icon: isJoin ? '👋' : '🚪',
        title: KINDS[kind],
        description: [
          notice ? `${notice}\n` : null,
          isJoin ? 'Envoyé dans le salon choisi quand un membre arrive (après l\'AntiRaid et l\'écran d\'adhésion de Discord).' : 'Envoyé dans le salon choisi quand un membre quitte le serveur.',
          CHANNEL_HINTS[state] ? `\n${ICONS.info} ${CHANNEL_HINTS[state]}` : null,
          unknown.length ? `\n${ICONS.warning} Variable(s) inconnue(s) : ${unknown.map((k) => `\`{${k}}\``).join(', ')}.` : null,
        ],
        fields: [
          field(ICONS.status, 'État', onOff(msg.enabled)),
          field(ICONS.channel, 'Salon', msg.channelId ? `<#${msg.channelId}>\n${stateText(state)}` : stateText('unset')),
          field(ICONS.color, 'Couleur', colorHex(msg.color) ?? 'Par défaut'),
          isJoin ? field('🔔', 'Mention du membre', msg.mention !== false ? '✅ Oui' : '❌ Non') : null,
          isJoin ? field(ICONS.mail, 'Copie en MP', msg.dm ? '✅ Oui' : '❌ Non') : null,
          field(ICONS.image, 'Bannière', msg.image ? `[Image](${msg.image})` : '*Aucune*'),
          wide('🏷️', 'Titre', templateBlock(msg.title)),
          wide(ICONS.reason, 'Texte', templateBlock(msg.description)),
          wide(ICONS.list, 'Variables', Object.keys(VARIABLES).map((k) => `\`{${k}}\``).join(' · ')),
        ],
        footer: '« Personnaliser » ouvre le formulaire · « Aperçu » montre le rendu pour vous',
      }),
    ],
    components: [
      navRow(kind),
      channelMenu(`cmd:bienvenue:channel:${kind}`, guild, msg.channelId, isJoin ? 'Salon des messages de bienvenue…' : 'Salon des messages de départ…'),
      ...buttonRows(
        switchButton(`${kind}.enabled`, msg.enabled),
        actionButton({ command: 'bienvenue', action: 'edit', args: [kind], label: 'Personnaliser', emoji: '✏️', style: ButtonStyle.Primary }),
        isJoin ? actionButton({ command: 'bienvenue', action: 'set', args: ['join.mention', msg.mention !== false ? 'off' : 'on'], label: msg.mention !== false ? 'Mention ✅' : 'Mention ❌', emoji: '🔔' }) : null,
        isJoin ? actionButton({ command: 'bienvenue', action: 'set', args: ['join.dm', msg.dm ? 'off' : 'on'], label: msg.dm ? 'MP ✅' : 'MP ❌', emoji: ICONS.mail }) : null,
        actionButton({ command: 'bienvenue', action: 'preview', args: [kind], label: 'Aperçu', emoji: '👁️' }),
      ),
      ...buttonRows(homeButton()),
    ],
  };
}

function rolesView(client, guild, notice) {
  const cfg = cfgOf(client, guild.id);
  const { humans, bots } = cfg.autoRoles;
  const v = cfg.verification;
  return {
    embeds: [
      card({
        tone: 'info',
        section: { emoji: '👋', label: 'Bienvenue' },
        icon: ICONS.role,
        title: 'Rôles automatiques',
        description: [
          notice ? `${notice}\n` : null,
          `Rôles donnés à l'arrivée : jusqu'à **${MAX_AUTO_ROLES}** pour les humains et **${MAX_AUTO_ROLES}** pour les bots.`,
          v.enabled ? `${ICONS.shield} La vérification est active : les rôles humains sont donnés **après la vérification**.` : null,
          subtext('Mon rôle doit être au-dessus de ces rôles. Les rôles gérés, @everyone et les rôles Administrateur sont refusés.'),
        ],
        fields: [
          wide(ICONS.members, `Humains (${humans.length}/${MAX_AUTO_ROLES})`, humans.length ? humans.map((id) => roleLine(guild, id)).join('\n') : '*Aucun*'),
          wide(ICONS.bot, `Bots (${bots.length}/${MAX_AUTO_ROLES})`, bots.length ? bots.map((id) => roleLine(guild, id)).join('\n') : '*Aucun*'),
        ],
        footer: 'Chaque menu remplace la sélection actuelle',
      }),
    ],
    components: [
      navRow('roles'),
      roleMenu('cmd:bienvenue:roles:humans', guild, humans, MAX_AUTO_ROLES, 'Rôles des nouveaux membres humains…'),
      roleMenu('cmd:bienvenue:roles:bots', guild, bots, MAX_AUTO_ROLES, 'Rôles des bots ajoutés…'),
      ...buttonRows(homeButton()),
    ],
  };
}

function verifyView(client, guild, notice) {
  const v = cfgOf(client, guild.id).verification;
  const role = v.roleId ? guild.roles?.cache?.get(v.roleId) : null;
  const issue = v.roleId && guild.roles?.cache ? roleIssue(role, guild) : null;
  const state = channelState(guild, v.channelId);
  const panel = v.panelMessageId && v.panelChannelId ? `https://discord.com/channels/${guild.id}/${v.panelChannelId}/${v.panelMessageId}` : null;
  const removeMode = v.mode === 'remove';
  return {
    embeds: [
      card({
        tone: v.enabled ? (issue || !panel ? 'warning' : 'success') : 'neutral',
        section: { emoji: '👋', label: 'Bienvenue' },
        icon: ICONS.shield,
        title: 'Vérification',
        description: [
          notice ? `${notice}\n` : null,
          removeMode
            ? 'Les nouveaux membres reçoivent le rôle **non vérifié** ; il leur est retiré quand ils cliquent sur le bouton du panneau.'
            : 'Les nouveaux membres reçoivent le rôle **vérifié** quand ils cliquent sur le bouton du panneau.',
          '1. Choisissez le **rôle** et le **salon** du panneau.',
          '2. Activez la vérification et publiez le **panneau**.',
          issue ? `\n${ICONS.error} Rôle inutilisable : ${issue}.` : null,
          role && !issue && dangerousPermissions(role).length ? `\n${ICONS.warning} Ce rôle confère des permissions sensibles : ${dangerousPermissions(role).join(', ')}.` : null,
          v.channelId && CHANNEL_HINTS[state] ? `\n${ICONS.info} Salon du panneau : ${CHANNEL_HINTS[state]}` : null,
          v.enabled && !panel ? `\n${ICONS.warning} Le panneau n'est pas publié : personne ne peut se vérifier.` : null,
        ],
        fields: [
          field(ICONS.status, 'État', onOff(v.enabled)),
          field('🔁', 'Mode', removeMode ? 'Retirer « non vérifié »' : 'Donner « vérifié »'),
          field(ICONS.role, 'Rôle', v.roleId ? `<@&${v.roleId}>` : '*Aucun*'),
          field(ICONS.channel, 'Salon du panneau', v.channelId ? `<#${v.channelId}>` : '*Aucun*'),
          field('🧩', 'Question anti-robot', v.captcha ? '✅ Oui' : '❌ Non'),
          field(ICONS.date, 'Âge minimal du compte', v.minAccountAgeDays ? `${v.minAccountAgeDays} jour(s)` : '*Aucun*'),
          wide('📌', 'Panneau', panel ? `[Voir le panneau publié](${panel})` : '*Non publié*'),
        ],
        footer: 'Les vérifications réussies sont journalisées (logs Membres)',
      }),
    ],
    components: [
      navRow('verify'),
      roleMenu('cmd:bienvenue:vrole', guild, v.roleId ? [v.roleId] : [], 1, removeMode ? 'Rôle « non vérifié » à retirer…' : 'Rôle « vérifié » à donner…'),
      channelMenu('cmd:bienvenue:vchannel', guild, v.channelId, 'Salon du panneau de vérification…'),
      ...buttonRows(
        switchButton('verification.enabled', v.enabled),
        actionButton({ command: 'bienvenue', action: 'set', args: ['verification.mode', removeMode ? 'add' : 'remove'], label: removeMode ? 'Mode : retrait' : 'Mode : ajout', emoji: '🔁' }),
        actionButton({ command: 'bienvenue', action: 'set', args: ['verification.captcha', v.captcha ? 'off' : 'on'], label: v.captcha ? 'Question ✅' : 'Question ❌', emoji: '🧩' }),
        actionButton({ command: 'bienvenue', action: 'vage', label: 'Âge minimal', emoji: ICONS.date }),
        actionButton({ command: 'bienvenue', action: 'publish', label: 'Publier le panneau', emoji: '📌', style: ButtonStyle.Primary }),
      ),
    ],
  };
}

function previewView(client, guild, notice) {
  const cfg = cfgOf(client, guild.id);
  const sample = { ...SAMPLE_VARS, server: guild.name ?? SAMPLE_VARS.server };
  const rendered = (msg) => `**${truncate(renderTemplate(msg.title, sample, { plain: true }), 200)}**\n${truncate(renderTemplate(msg.description, sample), 700)}`;
  return {
    embeds: [
      card({
        tone: 'info',
        section: { emoji: '👋', label: 'Bienvenue' },
        icon: '🧪',
        title: 'Aperçu et test',
        description: [
          notice ? `${notice}\n` : null,
          '**Aperçu** : le rendu s\'affiche pour vous seul. **Tester** : le message est réellement envoyé dans son salon, à votre nom (aucun rôle n\'est donné).',
        ],
        fields: [
          wide('👋', 'Bienvenue (exemple)', rendered(cfg.join)),
          wide('🚪', 'Départ (exemple)', rendered(cfg.leave)),
          wide(ICONS.list, 'Variables', Object.entries(VARIABLES).map(([k, d]) => `\`{${k}}\` · ${d}`).join('\n')),
        ],
        footer: '@everyone et @here sont toujours neutralisés',
      }),
    ],
    components: [
      navRow('preview'),
      ...buttonRows(
        actionButton({ command: 'bienvenue', action: 'preview', args: ['join'], label: 'Aperçu bienvenue', emoji: '👋', style: ButtonStyle.Primary }),
        actionButton({ command: 'bienvenue', action: 'preview', args: ['leave'], label: 'Aperçu départ', emoji: '🚪' }),
        actionButton({ command: 'bienvenue', action: 'preview', args: ['panel'], label: 'Aperçu panneau', emoji: ICONS.shield }),
        actionButton({ command: 'bienvenue', action: 'test', args: ['join'], label: 'Tester l\'arrivée', emoji: '📥' }),
        actionButton({ command: 'bienvenue', action: 'test', args: ['leave'], label: 'Tester le départ', emoji: '📤' }),
      ),
      ...buttonRows(homeButton()),
    ],
  };
}

function render(client, guild, view = 'home', notice) {
  const [name] = String(view).split(/[:.]/);
  switch (name) {
    case 'join':
    case 'leave':
      return messageView(client, guild, name, notice);
    case 'roles':
      return rolesView(client, guild, notice);
    case 'verify':
      return verifyView(client, guild, notice);
    case 'preview':
      return previewView(client, guild, notice);
    default:
      return homeView(client, guild, notice);
  }
}

/** Vue où se trouve un réglage (retour après modification). */
const viewOf = (section) => (section === 'verification' ? 'verify' : section);

// ---------------------------------------------------------------- formulaires

const input = (id, label, { value, placeholder, style = TextInputStyle.Short, max = 100, required = false } = {}) => {
  const t = new TextInputBuilder().setCustomId(id).setLabel(truncate(label, 45)).setStyle(style).setMaxLength(max).setRequired(required);
  if (value != null && String(value) !== '') t.setValue(String(value).slice(0, max));
  if (placeholder) t.setPlaceholder(placeholder.slice(0, 100));
  return new ActionRowBuilder().addComponents(t);
};

function messageModal(kind, msg) {
  return new ModalBuilder()
    .setCustomId(`cmd:bienvenue:editsubmit:${kind}`)
    .setTitle(KINDS[kind])
    .addComponents(
      input('title', 'Titre', { value: msg.title, max: 200, required: true, placeholder: 'Bienvenue sur {serveur} !' }),
      input('description', 'Texte ({membre} {pseudo} {serveur} {nombre}…)', { value: msg.description, max: 2000, required: true, style: TextInputStyle.Paragraph }),
      input('color', 'Couleur (ex : #5865F2, vide = défaut)', { value: colorHex(msg.color), max: 7 }),
      input('image', 'Bannière : adresse https (vide = aucune)', { value: msg.image, max: 500, placeholder: 'https://exemple.com/banniere.png' }),
    );
}

function ageModal(v) {
  return new ModalBuilder()
    .setCustomId('cmd:bienvenue:vagesubmit')
    .setTitle('Âge minimal du compte')
    .addComponents(input('days', 'Âge minimal du compte (jours, 0 à 365)', { value: v.minAccountAgeDays ?? 0, max: 3, required: true, placeholder: '0 = aucun minimum' }));
}

function captchaModal(label) {
  return new ModalBuilder()
    .setCustomId('cmd:bienvenue:verifysubmit')
    .setTitle('Vérification anti-robot')
    .addComponents(input('answer', label, { max: 20, required: true, placeholder: 'Votre réponse' }));
}

// ---------------------------------------------------------------- aides

function textChannel(interaction, id) {
  if (!id) return null;
  if (!/^\d{17,20}$/.test(id)) throw new UserError('Salon invalide.');
  const ch = interaction.guild.channels.cache.get(id);
  if (!ch || !TEXT_TYPES.includes(ch.type)) throw new UserError('Choisissez un salon textuel du serveur.');
  return ch;
}

const channelNotice = (guild, id, label) => {
  if (!id) return `${ICONS.success} ${label} : salon retiré.`;
  return channelState(guild, id) === 'noperm'
    ? `${ICONS.warning} Salon enregistré, mais je ne peux pas y écrire : donnez-moi **Voir**, **Envoyer** et **Intégrer des liens**.`
    : `${ICONS.success} ${label} → <#${id}>.`;
};

/** Variables rendues pour l'auteur de l'interaction (aperçu, test). */
function selfVars(interaction) {
  const user = interaction.user;
  return memberVars({ displayName: interaction.member?.displayName ?? interaction.member?.nick ?? user.globalName ?? user.username, user, guild: interaction.guild });
}

/** Membre complet de l'interaction (rôles en cache). */
async function fullMember(interaction) {
  const m = interaction.member;
  if (m?.roles?.cache && m.guild) return m;
  return interaction.guild.members.fetch(interaction.user.id);
}

/** Vérification effective + réponse éphémère. */
async function completeVerification(interaction, client, member, captcha) {
  await interaction.deferReply({ ephemeral: true });
  const { added, removed } = await client.services.welcome.verify(member, { captcha });
  const changes = [
    added.length ? `${ICONS.role} Rôle(s) reçu(s) : ${added.map((id) => `<@&${id}>`).join(' ')}` : null,
    removed.length ? `${ICONS.role} Rôle(s) retiré(s) : ${removed.map((id) => `<@&${id}>`).join(' ')}` : null,
  ].filter(Boolean);
  await interaction.editReply({ embeds: [status.ok(['Vous êtes vérifié(e) : bienvenue sur le serveur !', ...changes].join('\n'), 'Vérification réussie')] });
}

// ---------------------------------------------------------------- commande

module.exports = {
  category: 'configuration',
  cooldown: 3_000,
  render,
  data: new SlashCommandBuilder()
    .setName('bienvenue')
    .setDescription('Ouvre le tableau de bord de l\'accueil : bienvenue, départ, rôles automatiques, vérification.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction, client) {
    guard(interaction);
    await interaction.reply({ ...render(client, interaction.guild, 'home'), ephemeral: true });
  },

  buttons: {
    /** Menu de navigation. */
    async nav(interaction, client) {
      guard(interaction);
      await interaction.update(render(client, interaction.guild, interaction.values?.[0] ?? 'home'));
    },
    /** cmd:bienvenue:go:<vue> */
    async go(interaction, client, [view]) {
      guard(interaction);
      await interaction.update(render(client, interaction.guild, view ?? 'home'));
    },
    /** cmd:bienvenue:set:<réglage>:<on|off> ou set:verification.mode:<add|remove> — valeur cible explicite. */
    async set(interaction, client, [key, value]) {
      guard(interaction);
      const cfg = cfgOf(client, interaction.guildId);
      let section;
      let patch;
      let notice;
      if (key === 'verification.mode') {
        if (!['add', 'remove'].includes(value)) throw new UserError('Mode inconnu.');
        section = 'verification';
        patch = { mode: value };
        notice = value === 'remove'
          ? `${ICONS.success} Mode **retrait** : choisissez le rôle « non vérifié » donné à l'arrivée et retiré à la vérification.`
          : `${ICONS.success} Mode **ajout** : choisissez le rôle « vérifié » donné à la vérification.`;
        // Le rôle choisi n'a pas le même sens d'un mode à l'autre.
        if (cfg.verification.mode !== value && cfg.verification.roleId) {
          patch.roleId = null;
          patch.enabled = false;
          notice += `\n${ICONS.info} Rôle réinitialisé et vérification désactivée : choisissez le nouveau rôle.`;
        }
      } else {
        if (!SWITCHES[key] || !['on', 'off'].includes(value)) throw new UserError('Réglage inconnu.');
        const [sec, prop] = SWITCHES[key];
        const on = value === 'on';
        if (on && prop === 'enabled') {
          if (sec === 'verification' && !cfg.verification.roleId) throw new UserError('Choisissez d\'abord le rôle de vérification.');
          if (sec !== 'verification' && !cfg[sec].channelId) throw new UserError('Choisissez d\'abord un salon.');
        }
        section = sec;
        patch = { [prop]: on };
        notice = `${ICONS.success} Réglage mis à jour : **${on ? 'activé' : 'désactivé'}**.`;
      }
      client.services.config.update(interaction.guildId, { welcome: { [section]: patch } });
      await interaction.update(render(client, interaction.guild, viewOf(section), notice));
    },
    /** cmd:bienvenue:channel:<join|leave> — salon du message. */
    async channel(interaction, client, [kind]) {
      guard(interaction);
      if (!KINDS[kind]) throw new UserError('Message inconnu.');
      const id = textChannel(interaction, interaction.values?.[0] ?? null)?.id ?? null;
      const patch = { channelId: id };
      if (!id) patch.enabled = false;
      client.services.config.update(interaction.guildId, { welcome: { [kind]: patch } });
      await interaction.update(messageView(client, interaction.guild, kind, channelNotice(interaction.guild, id, KINDS[kind])));
    },
    /** cmd:bienvenue:edit:<join|leave> — ouvre le formulaire du message. */
    async edit(interaction, client, [kind]) {
      guard(interaction);
      if (!KINDS[kind]) throw new UserError('Message inconnu.');
      await interaction.showModal(messageModal(kind, cfgOf(client, interaction.guildId)[kind]));
    },
    async editsubmit(interaction, client, [kind]) {
      guard(interaction);
      if (!KINDS[kind]) throw new UserError('Message inconnu.');
      const title = interaction.fields.getTextInputValue('title')?.trim();
      const description = interaction.fields.getTextInputValue('description')?.trim();
      if (!title || title.length > 200) throw new UserError('Le titre est obligatoire (200 caractères maximum).');
      if (!description || description.length > 2000) throw new UserError('Le texte est obligatoire (2000 caractères maximum).');
      const color = parseColor(interaction.fields.getTextInputValue('color'));
      const image = parseImageUrl(interaction.fields.getTextInputValue('image'));
      client.services.config.update(interaction.guildId, { welcome: { [kind]: { title, description, color, image } } });
      const unknown = unknownVariables(`${title} ${description}`);
      const notice = [
        `${ICONS.success} **${KINDS[kind]}** enregistré.`,
        unknown.length ? `${ICONS.warning} Variable(s) inconnue(s), laissée(s) telle(s) quelle(s) : ${unknown.map((k) => `\`{${k}}\``).join(', ')}.` : null,
      ].filter(Boolean).join('\n');
      await interaction.update(messageView(client, interaction.guild, kind, notice));
    },
    /** cmd:bienvenue:preview:<join|leave|panel> — rendu éphémère pour l'administrateur. */
    async preview(interaction, client, [kind]) {
      guard(interaction);
      const cfg = cfgOf(client, interaction.guildId);
      if (kind === 'panel') {
        await interaction.reply({ embeds: [status.note('Voici le panneau tel qu\'il sera publié (avec le bouton « Me vérifier »).', 'Aperçu'), panelCard(interaction.guild, cfg.verification)], ephemeral: true });
        return;
      }
      if (!KINDS[kind]) throw new UserError('Message inconnu.');
      const vars = selfVars(interaction);
      await interaction.reply({
        embeds: [status.note(`Voici le **${KINDS[kind].toLowerCase()}** tel que vous le recevriez.`, 'Aperçu'), messageCard(kind, cfg[kind], vars)],
        ephemeral: true,
      });
    },
    /** cmd:bienvenue:test:<join|leave> — envoi réel dans le salon, au nom de l'administrateur. */
    async test(interaction, client, [kind]) {
      guard(interaction);
      if (!KINDS[kind]) throw new UserError('Message inconnu.');
      const msg = cfgOf(client, interaction.guildId)[kind];
      const state = channelState(interaction.guild, msg.channelId);
      if (state !== 'ok') throw new UserError(state === 'unset' ? 'Choisissez d\'abord un salon pour ce message.' : CHANNEL_HINTS[state]);
      await interaction.deferUpdate();
      const vars = selfVars(interaction);
      let notice;
      try {
        await interaction.guild.channels.cache.get(msg.channelId).send(messagePayload(kind, msg, vars));
        notice = `${ICONS.success} Message de test envoyé dans <#${msg.channelId}>.`;
      } catch {
        notice = `${ICONS.error} Envoi impossible dans <#${msg.channelId}> : vérifiez mes permissions.`;
      }
      await interaction.editReply(previewView(client, interaction.guild, notice));
    },
    /** cmd:bienvenue:roles:<humans|bots> — rôles automatiques (remplace la sélection). */
    async roles(interaction, client, [target]) {
      guard(interaction);
      if (!['humans', 'bots'].includes(target)) throw new UserError('Liste de rôles inconnue.');
      const guild = interaction.guild;
      const accepted = [];
      const refused = [];
      const warned = [];
      for (const id of (interaction.values ?? []).slice(0, MAX_AUTO_ROLES)) {
        if (!/^\d{17,20}$/.test(id)) continue;
        const role = guild.roles.cache.get(id);
        const issue = roleIssue(role, guild);
        if (issue) {
          refused.push(`<@&${id}> : ${issue}`);
          continue;
        }
        const danger = dangerousPermissions(role);
        if (danger.length) warned.push(`<@&${id}> confère ${danger.join(', ')}`);
        accepted.push(id);
      }
      client.services.config.update(interaction.guildId, { welcome: { autoRoles: { [target]: accepted } } });
      const notice = [
        `${ICONS.success} **${accepted.length}** rôle(s) automatique(s) pour les ${target === 'humans' ? 'humains' : 'bots'}.`,
        refused.length ? `${ICONS.error} Refusé(s) :\n${refused.join('\n')}` : null,
        warned.length ? `${ICONS.warning} **Attention**, permissions sensibles données à chaque arrivant :\n${warned.join('\n')}` : null,
      ].filter(Boolean).join('\n');
      await interaction.update(rolesView(client, guild, truncate(notice, 1500)));
    },
    /** Rôle de vérification. */
    async vrole(interaction, client) {
      guard(interaction);
      const guild = interaction.guild;
      const id = interaction.values?.[0] ?? null;
      let notice;
      if (!id) {
        client.services.config.update(interaction.guildId, { welcome: { verification: { roleId: null, enabled: false } } });
        notice = `${ICONS.success} Rôle retiré : la vérification est désactivée.`;
      } else {
        if (!/^\d{17,20}$/.test(id)) throw new UserError('Rôle invalide.');
        const role = guild.roles.cache.get(id);
        const issue = roleIssue(role, guild);
        if (issue) throw new UserError(`Ce rôle ne peut pas servir à la vérification : ${issue}.`);
        client.services.config.update(interaction.guildId, { welcome: { verification: { roleId: id } } });
        const danger = dangerousPermissions(role);
        notice = [
          `${ICONS.success} Rôle de vérification : <@&${id}>.`,
          danger.length ? `${ICONS.warning} **Attention**, ce rôle confère : ${danger.join(', ')}.` : null,
        ].filter(Boolean).join('\n');
      }
      await interaction.update(verifyView(client, guild, notice));
    },
    /** Salon du panneau de vérification. */
    async vchannel(interaction, client) {
      guard(interaction);
      const id = textChannel(interaction, interaction.values?.[0] ?? null)?.id ?? null;
      client.services.config.update(interaction.guildId, { welcome: { verification: { channelId: id } } });
      await interaction.update(verifyView(client, interaction.guild, channelNotice(interaction.guild, id, 'Salon du panneau')));
    },
    /** Ouvre le formulaire de l'âge minimal. */
    async vage(interaction, client) {
      guard(interaction);
      await interaction.showModal(ageModal(cfgOf(client, interaction.guildId).verification));
    },
    async vagesubmit(interaction, client) {
      guard(interaction);
      const raw = interaction.fields.getTextInputValue('days')?.trim();
      const days = Number(raw);
      if (!/^\d{1,3}$/.test(raw ?? '') || days > 365) throw new UserError('Âge minimal : entrez un nombre entier de jours entre 0 et 365.');
      client.services.config.update(interaction.guildId, { welcome: { verification: { minAccountAgeDays: days } } });
      await interaction.update(verifyView(client, interaction.guild, `${ICONS.success} Âge minimal du compte : **${days ? `${days} jour(s)` : 'aucun'}**.`));
    },
    /** Publie (ou republie) le panneau public de vérification. */
    async publish(interaction, client) {
      guard(interaction);
      const guild = interaction.guild;
      const v = cfgOf(client, interaction.guildId).verification;
      if (!v.roleId) throw new UserError('Choisissez d\'abord le rôle de vérification.');
      const issue = roleIssue(guild.roles.cache.get(v.roleId), guild);
      if (issue) throw new UserError(`Le rôle de vérification est inutilisable : ${issue}.`);
      const state = channelState(guild, v.channelId);
      if (state !== 'ok') throw new UserError(state === 'unset' ? 'Choisissez d\'abord le salon du panneau.' : CHANNEL_HINTS[state]);
      await interaction.deferUpdate();
      const channel = guild.channels.cache.get(v.channelId);
      const message = await channel.send({
        embeds: [panelCard(guild, v)],
        components: buttonRows(actionButton({ command: 'bienvenue', action: 'verify', label: 'Me vérifier', emoji: ICONS.success, style: ButtonStyle.Success })),
        allowedMentions: { parse: [] },
      });
      // Ancien panneau du bot : supprimé pour éviter les doublons.
      if (v.panelMessageId && v.panelMessageId !== message.id) {
        await guild.channels.cache.get(v.panelChannelId)?.messages?.delete?.(v.panelMessageId).catch(() => {});
      }
      client.services.config.update(interaction.guildId, { welcome: { verification: { panelChannelId: channel.id, panelMessageId: message.id } } });
      const notice = [
        `${ICONS.success} Panneau publié dans ${channel}.`,
        v.enabled ? null : `${ICONS.warning} La vérification est **désactivée** : activez-la pour que le bouton fonctionne.`,
      ].filter(Boolean).join('\n');
      await interaction.editReply(verifyView(client, guild, notice));
    },

    // ------------------------------------------------------------ public

    /** cmd:bienvenue:verify — bouton PUBLIC du panneau (aucune permission requise). */
    async verify(interaction, client) {
      const member = await fullMember(interaction);
      const svc = client.services.welcome;
      svc.assertCanVerify(member);
      if (cfgOf(client, interaction.guildId).verification.captcha) {
        const { label } = svc.createChallenge(interaction.guildId, interaction.user.id);
        await interaction.showModal(captchaModal(label));
        return;
      }
      await completeVerification(interaction, client, member, false);
    },
    /** Réponse à la question anti-robot (comparée au défi gardé en mémoire). */
    async verifysubmit(interaction, client) {
      const svc = client.services.welcome;
      const result = svc.checkChallenge(interaction.guildId, interaction.user.id, interaction.fields.getTextInputValue('answer'));
      if (result === 'locked') {
        throw new UserError('Trop de mauvaises réponses. Patientez quelques minutes avant de réessayer.');
      }
      if (result === 'expired') throw new UserError('Cette question a expiré. Cliquez à nouveau sur « Me vérifier ».');
      if (result === 'wrong') throw new UserError('Réponse incorrecte. Cliquez à nouveau sur « Me vérifier » pour obtenir une nouvelle question.');
      const member = await fullMember(interaction);
      svc.assertCanVerify(member);
      await completeVerification(interaction, client, member, true);
    },
  },
};
