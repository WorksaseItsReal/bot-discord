'use strict';

const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { truncate } = require('../../utils/embeds');
const { discordTimestamp, formatDuration } = require('../../utils/time');
const { card, field, ICONS, userLine, subtext, code, status } = require('../../utils/ui');
const { paginate } = require('../../utils/pagination');
const { TYPE_LABELS, sanctionIcon, userFromId, requirePermission } = require('../../services/ModerationService');
const { snowflake } = require('../../utils/buttonGuard');
const { UserError } = require('../../core/errors');
const { isEnforced } = require('../../database/repositories/SanctionRepository');

/** Commande qui lève chaque type de sanction encore en vigueur. */
const LIFT_COMMANDS = { tempban: '/unban', mute: '/unmute', timeout: '/untimeout' };

/**
 * Refuse de supprimer des sanctions encore en vigueur (choix le plus sûr) :
 * supprimer la ligne d'un ban temporaire le rendrait définitif (le scheduler ne
 * pourrait plus le lever), et un mute effacé ne serait plus réappliqué au retour.
 * Le modérateur doit d'abord lever la sanction avec la commande dédiée, qui passe
 * par ModerationService (vérifications de hiérarchie + log de révocation). Pur.
 * @returns {string|null} message d'erreur, ou null si la suppression est sûre
 */
function enforcedRefusal(sanctions) {
  if (!sanctions.length) return null;
  const lines = sanctions.map((s) => {
    const label = TYPE_LABELS[s.type] ?? s.type;
    const until = s.expires_at ? ` jusqu'au ${discordTimestamp(s.expires_at, 'f')}` : '';
    return `• ${code(`#${s.id}`)} **${label}**${until} → ${LIFT_COMMANDS[s.type] ?? 'levez-la'} d'abord`;
  });
  return `Impossible de supprimer une sanction **encore en vigueur** : elle ne pourrait plus être levée automatiquement.\n${lines.join('\n')}`;
}

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
  enforcedRefusal,
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
      if (!sanction) throw new UserError(`Aucune sanction ${code(`#${id}`)} trouvée sur ce serveur.`);
      const refusal = isEnforced(sanction) ? enforcedRefusal([sanction]) : null;
      if (refusal) throw new UserError(refusal);
      if (!repo.delete(guildId, id)) throw new UserError(`Aucune sanction ${code(`#${id}`)} trouvée sur ce serveur.`);
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
      const refusal = enforcedRefusal(repo.listEnforced(guildId, user.id));
      if (refusal) throw new UserError(refusal);
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
    async history(interaction, client, [rawUserId]) {
      requirePermission(interaction, 'ModerateMembers');
      const userId = snowflake(rawUserId, 'membre');
      const user = (await client.users.fetch(userId).catch(() => null)) ?? userFromId(userId);
      return showHistory(interaction, client, user);
    },
  },
};
