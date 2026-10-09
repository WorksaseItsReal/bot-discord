'use strict';

const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  ChannelSelectMenuBuilder,
  RoleSelectMenuBuilder,
} = require('discord.js');
const { card, field, wide, ICONS, code, subtext, actionButton, deleteButton, labelButton, buttonRows, ButtonStyle } = require('../../utils/ui');
const { truncate } = require('../../utils/embeds');
const { isValidDayMonth, daysInMonth, formatDayMonth, MONTHS } = require('../../utils/calendar');
const { requirePermission } = require('../../services/ModerationService');
const { ANNOUNCE_CHANNEL_TYPES, channelIssue } = require('../../services/AnnouncementService');
const { roleIssue } = require('../../services/TempRoleService');
const { DEFAULT_MESSAGE, VARIABLES, shownAge, renderBirthday, unknownVariables, birthdayCard, upcoming } = require('../../services/BirthdayService');
const { canonicalTimeZone } = require('./annonce');
const { UserError } = require('../../core/errors');

/**
 * /anniversaire definir · retirer · liste (tout le monde) · config (« Gérer le serveur »).
 * L'année de naissance est facultative et n'est JAMAIS affichée sans l'accord du membre.
 */

const PER_PAGE = 10;
const SNOWFLAKE = /^\d{17,20}$/;
const guard = (interaction) => requirePermission(interaction, 'ManageGuild');
const cfgOf = (client, guildId) => client.services.config.get(guildId).birthdays ?? {};
const row = (component) => new ActionRowBuilder().addComponents(component);

/** « dans 3 jours » / « aujourd'hui » / « demain ». Pur. */
function inDaysLabel(n) {
  if (n === 0) return '🎉 **aujourd\'hui**';
  if (n === 1) return 'demain';
  return `dans ${n} jours`;
}

/** Page de la liste des prochains anniversaires (membres encore présents). */
function listView(client, guild, entries, page, ownerId) {
  const pages = Math.max(1, Math.ceil(entries.length / PER_PAGE));
  const current = Math.min(Math.max(0, Number(page) || 0), pages - 1);
  const slice = entries.slice(current * PER_PAGE, (current + 1) * PER_PAGE);
  const lines = slice.map(({ row: r, next }) => {
    const age = shownAge(r, next.year);
    return `🎂 **${formatDayMonth(next.day, next.month)}** · <@${r.user_id}> · ${inDaysLabel(next.inDays)}${age ? ` · ${age} ans` : ''}`;
  });
  const tz = client.services.birthdays.timeZone(guild.id);
  return {
    embeds: [
      card({
        tone: 'celebrate',
        section: 'utility',
        icon: '🎂',
        title: 'Prochains anniversaires',
        description: [
          lines.length ? lines.join('\n') : '*Aucun anniversaire enregistré. Ajoutez le vôtre avec `/anniversaire definir`.*',
          '',
          subtext('L\'âge n\'apparaît que pour les membres qui ont accepté de le montrer.'),
        ],
        fields: [field(ICONS.count, 'Enregistrés', `**${entries.length}**`), field(ICONS.time, 'Fuseau', code(tz)), field('📄', 'Page', `${current + 1} / ${pages}`)],
      }),
    ],
    components: buttonRows(
      pages > 1 ? actionButton({ command: 'anniversaire', action: 'page', args: [Math.max(0, current - 1), ownerId], emoji: ICONS.back, disabled: current === 0 }) : null,
      pages > 1 ? labelButton(`Page ${current + 1} / ${pages}`, `cmd:_:noop:bday${current}`) : null,
      pages > 1 ? actionButton({ command: 'anniversaire', action: 'page', args: [current + 1, ownerId], emoji: ICONS.next, disabled: current >= pages - 1 }) : null,
      deleteButton(ownerId),
    ),
  };
}

