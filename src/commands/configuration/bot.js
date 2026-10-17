'use strict';

const { SlashCommandBuilder, PermissionFlagsBits, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } = require('discord.js');
const { card, field, wide, ICONS, code, subtext, status, actionButton, labelButton, buttonRows, ButtonStyle } = require('../../utils/ui');
const { truncate } = require('../../utils/embeds');
const { safeName } = require('../../utils/safeText');
const { formatDuration } = require('../../utils/time');
const { UserError } = require('../../core/errors');
const { BOT_ACTIVITY_TYPES, TYPE_LABELS, STATUS_LABELS, MAX_TEXT, parseStreamUrl, cleanActivityText } = require('../../utils/presence');
const { assertImageAttachment } = require('../../services/BotProfileService');
const { createLogger } = require('../../core/logger');

const logger = createLogger('bot-console');

/**
 * /bot — console des PROPRIÉTAIRES du bot (OWNER_IDS) : nom, avatar, bannière, activité,
 * statut, rotation, serveurs, quitter un serveur, infos.
 *
 * Commande de SERVEUR (`scope: 'owner'`) : enregistrée UNIQUEMENT sur OWNER_GUILD_ID par
 * scripts/deploy-commands.js, jamais globalement. Défense en profondeur : chaque exécution,
 * bouton, formulaire et autocomplétion revérifie OWNER_IDS et, si OWNER_GUILD_ID est réglé,
 * que l'interaction vient bien de ce serveur. L'autocomplétion ne passe pas par le contrôle
 * commun (interactionCreate) : elle le refait elle-même.
 * Réglage d'instance : aucun log de serveur, seulement le journal du bot.
 */

const SECTION = { emoji: ICONS.bot, label: 'Console du bot' };
const PER_PAGE = 10;
const STATUS_CHOICES = Object.freeze({ en_ligne: 'online', inactif: 'idle', ne_pas_deranger: 'dnd', invisible: 'invisible' });
const ACTIVITY_CHOICES = [
  { name: 'Joue à', value: 'joue' },
  { name: 'Regarde', value: 'regarde' },
  { name: 'Écoute', value: 'ecoute' },
  { name: 'Participe à', value: 'participe' },
  { name: 'En direct (stream Twitch ou YouTube)', value: 'stream' },
  { name: 'Statut personnalisé', value: 'personnalise' },
];
const SNOWFLAKE = /^\d{17,20}$/;

/**
 * Accès à la console : propriétaire du bot, Administrateur, et (si OWNER_GUILD_ID est réglé)
 * interaction venue de ce serveur. Lève une UserError.
 */
function assertOwner(interaction, client, { requireAdmin = true } = {}) {
  if (!client.config.ownerIds.includes(interaction.user?.id)) throw new UserError('Cette console est réservée aux propriétaires du bot.');
  const ownerGuild = client.config.ownerGuildId;
  if (ownerGuild && interaction.guildId !== ownerGuild) throw new UserError('Cette console ne s\'utilise que sur le serveur des propriétaires (OWNER_GUILD_ID).');
  if (requireAdmin && interaction.inGuild?.() && !interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    throw new UserError('Il faut la permission **Administrateur** pour utiliser cette console.');
  }
}

/** Accès sans lever (autocomplétion). */
function isOwnerContext(interaction, client) {
  try {
    assertOwner(interaction, client);
    return true;
  } catch {
    return false;
  }
}

/** Libellé lisible de l'activité affichée. */
function activityLabel(activity) {
  if (!activity) return '*Aucune*';
  const label = TYPE_LABELS[activity.type] ?? 'Activité';
  return `${label} · ${truncate(activity.text, 100)}${activity.url ? `\n${subtext(truncate(activity.url, 120))}` : ''}`;
}

const SOURCE_LABELS = { bot: 'Imposée par /bot', env: 'PRESENCE_STATUSES (.env)', defaut: 'Statuts par défaut' };

