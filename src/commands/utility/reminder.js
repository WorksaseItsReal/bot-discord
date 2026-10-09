'use strict';

const { SlashCommandBuilder } = require('discord.js');
const { truncate } = require('../../utils/embeds');
const { parseDuration, discordTimestamp } = require('../../utils/time');
const { card, field, wide, ICONS, subtext, status, actionButton, buttonRows, ButtonStyle } = require('../../utils/ui');
const { assertInvoker } = require('../../utils/buttonGuard');
const { UserError } = require('../../core/errors');

const REMINDER_ICON = '⏰';
const MAX_LISTED = 10;
/** Rappels en cours au maximum par utilisateur (évite de remplir la base et le planificateur). */
const MAX_ACTIVE_REMINDERS = 25;

/** Carte « Vos rappels » + un bouton d'annulation par rappel affiché. Pur. */
function renderList(list, ownerId) {
  if (!list.length) {
    return { embeds: [status.note('Vous n\'avez aucun rappel en cours. Créez-en un avec `/reminder create`.', 'Rappels')], components: [] };
  }
  const shown = list.slice(0, MAX_LISTED);
  const rest = list.length - shown.length;
  const lines = shown.map((r) => `**#${r.id}** · ${discordTimestamp(r.remind_at, 'R')} — ${truncate(r.message.replace(/\s+/g, ' '), 90)}`);
  return {
    embeds: [
      card({
        tone: 'neutral',
        section: 'utility',
        icon: REMINDER_ICON,
        title: 'Vos rappels',
        description: [...lines, rest > 0 ? subtext(`… et ${rest} autre${rest > 1 ? 's' : ''}.`) : null, '', subtext('Cliquez sur un numéro ci-dessous pour annuler ce rappel.')],
        fields: [
          field(ICONS.count, 'En cours', `**${list.length}**`),
          field(ICONS.next, 'Prochain', discordTimestamp(list[0].remind_at, 'f')),
        ],
      }),
    ],
    components: buttonRows(
      shown.map((r) =>
        actionButton({ command: 'reminder', action: 'cancel', args: [ownerId, r.id, 'l'], label: `#${r.id}`, emoji: ICONS.delete, style: ButtonStyle.Secondary }),
      ),
    ),
  };
}

/**
 * Rappels persistants. La livraison est assurée par le SchedulerService,
 * donc les rappels survivent au redémarrage.
 */
module.exports = {
  category: 'utility',
  renderList,
  MAX_ACTIVE_REMINDERS,
  data: new SlashCommandBuilder()
    .setName('reminder')
    .setDescription('Gère vos rappels.')
    .addSubcommand((s) =>
      s.setName('create').setDescription('Crée un rappel.')
        .addStringOption((o) => o.setName('duree').setDescription('Dans combien de temps ? (ex: 10m, 2h, 1d)').setRequired(true))
        .addStringOption((o) => o.setName('message').setDescription('Message du rappel').setRequired(true).setMaxLength(2000)))
    .addSubcommand((s) => s.setName('list').setDescription('Liste vos rappels.'))
    .addSubcommand((s) => s.setName('delete').setDescription('Supprime un rappel.').addIntegerOption((o) => o.setName('id').setDescription('ID du rappel').setRequired(true))),

  async execute(interaction, client) {
    const sub = interaction.options.getSubcommand();
    const repo = client.repositories.reminders;

    if (sub === 'create') {
      const ms = parseDuration(interaction.options.getString('duree'));
      if (!ms) throw new UserError('Durée invalide (ex: `10m`, `2h`, `1d`).');
      const message = interaction.options.getString('message').trim();
      if (!message) throw new UserError('Le message du rappel ne peut pas être vide.');
      if (message.length > 2000) throw new UserError('Le message du rappel est trop long (2000 caractères max).');
      const active = repo.listByUser(interaction.user.id).length;
      if (active >= MAX_ACTIVE_REMINDERS) {
        throw new UserError(`Vous avez déjà **${active}** rappels en cours (maximum ${MAX_ACTIVE_REMINDERS}). Supprimez-en avec \`/reminder list\` avant d'en créer un nouveau.`);
      }
      const remindAt = Date.now() + ms;
      const id = repo.create({ guildId: interaction.guildId, channelId: interaction.channelId, userId: interaction.user.id, message, remindAt });
      return interaction.reply({
        embeds: [
          card({
            tone: 'success',
            section: 'utility',
            icon: REMINDER_ICON,
            title: 'Rappel programmé',
            description: [`Je vous le rappellerai ${discordTimestamp(remindAt, 'R')}.`, subtext('Le rappel est conservé même si le bot redémarre.')],
            fields: [
              field(ICONS.id, 'Numéro', `**#${id}**`),
              field(ICONS.date, 'Échéance', discordTimestamp(remindAt, 'f')),
              field(ICONS.channel, 'Salon', interaction.channelId ? `<#${interaction.channelId}>` : 'Messages privés'),
              wide(ICONS.reason, 'Message', truncate(message, 1000)),
            ],
          }),
        ],
        components: buttonRows(
          actionButton({ command: 'reminder', action: 'cancel', args: [interaction.user.id, id, 'c'], label: 'Annuler', emoji: ICONS.delete, style: ButtonStyle.Danger }),
        ),
        ephemeral: true,
      });
    }
    if (sub === 'list') {
      return interaction.reply({ ...renderList(repo.listByUser(interaction.user.id), interaction.user.id), ephemeral: true });
    }
    if (sub === 'delete') {
      const id = interaction.options.getInteger('id');
      if (!repo.delete(id, interaction.user.id)) throw new UserError('Rappel introuvable (ou pas le vôtre).');
      return interaction.reply({ embeds: [status.ok(`Le rappel **#${id}** est supprimé.`)], ephemeral: true });
    }
  },

  buttons: {
    /** cmd:reminder:cancel:<ownerId>:<id>:<c|l> — annule un rappel (c : depuis la création, l : depuis la liste). */
    async cancel(interaction, client, [ownerId, rawId, mode]) {
      assertInvoker(interaction, ownerId, 'Seule la personne qui a créé ce rappel peut l\'annuler.');
      if (!/^\d{1,12}$/.test(rawId ?? '') || !['c', 'l'].includes(mode)) throw new UserError('Ce bouton est invalide. Utilisez `/reminder list`.');
      const repo = client.repositories.reminders;
      const id = Number(rawId);
      if (!repo.delete(id, ownerId)) throw new UserError(`Le rappel **#${id}** n'existe plus (déjà envoyé ou supprimé).`);
      if (mode === 'l') return interaction.update(renderList(repo.listByUser(ownerId), ownerId));
      await interaction.update({ embeds: [status.ok(`Le rappel **#${id}** est annulé.`, 'Rappel annulé')], components: [] });
    },
  },
};