/** Anniversaires des membres encore présents, triés à partir d'aujourd'hui (fuseau du serveur). */
async function upcomingEntries(client, guild) {
  const rows = client.repositories.birthdays.all(guild.id);
  const present = await client.services.birthdays.presentMembers(guild, rows.map((r) => r.user_id));
  return upcoming(rows.filter((r) => present.has(r.user_id)), client.services.birthdays.today(guild.id));
}

/** Tableau de bord de configuration (éphémère). */
function configView(client, guild, notice = null) {
  const cfg = cfgOf(client, guild.id);
  const tz = client.services.birthdays.timeZone(guild.id);
  const channelState = cfg.channelId ? channelIssue(guild, cfg.channelId) : null;
  const role = cfg.roleId ? guild.roles.cache.get(cfg.roleId) : null;
  const roleState = cfg.roleId ? (role ? roleIssue(guild, role) : 'Ce rôle a été supprimé.') : null;
  const sample = renderBirthday(cfg.message, { id: null, name: 'Membre', server: guild.name, age: 25 });
  const channelMenu = new ChannelSelectMenuBuilder().setCustomId('cmd:anniversaire:cchannel').setPlaceholder('Salon des messages d\'anniversaire…').setChannelTypes(...ANNOUNCE_CHANNEL_TYPES).setMinValues(0).setMaxValues(1);
  if (cfg.channelId && guild.channels.cache.has(cfg.channelId)) channelMenu.setDefaultChannels(cfg.channelId);
  const roleMenu = new RoleSelectMenuBuilder().setCustomId('cmd:anniversaire:crole').setPlaceholder('Rôle « anniversaire » (porté 24 h)…').setMinValues(0).setMaxValues(1);
  if (role) roleMenu.setDefaultRoles(role.id);
  return {
    embeds: [
      card({
        tone: cfg.enabled ? 'success' : 'neutral',
        section: 'utility',
        icon: '🎂',
        title: 'Anniversaires · Configuration',
        description: [
          notice ? `${notice}\n` : null,
          cfg.enabled ? '🟢 Les anniversaires sont **fêtés**.' : '🔴 Les anniversaires ne sont **pas fêtés**.',
          `${ICONS.members} **${client.repositories.birthdays.count(guild.id)}** anniversaire(s) enregistré(s).`,
          '',
          subtext('Un message par membre et par jour, à l\'heure choisie (fuseau du serveur). Le 29 février est fêté le 28 les années non bissextiles.'),
        ],
        fields: [
          field(ICONS.channel, 'Salon', cfg.channelId ? `<#${cfg.channelId}>${channelState ? `\n${ICONS.warning} ${channelState}` : ''}` : '*Aucun message*'),
          field(ICONS.role, 'Rôle (24 h)', cfg.roleId ? `<@&${cfg.roleId}>${roleState ? `\n${ICONS.warning} ${roleState}` : ''}` : '*Aucun*'),
          field(ICONS.time, 'Fuseau · heure', `${code(tz)}\n${String(cfg.hour ?? 0).padStart(2, '0')} h 00`),
          wide('📝', 'Message (aperçu, 25 ans)', truncate(sample, 1000)),
        ],
        footer: `Variables : ${Object.keys(VARIABLES).map((k) => `{${k}}`).join(' ')}`,
      }),
    ],
    components: [
      row(channelMenu),
      row(roleMenu),
      ...buttonRows(
        cfg.enabled
          ? actionButton({ command: 'anniversaire', action: 'ctoggle', args: ['off'], label: 'Désactiver', emoji: '🔴', style: ButtonStyle.Danger })
          : actionButton({ command: 'anniversaire', action: 'ctoggle', args: ['on'], label: 'Activer', emoji: '🟢', style: ButtonStyle.Success }),
        actionButton({ command: 'anniversaire', action: 'cmessage', label: 'Message', emoji: '📝', style: ButtonStyle.Primary }),
        actionButton({ command: 'anniversaire', action: 'ctime', label: 'Fuseau et heure', emoji: ICONS.time }),
        actionButton({ command: 'anniversaire', action: 'cpreview', label: 'Aperçu', emoji: '👁️' }),
        actionButton({ command: 'anniversaire', action: 'crefresh', label: 'Actualiser', emoji: ICONS.refresh }),
      ),
    ],
  };
}