/** Carte « infos » de la console. */
function infoView(client) {
  const profile = client.services.botProfile;
  const settings = profile.presenceSettings();
  const source = profile.presenceSource();
  const override = profile.presenceOverride();
  const members = client.guilds.cache.reduce((n, g) => n + (g.memberCount || 0), 0);
  const ownerGuild = client.config.ownerGuildId;
  return {
    embeds: [
      card({
        tone: 'brand',
        section: SECTION,
        icon: ICONS.bot,
        title: safeName(client.user.username),
        description: [
          'Réglages de l\'instance : ils s\'appliquent à **tous** les serveurs.',
          subtext('Profil propre à un serveur : /settings profil (sur ce serveur).'),
        ],
        thumbnail: client.user.displayAvatarURL?.({ size: 256 }) ?? null,
        fields: [
          field(ICONS.id, 'Identifiant', code(client.user.id)),
          field(ICONS.server, 'Serveurs', `**${client.guilds.cache.size}**`),
          field(ICONS.members, 'Membres', `**${members.toLocaleString('fr-FR')}**`),
          field(ICONS.status, 'Statut', STATUS_LABELS[settings.status] ?? STATUS_LABELS.online),
          field(ICONS.refresh, 'Statuts affichés', `${SOURCE_LABELS[source]}\n${subtext(`${settings.statuses.length} statut(s) · toutes les ${Math.round(settings.intervalMs / 60_000)} min`)}`),
          field(ICONS.duration, 'Disponibilité', code(formatDuration(client.uptime ?? 0))),
          wide('🎮', 'Activité imposée', override?.activity ? activityLabel(override.activity) : '*Aucune : la rotation des statuts s\'applique.*'),
          field(ICONS.owner, 'Serveur propriétaire', ownerGuild ? code(ownerGuild) : '*Non défini (OWNER_GUILD_ID)*'),
          field(ICONS.image, 'Téléchargements CDN', client.config.cdnNetwork !== false ? '🟢 Activés' : '🔴 Désactivés (CDN_NETWORK=off)'),
          field(ICONS.rocket, 'Version', code(`v${client.config.version}`)),
        ],
        footer: 'Console des propriétaires',
      }),
    ],
    components: buttonRows(
      actionButton({ command: 'bot', action: 'info', label: 'Actualiser', emoji: ICONS.refresh, style: ButtonStyle.Primary }),
      actionButton({ command: 'bot', action: 'servers', args: [1], label: 'Serveurs', emoji: ICONS.server }),
      override?.activity ? actionButton({ command: 'bot', action: 'rotation', label: 'Reprendre la rotation', emoji: ICONS.refresh }) : null,
    ),
  };
}

/** Serveurs du bot, les plus grands d'abord. */
function sortedGuilds(client) {
  return [...client.guilds.cache.values()].sort((a, b) => (b.memberCount || 0) - (a.memberCount || 0) || a.id.localeCompare(b.id));
}

/** Page de la liste des serveurs (1-indexée, bornée). */
function serversView(client, page = 1) {
  const guilds = sortedGuilds(client);
  const pages = Math.max(1, Math.ceil(guilds.length / PER_PAGE));
  const p = Math.min(Math.max(1, Number.parseInt(page, 10) || 1), pages);
  const ownerGuild = client.config.ownerGuildId;
  const lines = guilds.slice((p - 1) * PER_PAGE, p * PER_PAGE).map((g, i) => {
    const rank = (p - 1) * PER_PAGE + i + 1;
    return `**${rank}.** ${safeName(truncate(g.name, 80))} · ${code(g.id)} · ${(g.memberCount || 0).toLocaleString('fr-FR')} membres${g.id === ownerGuild ? ` · ${ICONS.owner}` : ''}`;
  });
  return {
    embeds: [
      card({
        tone: 'brand',
        section: SECTION,
        icon: ICONS.server,
        title: `Serveurs du bot · ${guilds.length}`,
        description: [lines.join('\n') || '*Aucun serveur.*', '', subtext('Quitter un serveur : /bot quitter (confirmation par son nom).')],
        footer: `Page ${p}/${pages}`,
      }),
    ],
    components: buttonRows(
      actionButton({ command: 'bot', action: 'servers', args: [p - 1], emoji: ICONS.back, disabled: p <= 1 }),
      labelButton(`Page ${p}/${pages}`),
      actionButton({ command: 'bot', action: 'servers', args: [p + 1], emoji: ICONS.next, disabled: p >= pages }),
      actionButton({ command: 'bot', action: 'info', label: 'Infos', emoji: ICONS.info }),
    ),
  };
}

/** Serveur que l'on peut quitter (existe, n'est pas OWNER_GUILD_ID). Lève une UserError. */
function leavableGuild(client, guildId) {
  if (!SNOWFLAKE.test(String(guildId ?? ''))) throw new UserError('Indiquez l\'identifiant d\'un serveur (choisissez-le dans la liste proposée).');
  if (client.config.ownerGuildId && guildId === client.config.ownerGuildId) throw new UserError('Impossible de quitter le serveur des propriétaires (OWNER_GUILD_ID).');
  const guild = client.guilds.cache.get(guildId);
  if (!guild) throw new UserError('Je ne suis pas sur ce serveur.');
  return guild;
}

/** Formulaire de confirmation : taper le nom exact du serveur. */
function leaveModal(guild) {
  return new ModalBuilder()
    .setCustomId(`cmd:bot:leave:${guild.id}`)
    .setTitle('Quitter un serveur')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('nom')
          .setLabel('Nom exact du serveur, pour confirmer')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(100)
          .setPlaceholder(truncate(guild.name, 100)),
      ),
    );
}

