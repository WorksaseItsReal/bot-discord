'use strict';

const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ChannelSelectMenuBuilder,
  RoleSelectMenuBuilder,
} = require('discord.js');
const { truncate } = require('../../utils/embeds');
const { card, field, wide, ICONS, subtext, code, status, actionButton, linkButton, buttonRows, ButtonStyle } = require('../../utils/ui');
const { discordTimestamp } = require('../../utils/time');
const { requirePermission } = require('../../services/ModerationService');
const {
  SECTION,
  APP_ICON,
  INTERVIEW_ICON,
  MAX_FORMS,
  MAX_ROLES,
  MAX_REASON,
  MAX_NAME,
  MAX_DESCRIPTION,
  TEXT_TYPES,
  parseName,
  parseDescription,
  parseQuestions,
  questionsToText,
  parseCooldown,
  formatCooldown,
  cooldownToInput,
  canReview,
  messageLink,
  questionLine,
} = require('../../services/ApplicationService');
const { UserError } = require('../../core/errors');

/**
 * /candidatures : tableau de bord (éphémère, « Gérer le serveur ») des formulaires de
 * candidature, et actions du staff sur les cartes publiées dans le salon de réception.
 *
 *   Vues : home · pending · form.<id> · confirmDel.<id>
 *   cmd:candidatures:accept:<id>        accepter (rôles du formulaire + MP)
 *   cmd:candidatures:reject:<id>        refuser (formulaire de motif, puis rejectsubmit)
 *   cmd:candidatures:interview:<id>     entretien (ticket, sinon fil privé)
 */

const SNOWFLAKE = /^\d{17,20}$/;
const PENDING_SHOWN = 15;

const guard = (interaction) => requirePermission(interaction, 'ManageGuild');
/** Actions sur les cartes : « Gérer le serveur » ou « Gérer les rôles ». */
function guardReview(interaction) {
  if (!canReview(interaction.memberPermissions)) {
    throw new UserError('Il faut la permission **Gérer les rôles** (ou **Gérer le serveur**) pour traiter les candidatures.');
  }
}
const svc = (client) => client.services.applications;
const row = (component) => new ActionRowBuilder().addComponents(component);
const homeButton = () => actionButton({ command: 'candidatures', action: 'go', args: ['home'], label: 'Accueil', emoji: '🏠' });

const NAV = [
  { value: 'home', label: 'Accueil', emoji: '🏠', description: 'Formulaires et chiffres clés' },
  { value: 'pending', label: 'En attente', emoji: '🟡', description: 'Candidatures à traiter, avec liens' },
];

function navRow(current) {
  return row(
    new StringSelectMenuBuilder()
      .setCustomId('cmd:candidatures:nav')
      .setPlaceholder('Aller à…')
      .addOptions(NAV.map((o) => ({ ...o, default: o.value === current }))),
  );
}

const input = (id, label, { value, placeholder, style = TextInputStyle.Short, max = 100, required = false } = {}) => {
  const t = new TextInputBuilder().setCustomId(id).setLabel(truncate(label, 45)).setStyle(style).setMaxLength(max).setRequired(required);
  if (value != null && String(value) !== '') t.setValue(String(value).slice(0, max));
  if (placeholder) t.setPlaceholder(placeholder.slice(0, 100));
  return row(t);
};

function textField(interaction, id) {
  try {
    const v = interaction.fields.getTextInputValue(id)?.trim();
    return v || undefined;
  } catch {
    return undefined;
  }
}

/** Valeur voulue par un bouton « on/off ». */
const target = (state) => {
  if (state !== 'on' && state !== 'off') throw new UserError('Ce bouton est invalide.');
  return state === 'on';
};

/** Le bot peut-il écrire dans ce salon ? (null si oui, sinon un avertissement) */
function sendWarning(guild, channel) {
  const me = guild.members?.me;
  const perms = me && channel?.permissionsFor?.(me);
  if (perms && !perms.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) {
    return `${ICONS.warning} Je ne peux pas écrire dans <#${channel.id}> : donnez-moi **Voir**, **Envoyer** et **Intégrer des liens**.`;
  }
  return null;
}

