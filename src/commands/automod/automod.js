'use strict';

const { SlashCommandBuilder, PermissionFlagsBits, ChannelType } = require('discord.js');
const { embeds, successReply } = require('../../utils/embeds');

const FILTERS = [
  'antiSpam', 'antiFlood', 'antiLink', 'antiInvite', 'antiMassMention',
  'antiCaps', 'badWords', 'antiRepeat', 'antiEmojiSpam', 'antiDuplicate',
];

module.exports = {
  category: 'automod',
  data: new SlashCommandBuilder()
    .setName('automod')
    .setDescription('Configuration de l\'AutoMod.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setDMPermission(false)
    .addSubcommand((s) => s.setName('enable').setDescription('Active l\'AutoMod.'))
    .addSubcommand((s) => s.setName('disable').setDescription('Désactive l\'AutoMod.'))
    .addSubcommand((s) => s.setName('status').setDescription('Affiche la configuration AutoMod.'))
    .addSubcommand((s) =>
      s.setName('filter').setDescription('Active/désactive un filtre.')
        .addStringOption((o) => o.setName('nom').setDescription('Filtre').setRequired(true).addChoices(...FILTERS.map((f) => ({ name: f, value: f }))))
        .addBooleanOption((o) => o.setName('actif').setDescription('Activer ?').setRequired(true))
        .addStringOption((o) => o.setName('action').setDescription('Sanction').addChoices({ name: 'delete', value: 'delete' }, { name: 'warn', value: 'warn' }, { name: 'timeout', value: 'timeout' }))
        .addStringOption((o) => o.setName('duree').setDescription('Durée du timeout (ex: 10m)')))
    .addSubcommand((s) =>
      s.setName('ignore').setDescription('Ajoute/retire un salon ou rôle ignoré.')
        .addChannelOption((o) => o.setName('salon').setDescription('Salon à (dé)ignorer').addChannelTypes(ChannelType.GuildText))
        .addRoleOption((o) => o.setName('role').setDescription('Rôle à (dé)ignorer')))
    .addSubcommandGroup((g) =>
      g.setName('badword').setDescription('Gestion des mots interdits')
        .addSubcommand((s) => s.setName('add').setDescription('Ajoute un mot interdit.').addStringOption((o) => o.setName('mot').setDescription('Mot').setRequired(true)))
        .addSubcommand((s) => s.setName('remove').setDescription('Retire un mot interdit.').addStringOption((o) => o.setName('mot').setDescription('Mot').setRequired(true)))
        .addSubcommand((s) => s.setName('list').setDescription('Liste les mots interdits.'))),

  async execute(interaction, client) {
    const group = interaction.options.getSubcommandGroup(false);
    const sub = interaction.options.getSubcommand();
    const { config } = client.services;
    const guildId = interaction.guild.id;

    if (group === 'badword') return handleBadword(interaction, config, guildId, sub);

    if (sub === 'enable' || sub === 'disable') {
      config.update(guildId, { automod: { enabled: sub === 'enable' } });
      return interaction.reply(successReply(`AutoMod **${sub === 'enable' ? 'activé' : 'désactivé'}**.`, { ephemeral: true }));
    }

    if (sub === 'status') {
      const cfg = config.get(guildId).automod;
      const lines = FILTERS.map((f) => {
        const fc = cfg.filters[f];
        return `${fc.enabled ? '✅' : '⬜'} **${f}** → ${fc.action}${fc.duration ? ` (${fc.duration})` : ''}`;
      });
      return interaction.reply({
        embeds: [embeds.neutral('🤖 AutoMod').setDescription(`État global : **${cfg.enabled ? 'activé' : 'désactivé'}**\n\n${lines.join('\n')}`)
          .addFields(
            { name: 'Salons ignorés', value: cfg.ignoredChannels.map((c) => `<#${c}>`).join(' ') || '—', inline: true },
            { name: 'Rôles ignorés', value: cfg.ignoredRoles.map((r) => `<@&${r}>`).join(' ') || '—', inline: true },
          )],
        ephemeral: true,
      });
    }

    if (sub === 'filter') {
      const name = interaction.options.getString('nom');
      const enabled = interaction.options.getBoolean('actif');
      const action = interaction.options.getString('action');
      const duration = interaction.options.getString('duree');
      const patch = { enabled };
      if (action) patch.action = action;
      if (duration) patch.duration = duration;
      config.update(guildId, { automod: { filters: { [name]: patch } } });
      return interaction.reply(successReply(`Filtre **${name}** ${enabled ? 'activé' : 'désactivé'}.`, { ephemeral: true }));
    }

    if (sub === 'ignore') {
      const channel = interaction.options.getChannel('salon');
      const role = interaction.options.getRole('role');
      if (!channel && !role) return interaction.reply({ embeds: [embeds.warning('Fournissez un salon ou un rôle.')], ephemeral: true });
      const cfg = config.get(guildId).automod;
      const msgs = [];
      if (channel) {
        const set = new Set(cfg.ignoredChannels);
        set.has(channel.id) ? set.delete(channel.id) : set.add(channel.id);
        config.update(guildId, { automod: { ignoredChannels: [...set] } });
        msgs.push(`Salon ${channel} ${set.has(channel.id) ? 'ignoré' : 'non ignoré'}.`);
      }
      if (role) {
        const set = new Set(config.get(guildId).automod.ignoredRoles);
        set.has(role.id) ? set.delete(role.id) : set.add(role.id);
        config.update(guildId, { automod: { ignoredRoles: [...set] } });
        msgs.push(`Rôle ${role} ${set.has(role.id) ? 'ignoré' : 'non ignoré'}.`);
      }
      return interaction.reply(successReply(msgs.join('\n'), { ephemeral: true }));
    }
  },
};

function handleBadword(interaction, config, guildId, sub) {
  const cfg = config.get(guildId).automod.filters.badWords;
  const words = new Set(cfg.words || []);
  if (sub === 'list') {
    return interaction.reply({ embeds: [embeds.neutral('Mots interdits').setDescription([...words].map((w) => `\`${w}\``).join(', ') || 'Aucun')], ephemeral: true });
  }
  const word = interaction.options.getString('mot').toLowerCase();
  if (sub === 'add') words.add(word);
  else words.delete(word);
  config.update(guildId, { automod: { filters: { badWords: { words: [...words], enabled: true } } } });
  return interaction.reply(successReply(`Mot \`${word}\` ${sub === 'add' ? 'ajouté' : 'retiré'}.`, { ephemeral: true }));
}