/** Activité saisie → { type, text, url? }. Lève une UserError. Pur. */
function readActivity(choice, rawText, rawUrl) {
  const type = BOT_ACTIVITY_TYPES[choice];
  if (type === undefined) throw new UserError('Type d\'activité inconnu.');
  const text = cleanActivityText(rawText);
  if (!text) throw new UserError('Le texte de l\'activité ne peut pas être vide.');
  if (text.length > MAX_TEXT) throw new UserError(`Le texte de l'activité fait au plus ${MAX_TEXT} caractères.`);
  if (choice === 'stream') {
    const url = parseStreamUrl(rawUrl);
    if (!url) throw new UserError('Un stream demande une `url` https vers une chaîne ou une vidéo **twitch.tv** ou **youtube.com**.');
    return { type, text, url };
  }
  if (rawUrl) throw new UserError('L\'option `url` ne sert qu\'au type « En direct (stream) ».');
  return { type, text };
}

module.exports = {
  category: 'configuration',
  scope: 'owner',
  ownerOnly: true,
  autoDelete: false,
  assertOwner,
  readActivity,
  serversView,
  data: new SlashCommandBuilder()
    .setName('bot')
    .setDescription('Console des propriétaires : identité, présence et serveurs du bot.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand((s) => s.setName('nom').setDescription('Change le nom global du bot.')
      .addStringOption((o) => o.setName('nom').setDescription('Nouveau nom du bot (2 à 32 caractères)').setRequired(true).setMinLength(2).setMaxLength(32)))
    .addSubcommand((s) => s.setName('avatar').setDescription('Change l\'avatar global du bot.')
      .addAttachmentOption((o) => o.setName('image').setDescription('Image PNG, JPEG, GIF ou WebP (8 Mo au plus)').setRequired(true)))
    .addSubcommand((s) => s.setName('banniere').setDescription('Change la bannière globale du bot.')
      .addAttachmentOption((o) => o.setName('image').setDescription('Image PNG, JPEG, GIF ou WebP (8 Mo au plus)').setRequired(true)))
    .addSubcommand((s) => s.setName('activite').setDescription('Impose une activité (prioritaire sur la rotation des statuts).')
      .addStringOption((o) => o.setName('type').setDescription('Type d\'activité affiché').setRequired(true).addChoices(...ACTIVITY_CHOICES))
      .addStringOption((o) => o.setName('texte').setDescription('Texte affiché (128 caractères au plus)').setRequired(true).setMaxLength(MAX_TEXT))
      .addStringOption((o) => o.setName('url').setDescription('Lien du stream (twitch.tv ou youtube.com), pour le type stream').setMaxLength(512)))
    .addSubcommand((s) => s.setName('statut').setDescription('Change le statut en ligne du bot.')
      .addStringOption((o) => o.setName('statut').setDescription('Statut affiché').setRequired(true).addChoices(
        { name: 'En ligne', value: 'en_ligne' },
        { name: 'Inactif', value: 'inactif' },
        { name: 'Ne pas déranger', value: 'ne_pas_deranger' },
        { name: 'Invisible', value: 'invisible' },
      )))
    .addSubcommand((s) => s.setName('rotation').setDescription('Retire l\'activité imposée : la rotation des statuts reprend.'))
    .addSubcommand((s) => s.setName('serveurs').setDescription('Liste les serveurs du bot.')
      .addIntegerOption((o) => o.setName('page').setDescription('Numéro de page de la liste').setMinValue(1)))
    .addSubcommand((s) => s.setName('quitter').setDescription('Fait quitter un serveur au bot (confirmation par son nom).')
      .addStringOption((o) => o.setName('serveur').setDescription('Serveur à quitter (nom ou identifiant)').setRequired(true).setAutocomplete(true).setMaxLength(100)))
    .addSubcommand((s) => s.setName('infos').setDescription('Affiche l\'état du bot : présence, serveurs, réglages.')),

  /** @param {import('discord.js').ChatInputCommandInteraction} interaction */
  async execute(interaction, client) {
    assertOwner(interaction, client);
    const sub = interaction.options.getSubcommand();
    const profile = client.services.botProfile;

    if (sub === 'infos') return interaction.reply({ ...infoView(client), ephemeral: true });
    if (sub === 'serveurs') return interaction.reply({ ...serversView(client, interaction.options.getInteger('page') ?? 1), ephemeral: true });

    if (sub === 'quitter') {
      const guild = leavableGuild(client, interaction.options.getString('serveur', true).trim());
      return interaction.showModal(leaveModal(guild));
    }

    if (sub === 'nom') {
      const name = interaction.options.getString('nom', true);
      await interaction.deferReply({ ephemeral: true });
      const saved = await profile.setUsername(name, interaction.user.id);
      return interaction.editReply({ embeds: [status.ok(`Mon nom global est désormais **${safeName(saved)}** (sur tous les serveurs).`, 'Nom changé')] });
    }

    if (sub === 'avatar' || sub === 'banniere') {
      const attachment = interaction.options.getAttachment('image', true);
      assertImageAttachment(attachment);
      await interaction.deferReply({ ephemeral: true });
      await profile.setGlobalImage(sub === 'banniere' ? 'banner' : 'avatar', attachment.url, interaction.user.id);
      return interaction.editReply({ embeds: [status.ok(sub === 'avatar' ? 'Mon avatar global a été mis à jour.' : 'Ma bannière globale a été mise à jour.', sub === 'avatar' ? 'Avatar changé' : 'Bannière changée')] });
    }

    if (sub === 'activite') {
      const activity = readActivity(interaction.options.getString('type', true), interaction.options.getString('texte', true), interaction.options.getString('url'));
      profile.setActivity(activity, interaction.user.id);
      return interaction.reply({
        embeds: [status.ok(`Activité imposée : **${activityLabel(activity)}**.\n${subtext('Elle remplace la rotation des statuts, y compris après un redémarrage. /bot rotation pour la retirer.')}`, 'Activité changée')],
        components: buttonRows(actionButton({ command: 'bot', action: 'rotation', label: 'Reprendre la rotation', emoji: ICONS.refresh })),
        ephemeral: true,
      });
    }

    if (sub === 'statut') {
      const value = STATUS_CHOICES[interaction.options.getString('statut', true)];
      if (!value) throw new UserError('Statut inconnu.');
      profile.setStatus(value, interaction.user.id);
      return interaction.reply({ embeds: [status.ok(`Statut : **${STATUS_LABELS[value]}**.`, 'Statut changé')], ephemeral: true });
    }

    if (sub === 'rotation') {
      profile.clearActivity(interaction.user.id);
      const source = profile.presenceSource();
      return interaction.reply({ embeds: [status.ok(`La rotation des statuts reprend (${SOURCE_LABELS[source]}).`, 'Rotation des statuts')], ephemeral: true });
    }
    throw new UserError('Sous-commande inconnue.');
  },

  /**
   * Autocomplétion de /bot quitter : ne passe PAS par le contrôle commun des commandes
   * (interactionCreate) → OWNER_IDS et la provenance sont revérifiés ICI. Liste vide sinon.
   * @param {import('discord.js').AutocompleteInteraction} interaction
   */
  async autocomplete(interaction, client) {
    if (!isOwnerContext(interaction, client)) return interaction.respond([]);
    const focused = String(interaction.options.getFocused() ?? '').toLowerCase().trim();
    const ownerGuild = client.config.ownerGuildId;
    const choices = sortedGuilds(client)
      .filter((g) => g.id !== ownerGuild && (!focused || g.id.includes(focused) || g.name.toLowerCase().includes(focused)))
      .slice(0, 25)
      .map((g) => ({ name: truncate(`${g.name} · ${g.memberCount || 0} membres · ${g.id}`, 100), value: g.id }));
    return interaction.respond(choices);
  },

  buttons: {
    /** cmd:bot:info — carte d'état (actualise). */
    async info(interaction, client) {
      assertOwner(interaction, client);
      await interaction.update(infoView(client));
    },
    /** cmd:bot:servers:<page> — liste paginée des serveurs. */
    async servers(interaction, client, [page]) {
      assertOwner(interaction, client);
      await interaction.update(serversView(client, page));
    },
    /** cmd:bot:rotation — retire l'activité imposée (réponse éphémère). */
    async rotation(interaction, client) {
      assertOwner(interaction, client);
      client.services.botProfile.clearActivity(interaction.user.id);
      await interaction.reply({ embeds: [status.ok(`La rotation des statuts reprend (${SOURCE_LABELS[client.services.botProfile.presenceSource()]}).`, 'Rotation des statuts')], ephemeral: true });
    },
    /** cmd:bot:leave:<guildId> — formulaire de confirmation (nom exact du serveur), puis départ. */
    async leave(interaction, client, [guildId]) {
      assertOwner(interaction, client);
      if (!interaction.isModalSubmit?.()) throw new UserError('Utilisez /bot quitter.');
      const guild = leavableGuild(client, guildId);
      const typed = String(interaction.fields.getTextInputValue('nom') ?? '').trim();
      if (typed !== guild.name.trim()) throw new UserError('Le nom saisi ne correspond pas exactement au nom du serveur : je reste.');
      await interaction.deferReply({ ephemeral: true });
      const name = guild.name;
      await guild.leave();
      logger.info(`Serveur quitté sur demande de ${interaction.user.id} : ${guild.id} (${name}).`);
      await interaction.editReply({ embeds: [status.ok(`J'ai quitté **${safeName(truncate(name, 100))}** (${code(guildId)}).`, 'Serveur quitté')] });
    },
  },
};