// ---------------------------------------------------------------- vues

function homeView(client, guild, notice) {
  const forms = svc(client).forms(guild.id);
  const repo = client.repositories.applications;
  const counts = repo.counts(guild.id);
  const perForm = repo.pendingPerForm(guild.id);
  const lines = forms.map((f) => {
    const problem = svc(client).reviewProblem(guild, f);
    const pending = perForm.get(f.id) ?? 0;
    return `${f.open ? '🟢' : '🔴'} **${truncate(f.name, 60)}** · ${f.questions.length} question(s)${pending ? ` · 🟡 **${pending}** en attente` : ''}${problem ? ` · ${ICONS.warning} *${problem}*` : ''}`;
  });
  const components = [navRow('home')];
  if (forms.length) {
    components.push(row(
      new StringSelectMenuBuilder()
        .setCustomId('cmd:candidatures:pick')
        .setPlaceholder('Configurer un formulaire…')
        .addOptions(forms.map((f) => ({
          value: String(f.id),
          label: truncate(f.name, 100),
          description: truncate(`${f.open ? 'Ouvert' : 'Fermé'} · ${f.questions.length} question(s)${perForm.get(f.id) ? ` · ${perForm.get(f.id)} en attente` : ''}`, 100),
          emoji: f.open ? '🟢' : '🔴',
        }))),
    ));
  }
  components.push(...buttonRows(
    actionButton({ command: 'candidatures', action: 'create', label: 'Nouveau formulaire', emoji: '➕', style: ButtonStyle.Primary, disabled: forms.length >= MAX_FORMS }),
    actionButton({ command: 'candidatures', action: 'go', args: ['pending'], label: 'En attente', emoji: '🟡' }),
    actionButton({ command: 'candidatures', action: 'go', args: ['home'], label: 'Actualiser', emoji: ICONS.refresh }),
  ));
  return {
    embeds: [
      card({
        tone: forms.some((f) => f.open) ? 'success' : 'neutral',
        section: SECTION,
        icon: APP_ICON,
        title: 'Candidatures · Tableau de bord',
        description: [
          notice ? `${notice}\n` : null,
          'Créez des formulaires (recrutement du staff, d\'une équipe…) : les membres postulent depuis un panneau, l\'équipe accepte, refuse ou ouvre un entretien depuis la carte reçue.',
          '',
          lines.length ? lines.join('\n') : '*Aucun formulaire pour l\'instant : cliquez sur « Nouveau formulaire ».*',
        ],
        fields: [
          field(ICONS.list, 'Formulaires', `${forms.length} / ${MAX_FORMS}`),
          field('🟡', 'En attente', `**${counts.pending}**`),
          field(ICONS.success, 'Acceptées', `**${counts.accepted}**`),
          field('🚫', 'Refusées', `**${counts.rejected}**`),
          field('↩️', 'Retirées', `**${counts.withdrawn}**`),
        ],
        footer: 'Membres : /candidature statut · /candidature retirer',
      }),
    ],
    components,
  };
}

function pendingView(client, guild, notice) {
  const repo = client.repositories.applications;
  const list = repo.listPending(guild.id, PENDING_SHOWN + 1);
  const total = repo.counts(guild.id).pending;
  const lines = list.slice(0, PENDING_SHOWN).map((a) => {
    const link = a.card_channel_id && a.card_message_id ? ` · [Carte](${messageLink(guild.id, a.card_channel_id, a.card_message_id)})` : '';
    return `${code(`#${a.id}`)} · <@${a.user_id}> · **${truncate(a.form_name, 50)}** · ${discordTimestamp(a.created_at, 'R')}${a.interview_channel_id ? ` · ${INTERVIEW_ICON}` : ''}${link}`;
  });
  return {
    embeds: [
      card({
        tone: total ? 'warning' : 'success',
        section: SECTION,
        icon: '🟡',
        title: `Candidatures en attente · ${total}`,
        description: [
          notice ? `${notice}\n` : null,
          lines.length ? lines.join('\n') : 'Aucune candidature en attente. ✨',
          total > PENDING_SHOWN ? subtext(`… et ${total - PENDING_SHOWN} autre(s), les plus récentes.`) : null,
        ],
        footer: 'Traitez-les depuis leur carte, dans le salon de réception',
      }),
    ],
    components: [
      navRow('pending'),
      ...buttonRows(
        actionButton({ command: 'candidatures', action: 'go', args: ['pending'], label: 'Actualiser', emoji: ICONS.refresh, style: ButtonStyle.Primary }),
        homeButton(),
      ),
    ],
  };
}

