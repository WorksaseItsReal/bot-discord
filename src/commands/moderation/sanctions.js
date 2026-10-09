'use strict';

const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');
const { truncate } = require('../../utils/embeds');
const { discordTimestamp, formatDuration } = require('../../utils/time');
const { card, field, wide, ICONS, userLine, subtext, code, actionButton, labelButton, buttonRows, ButtonStyle } = require('../../utils/ui');
const { TYPE_LABELS, SANCTIONS, LIFTS, MAX_REASON, normalizeReason, sanctionIcon, userFromId, requirePermission } = require('../../services/ModerationService');
const { snowflake } = require('../../utils/buttonGuard');
const { UserError } = require('../../core/errors');
const { confirm } = require('../../utils/confirmation');
const { isEnforced, sanctionState } = require('../../database/repositories/SanctionRepository');

/**
 * /sanctions : gestion des sanctions (« cases ») et des notes de modération.
 * Réponses éphémères, navigation par boutons et menus persistants (l'état est
 * encodé dans les customId). Les permissions sont revérifiées à chaque clic.
 *
 * Vues : case:<id> · hist:<userId>:<page>:<filtre> · notes:<userId>:<page>
 */

/** Commande qui lève chaque type de sanction encore en vigueur. */
const LIFT_COMMANDS = { tempban: '/unban', ban: '/unban', mute: '/unmute', timeout: '/untimeout' };

/** Types de sanction filtrables dans l'historique. */
const SANCTION_TYPES = ['warn', 'mute', 'timeout', 'kick', 'tempban', 'ban'];
const FILTERS = ['all', ...SANCTION_TYPES];

/** Présentation de l'état d'une sanction (voir `sanctionState`). */
const STATES = {
  active: { emoji: '🟢', label: 'En vigueur' },
  revoked: { emoji: ICONS.unlock, label: 'Levée' },
  expired: { emoji: ICONS.expires, label: 'Expirée' },
  done: { emoji: ICONS.check, label: 'Appliquée' },
};

const PER_PAGE = 5;
const NOTES_PER_PAGE = 5;
const MAX_NOTE = 1000;
const NOTE_ICON = '🗒️';
const EDIT_ICON = '✏️';

/**
 * Refuse de supprimer des sanctions encore en vigueur (choix le plus sûr) :
 * supprimer la ligne d'un ban temporaire le rendrait définitif (le scheduler ne
 * pourrait plus le lever), et un mute effacé ne serait plus réappliqué au retour.
 * Le modérateur doit d'abord lever la sanction avec la commande dédiée, qui passe
 * par ModerationService (vérifications de hiérarchie + log de révocation). Pur.
 * @returns {string|null} message d'erreur, ou null si la suppression est sûre
 */
function enforcedRefusal(sanctions) {
  if (!sanctions.length) return null;
  const lines = sanctions.map((s) => {
    const label = TYPE_LABELS[s.type] ?? s.type;
    const until = s.expires_at ? ` jusqu'au ${discordTimestamp(s.expires_at, 'f')}` : '';
    const lift = LIFT_COMMANDS[s.type] ? `levez-la d'abord avec ${LIFT_COMMANDS[s.type]}` : 'levez-la d\'abord';
    return `• ${code(`#${s.id}`)} **${label}**${until} → ${lift}`;
  });
  return `Impossible de supprimer une sanction **encore en vigueur** : elle ne pourrait plus être levée automatiquement.\n${lines.join('\n')}`;
}

// ---------------------------------------------------------------- helpers purs

/** Une sanction sur deux lignes : type + date (+ état), puis détails en gris. Pur. */
function sanctionLine(s, now = Date.now()) {
  const label = TYPE_LABELS[s.type] ?? s.type;
  const state = sanctionState(s, now);
  const badge = state === 'active' ? ' · 🟢 En cours' : state === 'revoked' ? ` · ${ICONS.unlock} Levée` : state === 'expired' ? ` · ${ICONS.expires} Expirée` : '';
  const head = `${sanctionIcon(s.type)} **${label}** ${code(`#${s.id}`)} · ${discordTimestamp(s.created_at, 'd')}${badge}`;
  const details = [
    `par <@${s.moderator_id}>`,
    s.duration_ms ? formatDuration(s.duration_ms) : null,
    truncate((s.reason || 'Aucune raison').replace(/\s+/g, ' '), 120),
  ].filter(Boolean);
  return `${head}\n${subtext(details.join(' · '))}`;
}

