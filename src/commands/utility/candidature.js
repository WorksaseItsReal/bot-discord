'use strict';

const { SlashCommandBuilder } = require('discord.js');
const { truncate } = require('../../utils/embeds');
const { card, field, ICONS, subtext, code, status, actionButton, buttonRows, ButtonStyle } = require('../../utils/ui');
const { ApplicationService, SECTION, APP_ICON, STATUS, MAX_QUESTIONS } = require('../../services/ApplicationService');
const { UserError } = require('../../core/errors');

/**
 * /candidature : suivi de ses candidatures (statut, retrait) et routes publiques du panneau.
 *
 *   cmd:candidature:apply:<formulaire>     bouton « Postuler » du panneau (ouvre le formulaire Discord)
 *   cmd:candidature:submit:<formulaire>    envoi du formulaire Discord
 *   cmd:candidature:withdraw:<candidature> retrait d'une candidature en attente (son auteur)
 */

const SHOWN = 10;
const svc = (client) => client.services.applications;
const ID = /^\d{1,12}$/;

/** Suivi des candidatures d'un membre (boutons de retrait pour celles en attente). */
function statusView(client, guild, userId, notice) {
  const apps = svc(client).ofMember(guild.id, userId, SHOWN);
  const pending = apps.filter((a) => a.status === 'pending');
  return {
    embeds: [
      card({
        tone: pending.length ? 'warning' : apps.length ? 'info' : 'neutral',
        section: SECTION,
        icon: APP_ICON,
        title: 'Mes candidatures',
        description: [
          notice ? `${notice}\n` : null,
          apps.length ? ApplicationService.memberLines(apps).join('\n') : 'Vous n\'avez envoyé aucune candidature sur ce serveur.',
          '',
          subtext('Les décisions vous sont envoyées en message privé. Postulez depuis le panneau « Postuler » d\'un formulaire.'),
        ],
        fields: [
          field('🟡', 'En attente', `**${pending.length}**`),
          field(ICONS.success, 'Acceptées', `**${apps.filter((a) => a.status === 'accepted').length}**`),
          field('🚫', 'Refusées', `**${apps.filter((a) => a.status === 'rejected').length}**`),
        ],
        footer: apps.length >= SHOWN ? `${SHOWN} dernières candidatures` : undefined,
      }),
    ],
    components: buttonRows(
      pending.slice(0, 5).map((a) => actionButton({ command: 'candidature', action: 'withdraw', args: [a.id], label: `Retirer #${a.id}`, emoji: '↩️', style: ButtonStyle.Danger })),
    ),
  };
}

/** Retire une candidature, met à jour la carte du staff et journalise (après la réponse). */
async function afterWithdraw(client, guild, app, user) {
  const service = svc(client);
  await service.refreshCard(guild, app);
  await service.log(guild, app, { title: 'Candidature retirée', tone: 'neutral', description: `↩️ ${user} a retiré sa candidature **${truncate(app.form_name, 100)}**.` });
}