function formView(client, guild, id, notice) {
  const service = svc(client);
  const form = service.form(guild.id, id);
  const cache = guild.channels?.cache;
  const roleCache = guild.roles?.cache;
  const roles = form.role_ids.filter((r) => !roleCache || roleCache.has(r)).slice(0, MAX_ROLES);
  const pending = client.repositories.applications.pendingPerForm(guild.id).get(form.id) ?? 0;
  const problem = service.reviewProblem(guild, form);
  const panelUrl = form.panel_channel_id && form.panel_message_id ? messageLink(guild.id, form.panel_channel_id, form.panel_message_id) : null;

  const review = new ChannelSelectMenuBuilder()
    .setCustomId(`cmd:candidatures:review:${form.id}`)
    .setPlaceholder('Salon de réception des candidatures (staff)…')
    .setChannelTypes(...TEXT_TYPES)
    .setMinValues(0)
    .setMaxValues(1);
  if (form.review_channel_id && cache?.has(form.review_channel_id)) review.setDefaultChannels(form.review_channel_id);
  const roleMenu = new RoleSelectMenuBuilder().setCustomId(`cmd:candidatures:roles:${form.id}`).setPlaceholder('Rôle(s) donné(s) si accepté (aucun)').setMinValues(0).setMaxValues(MAX_ROLES);
  if (roles.length) roleMenu.setDefaultRoles(...roles);
  const ping = new RoleSelectMenuBuilder().setCustomId(`cmd:candidatures:ping:${form.id}`).setPlaceholder('Rôle pingué à chaque candidature (aucun)').setMinValues(0).setMaxValues(1);
  if (form.ping_role_id && roleCache?.has(form.ping_role_id)) ping.setDefaultRoles(form.ping_role_id);
  const panel = new ChannelSelectMenuBuilder()
    .setCustomId(`cmd:candidatures:panelch:${form.id}`)
    .setPlaceholder('Salon du panneau « Postuler »…')
    .setChannelTypes(...TEXT_TYPES)
    .setMinValues(0)
    .setMaxValues(1);
  if (form.panel_channel_id && cache?.has(form.panel_channel_id)) panel.setDefaultChannels(form.panel_channel_id);

  return {
    embeds: [
      card({
        tone: form.open ? (problem ? 'warning' : 'success') : 'neutral',
        section: SECTION,
        icon: APP_ICON,
        title: `Formulaire · ${form.name}`,
        description: [
          notice ? `${notice}\n` : null,
          form.open ? '🟢 Candidatures **ouvertes**.' : '🔴 Candidatures **fermées** : le bouton « Postuler » est désactivé.',
          form.description ? subtext(truncate(form.description.replace(/\n+/g, ' '), 300)) : null,
          problem ? `\n${ICONS.warning} Pas de réception possible : ${problem}.` : null,
          !problem && service.reviewWarning(guild, form) ? `\n${ICONS.warning} ${service.reviewWarning(guild, form)}` : null,
          !panelUrl ? subtext('Choisissez le salon du panneau puis cliquez sur « Publier ».') : null,
        ],
        fields: [
          field(ICONS.channel, 'Réception', form.review_channel_id ? `<#${form.review_channel_id}>` : '*À choisir*'),
          field('🔔', 'Ping', form.ping_role_id ? `<@&${form.ping_role_id}>` : '*Aucun*'),
          field(ICONS.role, 'Rôles si accepté', roles.length ? roles.map((r) => `<@&${r}>`).join(' ') : '*Aucun*'),
          field(ICONS.duration, 'Délai entre deux', formatCooldown(form.cooldown_ms)),
          field('📣', 'Panneau', panelUrl ? `[Voir](${panelUrl}) · <#${form.panel_channel_id}>` : form.panel_channel_id ? `<#${form.panel_channel_id}> · *non publié*` : '*Non publié*'),
          field('🟡', 'En attente', `**${pending}**`),
          wide(ICONS.list, `Questions (${form.questions.length})`, form.questions.map(questionLine).join('\n') || '*Aucune*'),
        ],
        footer: `Formulaire #${form.id} · ✏️ réponse courte · 📄 réponse longue · 1 candidature en attente par membre`,
      }),
    ],
    components: [
      row(review),
      row(roleMenu),
      row(ping),
      row(panel),
      ...buttonRows(
        actionButton({ command: 'candidatures', action: 'edit', args: [form.id], label: 'Modifier', emoji: '✏️' }),
        form.open
          ? actionButton({ command: 'candidatures', action: 'toggle', args: [form.id, 'off'], label: 'Fermer', emoji: '🔴', style: ButtonStyle.Danger })
          : actionButton({ command: 'candidatures', action: 'toggle', args: [form.id, 'on'], label: 'Ouvrir', emoji: '🟢', style: ButtonStyle.Success }),
        actionButton({ command: 'candidatures', action: 'publish', args: [form.id], label: panelUrl ? 'Republier' : 'Publier', emoji: '📣', style: ButtonStyle.Primary }),
        actionButton({ command: 'candidatures', action: 'go', args: [`confirmDel.${form.id}`], label: 'Supprimer', emoji: ICONS.delete }),
        homeButton(),
      ),
    ],
  };
}