/** « 2 Avertissements · 1 Bannissement ». Pur. */
function typeSummary(counts) {
  const parts = SANCTION_TYPES.filter((t) => counts[t]).map((t) => `${sanctionIcon(t)} ${TYPE_LABELS[t]} · **${counts[t]}**`);
  return parts.length ? parts.join('\n') : '*Aucune sanction*';
}

/** Texte nettoyé d'une note (1 à 1000 caractères). */
function normalizeNote(raw) {
  const text = String(raw ?? '').trim();
  if (!text) throw new UserError('La note ne peut pas être vide.');
  if (text.length > MAX_NOTE) throw new UserError(`La note est trop longue (${MAX_NOTE} caractères maximum).`);
  return text;
}

function parseId(raw) {
  if (typeof raw !== 'string' || !/^\d{1,10}$/.test(raw) || Number(raw) < 1) throw new UserError('Bouton invalide (sanction).');
  return Number(raw);
}

function parsePage(raw) {
  if (raw == null || raw === '') return 0;
  if (typeof raw !== 'string' || !/^\d{1,4}$/.test(raw)) throw new UserError('Bouton invalide (page).');
  return Number(raw);
}

function parseFilter(raw) {
  const f = raw ?? 'all';
  if (!FILTERS.includes(f)) throw new UserError('Filtre inconnu.');
  return f;
}

// ---------------------------------------------------------------- permissions

const guard = (interaction) => requirePermission(interaction, 'ModerateMembers');

