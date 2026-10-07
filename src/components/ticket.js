'use strict';

const { card, field, ICONS, linkButton, buttonRows, status, subtext } = require('../utils/ui');
const { button, row, ButtonStyle } = require('../utils/components');
const { UserError } = require('../core/errors');

/**
 * Boutons et menus persistants du système de tickets.
 * customIds : ticket:create | ticket:open (menu des motifs) | ticket:claim |
 *             ticket:close | ticket:closeconfirm | ticket:closecancel | ticket:transcript
 * (les anciens messages ne contiennent que create/claim/close : toujours pris en charge)
 */

/** Ouvre le ticket et répond (éphémère) avec le lien du salon. */
async function openTicket(interaction, client, reason) {
  const { tickets } = client.services;
  const channel = await tickets.create(interaction.guild, interaction.user, { reason });
  return interaction.editReply({
    embeds: [tickets.createdReply(channel)],
    components: channel.url ? buttonRows(linkButton('Accéder au ticket', channel.url, ICONS.ticket)) : [],
  });
}

/** Carte de confirmation de fermeture (éphémère). */
function closeConfirmation(client, guildId) {
  const logChannel = client.services.config.get(guildId).tickets?.logChannel;
  return {
    embeds: [
      card({
        tone: 'warning',
        section: 'tickets',
        icon: ICONS.lock,
        title: 'Fermer ce ticket ?',
        description: [
          'Le salon sera **supprimé** 5 secondes après confirmation.',
          logChannel
            ? `Le transcript sera archivé dans <#${logChannel}>.`
            : `${ICONS.warning} Aucun salon de transcripts n'est configuré : téléchargez le transcript avant de fermer si besoin.`,
          subtext('Cette action est définitive.'),
        ],
      }),
    ],
    components: [
      row(
        button({ id: 'ticket:closeconfirm', label: 'Fermer le ticket', style: ButtonStyle.Danger, emoji: ICONS.lock }),
        button({ id: 'ticket:transcript', label: 'Transcript', style: ButtonStyle.Secondary, emoji: '📄' }),
        button({ id: 'ticket:closecancel', label: 'Annuler', style: ButtonStyle.Secondary, emoji: ICONS.back }),
      ),
    ],
    ephemeral: true,
  };
}

module.exports = {
  id: 'ticket',
  closeConfirmation,
  /** @param {import('discord.js').ButtonInteraction | import('discord.js').StringSelectMenuInteraction} interaction */
  async execute(interaction, client) {
    const isSelect = interaction.isStringSelectMenu?.() ?? false;
    if (!interaction.isButton() && !isSelect) return;
    const action = interaction.customId.split(':')[1];
    const { tickets } = client.services;

    if (action === 'create') {
      // Motifs configurés : on demande d'abord le motif (menu éphémère).
      const reasons = client.services.config.get(interaction.guildId).tickets?.reasons ?? [];
      if (reasons.length) {
        return interaction.reply({
          embeds: [status.note('Choisissez le motif de votre demande pour ouvrir un ticket.', 'Ouvrir un ticket')],
          components: [tickets.reasonMenu(reasons)],
          ephemeral: true,
        });
      }
      await interaction.deferReply({ ephemeral: true });
      return openTicket(interaction, client, null);
    }

    if (action === 'open') {
      if (!isSelect) return;
      const value = interaction.values?.[0];
      const reasons = client.services.config.get(interaction.guildId).tickets?.reasons ?? [];
      const reason = reasons.find((r) => r.value === value)?.label ?? null;
      await interaction.deferReply({ ephemeral: true });
      return openTicket(interaction, client, reason);
    }

    if (action === 'closecancel') {
      return interaction.update({ embeds: [status.note('Fermeture annulée : le ticket reste ouvert.')], components: [] });
    }

    const record = client.repositories.tickets.getByChannel(interaction.channelId);
    if (!record) throw new UserError('Ce salon n\'est plus un ticket actif.');

    if (action === 'claim') {
      // La vérification « support » est refaite par le service.
      await interaction.deferUpdate();
      await tickets.claim(interaction.channel, interaction.member, { message: interaction.message });
      return;
    }
    if (action === 'transcript') {
      tickets.assertParticipant(interaction.member, record);
      await interaction.deferReply({ ephemeral: true });
      return interaction.editReply(await tickets.transcriptPayload(interaction.channel));
    }
    if (action === 'close') {
      tickets.assertParticipant(interaction.member, record);
      return interaction.reply(closeConfirmation(client, interaction.guildId));
    }
    if (action === 'closeconfirm') {
      tickets.assertParticipant(interaction.member, record);
      // Un second clic pendant le délai est refusé par le service (UserError).
      await tickets.close(interaction.channel, interaction.user, {
        delayMs: 5000,
        onAccepted: () =>
          interaction.update({
            embeds: [card({ tone: 'neutral', icon: ICONS.lock, title: 'Fermeture en cours', description: 'Le ticket sera supprimé dans **5 secondes**.', fields: [field(ICONS.user, 'Fermé par', `${interaction.user}`)] })],
            components: [],
          }),
      });
    }
  },
};
