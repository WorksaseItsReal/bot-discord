'use strict';

const { SlashCommandBuilder, PermissionFlagsBits, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } = require('discord.js');
const { card, field, ICONS, code, subtext, status, actionButton, labelButton, buttonRows, ButtonStyle } = require('../../utils/ui');
const { truncate } = require('../../utils/embeds');
const { discordTimestamp } = require('../../utils/time');
const { isValidTimeZone } = require('../../utils/datetime');
const { localParts, nextAfter, REPEATS } = require('../../utils/calendar');
const { parseWhen } = require('./timestamp');
const { parseColor, colorHex, parseImageUrl } = require('../../services/WelcomeService');
const { ANNOUNCE_CHANNEL_TYPES, announcementCard, assertMentionAllowed, channelIssue } = require('../../services/AnnouncementService');
const { requirePermission } = require('../../services/ModerationService');
const { UserError } = require('../../core/errors');

/**
 * /annonce programmer : formulaire (titre, message, couleur, image) → aperçu éphémère
 * « Programmer » / « Annuler » → publication par le SchedulerService à l'échéance.
 * /annonce liste : annonces programmées (« Envoyer maintenant », « Supprimer »).
 */

const MAX_SCHEDULED = 25;
const PER_PAGE = 4;
const MAX_AHEAD_MS = 366 * 86_400_000;
const DEFAULT_TZ = 'Europe/Paris';

const guard = (interaction) => requirePermission(interaction, 'ManageGuild');

/** Fuseau IANA canonique (« europe/paris » → « Europe/Paris »), ou null. Pur. */
function canonicalTimeZone(input) {
  const raw = String(input ?? '').trim();
  if (!raw || !isValidTimeZone(raw)) return null;
  return new Intl.DateTimeFormat('en-US', { timeZone: raw }).resolvedOptions().timeZone;
}

/**
 * Échéance d'une saisie libre (parseWhen de /timestamp), plus « JJ/MM [heure] » sans
 * année : l'année en cours, ou la suivante si la date est passée (ou n'existe pas cette
 * année : « 29/02 » une année non bissextile vise la suivante si elle l'est). Pur.
 * @returns {number|null}
 */
function parseAnnounceDate(input, timeZone = DEFAULT_TZ, now = Date.now()) {
  const str = String(input ?? '').trim();
  const m = /^(\d{1,2})[/.](\d{1,2})(?:\s+(.+))?$/.exec(str);
  if (m) {
    const { year } = localParts(now, timeZone);
    for (const y of [year, year + 1]) {
      const ts = parseWhen(`${m[1]}/${m[2]}/${y}${m[3] ? ` ${m[3]}` : ''}`, timeZone, now);
      if (ts != null && ts > now) return ts;
    }
    return null;
  }
  return parseWhen(str, timeZone, now);
}

/** Libellé de la mention d'une annonce. */
function mentionLabel(row) {
  if (!row.role_id) return '*Aucune*';
  return row.role_id === row.guild_id ? '@everyone' : `<@&${row.role_id}>`;
}

/** Résumé d'une annonce (aperçu, confirmation). */
function summaryCard(row, { title, tone = 'info', icon = '📢', notice = null } = {}) {
  return card({
    tone,
    section: 'utility',
    icon,
    title,
    description: [
      notice,
      row.repeat === 'none'
        ? `Publication ${discordTimestamp(row.next_run, 'F')} (${discordTimestamp(row.next_run, 'R')}).`
        : `Première publication ${discordTimestamp(row.next_run, 'F')} (${discordTimestamp(row.next_run, 'R')}), puis **${REPEATS[row.repeat].toLowerCase()}**.`,
    ],
    fields: [
      field(ICONS.channel, 'Salon', `<#${row.channel_id}>`),
      field(ICONS.refresh, 'Répétition', REPEATS[row.repeat] ?? row.repeat),
      field('📣', 'Mention', mentionLabel(row)),
      field(ICONS.time, 'Fuseau', code(row.time_zone)),
      field(ICONS.color, 'Couleur', colorHex(row.color) ? code(colorHex(row.color)) : '*Par défaut*'),
      field(ICONS.id, 'Référence', code(`#${row.id}`)),
    ],
    footer: 'Aperçu ci-dessous : c\'est exactement ce qui sera publié',
  });
}

