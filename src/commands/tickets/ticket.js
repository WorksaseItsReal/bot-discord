'use strict';

const { SlashCommandBuilder, PermissionFlagsBits, ChannelType } = require('discord.js');
const { card, field, ICONS, status, linkButton, buttonRows, userLine, subtext } = require('../../utils/ui');
const { UserError } = require('../../core/errors');

module.exports = {
  category: 'tickets',
  data: new SlashCommandBuilder()
    .setName('ticket')
    .setDescription('Système de tickets.')
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
    .addSubcommand((s) => s.setName('claim').setDescription('Prend en charge le ticket actuel.'))
    .addSubcommand((s) => s.setName('transcript').setDescription('Génère le transcript du ticket.'))
    .addSubcommand((s) =>
      s.setName('add').setDescription('Ajoute un membre au ticket.').addUserOption((o) => o.setName('membre').setDescription('Membre').setRequired(true)))
    .addSubcommand((s) =>
      s.setName('remove').setDescription('Retire un membre du ticket.').addUserOption((o) => o.setName('membre').setDescription('Membre').setRequired(true)))
    .addSubcommand((s) =>
      s.setName('rename').setDescription('Renomme le ticket.').addStringOption((o) => o.setName('nom').setDescription('Nouveau nom').setRequired(true).setMaxLength(90))),

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
      const cfg = config.get(interaction.guild.id).tickets ?? {};
      return interaction.reply({
        embeds: [
          card({
            tone: 'success',
            section: 'tickets',
            icon: ICONS.settings,
            title: 'Tickets configurés',
            description: ['La configuration des tickets est à jour.', subtext('Publiez le panneau avec /ticket panel.')],
            fields: [
              field(ICONS.category, 'Catégorie', cfg.categoryId ? `<#${cfg.categoryId}>` : '*Aucune*'),
              field(ICONS.role, 'Support', cfg.supportRoleId ? `<@&${cfg.supportRoleId}>` : '*Gérer les salons*'),
              field(ICONS.history, 'Logs', cfg.logChannel ? `<#${cfg.logChannel}>` : '*Désactivés*'),
              field(ICONS.count, 'Max par membre', `**${cfg.maxPerUser || 1}**`),
            ],
          }),
        ],
        ephemeral: true,
      });
    }

    if (sub === 'panel') {
      requirePerm(interaction, PermissionFlagsBits.ManageGuild);
      const channel = interaction.options.getChannel('salon') || interaction.channel;
      const message = await channel.send(tickets.panel(interaction.guild));
      return interaction.reply({
        embeds: [status.ok(`Le panneau de tickets est en ligne dans ${channel}.`, 'Panneau publié')],
        components: message?.url ? buttonRows(linkButton('Voir le panneau', message.url, ICONS.link)) : [],
        ephemeral: true,
      });
    }

    // Actions dans un ticket
    const record = client.repositories.tickets.getByChannel(interaction.channel.id);
    if (!record) throw new UserError('Cette commande doit être utilisée dans un salon de ticket.');

    if (sub === 'close') {
      tickets.assertParticipant(interaction.member, record);
      return tickets.close(interaction.channel, interaction.user, {
        delayMs: 5000,
        onAccepted: () =>
          interaction.reply({
            embeds: [card({ tone: 'neutral', icon: ICONS.lock, title: 'Fermeture en cours', description: 'Le ticket sera supprimé dans **5 secondes**.' })],
            ephemeral: true,
          }),
      });
    }
    if (sub === 'claim') {
      await interaction.deferReply({ ephemeral: true });
      await tickets.claim(interaction.channel, interaction.member);
      return interaction.editReply({ embeds: [status.ok('Vous suivez désormais ce ticket.', 'Ticket pris en charge')] });
    }
    if (sub === 'transcript') {
      tickets.assertParticipant(interaction.member, record);
      await interaction.deferReply({ ephemeral: true });
      return interaction.editReply(await tickets.transcriptPayload(interaction.channel));
    }
    if (sub === 'add' || sub === 'remove' || sub === 'rename') tickets.assertStaff(interaction.member);
    if (sub === 'add' || sub === 'remove') {
      const user = interaction.options.getUser('membre');
      if (sub === 'remove' && (user.id === record.user_id || user.id === client.user.id)) {
        throw new UserError('Impossible de retirer l\'auteur du ticket ou le bot.');
      }
      await interaction.channel.permissionOverwrites.edit(user, {
        ViewChannel: sub === 'add' ? true : null,
        SendMessages: sub === 'add' ? true : null,
      });
      const added = sub === 'add';
      return interaction.reply({
        embeds: [
          card({
            tone: added ? 'success' : 'neutral',
            section: 'tickets',
            icon: added ? '➕' : '➖',
            title: added ? 'Membre ajouté au ticket' : 'Membre retiré du ticket',
            description: added ? `${user} peut maintenant voir ce ticket et y écrire.` : `${user} n'a plus accès à ce ticket.`,
            fields: [field(ICONS.user, 'Membre', userLine(user)), field(ICONS.moderator, 'Par', `${interaction.user}`)],
          }),
        ],
      });
    }
    if (sub === 'rename') {
      const name = interaction.options.getString('nom');
      const before = interaction.channel.name;
      await interaction.channel.setName(name.slice(0, 90));
      return interaction.reply({
        embeds: [
          card({
            tone: 'info',
            section: 'tickets',
            icon: '✏️',
            title: 'Ticket renommé',
            fields: [field(ICONS.history, 'Avant', `\`#${before}\``), field(ICONS.channel, 'Après', `${interaction.channel}`), field(ICONS.moderator, 'Par', `${interaction.user}`)],
          }),
        ],
      });
    }
  },
};

function requirePerm(interaction, flag) {
  if (!interaction.member.permissions.has(flag)) throw new UserError('Vous n\'avez pas la permission requise.');
}