function confirmDeleteView(client, guild, id) {
  const form = svc(client).form(guild.id, id);
  return {
    embeds: [
      card({
        tone: 'danger',
        section: SECTION,
        icon: ICONS.warning,
        title: 'Supprimer ce formulaire ?',
        description: [
          `Le formulaire **${form.name}** sera **définitivement supprimé**, ainsi que son panneau publié.`,
          subtext('Les candidatures déjà traitées restent consultables par leurs auteurs.'),
        ],
      }),
    ],
    components: buttonRows(
      actionButton({ command: 'candidatures', action: 'delete', args: [form.id], label: 'Oui, supprimer', emoji: ICONS.delete, style: ButtonStyle.Danger }),
      actionButton({ command: 'candidatures', action: 'go', args: [`form.${form.id}`], label: 'Annuler', emoji: ICONS.back }),
    ),
  };
}

/** Rend une vue (« form:<id> » depuis un menu, « form.<id> » depuis un bouton). */
function render(client, guild, view = 'home', notice) {
  const [name, arg] = String(view).split(/[:.]/);
  switch (name) {
    case 'pending':
      return pendingView(client, guild, notice);
    case 'form':
      return formView(client, guild, arg, notice);
    case 'confirmDel':
      return confirmDeleteView(client, guild, arg);
    default:
      return homeView(client, guild, notice);
  }
}

// ---------------------------------------------------------------- formulaires Discord