/** Liste paginée (éphémère) avec « Envoyer maintenant » / « Supprimer » par annonce. */
function listView(client, guild, page = 0, notice = null) {
  const repo = client.repositories.announcements;
  const total = repo.count(guild.id);
  const pages = Math.max(1, Math.ceil(total / PER_PAGE));
  const current = Math.min(Math.max(0, Number(page) || 0), pages - 1);
  const rows = repo.list(guild.id, { limit: PER_PAGE, offset: current * PER_PAGE });
  const lines = rows.map((r) => {
    const name = r.title ? `**${truncate(r.title.replace(/[*_`~|]/g, ''), 60)}**` : `*${truncate(String(r.message ?? '').replace(/\s+/g, ' ').replace(/[*_`~|]/g, ''), 60)}*`;
    const when = r.status === 'disabled'
      ? `${ICONS.warning} désactivée : ${truncate(r.last_error ?? 'raison inconnue', 120)}`
      : `${discordTimestamp(r.next_run, 'f')} (${discordTimestamp(r.next_run, 'R')})`;
    const repeat = r.repeat === 'none' ? '' : ` · ${ICONS.refresh} ${REPEATS[r.repeat]}`;
    return `\`#${r.id}\` ${name}\n${subtext(`<#${r.channel_id}> · ${when}${repeat}${r.role_id ? ` · ${mentionLabel(r)}` : ''}`)}`;
  });
  const components = rows.map((r) => new ActionRowBuilder().addComponents(
    actionButton({ command: 'annonce', action: 'asend', args: [r.id, current], label: `Envoyer maintenant · #${r.id}`, emoji: '📤', style: ButtonStyle.Primary, disabled: r.status !== 'scheduled' }),
    actionButton({ command: 'annonce', action: 'adelete', args: [r.id, current], label: `Supprimer · #${r.id}`, emoji: ICONS.delete, style: ButtonStyle.Danger }),
  ));
  components.push(...buttonRows(
    pages > 1 && actionButton({ command: 'annonce', action: 'alist', args: [Math.max(0, current - 1)], emoji: ICONS.back, disabled: current === 0 }),
    pages > 1 && labelButton(`Page ${current + 1} / ${pages}`, `cmd:_:noop:alist${current}`),
    pages > 1 && actionButton({ command: 'annonce', action: 'alist', args: [current + 1], emoji: ICONS.next, disabled: current >= pages - 1 }),
    actionButton({ command: 'annonce', action: 'alist', args: [current, 'r'], label: 'Actualiser', emoji: ICONS.refresh }),
  ));
  return {
    embeds: [
      card({
        tone: 'info',
        section: 'utility',
        icon: '📢',
        title: 'Annonces programmées',
        description: [notice ? `${notice}\n` : null, lines.length ? lines.join('\n') : '*Aucune annonce programmée. Utilisez `/annonce programmer`.*'],
        fields: [field(ICONS.count, 'Programmées', `**${repo.countScheduled(guild.id)}** / ${MAX_SCHEDULED}`), field('📄', 'Page', `${current + 1} / ${pages}`)],
        footer: 'Les « Envoyer maintenant » ne décalent pas les répétitions',
      }),
    ],
    components,
  };
}

const input = (id, label, { style = TextInputStyle.Short, max = 100, required = false, placeholder } = {}) => {
  const t = new TextInputBuilder().setCustomId(id).setLabel(label.slice(0, 45)).setStyle(style).setMaxLength(max).setRequired(required);
  if (placeholder) t.setPlaceholder(placeholder.slice(0, 100));
  return new ActionRowBuilder().addComponents(t);
};

function composeModal(id) {
  return new ModalBuilder()
    .setCustomId(`cmd:annonce:compose:${id}`)
    .setTitle('Nouvelle annonce programmée')
    .addComponents(
      input('titre', 'Titre (facultatif)', { max: 256, placeholder: 'Soirée jeux vendredi !' }),
      input('message', 'Message', { style: TextInputStyle.Paragraph, max: 4000, required: true, placeholder: 'Rendez-vous à 21 h dans le salon vocal…' }),
      input('couleur', 'Couleur hexadécimale (facultatif)', { max: 7, placeholder: '#5865F2' }),
      input('image', 'Image : adresse https (facultatif)', { max: 500, placeholder: 'https://exemple.com/banniere.png' }),
    );
}

/** Valeur d'un champ de formulaire (vide → null). */
function textField(interaction, id) {
  try {
    return interaction.fields.getTextInputValue(id)?.trim() || null;
  } catch {
    return null;
  }
}

/** Le bot et l'auteur peuvent-ils publier dans ce salon ? Lève une UserError. */
function assertChannel(interaction, channelId) {
  const guild = interaction.guild;
  const channel = guild.channels.cache.get(channelId);
  if (!channel || !ANNOUNCE_CHANNEL_TYPES.includes(channel.type)) throw new UserError('Choisissez un salon textuel ou d\'annonces du serveur.');
  const issue = channelIssue(guild, channelId);
  if (issue) throw new UserError(`Je ne peux pas publier dans ${channel} : ${issue}.`);
  const perms = interaction.member && typeof channel.permissionsFor === 'function' ? channel.permissionsFor(interaction.member) : null;
  if (perms && !perms.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])) {
    throw new UserError(`Vous ne pouvez pas écrire dans ${channel} : choisissez un salon où vous avez le droit de publier.`);
  }
  return channel;
}

