'use strict';

const { SlashCommandBuilder, PermissionFlagsBits, ChannelType } = require('discord.js');
const { embeds, successReply } = require('../../utils/embeds');
const { UserError } = require('../../core/errors');

module.exports = {
  category: 'voice',
  data: new SlashCommandBuilder()
    .setName('voice')
    .setDescription('Gestion des salons vocaux.')
    .setDefaultMemberPermissions(PermissionFlagsBits.MoveMembers)
    .setDMPermission(false)
    .addSubcommand((s) =>
      s.setName('move').setDescription('Déplace un membre vers un salon vocal.')
        .addUserOption((o) => o.setName('membre').setDescription('Membre').setRequired(true))
        .addChannelOption((o) => o.setName('salon').setDescription('Salon vocal').addChannelTypes(ChannelType.GuildVoice).setRequired(true)))
    .addSubcommand((s) =>
      s.setName('kick').setDescription('Déconnecte un membre du vocal.')
        .addUserOption((o) => o.setName('membre').setDescription('Membre').setRequired(true)))
    .addSubcommand((s) =>
      s.setName('mute').setDescription('Coupe le micro d\'un membre en vocal.')
        .addUserOption((o) => o.setName('membre').setDescription('Membre').setRequired(true)))
    .addSubcommand((s) =>
      s.setName('unmute').setDescription('Réactive le micro d\'un membre.')
        .addUserOption((o) => o.setName('membre').setDescription('Membre').setRequired(true)))
    .addSubcommand((s) =>
      s.setName('disconnect').setDescription('Déconnecte un membre (alias de kick).')
        .addUserOption((o) => o.setName('membre').setDescription('Membre').setRequired(true)))
    .addSubcommand((s) =>
      s.setName('cleanup').setDescription('Déconnecte tous les membres d\'un salon vocal.')
        .addChannelOption((o) => o.setName('salon').setDescription('Salon vocal').addChannelTypes(ChannelType.GuildVoice).setRequired(true))),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();

    if (sub === 'cleanup') {
      const channel = interaction.options.getChannel('salon');
      await interaction.deferReply({ ephemeral: true });
      let n = 0;
      for (const m of channel.members.values()) {
        await m.voice.disconnect('Cleanup vocal').then(() => (n += 1)).catch(() => {});
      }
      return interaction.editReply({ embeds: [embeds.success(`${n} membre(s) déconnecté(s) de ${channel}.`)] });
    }

    const user = interaction.options.getUser('membre');
    const member = await interaction.guild.members.fetch(user.id).catch(() => null);
    if (!member) throw new UserError('Membre introuvable.');
    if (!member.voice.channel) throw new UserError('Ce membre n\'est pas connecté en vocal.');

    if (sub === 'move') {
      const channel = interaction.options.getChannel('salon');
      await member.voice.setChannel(channel);
      return interaction.reply(successReply(`${user} déplacé vers ${channel}.`));
    }
    if (sub === 'kick' || sub === 'disconnect') {
      await member.voice.disconnect(`Par ${interaction.user.tag}`);
      return interaction.reply(successReply(`${user} déconnecté du vocal.`));
    }
    if (sub === 'mute') {
      await member.voice.setMute(true, `Par ${interaction.user.tag}`);
      return interaction.reply(successReply(`Micro de ${user} coupé.`));
    }
    if (sub === 'unmute') {
      await member.voice.setMute(false, `Par ${interaction.user.tag}`);
      return interaction.reply(successReply(`Micro de ${user} réactivé.`));
    }
  },
};
