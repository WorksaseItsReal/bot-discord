'use strict';

const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { buttonRows, wide, ICONS } = require('../../utils/ui');
const { sanctionCard, historyButton, revokeHandler } = require('../../services/ModerationService');
const { UserError } = require('../../core/errors');

module.exports = {
  category: 'moderation',
  data: new SlashCommandBuilder()
    .setName('unban')
    .setDescription('Débannit un utilisateur via son ID.')
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
    .addStringOption((o) => o.setName('user_id').setDescription('ID de l\'utilisateur à débannir').setRequired(true))
    .addStringOption((o) => o.setName('raison').setDescription('Raison du débannissement (facultative)').setMaxLength(512)),

  /** @param {import('discord.js').ChatInputCommandInteraction} interaction */
  async execute(interaction, client) {
    const userId = interaction.options.getString('user_id').trim();
    if (!/^\d{17,20}$/.test(userId)) throw new UserError('ID utilisateur invalide : il doit contenir 17 à 20 chiffres.');
    const reason = interaction.options.getString('raison');
    // Plusieurs appels API (fetch du ban, débannissement, log) : acquittement immédiat.
    await interaction.deferReply();
    const res = await client.services.moderation.unban(interaction.guild, userId, interaction.member, reason);
    const card = sanctionCard({ type: 'unban', user: res.user, userId: res.userId, moderator: interaction.user, reason });
    if (res.dbOnly) card.addFields(wide(ICONS.info, 'Note', 'Il n\'était déjà plus banni sur Discord : seule la sanction restée active en base a été levée.'));
    await interaction.editReply({ embeds: [card], components: buttonRows(historyButton(res.userId)) });
  },

  buttons: {
    /**
     * cmd:unban:revoke:<userId> — bouton « Débannir » des cartes de bannissement.
     * Revérifie la permission du cliqueur, valide l'ID et que l'utilisateur est toujours banni.
     */
    revoke: revokeHandler({
      permission: 'BanMembers',
      type: 'unban',
      done: 'Débanni',
      async run(interaction, client, userId) {
        if (!interaction.guild.members.me?.permissions.has(PermissionFlagsBits.BanMembers)) {
          throw new UserError('Il me manque la permission **Bannir des membres** pour débannir.');
        }
        // unban() vérifie que l'utilisateur est toujours banni et agit sur l'utilisateur résolu.
        const reason = `Débanni via le bouton par ${interaction.user.tag}`;
        const { user, userId: id } = await client.services.moderation.unban(interaction.guild, userId, interaction.member, reason);
        return user ?? { id, tag: id, toString: () => `<@${id}>` };
      },
    }),
  },
};
