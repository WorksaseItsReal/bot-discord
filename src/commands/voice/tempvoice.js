'use strict';

const { SlashCommandBuilder, PermissionFlagsBits, ChannelType } = require('discord.js');
const { card, field, wide, ICONS, code, subtext, bullets, actionButton, buttonRows, ButtonStyle } = require('../../utils/ui');
const { UserError } = require('../../core/errors');

function assertManageChannels(interaction) {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageChannels)) {
    throw new UserError('Il faut la permission **Gérer les salons** pour configurer les vocaux temporaires.');
  }
}

/** Panneau d'état du système de vocaux temporaires (+ boutons). */
function statusPanel(client, guild, { notice } = {}) {
  const cfg = client.services.config.get(guild.id).tempVoice ?? {};
  const active = client.services.tempVoice.listByGuild?.(guild.id) ?? [];
  const hubOk = cfg.hubChannelId && guild.channels.cache.has(cfg.hubChannelId);
  const enabled = Boolean(cfg.enabled && cfg.hubChannelId);
  const shown = active.slice(0, 10).map((r) => `<#${r.channel_id}> · <@${r.owner_id}>`);
  return {
    embeds: [
      card({
        tone: enabled ? (hubOk ? 'info' : 'warning') : 'neutral',
        section: 'voice',
        icon: ICONS.voice,
        title: 'Vocaux temporaires',
        description: [
          notice ?? null,
          enabled
            ? `Rejoignez ${hubOk ? `<#${cfg.hubChannelId}>` : 'le salon hub'} pour créer automatiquement votre propre vocal, supprimé dès qu'il est vide.`
            : 'Le système est **désactivé**. Configurez-le avec `/tempvoice setup`.',
          enabled && !hubOk ? `${ICONS.warning} Le salon hub configuré est introuvable : relancez \`/tempvoice setup\`.` : null,
        ],
        fields: [
          field(ICONS.status, 'État', enabled ? '🟢 Activé' : '⚫ Désactivé'),
          field(ICONS.voice, 'Hub', cfg.hubChannelId ? `<#${cfg.hubChannelId}>` : '—'),
          field(ICONS.category, 'Catégorie', cfg.categoryId ? `<#${cfg.categoryId}>` : '*Celle du hub*'),
          field(ICONS.tag, 'Nom des salons', code(cfg.nameTemplate || 'Vocal de {user}')),
          field(ICONS.count, 'Vocaux actifs', `**${active.length}**`),
          active.length ? wide(ICONS.list, 'En cours', `${bullets(shown)}${active.length > 10 ? `\n${subtext(`+${active.length - 10} autre(s)`)}` : ''}`) : null,
        ],
      }),
    ],
    components: buttonRows(
      actionButton({ command: 'tempvoice', action: 'refresh', label: 'Actualiser', emoji: ICONS.refresh }),
      cfg.hubChannelId
        ? actionButton({
            command: 'tempvoice',
            action: 'toggle',
            label: enabled ? 'Désactiver' : 'Activer',
            emoji: enabled ? '⏸️' : '▶️',
            style: enabled ? ButtonStyle.Danger : ButtonStyle.Success,
          })
        : null,
    ),
  };
}

module.exports = {
  category: 'voice',
  statusPanel,
  data: new SlashCommandBuilder()
    .setName('tempvoice')
    .setDescription('Configure les salons vocaux temporaires (join-to-create).')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .addSubcommand((s) =>
      s.setName('setup').setDescription('Active le système avec un salon hub.')
        .addChannelOption((o) => o.setName('hub').setDescription('Salon vocal "Créer un vocal"').addChannelTypes(ChannelType.GuildVoice).setRequired(true))
        .addChannelOption((o) => o.setName('categorie').setDescription('Catégorie où créer les vocaux').addChannelTypes(ChannelType.GuildCategory)))
    .addSubcommand((s) => s.setName('disable').setDescription('Désactive les vocaux temporaires.'))
    .addSubcommand((s) => s.setName('status').setDescription('Affiche l\'état du système.')),

  async execute(interaction, client) {
    const sub = interaction.options.getSubcommand();
    const { config } = client.services;
    const guildId = interaction.guild.id;

    if (sub === 'setup') {
      const hub = interaction.options.getChannel('hub');
      const category = interaction.options.getChannel('categorie');
      config.update(guildId, { tempVoice: { enabled: true, hubChannelId: hub.id, categoryId: category?.id ?? null } });
      return interaction.reply({
        ...statusPanel(client, interaction.guild, { notice: `${ICONS.success} **Vocaux temporaires activés.**` }),
        ephemeral: true,
      });
    }
    if (sub === 'disable') {
      config.update(guildId, { tempVoice: { enabled: false } });
      return interaction.reply({
        ...statusPanel(client, interaction.guild, { notice: `${ICONS.info} **Vocaux temporaires désactivés.** Les vocaux existants restent jusqu'à ce qu'ils se vident.` }),
        ephemeral: true,
      });
    }
    return interaction.reply({ ...statusPanel(client, interaction.guild), ephemeral: true });
  },

  buttons: {
    /** cmd:tempvoice:refresh — réaffiche l'état. */
    async refresh(interaction, client) {
      assertManageChannels(interaction);
      await interaction.update(statusPanel(client, interaction.guild));
    },
    /** cmd:tempvoice:toggle — active/désactive (hub déjà configuré). */
    async toggle(interaction, client) {
      assertManageChannels(interaction);
      const { config } = client.services;
      const cfg = config.get(interaction.guildId).tempVoice ?? {};
      if (!cfg.hubChannelId) throw new UserError('Aucun salon hub configuré : utilisez `/tempvoice setup`.');
      const enabled = !cfg.enabled;
      config.update(interaction.guildId, { tempVoice: { enabled } });
      await interaction.update(
        statusPanel(client, interaction.guild, { notice: enabled ? `${ICONS.success} **Vocaux temporaires activés.**` : `${ICONS.info} **Vocaux temporaires désactivés.**` }),
      );
    },
  },
};
