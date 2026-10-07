'use strict';

const { SlashCommandBuilder, PermissionFlagsBits, ChannelType } = require('discord.js');
const { truncate } = require('../../utils/embeds');
const { discordTimestamp } = require('../../utils/time');
const { card, field, wide, ICONS, status, subtext, linkButton, buttonRows } = require('../../utils/ui');
const { paginate } = require('../../utils/pagination');
const { STATUS } = require('../../services/SuggestionService');
const { UserError } = require('../../core/errors');

const PER_PAGE = 6;
const LIST_LIMIT = 60;

module.exports = {
  category: 'suggestions',
  data: new SlashCommandBuilder()
    .setName('suggestion')
    .setDescription('Système de suggestions.')
    .addSubcommand((s) =>
      s.setName('setup').setDescription('Définit le salon des suggestions.')
        .addChannelOption((o) => o.setName('salon').setDescription('Salon').addChannelTypes(ChannelType.GuildText).setRequired(true)))
    .addSubcommand((s) =>
      s.setName('create').setDescription('Propose une suggestion.')
        .addStringOption((o) => o.setName('contenu').setDescription('Votre suggestion').setRequired(true).setMaxLength(2000)))
    .addSubcommand((s) =>
      s.setName('approve').setDescription('Approuve une suggestion.')
        .addIntegerOption((o) => o.setName('id').setDescription('ID').setRequired(true))
        .addStringOption((o) => o.setName('raison').setDescription('Explication affichée sur la suggestion').setMaxLength(900)))
    .addSubcommand((s) =>
      s.setName('deny').setDescription('Refuse une suggestion.')
        .addIntegerOption((o) => o.setName('id').setDescription('ID').setRequired(true))
        .addStringOption((o) => o.setName('raison').setDescription('Explication affichée sur la suggestion').setMaxLength(900)))
    .addSubcommand((s) => s.setName('list').setDescription('Liste les dernières suggestions.')),

  async execute(interaction, client) {
    const sub = interaction.options.getSubcommand();
    const { suggestions, config } = client.services;
    const guildId = interaction.guild.id;

    if (sub === 'setup') {
      requireManage(interaction);
      const channel = interaction.options.getChannel('salon');
      config.update(guildId, { suggestions: { channelId: channel.id } });
      return interaction.reply({
        embeds: [
          card({
            tone: 'success',
            section: 'suggestions',
            icon: ICONS.settings,
            title: 'Suggestions configurées',
            description: [`Les suggestions seront publiées dans ${channel}.`, subtext('Les membres proposent leurs idées avec /suggestion create.')],
          }),
        ],
        ephemeral: true,
      });
    }
    if (sub === 'create') {
      const content = interaction.options.getString('contenu');
      await interaction.deferReply({ ephemeral: true });
      const id = await suggestions.create(interaction.guild, interaction.user, content);
      const url = suggestions.url(client.repositories.suggestions.get(id));
      return interaction.editReply({
        embeds: [
          card({
            tone: 'info',
            section: 'suggestions',
            icon: ICONS.idea,
            title: `Suggestion #${id} publiée`,
            description: ['Merci pour votre idée ! La communauté peut maintenant voter.', subtext('Le staff l\'examinera et vous verrez sa décision sur le message.')],
          }),
        ],
        components: url ? buttonRows(linkButton('Voir la suggestion', url, ICONS.link)) : [],
      });
    }
    if (sub === 'approve' || sub === 'deny') {
      requireManage(interaction);
      const id = interaction.options.getInteger('id');
      const reason = interaction.options.getString('raison');
      const approved = sub === 'approve';
      await interaction.deferReply({ ephemeral: true });
      const updated = await suggestions.setStatus(interaction.guild, id, approved ? 'approved' : 'denied', { by: `${interaction.user}`, reason });
      const url = suggestions.url(updated);
      return interaction.editReply({
        embeds: [
          card({
            tone: approved ? 'success' : 'danger',
            section: 'suggestions',
            icon: approved ? ICONS.success : ICONS.error,
            title: `Suggestion #${id} ${approved ? 'approuvée' : 'refusée'}`,
            description: truncate(updated.content, 300),
            fields: [
              field(ICONS.user, 'Auteur', `<@${updated.author_id}>`),
              field(ICONS.moderator, 'Décision par', `${interaction.user}`),
              wide(ICONS.reason, 'Raison', reason ?? '*Aucune raison précisée*'),
            ],
          }),
        ],
        components: url ? buttonRows(linkButton('Voir la suggestion', url, ICONS.link)) : [],
      });
    }
    if (sub === 'list') {
      const repo = client.repositories.suggestions;
      const list = repo.list(guildId, LIST_LIMIT);
      if (!list.length) {
        return interaction.reply({ embeds: [status.note('Aucune suggestion pour le moment. Proposez la première avec /suggestion create !', 'Suggestions')], ephemeral: true });
      }
      const counts = { pending: 0, approved: 0, denied: 0 };
      for (const s of list) if (s.status in counts) counts[s.status] += 1;
      const pages = [];
      for (let i = 0; i < list.length; i += PER_PAGE) {
        const lines = list.slice(i, i + PER_PAGE).map((s) => {
          const meta = STATUS[s.status] ?? { pill: s.status };
          const url = suggestions.url(s);
          return [
            `${meta.pill.split(' ')[0]} **#${s.id}** · ${truncate(s.content.replace(/\s+/g, ' '), 90)}`,
            subtext(`<@${s.author_id}> · 👍 ${s.up} · 👎 ${s.down} · ${discordTimestamp(s.created_at, 'R')}${url ? ` · [Voir](${url})` : ''}`),
          ].join('\n');
        });
        pages.push(
          card({
            tone: 'info',
            section: 'suggestions',
            icon: ICONS.idea,
            title: `Dernières suggestions (${list.length})`,
            description: lines.join('\n\n'),
            fields: [
              field('🕐', 'En attente', `**${counts.pending}**`),
              field(ICONS.success, 'Approuvées', `**${counts.approved}**`),
              field(ICONS.error, 'Refusées', `**${counts.denied}**`),
            ],
          }),
        );
      }
      return paginate(interaction, pages, { ephemeral: true });
    }
  },
};

function requireManage(interaction) {
  if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
    throw new UserError('Il faut la permission **Gérer le serveur** pour faire cela.');
  }
}
