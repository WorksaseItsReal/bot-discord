'use strict';

const { SlashCommandBuilder, PermissionFlagsBits, ChannelType, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } = require('discord.js');
const { card, field, ICONS, status, subtext } = require('../../utils/ui');
const { UserError } = require('../../core/errors');

/** customId du formulaire de réponse (routé vers buttons.send par components/cmd.js). */
const REPLY_MODAL_ID = 'cmd:modmail:send';

module.exports = {
  category: 'tickets',
  data: new SlashCommandBuilder()
    .setName('modmail')
    .setDescription('Système ModMail (DM ↔ staff).')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .addSubcommand((s) =>
      s.setName('setup').setDescription('Configure et active le ModMail.')
        .addChannelOption((o) => o.setName('categorie').setDescription('Catégorie des conversations').addChannelTypes(ChannelType.GuildCategory))
        .addRoleOption((o) => o.setName('role_staff').setDescription('Rôle staff'))
        .addBooleanOption((o) => o.setName('actif').setDescription('Activer ?')))
    .addSubcommand((s) =>
      s.setName('reply').setDescription('Répond à la conversation ModMail actuelle.')
        .addStringOption((o) => o.setName('message').setDescription('Message').setRequired(true).setMaxLength(2000)))
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
      const cfg = config.get(interaction.guild.id).modmail ?? {};
      return interaction.reply({
        embeds: [
          card({
            tone: cfg.enabled ? 'success' : 'neutral',
            section: 'tickets',
            icon: ICONS.mail,
            title: cfg.enabled ? 'ModMail activé' : 'ModMail configuré (inactif)',
            description: [
              cfg.enabled
                ? 'Les membres peuvent désormais écrire au bot en message privé pour contacter le staff.'
                : 'La configuration est enregistrée. Activez le ModMail avec l\'option `actif`.',
              subtext('Chaque conversation ouvre un salon privé visible du staff.'),
            ],
            fields: [
              field(ICONS.status, 'État', cfg.enabled ? '🟢 Actif' : '⚫ Inactif'),
              field(ICONS.category, 'Catégorie', cfg.categoryId ? `<#${cfg.categoryId}>` : '*Aucune*'),
              field(ICONS.role, 'Staff', cfg.staffRoleId ? `<@&${cfg.staffRoleId}>` : '*Gérer les messages*'),
            ],
          }),
        ],
        ephemeral: true,
      });
    }
    if (sub === 'reply') {
      await interaction.deferReply({ ephemeral: true });
      await modmail.reply(interaction.channel, interaction.user, interaction.options.getString('message'));
      return interaction.editReply({ embeds: [status.ok('Votre réponse a été envoyée en message privé.', 'Réponse envoyée')] });
    }
    if (sub === 'close') {
      if (!modmailThread(client, interaction.channel.id)) throw new UserError('Ce salon n\'est pas une conversation ModMail.');
      await interaction.reply({ embeds: [closingCard()], ephemeral: true });
      return modmail.close(interaction.channel);
    }
  },

  buttons: {
    /** cmd:modmail:reply — ouvre le formulaire de réponse (staff uniquement). */
    async reply(interaction, client) {
      const { modmail } = client.services;
      modmail.assertStaff(interaction.member);
      const thread = modmailThread(client, interaction.channelId);
      if (!thread || thread.status !== 'open') throw new UserError('Cette conversation ModMail est fermée.');
      const modal = new ModalBuilder()
        .setCustomId(REPLY_MODAL_ID)
        .setTitle('Répondre au membre')
        .addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('message')
              .setLabel('Votre réponse (envoyée en MP)')
              .setStyle(TextInputStyle.Paragraph)
              .setMaxLength(2000)
              .setRequired(true),
          ),
        );
      await interaction.showModal(modal);
    },

    /** cmd:modmail:send — soumission du formulaire de réponse. */
    async send(interaction, client) {
      if (!interaction.isModalSubmit?.()) return interaction.deferUpdate().catch(() => {});
      const { modmail } = client.services;
      modmail.assertStaff(interaction.member);
      const content = interaction.fields.getTextInputValue('message');
      await interaction.deferReply({ ephemeral: true });
      await modmail.reply(interaction.channel, interaction.user, content);
      return interaction.editReply({ embeds: [status.ok('Votre réponse a été envoyée en message privé.', 'Réponse envoyée')] });
    },

    /** cmd:modmail:close — ferme la conversation (staff uniquement). */
    async close(interaction, client) {
      const { modmail } = client.services;
      modmail.assertStaff(interaction.member);
      if (!modmailThread(client, interaction.channelId)) throw new UserError('Ce salon n\'est pas une conversation ModMail.');
      await interaction.reply({ embeds: [closingCard()], ephemeral: true });
      return modmail.close(interaction.channel);
    },
  },
};

function modmailThread(client, channelId) {
  return client.services.modmail.modmail?.getByChannel?.(channelId) ?? null;
}

function closingCard() {
  return card({
    tone: 'neutral',
    section: 'tickets',
    icon: ICONS.lock,
    title: 'Fermeture de la conversation',
    description: 'Le membre est prévenu en message privé, puis ce salon est supprimé.',
  });
}