function formModal(form) {
  return new ModalBuilder()
    .setCustomId(form ? `cmd:candidatures:formsubmit:${form.id}` : 'cmd:candidatures:formsubmit')
    .setTitle(form ? 'Modifier le formulaire' : 'Nouveau formulaire')
    .addComponents(
      input('name', `Nom (${MAX_NAME} caractères max.)`, { value: form?.name, max: MAX_NAME, required: true, placeholder: 'Recrutement modération' }),
      input('description', 'Présentation (affichée sur le panneau)', { value: form?.description, max: MAX_DESCRIPTION, style: TextInputStyle.Paragraph, placeholder: 'Nous recrutons des modérateurs motivés…' }),
      input('questions', 'Questions : une par ligne (5 max.)', {
        value: form ? questionsToText(form.questions) : null,
        max: 400,
        style: TextInputStyle.Paragraph,
        required: true,
        placeholder: 'Quel âge avez-vous ?\n+ Pourquoi vous ? (« + » : réponse longue)',
      }),
      input('cooldown', 'Délai entre deux candidatures (ex : 7d)', { value: form ? cooldownToInput(form.cooldown_ms) : '7d', max: 20, placeholder: '7d · 12h · 0 = aucun' }),
    );
}

function rejectModal(appId) {
  return new ModalBuilder()
    .setCustomId(`cmd:candidatures:rejectsubmit:${appId}`)
    .setTitle(`Refuser la candidature #${appId}`.slice(0, 45))
    .addComponents(
      input('motif', 'Motif (envoyé au candidat en MP)', { max: MAX_REASON, style: TextInputStyle.Paragraph, placeholder: 'Merci pour votre candidature ! Nous cherchons…' }),
    );
}

/** Rôle validé d'un sélecteur, ou null. */
function pickRole(interaction) {
  const id = interaction.values?.[0] ?? null;
  if (!id) return null;
  if (!SNOWFLAKE.test(id)) throw new UserError('Rôle invalide.');
  return id;
}

/** Salon textuel validé d'un sélecteur, ou null. */
function pickChannel(interaction) {
  const id = interaction.values?.[0] ?? null;
  if (!id) return null;
  if (!SNOWFLAKE.test(id)) throw new UserError('Salon invalide.');
  const ch = interaction.guild.channels.cache.get(id);
  if (!ch || !TEXT_TYPES.includes(ch.type)) throw new UserError('Choisissez un salon textuel du serveur.');
  return ch;
}

// ---------------------------------------------------------------- commande