module.exports = {
  category: 'utility',
  cooldown: 3_000,
  statusView,
  data: new SlashCommandBuilder()
    .setName('candidature')
    .setDescription('Suivez vos candidatures (statut) ou retirez une candidature en attente.')
    .addSubcommand((s) => s.setName('statut').setDescription('Affiche vos candidatures sur ce serveur et leur statut.'))
    .addSubcommand((s) =>
      s.setName('retirer').setDescription('Retire une de vos candidatures encore en attente.')
        .addIntegerOption((o) => o.setName('candidature').setDescription('Numéro de la candidature en attente à retirer (vide : liste)').setMinValue(1).setAutocomplete(true))),

  async execute(interaction, client) {
    const sub = interaction.options.getSubcommand();
    if (sub === 'statut') {
      return interaction.reply({ ...statusView(client, interaction.guild, interaction.user.id), ephemeral: true });
    }
    // retirer
    const id = interaction.options.getInteger('candidature');
    if (!id) {
      const pending = client.repositories.applications.listPendingOfMember(interaction.guildId, interaction.user.id, 5);
      if (!pending.length) return interaction.reply({ embeds: [status.note('Vous n\'avez aucune candidature en attente.', 'Candidatures')], ephemeral: true });
      return interaction.reply({ ...statusView(client, interaction.guild, interaction.user.id, `${ICONS.info} Choisissez la candidature à retirer.`), ephemeral: true });
    }
    const app = svc(client).withdraw(interaction.guild, interaction.user.id, id);
    await interaction.reply({ embeds: [status.ok(`Votre candidature **${truncate(app.form_name, 100)}** (${code(`#${app.id}`)}) est retirée.`, 'Candidature retirée')], ephemeral: true });
    await afterWithdraw(client, interaction.guild, app, interaction.user);
  },

  /** Candidatures en attente de l'utilisateur. */
  async autocomplete(interaction, client) {
    const typed = String(interaction.options.getFocused() ?? '').toLowerCase();
    const pending = client.repositories.applications.listPendingOfMember(interaction.guildId, interaction.user.id, 25);
    await interaction.respond(
      pending
        .filter((a) => !typed || String(a.id).includes(typed) || a.form_name.toLowerCase().includes(typed))
        .slice(0, 25)
        .map((a) => ({ name: truncate(`#${a.id} · ${a.form_name}`, 100), value: a.id })),
    );
  },

  buttons: {
    /** cmd:candidature:apply:<formulaire> — bouton « Postuler » du panneau. */
    async apply(interaction, client, [formId]) {
      if (!ID.test(formId ?? '')) throw new UserError('Ce bouton est invalide.');
      const service = svc(client);
      const form = service.form(interaction.guildId, formId);
      if (interaction.user.bot) throw new UserError('Les bots ne peuvent pas postuler.');
      service.assertCanApply(interaction.guild, interaction.user.id, form);
      await interaction.showModal(service.applyModal(form));
    },
    /** cmd:candidature:submit:<formulaire> — réponses envoyées. */
    async submit(interaction, client, [formId]) {
      if (!ID.test(formId ?? '')) throw new UserError('Ce formulaire est invalide.');
      const service = svc(client);
      const form = service.form(interaction.guildId, formId);
      const raw = Array.from({ length: Math.min(form.questions.length, MAX_QUESTIONS) }, (_, i) => {
        try {
          return interaction.fields.getTextInputValue(`q${i}`) ?? '';
        } catch {
          return '';
        }
      });
      // Contrôles synchrones avant d'accuser réception (refus immédiat et clair).
      service.assertCanApply(interaction.guild, interaction.user.id, form);
      ApplicationService.answers(form, raw);
      await interaction.deferReply({ ephemeral: true });
      const app = await service.submit(interaction.guild, interaction.user, form, raw);
      await interaction.editReply({
        embeds: [
          card({
            tone: 'success',
            section: SECTION,
            icon: ICONS.success,
            title: 'Candidature envoyée',
            description: [
              `Votre candidature **${truncate(form.name, 100)}** a été transmise à l'équipe. Merci !`,
              subtext('La décision vous sera envoyée en message privé : gardez-les ouverts pour ce serveur.'),
            ],
            fields: [field(APP_ICON, 'Numéro', code(`#${app.id}`)), field('🟡', 'Statut', STATUS.pending.label), field(ICONS.list, 'Suivi', '/candidature statut')],
          }),
        ],
      });
    },
    /** cmd:candidature:withdraw:<candidature> — retrait par son auteur. */
    async withdraw(interaction, client, [id]) {
      if (!ID.test(id ?? '')) throw new UserError('Ce bouton est invalide.');
      const app = svc(client).withdraw(interaction.guild, interaction.user.id, id);
      await interaction.update(statusView(client, interaction.guild, interaction.user.id, `${ICONS.success} Candidature ${code(`#${app.id}`)} retirée.`));
      await afterWithdraw(client, interaction.guild, app, interaction.user);
    },
  },
};