/** Brouillon de l'auteur, ou UserError. */
function ownDraft(client, interaction, id) {
  const row = /^\d{1,10}$/.test(id ?? '') ? client.repositories.announcements.get(interaction.guildId, Number(id)) : null;
  if (!row || row.status !== 'draft') throw new UserError('Ce brouillon a expiré ou a déjà été traité. Relancez `/annonce programmer`.');
  if (row.author_id !== interaction.user.id) throw new UserError('Seule la personne qui a préparé cette annonce peut la confirmer.');
  return row;
}

module.exports = {
  category: 'utility',
  cooldown: 3_000,
  parseAnnounceDate,
  canonicalTimeZone,
  listView,
  data: new SlashCommandBuilder()
    .setName('annonce')
    .setDescription('Annonces programmées : publication à une date précise, avec répétition.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((s) =>
      s.setName('programmer').setDescription('Programme une annonce (formulaire, puis aperçu avant confirmation).')
        .addChannelOption((o) => o.setName('salon').setDescription('Salon de publication').setRequired(true).addChannelTypes(...ANNOUNCE_CHANNEL_TYPES))
        .addStringOption((o) => o.setName('date').setDescription('Quand : 14h30, 25/12 18h, 25/12/2026 18:30, +2h, dans 3d…').setRequired(true).setMaxLength(40))
        .addStringOption((o) => o.setName('repetition').setDescription('Répéter l\'annonce (défaut : aucune)')
          .addChoices(...Object.entries(REPEATS).map(([value, name]) => ({ name, value }))))
        .addRoleOption((o) => o.setName('role').setDescription('Rôle à mentionner (facultatif)'))
        .addStringOption((o) => o.setName('fuseau').setDescription('Fuseau IANA de la date (défaut : Europe/Paris)').setMaxLength(50)))
    .addSubcommand((s) => s.setName('liste').setDescription('Liste les annonces programmées.')),

  async execute(interaction, client) {
    guard(interaction);
    const sub = interaction.options.getSubcommand();
    const guild = interaction.guild;
    if (sub === 'liste') return interaction.reply({ ...listView(client, guild, 0), ephemeral: true });

    const channel = assertChannel(interaction, interaction.options.getChannel('salon').id);
    const rawTz = interaction.options.getString('fuseau');
    const timeZone = rawTz ? canonicalTimeZone(rawTz) : DEFAULT_TZ;
    if (!timeZone) throw new UserError('Fuseau inconnu. Exemples : `Europe/Paris`, `America/Montreal`, `UTC`.');
    const now = Date.now();
    const runAt = parseAnnounceDate(interaction.options.getString('date'), timeZone, now);
    if (runAt == null) throw new UserError('Date invalide. Exemples : `14h30`, `25/12 18h`, `25/12/2026 18:30`, `+2h`, `dans 3d`.');
    if (runAt <= now + 30_000) throw new UserError('Cette date est déjà passée (ou trop proche) : choisissez un moment dans le futur.');
    if (runAt - now > MAX_AHEAD_MS) throw new UserError('Une annonce se programme au plus **un an** à l\'avance.');
    const repeat = interaction.options.getString('repetition') ?? 'none';
    if (!REPEATS[repeat]) throw new UserError('Répétition inconnue.');
    const role = interaction.options.getRole('role');
    assertMentionAllowed(guild, role?.id ?? null, interaction.memberPermissions);
    if (client.repositories.announcements.countScheduled(guild.id) >= MAX_SCHEDULED) {
      throw new UserError(`${MAX_SCHEDULED} annonces programmées au maximum : supprimez-en une avec \`/annonce liste\`.`);
    }
    const id = client.repositories.announcements.createDraft({ guildId: guild.id, channelId: channel.id, authorId: interaction.user.id, roleId: role?.id ?? null, repeat, timeZone, runAt, now });
    await interaction.showModal(composeModal(id));
  },

  buttons: {
    /** cmd:annonce:compose:<id> — formulaire rempli → aperçu éphémère. */
    async compose(interaction, client, [id]) {
      guard(interaction);
      const draft = ownDraft(client, interaction, id);
      const message = textField(interaction, 'message');
      if (!message) throw new UserError('Le message de l\'annonce est obligatoire.');
      const content = { title: textField(interaction, 'titre'), message, color: parseColor(textField(interaction, 'couleur')), image: parseImageUrl(textField(interaction, 'image')) };
      client.repositories.announcements.setContent(interaction.guildId, draft.id, content);
      const row = { ...draft, ...content };
      await interaction.reply({
        embeds: [summaryCard(row, { title: 'Aperçu de l\'annonce', tone: 'warning', icon: '👁️', notice: 'Vérifiez l\'annonce, puis confirmez.' }), announcementCard(row)],
        components: buttonRows(
          actionButton({ command: 'annonce', action: 'confirm', args: [draft.id], label: 'Programmer', emoji: '📅', style: ButtonStyle.Success }),
          actionButton({ command: 'annonce', action: 'cancel', args: [draft.id], label: 'Annuler', emoji: '✖️' }),
        ),
        ephemeral: true,
      });
    },

    /** cmd:annonce:confirm:<id> — brouillon → programmée (vérifications refaites). */
    async confirm(interaction, client, [id]) {
      guard(interaction);
      const draft = ownDraft(client, interaction, id);
      assertChannel(interaction, draft.channel_id);
      assertMentionAllowed(interaction.guild, draft.role_id, interaction.memberPermissions);
      const repo = client.repositories.announcements;
      if (repo.countScheduled(interaction.guildId) >= MAX_SCHEDULED) throw new UserError(`${MAX_SCHEDULED} annonces programmées au maximum.`);
      let runAt = draft.next_run;
      let runs = 0;
      const now = Date.now();
      if (runAt <= now) {
        // Aperçu resté ouvert au-delà de l'échéance : une répétition démarre à l'occurrence
        // suivante, sans changer d'ancre (une annonce mensuelle du 31 reste au 31).
        const next = nextAfter(draft.anchor_at, draft.repeat, draft.time_zone, 0, now);
        if (!next) throw new UserError('L\'heure prévue est passée pendant l\'aperçu. Relancez `/annonce programmer`.');
        runAt = next.at;
        runs = next.runs;
      }
      if (!repo.schedule(interaction.guildId, draft.id, runAt, { anchorAt: draft.anchor_at, runs })) throw new UserError('Ce brouillon a déjà été traité.');
      const row = repo.get(interaction.guildId, draft.id);
      await interaction.update({
        embeds: [summaryCard(row, { title: 'Annonce programmée', tone: 'success', icon: ICONS.success }), announcementCard(row)],
        components: buttonRows(actionButton({ command: 'annonce', action: 'alist', args: ['0'], label: 'Voir la liste', emoji: ICONS.list })),
      });
    },

    /** cmd:annonce:cancel:<id> — abandon du brouillon. */
    async cancel(interaction, client, [id]) {
      guard(interaction);
      const draft = ownDraft(client, interaction, id);
      client.repositories.announcements.delete(interaction.guildId, draft.id);
      await interaction.update({ embeds: [status.note('Annonce annulée : rien ne sera publié.', 'Annulée')], components: [] });
    },

    /** cmd:annonce:alist:<page>[:r] */
    async alist(interaction, client, [page]) {
      guard(interaction);
      await interaction.update(listView(client, interaction.guild, Number(page) || 0));
    },

    /** cmd:annonce:asend:<id>:<page> — publication immédiate. */
    async asend(interaction, client, [id, page]) {
      guard(interaction);
      if (!/^\d{1,10}$/.test(id ?? '')) throw new UserError('Ce bouton est invalide.');
      const row = client.repositories.announcements.get(interaction.guildId, Number(id));
      if (row?.status === 'sending') throw new UserError('Cette annonce est déjà en cours de publication.');
      if (!row || row.status !== 'scheduled') throw new UserError('Cette annonce n\'est plus programmée.');
      assertMentionAllowed(interaction.guild, row.role_id, interaction.memberPermissions);
      await interaction.deferUpdate();
      let notice;
      try {
        const after = await client.services.announcements.sendNow(interaction.guild, row.id, interaction.user);
        notice = `${ICONS.success} Annonce \`#${row.id}\` publiée dans <#${row.channel_id}>${after?.status === 'done' ? ' (envoi unique : terminée)' : ''}.`;
      } catch (e) {
        if (!e?.isUserError) throw e;
        notice = `${ICONS.error} ${e.message}`;
      }
      await interaction.editReply(listView(client, interaction.guild, Number(page) || 0, notice));
    },

    /** cmd:annonce:adelete:<id>:<page> */
    async adelete(interaction, client, [id, page]) {
      guard(interaction);
      if (!/^\d{1,10}$/.test(id ?? '')) throw new UserError('Ce bouton est invalide.');
      const row = client.repositories.announcements.get(interaction.guildId, Number(id));
      if (!row || row.status === 'draft') throw new UserError('Cette annonce n\'existe plus.');
      client.repositories.announcements.delete(interaction.guildId, row.id);
      await interaction.update(listView(client, interaction.guild, Number(page) || 0, `${ICONS.success} Annonce \`#${row.id}\` supprimée.`));
    },
  },
};