module.exports = {
  category: 'configuration',
  cooldown: 3_000,
  render,
  data: new SlashCommandBuilder()
    .setName('candidatures')
    .setDescription('Ouvre le tableau de bord des candidatures : formulaires, panneau, réception, rôles.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction, client) {
    guard(interaction);
    await interaction.reply({ ...render(client, interaction.guild, 'home'), ephemeral: true });
  },

  buttons: {
    /** Menu de navigation. */
    async nav(interaction, client) {
      guard(interaction);
      await interaction.update(render(client, interaction.guild, interaction.values?.[0] ?? 'home'));
    },
    /** cmd:candidatures:go:<vue> */
    async go(interaction, client, [view]) {
      guard(interaction);
      await interaction.update(render(client, interaction.guild, view ?? 'home'));
    },
    /** Menu « Configurer un formulaire ». */
    async pick(interaction, client) {
      guard(interaction);
      await interaction.update(formView(client, interaction.guild, interaction.values?.[0]));
    },

    // ------------------------------------------------------------ formulaires

    async create(interaction, client) {
      guard(interaction);
      if (svc(client).forms(interaction.guildId).length >= MAX_FORMS) throw new UserError(`${MAX_FORMS} formulaires maximum : supprimez-en un d'abord.`);
      await interaction.showModal(formModal(null));
    },
    /** cmd:candidatures:edit:<id> */
    async edit(interaction, client, [id]) {
      guard(interaction);
      await interaction.showModal(formModal(svc(client).form(interaction.guildId, id)));
    },
    /** cmd:candidatures:formsubmit[:<id>] — création ou modification. */
    async formsubmit(interaction, client, [id]) {
      guard(interaction);
      const service = svc(client);
      const current = id ? service.form(interaction.guildId, id) : null;
      const data = {
        name: parseName(textField(interaction, 'name')),
        description: parseDescription(textField(interaction, 'description')),
        questions: parseQuestions(textField(interaction, 'questions')),
        cooldownMs: parseCooldown(textField(interaction, 'cooldown')),
      };
      const duplicate = service.forms(interaction.guildId).find((f) => f.id !== current?.id && f.name.toLowerCase() === data.name.toLowerCase());
      if (duplicate) throw new UserError(`Un formulaire **${duplicate.name}** existe déjà.`);
      if (!current) {
        const form = service.createForm(interaction.guildId, data);
        await interaction.update(formView(client, interaction.guild, form.id, `${ICONS.success} Formulaire **${form.name}** créé (fermé). Choisissez le salon de réception, puis ouvrez-le et publiez son panneau.`));
        return;
      }
      await interaction.deferUpdate();
      const form = service.updateForm(interaction.guildId, current.id, data);
      const refreshed = await service.refreshPanel(interaction.guild, form);
      await interaction.editReply(formView(client, interaction.guild, form.id, `${ICONS.success} Formulaire modifié${refreshed ? ' et panneau mis à jour' : ''}.`));
    },
    /** cmd:candidatures:review:<id> — salon de réception. */
    async review(interaction, client, [id]) {
      guard(interaction);
      const service = svc(client);
      const form = service.form(interaction.guildId, id);
      const ch = pickChannel(interaction);
      service.updateForm(interaction.guildId, form.id, { reviewChannelId: ch?.id ?? null });
      const publicWarning = ch ? service.reviewWarning(interaction.guild, { review_channel_id: ch.id }) : null;
      const notice = ch
        ? sendWarning(interaction.guild, ch) ?? (publicWarning ? `${ICONS.warning} ${publicWarning}` : `${ICONS.success} Les candidatures arriveront dans ${ch}.`)
        : `${ICONS.warning} Salon de réception retiré : aucune candidature ne peut plus être reçue.`;
      await interaction.update(formView(client, interaction.guild, form.id, notice));
    },
    /** cmd:candidatures:roles:<id> — rôles donnés à l'acceptation (vérifiés). */
    async roles(interaction, client, [id]) {
      guard(interaction);
      const service = svc(client);
      const form = service.form(interaction.guildId, id);
      const ids = [...new Set((interaction.values ?? []).filter((r) => SNOWFLAKE.test(r)))].slice(0, MAX_ROLES);
      service.assertGrantableRoles(interaction.guild, ids, interaction.member);
      service.updateForm(interaction.guildId, form.id, { roleIds: ids });
      await interaction.update(formView(client, interaction.guild, form.id, `${ICONS.success} ${ids.length ? `${ids.length} rôle(s) donné(s) à l'acceptation.` : 'Aucun rôle donné à l\'acceptation.'}`));
    },
    /** cmd:candidatures:ping:<id> — rôle pingué à chaque candidature. */
    async ping(interaction, client, [id]) {
      guard(interaction);
      const service = svc(client);
      const form = service.form(interaction.guildId, id);
      const roleId = pickRole(interaction);
      if (roleId === interaction.guildId) throw new UserError('@everyone ne peut pas être pingué à chaque candidature : choisissez un rôle du staff.');
      const role = roleId ? interaction.guild.roles.cache.get(roleId) : null;
      if (roleId && !role) throw new UserError('Ce rôle n\'existe plus.');
      service.updateForm(interaction.guildId, form.id, { pingRoleId: roleId });
      const me = interaction.guild.members?.me;
      const silent = role && !role.mentionable && !me?.permissions?.has?.(PermissionFlagsBits.MentionEveryone);
      const notice = !role
        ? `${ICONS.success} Aucun rôle pingué.`
        : silent
          ? `${ICONS.warning} ${role} n'est pas mentionnable : rendez-le mentionnable (ou donnez-moi « Mentionner @everyone ») pour qu'il soit notifié.`
          : `${ICONS.success} ${role} sera pingué à chaque candidature.`;
      await interaction.update(formView(client, interaction.guild, form.id, notice));
    },
    /** cmd:candidatures:panelch:<id> — salon du panneau (un changement republie à neuf). */
    async panelch(interaction, client, [id]) {
      guard(interaction);
      const service = svc(client);
      const form = service.form(interaction.guildId, id);
      const ch = pickChannel(interaction);
      const patch = { panelChannelId: ch?.id ?? null, ...(form.panel_channel_id !== (ch?.id ?? null) ? { panelMessageId: null } : {}) };
      service.updateForm(interaction.guildId, form.id, patch);
      const notice = ch ? sendWarning(interaction.guild, ch) ?? `${ICONS.success} Le panneau sera publié dans ${ch} : cliquez sur « Publier ».` : `${ICONS.success} Salon du panneau retiré.`;
      await interaction.update(formView(client, interaction.guild, form.id, notice));
    },
    /** cmd:candidatures:toggle:<id>:<on|off> — ouvre ou ferme (panneau mis à jour). */
    async toggle(interaction, client, [id, state]) {
      guard(interaction);
      const service = svc(client);
      const form = service.form(interaction.guildId, id);
      const open = target(state);
      if (open) {
        const problem = service.reviewProblem(interaction.guild, form);
        if (problem) throw new UserError(`Impossible d'ouvrir ce formulaire : ${problem}.`);
      }
      await interaction.deferUpdate();
      const saved = service.updateForm(interaction.guildId, form.id, { open });
      const refreshed = await service.refreshPanel(interaction.guild, saved);
      await interaction.editReply(formView(client, interaction.guild, form.id, `${ICONS.success} Candidatures **${open ? 'ouvertes' : 'fermées'}**${refreshed ? ' · panneau mis à jour' : ''}.`));
    },
    /** cmd:candidatures:publish:<id> — publie ou met à jour le panneau. */
    async publish(interaction, client, [id]) {
      guard(interaction);
      const service = svc(client);
      const form = service.form(interaction.guildId, id);
      if (!form.panel_channel_id) throw new UserError('Choisissez d\'abord le salon du panneau (menu « Salon du panneau »).');
      await interaction.deferUpdate();
      let notice;
      try {
        const { form: saved, updated } = await service.publishPanel(interaction.guild, form);
        notice = `${ICONS.success} Panneau ${updated ? 'mis à jour' : 'publié'} dans <#${saved.panel_channel_id}>.${saved.open ? '' : ` ${ICONS.warning} Le formulaire est fermé : ouvrez-le pour recevoir des candidatures.`}`;
      } catch (err) {
        if (!(err instanceof UserError)) throw err;
        notice = `${ICONS.error} ${err.message}`;
      }
      await interaction.editReply(formView(client, interaction.guild, form.id, notice));
    },
    /** cmd:candidatures:delete:<id> — après confirmation. */
    async delete(interaction, client, [id]) {
      guard(interaction);
      const service = svc(client);
      service.assertDeletable(interaction.guildId, id);
      await interaction.deferUpdate();
      const form = await service.deleteForm(interaction.guild, id);
      await interaction.editReply(homeView(client, interaction.guild, `${ICONS.success} Formulaire **${form.name}** supprimé.`));
    },

    // ------------------------------------------------------------ cartes du staff

    /** cmd:candidatures:accept:<id> — rôles du formulaire + MP ; une seule décision. */
    async accept(interaction, client, [id]) {
      guardReview(interaction);
      const service = svc(client);
      const guild = interaction.guild;
      const app = service.application(guild.id, id);
      service.assertPending(app);
      service.assertNotApplicant(app, interaction.user.id);
      const roleIds = service.rolesToGrant(guild, app, interaction.member);
      const decided = service.decide(guild, app, { status: 'accepted', reviewer: interaction.user });
      await interaction.deferUpdate();
      const result = await service.complete(guild, decided, interaction.member, roleIds);
      await interaction.editReply(service.cardPayload(guild, result.app));
      const details = [
        result.added.length ? `Rôle(s) donné(s) : ${result.added.map((r) => `<@&${r}>`).join(' ')}.` : null,
        result.failed.length ? `${ICONS.warning} Rôle(s) non donné(s) : ${result.failed.map((r) => `<@&${r}>`).join(' ')}.` : null,
        result.dm ? 'Le candidat a été prévenu en MP.' : `${ICONS.warning} MP impossible : prévenez le candidat autrement.`,
      ].filter(Boolean);
      await interaction.followUp({ embeds: [status.ok(details.join('\n'), `Candidature #${app.id} acceptée`)], ephemeral: true });
      await service.log(guild, result.app, { title: 'Candidature acceptée', description: `${ICONS.success} Candidature de <@${app.user_id}> acceptée par ${interaction.user}.` });
    },
    /** cmd:candidatures:reject:<id> — formulaire du motif. */
    async reject(interaction, client, [id]) {
      guardReview(interaction);
      const service = svc(client);
      const app = service.application(interaction.guildId, id);
      service.assertPending(app);
      service.assertNotApplicant(app, interaction.user.id);
      await interaction.showModal(rejectModal(app.id));
    },
    /** cmd:candidatures:rejectsubmit:<id> — refus (motif facultatif) + MP ; une seule décision. */
    async rejectsubmit(interaction, client, [id]) {
      guardReview(interaction);
      const service = svc(client);
      const guild = interaction.guild;
      const app = service.application(guild.id, id);
      service.assertNotApplicant(app, interaction.user.id);
      const reason = textField(interaction, 'motif') ?? null;
      if (reason && reason.length > MAX_REASON) throw new UserError(`Motif trop long (${MAX_REASON} caractères maximum).`);
      const decided = service.decide(guild, app, { status: 'rejected', reviewer: interaction.user, reason });
      const fromCard = interaction.message?.id === app.card_message_id;
      if (fromCard) await interaction.deferUpdate();
      else await interaction.deferReply({ ephemeral: true });
      const result = await service.complete(guild, decided, interaction.member);
      if (fromCard) await interaction.editReply(service.cardPayload(guild, result.app));
      else await service.refreshCard(guild, result.app);
      const text = result.dm ? 'Le candidat a été prévenu en MP.' : `${ICONS.warning} MP impossible : prévenez le candidat autrement.`;
      const done = { embeds: [status.ok(text, `Candidature #${app.id} refusée`)] };
      if (fromCard) await interaction.followUp({ ...done, ephemeral: true });
      else await interaction.editReply(done);
      await service.log(guild, result.app, { title: 'Candidature refusée', description: `${ICONS.error} Candidature de <@${app.user_id}> refusée par ${interaction.user}.` });
    },
    /** cmd:candidatures:interview:<id> — ticket (si configuré) ou fil privé. */
    async interview(interaction, client, [id]) {
      guardReview(interaction);
      const service = svc(client);
      const guild = interaction.guild;
      const app = service.application(guild.id, id);
      service.assertPending(app);
      service.assertNotApplicant(app, interaction.user.id);
      await interaction.deferReply({ ephemeral: true });
      const { app: updated, channel, kind } = await service.openInterview(guild, app, interaction.member);
      const url = channel.url ?? `https://discord.com/channels/${guild.id}/${channel.id}`;
      await interaction.editReply({
        embeds: [status.ok(`${kind === 'ticket' ? 'Ticket' : 'Fil privé'} d'entretien ouvert avec <@${app.user_id}> : ${channel}.`, 'Entretien ouvert')],
        components: buttonRows(linkButton('Ouvrir', url, INTERVIEW_ICON)),
      });
      if (interaction.message?.id === app.card_message_id && interaction.message.edit) {
        await interaction.message.edit(service.cardPayload(guild, updated, { fit: true })).catch(() => {});
      } else {
        await service.refreshCard(guild, updated);
      }
      await service.log(guild, updated, { title: 'Entretien ouvert', tone: 'info', description: `${INTERVIEW_ICON} ${interaction.user} a ouvert un entretien (${kind === 'ticket' ? 'ticket' : 'fil privé'}) avec <@${app.user_id}> : ${channel}.` });
    },
  },
};