const input = (id, label, { value, style = TextInputStyle.Short, max = 100, required = false, placeholder } = {}) => {
  const t = new TextInputBuilder().setCustomId(id).setLabel(label.slice(0, 45)).setStyle(style).setMaxLength(max).setRequired(required);
  if (value != null && String(value) !== '') t.setValue(String(value).slice(0, max));
  if (placeholder) t.setPlaceholder(placeholder.slice(0, 100));
  return row(t);
};

function textField(interaction, id) {
  try {
    return interaction.fields.getTextInputValue(id)?.trim() || null;
  } catch {
    return null;
  }
}

/** Valeur voulue par un bouton « on/off ». */
function target(state) {
  if (state !== 'on' && state !== 'off') throw new UserError('Ce bouton est invalide.');
  return state === 'on';
}

/** Le rôle « anniversaire » est-il acceptable (bot ET auteur, pas de permission sensible) ? */
function assertBirthdayRole(interaction, roleId) {
  const guild = interaction.guild;
  const role = guild.roles.cache.get(roleId);
  const issue = roleIssue(guild, role);
  if (issue) throw new UserError(issue);
  if (interaction.user.id !== guild.ownerId && role.position >= (interaction.member?.roles?.highest?.position ?? 0)) {
    throw new UserError(`Le rôle ${role.name} est au-dessus (ou au niveau) de votre rôle le plus haut.`);
  }
  return role;
}

