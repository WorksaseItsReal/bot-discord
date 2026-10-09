'use strict';

const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { truncate } = require('../../utils/embeds');
const { card, field, ICONS, code, subtext, status } = require('../../utils/ui');
const { paginate } = require('../../utils/pagination');

const PER_PAGE = 8;
/** Taille d'une page de l'API des bans (maximum Discord). */
const FETCH_LIMIT = 1000;
/** Borne raisonnable du nombre de bans parcourus. */
const MAX_BANS = 10_000;

/**
 * Tous les bans du serveur (jusqu'à MAX_BANS), page par page : l'API n'en renvoie
 * que 1 000 par appel. Renvoie la liste et si la borne a été atteinte.
 * @returns {Promise<{ list: import('discord.js').GuildBan[], truncated: boolean }>}
 */
async function fetchAllBans(guild, { limit = FETCH_LIMIT, max = MAX_BANS } = {}) {
  const list = [];
  let after;
  for (;;) {
    const batch = await guild.bans.fetch(after ? { limit, after, cache: false } : { limit, cache: false });
    const values = [...batch.values()];
    list.push(...values);
    if (values.length < limit || list.length >= max) break;
    // Bans triés par identifiant croissant : la page suivante commence après le plus grand.
    const last = values.reduce((m, b) => (BigInt(b.user.id) > BigInt(m) ? b.user.id : m), values[0].user.id);
    if (last === after) break;
    after = last;
  }
  return { list: list.slice(0, max), truncated: list.length >= max };
}

/** Une ligne par bannissement : pseudo + ID, raison en gris. Pur. */
function banLine(ban) {
  const reason = truncate((ban.reason || 'Aucune raison').replace(/\s+/g, ' '), 140);
  return `${ICONS.ban} **${ban.user.username ?? ban.user.tag}** · ${code(ban.user.id)}\n${subtext(reason)}`;
}

module.exports = {
  category: 'moderation',
  banLine,
  fetchAllBans,
  data: new SlashCommandBuilder()
    .setName('banlist')
    .setDescription('Affiche la liste des membres bannis.')
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers),

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });
    const { list, truncated } = await fetchAllBans(interaction.guild);
    if (!list.length) {
      return interaction.editReply({ embeds: [status.note('Aucun membre n\'est banni de ce serveur. ✨', 'Liste vide')] });
    }
    const total = truncated ? `**${list.length}+**` : `**${list.length}**`;

    const pages = [];
    for (let i = 0; i < list.length; i += PER_PAGE) {
      pages.push(
        card({
          tone: 'danger',
          section: 'moderation',
          icon: ICONS.list,
          title: 'Membres bannis',
          description: list.slice(i, i + PER_PAGE).map(banLine).join('\n'),
          fields: [
            field(ICONS.count, 'Total', total),
            field(ICONS.unlock, 'Débannir', '`/unban user_id:`'),
          ],
        }),
      );
    }
    await paginate(interaction, pages, { ephemeral: true });
  },
};
