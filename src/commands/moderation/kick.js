'use strict';

const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { successReply } = require('../../utils/embeds');
const { confirm } = require('../../utils/confirmation');
const { UserError } = require('../../core/errors');

module.exports = {
  category: 'moderation',
  data: new SlashCommandBuilder()
    .setName('kick')
    .setDescription('Expulse un membre du serveur.')
    .setDefaultMemberPermissions(PermissionFlagsBits.KickMembers)
    .setDMPermission(false)
    .addUserOption((o) => o.setName('membre').setDescription('Le membre à expulser').setRequired(true))
    .addStringOption((o) => o.setName('raison').setDescription('Raison de l\'expulsion')),

  /** @param {import('discord.js').ChatInputCommandInteraction} interaction */
  async execute(interaction, client) {
    const user = interaction.options.getUser('membre');
    const reason = interaction.options.getString('raison');
    const member = await interaction.guild.members.fetch(user.id).catch(() => null);
    if (!member) throw new UserError('Ce membre n\'est pas sur le serveur.');

    const cfg = client.services.config.get(interaction.guild.id);
    if (cfg.moderation.confirmDangerous) {
      const ok = await confirm(interaction, { description: `Expulser ${user} ?`, confirmLabel: 'Expulser' });
      if (!ok) return;
    }

    await client.services.moderation.kick(interaction.guild, member, interaction.member, reason);
    const payload = successReply(`${user.tag} a été expulsé.`);
    if (cfg.moderation.confirmDangerous) await interaction.followUp({ ...payload, ephemeral: true });
    else await interaction.reply(payload);
  },
};