/** Modifier la raison / supprimer une sanction : l'auteur de la sanction ou « Gérer le serveur ». */
function assertCanEdit(interaction, sanction, what = 'modifier sa raison') {
  guard(interaction);
  if (sanction.moderator_id === interaction.user?.id) return;
  if (interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return;
  throw new UserError(`Seul l'auteur de la sanction (<@${sanction.moderator_id}>) ou un membre avec **Gérer le serveur** peut ${what}.`);
}

function getSanction(client, guildId, id) {
  const s = client.repositories.sanctions.get(guildId, id);
  if (!s) throw new UserError(`Aucune sanction ${code(`#${id}`)} trouvée sur ce serveur.`);
  return s;
}

/** Utilisateur pour l'affichage : cache du client, sinon mention seule. */
function displayUser(client, id) {
  return client.users?.cache?.get?.(id) ?? userFromId(id);
}

const ts = (ms) => `${discordTimestamp(ms, 'f')}\n${discordTimestamp(ms, 'R')}`;

// ---------------------------------------------------------------- vues

function histButton(userId, label = 'Historique du membre') {
  return actionButton({ command: 'sanctions', action: 'hist', args: [userId, 0, 'all'], label, emoji: ICONS.history });
}

/** Fiche complète d'une sanction. */
function caseView(client, guild, id, notice) {
  const s = getSanction(client, guild.id, id);
  const repo = client.repositories.sanctions;
  const notesRepo = client.repositories.modNotes;
  const meta = SANCTIONS[s.type] ?? { label: s.type, tone: 'caution' };
  const state = sanctionState(s);
  const st = STATES[state];
  const user = displayUser(client, s.user_id);
  const edits = repo.listEdits(guild.id, s.id, 5);
  const editCount = edits.length ? repo.countEdits(guild.id, s.id) : 0;
  const notes = notesRepo?.listBySanction(guild.id, s.id, 5) ?? [];
  const noteCount = notes.length ? notesRepo.countBySanction(guild.id, s.id) : 0;
  const lift = state === 'active' ? LIFTS[s.type] : null;

  const stateText = {
    active: s.expires_at ? `Prend fin ${discordTimestamp(s.expires_at, 'R')}.` : s.type === 'ban' ? 'Définitive, jusqu\'à un débannissement.' : 'Sans échéance, jusqu\'à sa levée.',
    revoked: s.revoked_at ? `Levée ${discordTimestamp(s.revoked_at, 'R')}${s.revoked_by ? ` par <@${s.revoked_by}>` : ' automatiquement'}.` : 'Levée avant son échéance.',
    expired: s.expires_at ? `Arrivée à échéance ${discordTimestamp(s.expires_at, 'R')}.` : 'Arrivée à échéance.',
    done: 'Sanction ponctuelle, sans durée.',
  }[state];

  const duration = s.duration_ms ? `**${formatDuration(s.duration_ms)}**` : s.type === 'ban' || s.type === 'mute' ? 'Définitive' : null;
  const revokedField =
    state === 'revoked' && (s.revoked_by || s.revoked_at || s.revoke_reason)
      ? wide(
        ICONS.unlock,
        'Levée',
        [
          `${s.revoked_by ? `Par <@${s.revoked_by}>` : 'Automatiquement'}${s.revoked_at ? ` · ${discordTimestamp(s.revoked_at, 'f')}` : ''}`,
          s.revoke_reason ? `Motif : ${truncate(s.revoke_reason, 300)}` : null,
        ].filter(Boolean).join('\n'),
      )
      : null;
  const editsField = edits.length
    ? wide(
      EDIT_ICON,
      `Modifications de la raison (${editCount})`,
      edits.map((e) => `${discordTimestamp(e.created_at, 'd')} · <@${e.editor_id}> · avant : *${truncate((e.old_reason || 'aucune raison').replace(/\s+/g, ' '), 120)}*`).join('\n')
        + (editCount > edits.length ? `\n${subtext(`+ ${editCount - edits.length} plus ancienne(s)`)}` : ''),
    )
    : null;
  const notesField = notes.length
    ? wide(
      NOTE_ICON,
      `Notes (${noteCount})`,
      notes.map((n) => `${discordTimestamp(n.created_at, 'd')} · <@${n.author_id}> : ${truncate(n.content.replace(/\s+/g, ' '), 150)}`).join('\n')
        + (noteCount > notes.length ? `\n${subtext(`+ ${noteCount - notes.length} autre(s) dans /sanctions notes`)}` : ''),
    )
    : null;

  return {
    embeds: [
      card({
        tone: state === 'active' || state === 'done' ? meta.tone : state === 'revoked' ? 'success' : 'neutral',
        section: 'moderation',
        icon: sanctionIcon(s.type),
        title: `Sanction #${s.id} · ${meta.label}`,
        description: [notice ? `${notice}\n` : null, `${st.emoji} **${st.label}** · ${stateText}`],
        thumbnail: user?.displayAvatarURL?.(),
        fields: [
          field(ICONS.user, 'Membre', userLine(user)),
          field(ICONS.moderator, 'Modérateur', `<@${s.moderator_id}>`),
          field(ICONS.date, 'Date', ts(s.created_at)),
          field(ICONS.duration, 'Durée', duration),
          field(ICONS.expires, 'Expiration', s.expires_at ? ts(s.expires_at) : null),
          field(ICONS.status, 'État', `${st.emoji} ${st.label}`),
          wide(ICONS.reason, 'Raison', s.reason ? truncate(s.reason, 1024) : '*Aucune raison fournie*'),
          revokedField,
          editsField,
          notesField,
        ],
        footer: `Sanction #${s.id}`,
      }),
    ],
    components: buttonRows(
      actionButton({ command: 'sanctions', action: 'editreason', args: [s.id], label: 'Modifier la raison', emoji: EDIT_ICON, style: ButtonStyle.Primary }),
      actionButton({ command: 'sanctions', action: 'notecase', args: [s.id], label: 'Ajouter une note', emoji: '📝' }),
      lift ? actionButton({ command: 'sanctions', action: 'lift', args: [s.id], label: `Lever (${lift.label.toLowerCase()})`, emoji: ICONS.unlock, style: ButtonStyle.Danger }) : null,
      histButton(s.user_id),
    ),
  };
}

/** Fiche historique d'un membre : résumé + liste paginée, filtrable par type. */
function historyView(client, guild, userId, page = 0, filter = 'all', notice) {
  const repo = client.repositories.sanctions;
  const type = filter === 'all' ? null : filter;
  const user = displayUser(client, userId);
  const counts = repo.countByType(guild.id, userId);
  const total = Object.values(counts).reduce((a, n) => a + n, 0);
  const filtered = type ? counts[type] ?? 0 : total;
  const pages = Math.max(1, Math.ceil(filtered / PER_PAGE));
  const p = Math.min(Math.max(0, page), pages - 1);
  const list = repo.listPage(guild.id, userId, { type, limit: PER_PAGE, offset: p * PER_PAGE });
  const strikes = client.services.strikes?.getCount(guild.id, userId) ?? 0;
  const noteCount = client.repositories.modNotes?.count(guild.id, userId) ?? 0;
  const last = total ? repo.listPage(guild.id, userId, { limit: 1 })[0] : null;
  const active = repo.listActive(guild.id, userId).filter((s) => sanctionState(s) === 'active');

  const body = list.length
    ? list.map((s) => sanctionLine(s)).join('\n\n')
    : total
      ? `*Aucune sanction de type **${TYPE_LABELS[type] ?? type}**.*`
      : `${userLine(user)} n'a aucune sanction sur ce serveur. ✨`;

  const filterMenu = new StringSelectMenuBuilder()
    .setCustomId(`cmd:sanctions:filter:${userId}`)
    .setPlaceholder('Filtrer par type…')
    .addOptions(
      { value: 'all', label: `Toutes les sanctions (${total})`, emoji: ICONS.list, default: filter === 'all' },
      ...SANCTION_TYPES.filter((t) => counts[t] || t === filter).map((t) => ({
        value: t,
        label: `${TYPE_LABELS[t]} (${counts[t] ?? 0})`,
        emoji: sanctionIcon(t),
        default: t === filter,
      })),
    );

  const rows = [new ActionRowBuilder().addComponents(filterMenu)];
  if (list.length) {
    rows.push(
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`cmd:sanctions:open:${userId}`)
          .setPlaceholder('Ouvrir la fiche d\'une sanction…')
          .addOptions(
            list.map((s) => ({
              value: String(s.id),
              label: truncate(`#${s.id} · ${TYPE_LABELS[s.type] ?? s.type}`, 100),
              description: truncate((s.reason || 'Aucune raison').replace(/\s+/g, ' '), 100),
              emoji: sanctionIcon(s.type),
            })),
          ),
      ),
    );
  }
  rows.push(
    ...buttonRows(
      pages > 1 ? actionButton({ command: 'sanctions', action: 'hist', args: [userId, Math.max(0, p - 1), filter], emoji: ICONS.back, disabled: p === 0 }) : null,
      pages > 1 ? labelButton(`${p + 1} / ${pages}`) : null,
      pages > 1 ? actionButton({ command: 'sanctions', action: 'hist', args: [userId, Math.min(pages - 1, p + 1), filter], emoji: ICONS.next, disabled: p >= pages - 1 }) : null,
      actionButton({ command: 'sanctions', action: 'notes', args: [userId, 0], label: `Notes (${noteCount})`, emoji: NOTE_ICON }),
      actionButton({ command: 'sanctions', action: 'noteuser', args: [userId], label: 'Ajouter une note', emoji: '📝' }),
    ),
  );

  return {
    embeds: [
      card({
        tone: active.length ? 'caution' : total ? 'warning' : 'success',
        section: 'moderation',
        icon: ICONS.history,
        title: 'Historique de modération',
        description: [notice ? `${notice}\n` : null, `${ICONS.user} ${userLine(user)}`, '', body],
        thumbnail: user?.displayAvatarURL?.(),
        fields: [
          field(ICONS.count, 'Sanctions', `**${total}**`),
          field(ICONS.warn, 'Strikes actuels', `**${strikes}**`),
          field(NOTE_ICON, 'Notes', `**${noteCount}**`),
          field(ICONS.stats, 'Par type', typeSummary(counts)),
          field(ICONS.date, 'Dernière sanction', last ? `${sanctionIcon(last.type)} ${TYPE_LABELS[last.type] ?? last.type} ${code(`#${last.id}`)}\n${discordTimestamp(last.created_at, 'R')}` : '—'),
          field(
            '🟢',
            'En vigueur',
            active.length
              ? active.slice(0, 5).map((s) => `${sanctionIcon(s.type)} ${TYPE_LABELS[s.type] ?? s.type} ${code(`#${s.id}`)}${s.expires_at ? ` · fin ${discordTimestamp(s.expires_at, 'R')}` : ''}`).join('\n')
              : 'Aucune',
          ),
        ],
        footer: `${filter === 'all' ? 'Toutes les sanctions' : `Filtre : ${TYPE_LABELS[filter]}`}${pages > 1 ? ` · Page ${p + 1}/${pages}` : ''}`,
      }),
    ],
    components: rows,
  };
}

/** Notes de modération internes d'un membre (paginées). */
function notesView(client, guild, userId, page = 0, notice) {
  const repo = client.repositories.modNotes;
  const user = displayUser(client, userId);
  const total = repo.count(guild.id, userId);
  const pages = Math.max(1, Math.ceil(total / NOTES_PER_PAGE));
  const p = Math.min(Math.max(0, page), pages - 1);
  const notes = repo.listByUser(guild.id, userId, NOTES_PER_PAGE, p * NOTES_PER_PAGE);
  const body = notes.length
    ? notes
      .map((n) => `${NOTE_ICON} ${code(`#${n.id}`)} · ${discordTimestamp(n.created_at, 'd')} · par <@${n.author_id}>${n.sanction_id ? ` · sanction ${code(`#${n.sanction_id}`)}` : ''}\n${truncate(n.content, 600).split('\n').map((l) => `> ${l}`).join('\n')}`)
      .join('\n\n')
    : '*Aucune note pour ce membre.*';
  return {
    embeds: [
      card({
        tone: 'neutral',
        section: 'moderation',
        icon: NOTE_ICON,
        title: 'Notes de modération',
        description: [notice ? `${notice}\n` : null, `${ICONS.user} ${userLine(user)}`, subtext('Notes internes à l\'équipe : le membre n\'est pas prévenu et elles n\'ont aucun effet.'), '', body],
        thumbnail: user?.displayAvatarURL?.(),
        fields: [field(ICONS.count, 'Notes', `**${total}**`)],
        footer: pages > 1 ? `Page ${p + 1}/${pages}` : undefined,
      }),
    ],
    components: buttonRows(
      pages > 1 ? actionButton({ command: 'sanctions', action: 'notes', args: [userId, Math.max(0, p - 1)], emoji: ICONS.back, disabled: p === 0 }) : null,
      pages > 1 ? labelButton(`${p + 1} / ${pages}`) : null,
      pages > 1 ? actionButton({ command: 'sanctions', action: 'notes', args: [userId, Math.min(pages - 1, p + 1)], emoji: ICONS.next, disabled: p >= pages - 1 }) : null,
      actionButton({ command: 'sanctions', action: 'noteuser', args: [userId], label: 'Ajouter une note', emoji: '📝', style: ButtonStyle.Primary }),
      histButton(userId, 'Historique'),
    ),
  };
}

/** Rendu d'une vue : case:<id> · hist:<userId>:<page>:<filtre> · notes:<userId>:<page>. */
function render(client, guild, view, notice) {
  const [name, a, b, c] = String(view ?? '').split(/[:.]/);
  if (name === 'case') return caseView(client, guild, parseId(a), notice);
  if (name === 'hist') return historyView(client, guild, snowflake(a, 'membre'), parsePage(b), parseFilter(c), notice);
  if (name === 'notes') return notesView(client, guild, snowflake(a, 'membre'), parsePage(b), notice);
  throw new UserError('Vue inconnue.');
}

// ---------------------------------------------------------------- formulaires

function textInput(id, label, { value, max, style = TextInputStyle.Paragraph, placeholder } = {}) {
  const t = new TextInputBuilder().setCustomId(id).setLabel(truncate(label, 45)).setStyle(style).setMaxLength(max).setMinLength(1).setRequired(true);
  if (value) t.setValue(String(value).slice(0, max));
  if (placeholder) t.setPlaceholder(placeholder.slice(0, 100));
  return new ActionRowBuilder().addComponents(t);
}

function reasonModal(s) {
  return new ModalBuilder()
    .setCustomId(`cmd:sanctions:editreasonsubmit:${s.id}`)
    .setTitle(truncate(`Modifier la raison · #${s.id}`, 45))
    .addComponents(textInput('reason', 'Nouvelle raison', { value: s.reason, max: MAX_REASON }));
}

function noteModal(customId, title) {
  return new ModalBuilder()
    .setCustomId(customId)
    .setTitle(truncate(title, 45))
    .addComponents(textInput('note', 'Note interne (le membre ne la voit pas)', { max: MAX_NOTE, placeholder: 'Contexte, avertissement oral, suivi…' }));
}

/** Prépare une modification de raison (validations rapides AVANT tout appel lent). */
function prepareEdit(interaction, client, id, raw) {
  const s = getSanction(client, interaction.guildId ?? interaction.guild.id, id);
  assertCanEdit(interaction, s);
  const reason = normalizeReason(raw);
  if ((s.reason ?? '') === reason) throw new UserError('La nouvelle raison est identique à l\'actuelle.');
  return reason;
}

function editNotice(res) {
  return `${ICONS.success} Raison modifiée (ancienne raison conservée)${res.logUpdated ? ' · log mis à jour' : ''}.`;
}

// ---------------------------------------------------------------- commande

module.exports = {
  category: 'moderation',
  render,
  sanctionLine,
  typeSummary,
  enforcedRefusal,
  normalizeReason,
  normalizeNote,
  noteModal,
  data: new SlashCommandBuilder()
    .setName('sanctions')
    .setDescription('Gère les sanctions (fiches, historique, raisons) et les notes de modération.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addSubcommand((s) =>
      s
        .setName('voir')
        .setDescription('Affiche la fiche complète d\'une sanction.')
        .addIntegerOption((o) => o.setName('id').setDescription('Numéro de la sanction').setRequired(true).setMinValue(1)),
    )
    .addSubcommand((s) =>
      s
        .setName('historique')
        .setDescription('Affiche la fiche de modération d\'un membre.')
        .addUserOption((o) => o.setName('membre').setDescription('Le membre').setRequired(true))
        .addStringOption((o) =>
          o
            .setName('type')
            .setDescription('Afficher un seul type de sanction')
            .addChoices(...SANCTION_TYPES.map((t) => ({ name: TYPE_LABELS[t], value: t }))),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName('raison')
        .setDescription('Modifie la raison d\'une sanction (l\'ancienne est conservée).')
        .addIntegerOption((o) => o.setName('id').setDescription('Numéro de la sanction').setRequired(true).setMinValue(1))
        .addStringOption((o) => o.setName('raison').setDescription('Nouvelle raison').setRequired(true).setMaxLength(MAX_REASON)),
    )
    .addSubcommand((s) =>
      s
        .setName('note')
        .setDescription('Ajoute une note interne sur un membre (sans effet pour lui).')
        .addUserOption((o) => o.setName('membre').setDescription('Le membre').setRequired(true))
        .addStringOption((o) => o.setName('texte').setDescription('Contenu de la note').setRequired(true).setMaxLength(MAX_NOTE)),
    )
    .addSubcommand((s) =>
      s
        .setName('notes')
        .setDescription('Affiche les notes de modération d\'un membre.')
        .addUserOption((o) => o.setName('membre').setDescription('Le membre').setRequired(true)),
    )
    .addSubcommand((s) =>
      s.setName('remove').setDescription('Supprime une sanction par son ID.').addIntegerOption((o) => o.setName('id').setDescription('ID de la sanction').setRequired(true)),
    )
    .addSubcommand((s) =>
      s.setName('clear').setDescription('Efface tout l\'historique d\'un membre.').addUserOption((o) => o.setName('membre').setDescription('Le membre').setRequired(true)),
    ),

  /** @param {import('discord.js').ChatInputCommandInteraction} interaction */
  async execute(interaction, client) {
    guard(interaction);
    const sub = interaction.options.getSubcommand();
    const repo = client.repositories.sanctions;
    const guild = interaction.guild;
    const guildId = guild.id;

    if (sub === 'voir') {
      return interaction.reply({ ...caseView(client, guild, interaction.options.getInteger('id')), ephemeral: true });
    }

    if (sub === 'historique') {
      const user = interaction.options.getUser('membre');
      const filter = parseFilter(interaction.options.getString('type') ?? 'all');
      return interaction.reply({ ...historyView(client, guild, user.id, 0, filter), ephemeral: true });
    }

    if (sub === 'raison') {
      const id = interaction.options.getInteger('id');
      const reason = prepareEdit(interaction, client, id, interaction.options.getString('raison'));
      await interaction.deferReply({ ephemeral: true });
      const res = await client.services.moderation.editReason(guild, id, interaction.user, reason);
      return interaction.editReply(caseView(client, guild, id, editNotice(res)));
    }

    if (sub === 'note') {
      const user = interaction.options.getUser('membre');
      const content = normalizeNote(interaction.options.getString('texte'));
      client.repositories.modNotes.create({ guildId, userId: user.id, authorId: interaction.user.id, content });
      return interaction.reply({ ...notesView(client, guild, user.id, 0, `${ICONS.success} Note ajoutée.`), ephemeral: true });
    }

    if (sub === 'notes') {
      const user = interaction.options.getUser('membre');
      return interaction.reply({ ...notesView(client, guild, user.id, 0), ephemeral: true });
    }

    if (sub === 'remove') {
      const id = interaction.options.getInteger('id');
      const sanction = repo.get(guildId, id);
      if (!sanction) throw new UserError(`Aucune sanction ${code(`#${id}`)} trouvée sur ce serveur.`);
      // Effacer une trace de modération : l'auteur de la sanction ou « Gérer le serveur ».
      assertCanEdit(interaction, sanction, 'la supprimer');
      const refusal = isEnforced(sanction) ? enforcedRefusal([sanction]) : null;
      if (refusal) throw new UserError(refusal);
      if (!repo.delete(guildId, id)) throw new UserError(`Aucune sanction ${code(`#${id}`)} trouvée sur ce serveur.`);
      const fields = [
        field(ICONS.user, 'Membre', `<@${sanction.user_id}>`),
        field(sanctionIcon(sanction.type), 'Type', TYPE_LABELS[sanction.type] ?? sanction.type),
        field(ICONS.date, 'Date', discordTimestamp(sanction.created_at, 'd')),
      ];
      // Non bloquant : la réponse doit partir dans les 3 s (le log suit).
      Promise.resolve(client.services.logging?.send?.(guildId, 'moderation', card({
        tone: 'warning',
        section: 'moderation',
        icon: ICONS.delete,
        title: 'Sanction supprimée',
        description: `La sanction ${code(`#${id}`)} a été retirée de l'historique.`,
        fields: [
          ...fields,
          field(ICONS.moderator, 'Supprimée par', `${interaction.user}`),
          field(ICONS.moderator, 'Auteur de la sanction', `<@${sanction.moderator_id}>`),
          wide(ICONS.reason, 'Raison d\'origine', sanction.reason ? truncate(sanction.reason, 1024) : '*Aucune raison fournie*'),
        ],
        footer: `Sanction #${id}`,
      }), undefined, { event: 'sanction' })).catch(() => {});
      return interaction.reply({
        embeds: [
          card({
            tone: 'success',
            section: 'moderation',
            icon: ICONS.delete,
            title: 'Sanction supprimée',
            description: `La sanction ${code(`#${id}`)} a été retirée de l'historique.`,
            fields,
            footer: 'Les strikes ne sont pas modifiés : /sanctions clear pour les remettre à zéro.',
          }),
        ],
        ephemeral: true,
      });
    }

    if (sub === 'clear') {
      // Effacer tout un casier : réservé à « Gérer le serveur ».
      requirePermission(interaction, 'ManageGuild');
      const user = interaction.options.getUser('membre');
      const refuseIfEnforced = () => {
        const refusal = enforcedRefusal(repo.listEnforced(guildId, user.id));
        if (refusal) throw new UserError(refusal);
      };
      refuseIfEnforced();
      if (client.services.config?.get(guildId)?.moderation?.confirmDangerous) {
        const total = repo.count(guildId, user.id);
        const ok = await confirm(interaction, {
          description: `Effacer définitivement le casier de ${user} (**${total}** sanction${total > 1 ? 's' : ''}) et remettre ses strikes à zéro ?`,
          confirmLabel: 'Effacer',
        });
        if (!ok) return undefined;
        refuseIfEnforced(); // une sanction a pu être posée pendant la confirmation
      }
      const n = repo.clearUser(guildId, user.id);
      client.services.strikes.reset(guildId, user.id);
      // Non bloquant : la réponse doit partir dans les 3 s (le log suit).
      Promise.resolve(client.services.logging?.send?.(guildId, 'moderation', card({
        tone: 'warning',
        section: 'moderation',
        icon: ICONS.delete,
        title: 'Casier effacé',
        description: `Le casier de ${user} a été effacé.`,
        thumbnail: user.displayAvatarURL?.(),
        fields: [
          field(ICONS.user, 'Membre', userLine(user)),
          field(ICONS.moderator, 'Par', `${interaction.user}`),
          field(ICONS.count, 'Sanctions effacées', `**${n}**`),
        ],
      }), undefined, { event: 'sanction' })).catch(() => {});
      const payload = {
        embeds: [
          card({
            tone: 'success',
            section: 'moderation',
            icon: ICONS.delete,
            title: 'Historique effacé',
            description: `Le casier de ${user} est de nouveau vierge.`,
            fields: [
              field(ICONS.user, 'Membre', userLine(user)),
              field(ICONS.count, 'Sanctions effacées', `**${n}**`),
              field(ICONS.warn, 'Strikes', 'Remis à **0**'),
            ],
            footer: 'Les notes de modération sont conservées (/sanctions notes).',
          }),
        ],
      };
      // Après confirmation, la carte remplace la demande (éphémère).
      if (interaction.replied || interaction.deferred) return interaction.editReply(payload);
      return interaction.reply({ ...payload, ephemeral: true });
    }
    throw new UserError('Sous-commande inconnue.');
  },

  buttons: {
    /**
     * cmd:sanctions:history:<userId> — bouton « 📜 Sanctions » des cartes de sanction,
     * des logs et de l'AutoMod : ouvre la fiche historique (nouveau message éphémère).
     */
    async history(interaction, client, [rawUserId]) {
      guard(interaction);
      const userId = snowflake(rawUserId, 'membre');
      if (!client.users?.cache?.get?.(userId)) await client.users?.fetch?.(userId).catch(() => null);
      return interaction.reply({ ...historyView(client, interaction.guild, userId, 0, 'all'), ephemeral: true });
    },
    /** cmd:sanctions:hist:<userId>:<page>:<filtre> — navigation dans la fiche historique. */
    async hist(interaction, client, [rawUserId, rawPage, rawFilter]) {
      guard(interaction);
      await interaction.update(historyView(client, interaction.guild, snowflake(rawUserId, 'membre'), parsePage(rawPage), parseFilter(rawFilter)));
    },
    /** cmd:sanctions:filter:<userId> — menu de filtre par type. */
    async filter(interaction, client, [rawUserId]) {
      guard(interaction);
      await interaction.update(historyView(client, interaction.guild, snowflake(rawUserId, 'membre'), 0, parseFilter(interaction.values?.[0])));
    },
    /** cmd:sanctions:open:<userId> — menu « Ouvrir la fiche d'une sanction ». */
    async open(interaction, client, [rawUserId]) {
      guard(interaction);
      const userId = snowflake(rawUserId, 'membre');
      const id = parseId(interaction.values?.[0]);
      const s = getSanction(client, interaction.guildId, id);
      if (s.user_id !== userId) throw new UserError('Cette sanction ne concerne pas ce membre.');
      await interaction.update(caseView(client, interaction.guild, id));
    },
    /** cmd:sanctions:editreason:<id> — ouvre le formulaire de modification de la raison. */
    async editreason(interaction, client, [rawId]) {
      guard(interaction);
      const s = getSanction(client, interaction.guildId, parseId(rawId));
      assertCanEdit(interaction, s);
      await interaction.showModal(reasonModal(s));
    },
    async editreasonsubmit(interaction, client, [rawId]) {
      guard(interaction);
      const id = parseId(rawId);
      const reason = prepareEdit(interaction, client, id, interaction.fields.getTextInputValue('reason'));
      await interaction.deferUpdate();
      const res = await client.services.moderation.editReason(interaction.guild, id, interaction.user, reason);
      await interaction.editReply(caseView(client, interaction.guild, id, editNotice(res)));
    },
    /** cmd:sanctions:notecase:<id> — note interne rattachée à une sanction. */
    async notecase(interaction, client, [rawId]) {
      guard(interaction);
      const s = getSanction(client, interaction.guildId, parseId(rawId));
      await interaction.showModal(noteModal(`cmd:sanctions:notecasesubmit:${s.id}`, `Note · sanction #${s.id}`));
    },
    async notecasesubmit(interaction, client, [rawId]) {
      guard(interaction);
      const s = getSanction(client, interaction.guildId, parseId(rawId));
      const content = normalizeNote(interaction.fields.getTextInputValue('note'));
      client.repositories.modNotes.create({ guildId: interaction.guildId, userId: s.user_id, authorId: interaction.user.id, sanctionId: s.id, content });
      await interaction.update(caseView(client, interaction.guild, s.id, `${ICONS.success} Note ajoutée.`));
    },
    /** cmd:sanctions:noteuser:<userId> — note interne sur un membre. */
    async noteuser(interaction, client, [rawUserId]) {
      guard(interaction);
      const userId = snowflake(rawUserId, 'membre');
      await interaction.showModal(noteModal(`cmd:sanctions:noteusersubmit:${userId}`, 'Nouvelle note de modération'));
    },
    async noteusersubmit(interaction, client, [rawUserId]) {
      guard(interaction);
      const userId = snowflake(rawUserId, 'membre');
      const content = normalizeNote(interaction.fields.getTextInputValue('note'));
      client.repositories.modNotes.create({ guildId: interaction.guildId, userId, authorId: interaction.user.id, content });
      const view = notesView(client, interaction.guild, userId, 0, `${ICONS.success} Note ajoutée.`);
      // Formulaire ouvert depuis un message (fiche, notes) : on met la vue à jour ; depuis le
      // menu contextuel « Note de modération » (sans message) : nouvelle réponse éphémère.
      if (interaction.isFromMessage?.() === false) await interaction.reply({ ...view, ephemeral: true });
      else await interaction.update(view);
    },
    /** cmd:sanctions:notes:<userId>:<page> — notes d'un membre. */
    async notes(interaction, client, [rawUserId, rawPage]) {
      guard(interaction);
      await interaction.update(notesView(client, interaction.guild, snowflake(rawUserId, 'membre'), parsePage(rawPage)));
    },
    /**
     * cmd:sanctions:lift:<id> — lève une sanction en vigueur via l'action dédiée
     * (unban / unmute / untimeout de ModerationService, hiérarchie comprise).
     */
    async lift(interaction, client, [rawId]) {
      guard(interaction);
      const s = getSanction(client, interaction.guildId, parseId(rawId));
      const lift = LIFTS[s.type];
      if (!lift || sanctionState(s) !== 'active') throw new UserError('Cette sanction n\'est plus en vigueur : il n\'y a rien à lever.');
      requirePermission(interaction, lift.permission);
      await interaction.deferUpdate();
      await client.services.moderation.lift(interaction.guild, s, interaction.member, `Levée via la fiche #${s.id} par ${interaction.user.tag ?? interaction.user.username}`);
      await interaction.editReply(caseView(client, interaction.guild, s.id, `${ICONS.success} Sanction levée (${SANCTIONS[lift.type]?.label ?? lift.type}).`));
    },
  },
};
