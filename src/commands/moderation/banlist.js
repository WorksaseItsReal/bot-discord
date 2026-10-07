'use strict';

const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { truncate } = require('../../utils/embeds');
const { card, field, ICONS, code, subtext, status } = require('../../utils/ui');
const { paginate } = require('../../utils/pagination');

const PER_PAGE = 8;

/** Une ligne par bannissement : pseudo + ID, raison en gris. Pur. */
function banLine(ban) {
  const reason = truncate((ban.reason || 'Aucune raison').replace(/\s+/g, ' '), 140);
  return `${ICONS.ban} **${ban.user.username ?? ban.user.tag}** · ${code(ban.user.id)}\n${subtext(reason)}`;
}

module.exports = {
  category: 'moderation',
  banLine,
  data: new SlashCommandBuilder()
    .setName('banlist')
    .setDescription('Affiche la liste des membres bannis.')
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers),

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });
    const bans = await interaction.guild.bans.fetch();
    if (!bans.size) {
      return interaction.editReply({ embeds: [status.note('Aucun membre n\'est banni de ce serveur. ✨', 'Liste vide')] });
    }

    const list = [...bans.values()];
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
            field(ICONS.count, 'Total', `**${bans.size}**`),
            field(ICONS.unlock, 'Débannir', '`/unban user_id:`'),
          ],
        }),
      );
    }
    await paginate(interaction, pages, { ephemeral: true });
  },
};
