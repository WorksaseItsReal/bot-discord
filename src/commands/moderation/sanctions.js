'use strict';

const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { truncate } = require('../../utils/embeds');
const { discordTimestamp, formatDuration } = require('../../utils/time');
const { card, field, ICONS, userLine, subtext, code, status } = require('../../utils/ui');
const { paginate } = require('../../utils/pagination');
const { TYPE_LABELS, sanctionIcon, userFromId, needPermission } = require('../../services/ModerationService');
const { UserError } = require('../../core/errors');

const PER_PAGE = 5;
const MAX_ENTRIES = 100;

/** Une sanction sur deux lignes : type + date, puis détails en gris. Pur. */
function sanctionLine(s, now = Date.now()) {
  const label = TYPE_LABELS[s.type] ?? s.type;
  const running = s.active && s.expires_at && s.expires_at > now;
  const head = `${sanctionIcon(s.type)} **${label}** ${code(`#${s.id}`)} · ${discordTimestamp(s.created_at, 'd')}${running ? ' · 🟢 En cours' : ''}`;
  const details = [
    `par <@${s.moderator_id}>`,
    s.duration_ms ? formatDuration(s.duration_ms) : null,
    truncate((s.reason || 'Aucune raison').replace(/\s+/g, ' '), 120),
  ].filter(Boolean);
  return `${head}\n${subtext(details.join(' · '))}`;
}

/**
 * Pages de l'historique d'un membre (cartes paginables).
 * @returns {import('discord.js').EmbedBuilder[]} vide si aucune sanction
 */
function historyPages(client, guildId, user) {
  const list = client.repositories.sanctions.listByUser(guildId, user.id, MAX_ENTRIES);
  if (!list.length) return [];
  const total = client.repositories.sanctions.count(guildId, user.id);
  const strikes = client.services.strikes.getCount(guildId, user.id);
  const pages = [];
  for (let i = 0; i < list.length; i += PER_PAGE) {
    pages.push(
      card({
        tone: 'caution',
        section: 'moderation',
        icon: ICONS.history,
        title: 'Historique des sanctions',
        description: list.slice(i, i + PER_PAGE).map((s) => sanctionLine(s)).join('\n\n'),
        thumbnail: user.displayAvatarURL?.(),
        fields: [
          field(ICONS.user, 'Membre', userLine(user)),
          field(ICONS.count, 'Sanctions', `**${total}**`),
          field(ICONS.warn, 'Strikes', `**${strikes}**`),
        ],
        footer: total > list.length ? `${list.length} plus récentes sur ${total}` : undefined,
      }),
    );
  }
  return pages;
}

async function showHistory(interaction, client, user) {
  const pages = historyPages(client, interaction.guildId, user);
  if (!pages.length) {
    return interaction.reply({ embeds: [status.note(`${user} n'a aucune sanction sur ce serveur. ✨`, 'Casier vierge')], ephemeral: true });
  }
  return paginate(interaction, pages, { ephemeral: true });
}

module.exports = {
  category: 'moderation',
  historyPages,
  sanctionLine,
  data: new SlashCommandBuilder()
    .setName('sanctions')
    .setDescription('Gère l\'historique des sanctions d\'un membre.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addSubcommand((s) =>
      s.setName('list').setDescription('Affiche l\'historique d\'un membre.').addUserOption((o) => o.setName('membre').setDescription('Le membre').setRequired(true)),
    )
    .addSubcommand((s) =>
      s.setName('remove').setDescription('Supprime une sanction par son ID.').addIntegerOption((o) => o.setName('id').setDescription('ID de la sanction').setRequired(true)),
    )
    .addSubcommand((s) =>
      s.setName('clear').setDescription('Efface tout l\'historique d\'un membre.').addUserOption((o) => o.setName('membre').setDescription('Le membre').setRequired(true)),
    ),

  /** @param {import('discord.js').ChatInputCommandInteraction} interaction */
  async execute(interaction, client) {
    const sub = interaction.options.getSubcommand();
    const repo = client.repositories.sanctions;
    const guildId = interaction.guild.id;

    if (sub === 'list') {
      return showHistory(interaction, client, interaction.options.getUser('membre'));
    }

    if (sub === 'remove') {
      const id = interaction.options.getInteger('id');
      const sanction = repo.get(guildId, id);
      if (!sanction || !repo.delete(guildId, id)) throw new UserError(`Aucune sanction ${code(`#${id}`)} trouvée sur ce serveur.`);
      return interaction.reply({
        embeds: [
          card({
            tone: 'success',
            section: 'moderation',
            icon: ICONS.delete,
            title: 'Sanction supprimée',
            description: `La sanction ${code(`#${id}`)} a été retirée de l'historique.`,
            fields: [
              field(ICONS.user, 'Membre', `<@${sanction.user_id}>`),
              field(sanctionIcon(sanction.type), 'Type', TYPE_LABELS[sanction.type] ?? sanction.type),
              field(ICONS.date, 'Date', discordTimestamp(sanction.created_at, 'd')),
            ],
            footer: 'Les strikes ne sont pas modifiés : /sanctions clear pour les remettre à zéro.',
          }),
        ],
        ephemeral: true,
      });
    }

    if (sub === 'clear') {
      const user = interaction.options.getUser('membre');
      const n = repo.clearUser(guildId, user.id);
      client.services.strikes.reset(guildId, user.id);
      return interaction.reply({
        embeds: [
          card({
            tone: 'success',
            section: 'moderation',
            icon: ICONS.delete,
            title: 'Historique effacé',
            description: `Le casier de ${user} est de nouveau vierge.`,
            fields: [
              field(ICONS.user, 'Membre', userLine(user)),
              field(ICONS.count, 'Sanctions effacées', `**${n}**`),
              field(ICONS.warn, 'Strikes', 'Remis à **0**'),
            ],
          }),
        ],
        ephemeral: true,
      });
    }
  },

  buttons: {
    /** cmd:sanctions:history:<userId> — historique éphémère, réservé aux modérateurs. */
    async history(interaction, client, [userId]) {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ModerateMembers)) throw needPermission('ModerateMembers');
      const user = (await client.users.fetch(userId).catch(() => null)) ?? userFromId(userId);
      return showHistory(interaction, client, user);
    },
  },
};
