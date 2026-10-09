'use strict';

const { SlashCommandBuilder } = require('discord.js');
const { card, field, ICONS, status, actionButton, buttonRows, userLine, ButtonStyle } = require('../../utils/ui');
const { UserError } = require('../../core/errors');

/** Délai au-delà duquel un renommage est considéré « en file » (Discord : 2 renommages / 10 min par salon). */
const RENAME_TIMEOUT_MS = 5_000;

/** Promesse résolue à `fallback` si elle n'aboutit pas à temps (la requête continue). */
function withTimeout(promise, ms, fallback) {
  let timer;
  return Promise.race([promise, new Promise((resolve) => (timer = setTimeout(() => resolve(fallback), ms)))]).finally(() => clearTimeout(timer));
}

const isRateLimit = (err) => err?.status === 429 || err?.name === 'RateLimitError' || /rate ?limit/i.test(err?.message ?? '');

/** Sous-commandes de configuration déplacées vers le tableau de bord /tickets → vue cible. */
const MOVED = { setup: 'setup', panel: 'panel' };

/** Redirection vers /tickets (anciennes sous-commandes de configuration). */
function movedReply(sub) {
  return {
    embeds: [
      status.note(
        `La configuration des tickets se fait désormais dans le tableau de bord **/tickets** : ${sub === 'panel' ? 'section **Panneau**, bouton « Publier le panneau »' : 'section **Salons & staff**'}.`,
        'Commande déplacée',
      ),
    ],
    components: buttonRows(actionButton({ command: 'tickets', action: 'go', args: [MOVED[sub]], label: 'Ouvrir /tickets', emoji: ICONS.ticket, style: ButtonStyle.Primary })),
    ephemeral: true,
  };
}

module.exports = {
  category: 'tickets',
  movedReply,
  renameTimeoutMs: RENAME_TIMEOUT_MS,
  data: new SlashCommandBuilder()
    .setName('ticket')
    .setDescription('Actions dans un ticket (fermer, ajouter, renommer…). Configuration : /tickets.')
    .addSubcommand((s) => s.setName('setup').setDescription('Déplacé : la configuration se fait avec /tickets.'))
    .addSubcommand((s) => s.setName('panel').setDescription('Déplacé : publiez le panneau depuis /tickets.'))
    .addSubcommand((s) => s.setName('close').setDescription('Ferme le ticket actuel.'))
    .addSubcommand((s) => s.setName('claim').setDescription('Prend en charge le ticket actuel.'))
    .addSubcommand((s) => s.setName('transcript').setDescription('Génère le transcript du ticket.'))
    .addSubcommand((s) =>
      s.setName('add').setDescription('Ajoute un membre au ticket.').addUserOption((o) => o.setName('membre').setDescription('Membre à ajouter ou retirer de ce ticket').setRequired(true)))
    .addSubcommand((s) =>
      s.setName('remove').setDescription('Retire un membre du ticket.').addUserOption((o) => o.setName('membre').setDescription('Membre à ajouter ou retirer de ce ticket').setRequired(true)))
    .addSubcommand((s) =>
      s.setName('rename').setDescription('Renomme le ticket.').addStringOption((o) => o.setName('nom').setDescription('Nouveau nom').setRequired(true).setMaxLength(90))),

  async execute(interaction, client) {
    const sub = interaction.options.getSubcommand();
    const { tickets } = client.services;

    // Configuration déplacée vers le tableau de bord /tickets.
    if (Object.hasOwn(MOVED, sub)) return interaction.reply(movedReply(sub));

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
      const name = interaction.options.getString('nom').slice(0, 90);
      const before = interaction.channel.name;
      // Discord limite les renommages (2 / 10 min par salon) : la requête peut rester
      // en file plusieurs minutes. On accuse réception tout de suite et on n'attend pas indéfiniment.
      await interaction.deferReply();
      let result;
      try {
        result = await withTimeout(interaction.channel.setName(name, `Ticket renommé par ${interaction.user.tag ?? interaction.user.id}`), module.exports.renameTimeoutMs, 'queued');
      } catch (err) {
        if (isRateLimit(err)) throw new UserError('Discord limite les renommages de ce salon : réessayez dans quelques minutes.');
        throw err;
      }
      if (result === 'queued') {
        return interaction.editReply({
          embeds: [status.warn(`Renommage limité par Discord (2 toutes les 10 minutes par salon) : le nom **${name}** sera appliqué dès que possible.`, 'Renommage en attente')],
        });
      }
      return interaction.editReply({
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