module.exports = {
  category: 'utility',
  cooldown: 3_000,
  inDaysLabel,
  configView,
  data: new SlashCommandBuilder()
    .setName('anniversaire')
    .setDescription('Anniversaires des membres : enregistrer le vôtre, voir les prochains, configurer.')
    .addSubcommand((s) =>
      s.setName('definir').setDescription('Enregistre votre date d\'anniversaire.')
        .addIntegerOption((o) => o.setName('jour').setDescription('Jour (1 à 31)').setRequired(true).setMinValue(1).setMaxValue(31))
        .addIntegerOption((o) => o.setName('mois').setDescription('Mois').setRequired(true)
          .addChoices(...MONTHS.map((name, i) => ({ name, value: i + 1 }))))
        .addIntegerOption((o) => o.setName('annee').setDescription('Année de naissance (facultative, jamais affichée sans votre accord)').setMinValue(1900).setMaxValue(2100))
        .addBooleanOption((o) => o.setName('afficher_age').setDescription('Montrer votre âge aux autres membres (défaut : non)')))
    .addSubcommand((s) => s.setName('retirer').setDescription('Supprime votre date d\'anniversaire de ce serveur.'))
    .addSubcommand((s) => s.setName('liste').setDescription('Affiche les prochains anniversaires.'))
    .addSubcommand((s) => s.setName('config').setDescription('Configure les anniversaires (salon, message, rôle, fuseau).')),

  async execute(interaction, client) {
    const sub = interaction.options.getSubcommand();
    const guild = interaction.guild;
    const repo = client.repositories.birthdays;

    if (sub === 'definir') {
      const day = interaction.options.getInteger('jour');
      const month = interaction.options.getInteger('mois');
      const year = interaction.options.getInteger('annee');
      const showAge = interaction.options.getBoolean('afficher_age') ?? false;
      if (!isValidDayMonth(day, month)) throw new UserError(`Le ${day} ${MONTHS[month - 1] ?? '?'} n'existe pas.`);
      if (year != null) {
        const today = client.services.birthdays.today(guild.id);
        if (day > daysInMonth(year, month)) throw new UserError(`Le ${formatDayMonth(day, month, year)} n'existe pas.`);
        if (year > today.year || (year === today.year && (month > today.month || (month === today.month && day >= today.day)))) {
          throw new UserError('Cette date de naissance est dans le futur.');
        }
      }
      repo.set({ guildId: guild.id, userId: interaction.user.id, day, month, year, showAge: showAge && year != null });
      client.services.birthdays.invalidate(guild.id);
      const cfg = cfgOf(client, guild.id);
      return interaction.reply({
        embeds: [
          card({
            tone: 'celebrate',
            section: 'utility',
            icon: '🎂',
            title: 'Anniversaire enregistré',
            description: [
              `Votre anniversaire : **${formatDayMonth(day, month)}**.`,
              day === 29 && month === 2 ? subtext('Les années non bissextiles, il sera fêté le 28 février.') : null,
              cfg.enabled ? null : subtext('Les anniversaires ne sont pas encore fêtés sur ce serveur (un administrateur peut les activer).'),
            ],
            fields: [
              field(ICONS.date, 'Date', formatDayMonth(day, month)),
              field(ICONS.count, 'Année', year != null ? `${year}\n${subtext('visible par vous seul ici')}` : '*Non renseignée*'),
              field(ICONS.visible, 'Âge affiché', showAge && year != null ? 'Oui' : 'Non'),
            ],
          }),
        ],
        ephemeral: true,
      });
    }

    if (sub === 'retirer') {
      const removed = repo.delete(guild.id, interaction.user.id);
      if (!removed) throw new UserError('Aucun anniversaire enregistré pour vous sur ce serveur.');
      await client.services.birthdays.dropRole(guild, removed);
      return interaction.reply({ embeds: [card({ tone: 'neutral', section: 'utility', icon: ICONS.delete, title: 'Anniversaire supprimé', description: 'Votre date d\'anniversaire a été effacée de ce serveur.' })], ephemeral: true });
    }

    if (sub === 'liste') {
      await interaction.deferReply();
      const entries = await upcomingEntries(client, guild);
      return interaction.editReply(listView(client, guild, entries, 0, interaction.user.id));
    }

    // config
    guard(interaction);
    return interaction.reply({ ...configView(client, guild), ephemeral: true });
  },

  buttons: {
    /** cmd:anniversaire:page:<page>:<ownerId> */
    async page(interaction, client, [page, ownerId]) {
      if (!SNOWFLAKE.test(ownerId ?? '')) throw new UserError('Ce bouton est invalide.');
      await interaction.deferUpdate();
      const entries = await upcomingEntries(client, interaction.guild);
      await interaction.editReply(listView(client, interaction.guild, entries, Number(page) || 0, ownerId));
    },
    async crefresh(interaction, client) {
      guard(interaction);
      await interaction.update(configView(client, interaction.guild));
    },
    /** cmd:anniversaire:ctoggle:<on|off> */
    async ctoggle(interaction, client, [state]) {
      guard(interaction);
      const enabled = target(state);
      client.services.config.update(interaction.guildId, { birthdays: { enabled } });
      client.services.birthdays.invalidate(interaction.guildId);
      await interaction.update(configView(client, interaction.guild, `${ICONS.success} Anniversaires **${enabled ? 'activés' : 'désactivés'}**.`));
    },
    async cchannel(interaction, client) {
      guard(interaction);
      const id = interaction.values?.[0] ?? null;
      let notice = `${ICONS.success} Plus de message d'anniversaire (le rôle reste attribué s'il est configuré).`;
      if (id) {
        if (!SNOWFLAKE.test(id)) throw new UserError('Salon invalide.');
        const channel = interaction.guild.channels.cache.get(id);
        if (!channel || !ANNOUNCE_CHANNEL_TYPES.includes(channel.type)) throw new UserError('Choisissez un salon textuel du serveur.');
        const issue = channelIssue(interaction.guild, id);
        notice = issue ? `${ICONS.warning} Salon enregistré, mais ${issue}.` : `${ICONS.success} Messages d'anniversaire dans <#${id}>.`;
      }
      client.services.config.update(interaction.guildId, { birthdays: { channelId: id } });
      client.services.birthdays.invalidate(interaction.guildId);
      await interaction.update(configView(client, interaction.guild, notice));
    },
    async crole(interaction, client) {
      guard(interaction);
      const id = interaction.values?.[0] ?? null;
      if (id) {
        if (!SNOWFLAKE.test(id)) throw new UserError('Rôle invalide.');
        assertBirthdayRole(interaction, id);
      }
      client.services.config.update(interaction.guildId, { birthdays: { roleId: id } });
      await interaction.update(configView(client, interaction.guild, id ? `${ICONS.success} <@&${id}> sera porté 24 h le jour de l'anniversaire.` : `${ICONS.success} Rôle d'anniversaire retiré.`));
    },
    async cmessage(interaction, client) {
      guard(interaction);
      const cfg = cfgOf(client, interaction.guildId);
      await interaction.showModal(new ModalBuilder().setCustomId('cmd:anniversaire:cmessagesubmit').setTitle('Message d\'anniversaire').addComponents(
        input('message', 'Message ({membre}, {age}, {pseudo}…)', { value: cfg.message || DEFAULT_MESSAGE, style: TextInputStyle.Paragraph, max: 1000, placeholder: DEFAULT_MESSAGE }),
      ));
    },
    async cmessagesubmit(interaction, client) {
      guard(interaction);
      const text = textField(interaction, 'message');
      const unknown = unknownVariables(text);
      if (unknown.length) throw new UserError(`Variable(s) inconnue(s) : ${unknown.map((k) => `\`{${k}}\``).join(', ')}. Disponibles : ${Object.keys(VARIABLES).map((k) => `\`{${k}}\``).join(', ')}.`);
      const message = !text || text === DEFAULT_MESSAGE ? null : text;
      client.services.config.update(interaction.guildId, { birthdays: { message } });
      await interaction.update(configView(client, interaction.guild, `${ICONS.success} Message ${message ? 'enregistré' : 'par défaut rétabli'}.`));
    },
    async ctime(interaction, client) {
      guard(interaction);
      const cfg = cfgOf(client, interaction.guildId);
      await interaction.showModal(new ModalBuilder().setCustomId('cmd:anniversaire:ctimesubmit').setTitle('Fuseau et heure d\'envoi').addComponents(
        input('fuseau', 'Fuseau horaire IANA', { value: client.services.birthdays.timeZone(interaction.guildId), max: 50, required: true, placeholder: 'Europe/Paris' }),
        input('heure', 'Heure d\'envoi (0 à 23)', { value: cfg.hour ?? 9, max: 2, required: true, placeholder: '9' }),
      ));
    },
    async ctimesubmit(interaction, client) {
      guard(interaction);
      const timeZone = canonicalTimeZone(textField(interaction, 'fuseau'));
      if (!timeZone) throw new UserError('Fuseau inconnu. Exemples : `Europe/Paris`, `America/Montreal`, `Africa/Abidjan`, `UTC`.');
      const raw = textField(interaction, 'heure');
      const hour = Number(raw);
      if (raw == null || !Number.isInteger(hour) || hour < 0 || hour > 23) throw new UserError('Heure : entrez un nombre entier entre 0 et 23.');
      client.services.config.update(interaction.guildId, { birthdays: { timeZone, hour } });
      client.services.birthdays.invalidate(interaction.guildId);
      await interaction.update(configView(client, interaction.guild, `${ICONS.success} Fuseau ${code(timeZone)}, envoi à **${hour} h**.`));
    },
    /** Aperçu du message (nouveau message éphémère ; le tableau de bord reste en place). */
    async cpreview(interaction, client) {
      guard(interaction);
      const cfg = cfgOf(client, interaction.guildId);
      const member = interaction.member;
      const text = renderBirthday(cfg.message, { id: interaction.user.id, name: member?.displayName ?? interaction.user.username, server: interaction.guild.name, age: 25 });
      await interaction.reply({ embeds: [birthdayCard(truncate(text, 4000), interaction.user.displayAvatarURL?.() ?? null)], ephemeral: true });
    },
  },
};
