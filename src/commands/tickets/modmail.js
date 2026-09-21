'use strict';

const { SlashCommandBuilder, PermissionFlagsBits, ChannelType } = require('discord.js');
const { successReply } = require('../../utils/embeds');

module.exports = {
  category: 'tickets',
  data: new SlashCommandBuilder()
    .setName('modmail')
    .setDescription('Système ModMail (DM ↔ staff).')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .setDMPermission(false)
    .addSubcommand((s) =>
      s.setName('setup').setDescription('Configure et active le ModMail.')
        .addChannelOption((o) => o.setName('categorie').setDescription('Catégorie des conversations').addChannelTypes(ChannelType.GuildCategory))
        .addRoleOption((o) => o.setName('role_staff').setDescription('Rôle staff'))
        .addBooleanOption((o) => o.setName('actif').setDescription('Activer ?')))
    .addSubcommand((s) =>
      s.setName('reply').setDescription('Répond à la conversation ModMail actuelle.')
        .addStringOption((o) => o.setName('message').setDescription('Message').setRequired(true)))
    .addSubcommand((s) => s.setName('close').setDescription('Ferme la conversation ModMail actuelle.')),

  async execute(interaction, client) {
    const sub = interaction.options.getSubcommand();
    const { modmail, config } = client.services;

    if (sub === 'setup') {
      const patch = {};
      const category = interaction.options.getChannel('categorie');
      const role = interaction.options.getRole('role_staff');
      const active = interaction.options.getBoolean('actif');
      if (category) patch.categoryId = category.id;
      if (role) patch.staffRoleId = role.id;
      if (active !== null) patch.enabled = active;
      config.update(interaction.guild.id, { modmail: patch });
      return interaction.reply(successReply('ModMail configuré.', { ephemeral: true }));
    }
    if (sub === 'reply') {
      await modmail.reply(interaction.channel, interaction.user, interaction.options.getString('message'));
      return interaction.reply(successReply('Réponse envoyée.', { ephemeral: true }));
    }
    if (sub === 'close') {
      await interaction.reply(successReply('Fermeture de la conversation…', { ephemeral: true }));
      return modmail.close(interaction.channel);
    }
  },
};
