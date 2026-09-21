'use strict';

const { SlashCommandBuilder, PermissionFlagsBits, ChannelType } = require('discord.js');
const { embeds, successReply } = require('../../utils/embeds');
const { UserError } = require('../../core/errors');

module.exports = {
  category: 'tickets',
  data: new SlashCommandBuilder()
    .setName('ticket')
    .setDescription('Système de tickets.')
    .setDMPermission(false)
    .addSubcommand((s) =>
      s.setName('setup').setDescription('Configure le système de tickets.')
        .addChannelOption((o) => o.setName('categorie').setDescription('Catégorie des tickets').addChannelTypes(ChannelType.GuildCategory))
        .addRoleOption((o) => o.setName('role_support').setDescription('Rôle support'))
        .addChannelOption((o) => o.setName('logs').setDescription('Salon de logs/transcripts').addChannelTypes(ChannelType.GuildText))
        .addIntegerOption((o) => o.setName('max_par_membre').setDescription('Tickets max par membre').setMinValue(1).setMaxValue(10)))
    .addSubcommand((s) =>
      s.setName('panel').setDescription('Envoie le panneau d\'ouverture de ticket.')
        .addChannelOption((o) => o.setName('salon').setDescription('Salon où poster le panneau').addChannelTypes(ChannelType.GuildText)))
    .addSubcommand((s) => s.setName('close').setDescription('Ferme le ticket actuel.'))
    .addSubcommand((s) => s.setName('claim').setDescription('Réclame le ticket actuel.'))
    .addSubcommand((s) => s.setName('transcript').setDescription('Génère le transcript du ticket.'))
    .addSubcommand((s) =>
      s.setName('add').setDescription('Ajoute un membre au ticket.').addUserOption((o) => o.setName('membre').setDescription('Membre').setRequired(true)))
    .addSubcommand((s) =>
      s.setName('remove').setDescription('Retire un membre du ticket.').addUserOption((o) => o.setName('membre').setDescription('Membre').setRequired(true)))
    .addSubcommand((s) =>
      s.setName('rename').setDescription('Renomme le ticket.').addStringOption((o) => o.setName('nom').setDescription('Nouveau nom').setRequired(true))),

  async execute(interaction, client) {
    const sub = interaction.options.getSubcommand();
    const { tickets, config } = client.services;

    if (sub === 'setup') {
      requirePerm(interaction, PermissionFlagsBits.ManageGuild);
      const patch = {};
      const category = interaction.options.getChannel('categorie');
      const role = interaction.options.getRole('role_support');
      const logs = interaction.options.getChannel('logs');
      const max = interaction.options.getInteger('max_par_membre');
      if (category) patch.categoryId = category.id;
      if (role) patch.supportRoleId = role.id;
      if (logs) patch.logChannel = logs.id;
      if (max) patch.maxPerUser = max;
      config.update(interaction.guild.id, { tickets: patch });
      return interaction.reply(successReply('Configuration des tickets mise à jour.', { ephemeral: true }));
    }

    if (sub === 'panel') {
      requirePerm(interaction, PermissionFlagsBits.ManageGuild);
      const channel = interaction.options.getChannel('salon') || interaction.channel;
      await channel.send(tickets.panel());
      return interaction.reply(successReply(`Panneau envoyé dans ${channel}.`, { ephemeral: true }));
    }

    // Actions dans un ticket
    const record = client.repositories.tickets.getByChannel(interaction.channel.id);
    if (!record) throw new UserError('Cette commande doit être utilisée dans un salon de ticket.');

    if (sub === 'close') {
      await interaction.reply(successReply('Fermeture du ticket…', { ephemeral: true }));
      return tickets.close(interaction.channel, interaction.user);
    }
    if (sub === 'claim') {
      await tickets.claim(interaction.channel, interaction.user);
      return interaction.reply(successReply('Ticket réclamé.', { ephemeral: true }));
    }
    if (sub === 'transcript') {
      const content = await tickets.generateTranscript(interaction.channel);
      return interaction.reply({ files: [{ attachment: Buffer.from(content, 'utf8'), name: `transcript-${record.id}.txt` }], ephemeral: true });
    }
    if (sub === 'add' || sub === 'remove') {
      const user = interaction.options.getUser('membre');
      await interaction.channel.permissionOverwrites.edit(user, {
        ViewChannel: sub === 'add' ? true : null,
        SendMessages: sub === 'add' ? true : null,
      });
      return interaction.reply(successReply(`${user} ${sub === 'add' ? 'ajouté au' : 'retiré du'} ticket.`, { ephemeral: true }));
    }
    if (sub === 'rename') {
      const name = interaction.options.getString('nom');
      await interaction.channel.setName(name.slice(0, 90));
      return interaction.reply(successReply(`Ticket renommé en **${name}**.`, { ephemeral: true }));
    }
  },
};

function requirePerm(interaction, flag) {
  if (!interaction.member.permissions.has(flag)) throw new UserError('Vous n\'avez pas la permission requise.');
}
