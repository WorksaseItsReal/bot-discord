'use strict';

const { ButtonBuilder, ButtonStyle, ActionRowBuilder } = require('discord.js');
const { truncate, progressBar, listOrMore } = require('./embeds');
const { card, field, wide, subtext, ICONS, TONES, linkButton, buttonRows } = require('./ui');
const { parseDuration, discordTimestamp } = require('./time');

/**
 * Mise en forme des projets : statuts, validation des entrées et cartes (utils/ui.js).
 * Tout est pur (sans accès Discord ni base) → entièrement testable.
 */

const STATUSES = Object.freeze({
  idee: { label: 'Idée', emoji: '💡', color: 0x95a5a6 },
  planifie: { label: 'Planifié', emoji: '🗓️', color: 0x3498db },
  en_cours: { label: 'En cours', emoji: '🚧', color: 0xf39c12 },
  en_test: { label: 'En test', emoji: '🧪', color: 0x1abc9c },
  en_pause: { label: 'En pause', emoji: '⏸️', color: 0x9b59b6 },
  termine: { label: 'Terminé', emoji: '✅', color: 0x2ecc71 },
  abandonne: { label: 'Abandonné', emoji: '🛑', color: 0xe74c3c },
});

const CLOSED_STATUSES = new Set(['termine', 'abandonne']);

const LIMITS = Object.freeze({
  name: 80,
  description: 2000,
  tags: 10,
  tag: 24,
  links: 5,
  linkLabel: 60,
  url: 512,
  members: 25,
  memberRole: 40,
  tasks: 25,
  taskTitle: 100,
  perGuild: 200,
});

function statusMeta(status) {
  return STATUSES[status] || { label: status || 'Inconnu', emoji: '❔', color: TONES.brand };
}

function statusChoices() {
  return Object.entries(STATUSES).map(([value, s]) => ({ name: `${s.emoji} ${s.label}`, value }));
}

/** « #RRGGBB » / « RRGGBB » / « #RGB » → entier, ou null si invalide. */
function parseColor(input) {
  if (input == null) return null;
  let hex = String(input).trim().replace(/^#/, '').replace(/^0x/i, '');
  if (/^[0-9a-f]{3}$/i.test(hex)) hex = hex.split('').map((c) => c + c).join('');
  if (!/^[0-9a-f]{6}$/i.test(hex)) return null;
  return parseInt(hex, 16);
}

function formatColor(value) {
  return `#${Number(value).toString(16).padStart(6, '0').toUpperCase()}`;
}

/** URL http(s) valide et raisonnable, sinon null. */
function normalizeUrl(input) {
  if (!input) return null;
  const str = String(input).trim();
  if (str.length > LIMITS.url) return null;
  try {
    const url = new URL(str);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.toString();
  } catch {
    return null;
  }
}

/** « web, Bot ,  api » → ['web', 'bot', 'api'] (dédoublonné, borné). */
function parseTags(input) {
  if (!input) return [];
  const seen = new Set();
  for (const raw of String(input).split(/[,;\n]/)) {
    const tag = raw.trim().replace(/^#/, '').toLowerCase().slice(0, LIMITS.tag);
    if (tag) seen.add(tag);
    if (seen.size >= LIMITS.tags) break;
  }
  return [...seen];
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Interprète une échéance saisie par un utilisateur.
 * Formats : JJ/MM/AAAA, AAAA-MM-JJ, ou durée relative (« 2w », « 10d »).
 * Les dates sont fixées à midi UTC pour s'afficher au bon jour partout dans le monde.
 * @returns {{ value: number|null, clear?: boolean, error?: string }}
 */
function parseDeadline(input, now = Date.now()) {
  const str = String(input ?? '').trim().toLowerCase();
  if (!str) return { value: null, error: 'Date vide.' };
  if (['aucune', 'aucun', 'none', 'non', '-', '0'].includes(str)) return { value: null, clear: true };

  let ts = null;
  let m = str.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
  if (m) ts = utcNoon(Number(m[3]), Number(m[2]), Number(m[1]));
  if (!m) {
    m = str.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (m) ts = utcNoon(Number(m[1]), Number(m[2]), Number(m[3]));
  }
  if (!m) {
    const ms = parseDuration(str);
    if (ms) ts = now + ms;
  }
  if (ts == null) return { value: null, error: 'Format invalide. Utilisez `JJ/MM/AAAA`, `AAAA-MM-JJ` ou une durée comme `2w` / `10d`.' };
  if (ts < Date.UTC(2000, 0, 1)) return { value: null, error: 'Date trop ancienne.' };
  if (ts > now + 10 * 365 * DAY_MS) return { value: null, error: 'Échéance trop lointaine (10 ans maximum).' };
  return { value: ts };
}

function utcNoon(year, month, day) {
  const ts = Date.UTC(year, month - 1, day, 12);
  const d = new Date(ts);
  // Refuse les dates impossibles (31/02, 00/13…)
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
  return ts;
}

/** En retard si la journée d'échéance est entièrement passée et le projet n'est pas clos. */
function isOverdue(project, now = Date.now()) {
  return Boolean(project.deadline) && !CLOSED_STATUSES.has(project.status) && now > project.deadline + 12 * 60 * 60 * 1000;
}

/**
 * Progression affichée (0-100) : calculée depuis les tâches s'il y en a,
 * sinon valeur manuelle ; un projet terminé est toujours à 100 %.
 */
function computeProgress(project, counts) {
  if (project.status === 'termine') return 100;
  if (counts && counts.total > 0) return Math.round((counts.done / counts.total) * 100);
  const manual = Number(project.progress);
  return Number.isFinite(manual) ? Math.min(100, Math.max(0, Math.round(manual))) : 0;
}

// ============================================================================
//  Rendu (système de design : card / field / wide de utils/ui.js)
// ============================================================================

/** Barre de progression d'une fiche (large) ou d'une ligne de liste (courte). */
const BAR = Object.freeze({ card: 18, list: 10, tasks: 12 });

/** Icône d'échéance (un concept = un emoji). */
const DEADLINE_ICON = ICONS.date;

function plural(n, word) {
  return `${n} ${word}${n > 1 ? 's' : ''}`;
}

/** Couleur d'une fiche : couleur choisie par l'utilisateur, sinon celle du statut. */
function projectTone(project) {
  return project.color ?? statusMeta(project.status).color;
}

/** Section (en-tête discret) d'une fiche : « 📁 Projet #3 · Serveur ». */
function projectSection(project, guild) {
  const name = guild?.name ? ` · ${guild.name}` : '';
  return { emoji: ICONS.project, label: `Projet #${project.number}${name}` };
}

function tasksLabel(counts) {
  if (!counts?.total) return null;
  return `${counts.done}/${counts.total} tâche${counts.total > 1 ? 's' : ''} terminée${counts.done > 1 ? 's' : ''}`;
}

/** « `██████░░░░` **42 %** » — la ligne la plus visible de la fiche. */
function progressLine(percent, counts, size = BAR.card) {
  const tasks = counts?.total ? ` · ${counts.done}/${counts.total} tâche${counts.total > 1 ? 's' : ''}` : '';
  return `\`${progressBar(percent / 100, size)}\` **${percent} %**${tasks}`;
}

function deadlineText(project, now = Date.now()) {
  if (!project.deadline) return '*Non définie*';
  const base = `${discordTimestamp(project.deadline, 'D')}\n${discordTimestamp(project.deadline, 'R')}`;
  return isOverdue(project, now) ? `${base}\n${ICONS.warning} **En retard**` : base;
}

function memberLine(m) {
  return m.role ? `<@${m.userId}> · *${truncate(m.role, LIMITS.memberRole)}*` : `<@${m.userId}>`;
}

/** Checklist bornée à ~1000 caractères (limite d'un champ d'embed). */
function taskChecklist(tasks, maxChars = 1000) {
  const lines = [];
  let used = 0;
  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[i];
    const line = t.done ? `✅ ~~${truncate(t.title, 80)}~~` : `⬜ ${truncate(t.title, 80)}`;
    const remaining = tasks.length - i;
    const reserve = remaining > 1 ? 40 : 0; // place pour « … et N autres »
    if (used + line.length + 1 + reserve > maxChars) {
      lines.push(subtext(`… et ${remaining} autre${remaining > 1 ? 's' : ''} · bouton « Tâches »`));
      break;
    }
    lines.push(line);
    used += line.length + 1;
  }
  return lines.join('\n') || '*Aucune tâche.*';
}

function linksText(project) {
  const links = (project.links || []).filter((l) => normalizeUrl(l.url));
  if (!links.length) return null;
  return truncate(links.map((l) => `[${truncate(l.label, LIMITS.linkLabel)}](${l.url})`).join('  ·  '), 1024);
}

function tagsText(tags, max = LIMITS.tags) {
  if (!tags?.length) return null;
  return tags.slice(0, max).map((t) => `\`${t}\``).join(' ');
}

/**
 * Fiche complète d'un projet.
 *
 *   ┃ 📁  Projet #3 · Serveur
 *   ┃ 🚧  Nom du projet                         (lien principal)
 *   ┃ Description…
 *   ┃ 📊 Progression
 *   ┃ `██████████░░░░░░░░` 55 % · 3/7 tâches
 *   ┃ 📌 Statut   👑 Responsable   📅 Échéance
 *   ┃ 👥 Équipe · 🏷️ Tags · 🧩 Tâches · 🔗 Liens
 *
 * @param {object} project projet hydraté
 * @param {{ tasks?: object[], members?: object[], guild?: { name: string }, now?: number }} [extra]
 */
function buildProjectEmbed(project, { tasks = [], members = [], guild = null, now = Date.now() } = {}) {
  const meta = statusMeta(project.status);
  const counts = { total: tasks.length, done: tasks.filter((t) => t.done).length };
  const percent = computeProgress(project, counts);
  const overdue = isOverdue(project, now);
  const firstLink = project.links?.[0]?.url ? normalizeUrl(project.links[0].url) : null;

  const description = [
    truncate(project.description?.trim() || '*Aucune description pour le moment.*', LIMITS.description),
    '',
    `${ICONS.stats} **Progression**`,
    `\`${progressBar(percent / 100, BAR.card)}\` **${percent} %**`,
    subtext(
      [
        tasksLabel(counts) ?? (percent === 100 ? 'Projet achevé' : 'Progression manuelle · /projet progression'),
        overdue ? `${ICONS.warning} échéance dépassée` : null,
      ]
        .filter(Boolean)
        .join(' · '),
    ),
  ];

  const fields = [
    field(ICONS.status, 'Statut', `${meta.emoji} **${meta.label}**`),
    field(ICONS.owner, 'Responsable', `<@${project.ownerId}>`),
    field(DEADLINE_ICON, 'Échéance', deadlineText(project, now)),
  ];
  if (members.length) {
    fields.push(wide(ICONS.members, `Équipe (${members.length})`, truncate(listOrMore(members.map(memberLine), 12, '\n'), 1024)));
  }
  const tags = tagsText(project.tags);
  if (tags) fields.push(wide(ICONS.tag, 'Tags', truncate(tags, 1024)));
  if (tasks.length) fields.push(wide(ICONS.task, `Tâches · ${counts.done}/${counts.total}`, taskChecklist(tasks)));
  const links = linksText(project);
  if (links) fields.push(wide(ICONS.link, 'Liens', links));

  const created = project.createdAt ? `créé le ${new Date(project.createdAt).toLocaleDateString('fr-FR')} · ` : '';
  return card({
    tone: projectTone(project),
    section: projectSection(project, guild),
    icon: meta.emoji,
    title: project.name,
    url: firstLink || undefined,
    description,
    fields,
    thumbnail: project.thumbnailUrl && normalizeUrl(project.thumbnailUrl) ? project.thumbnailUrl : null,
    image: project.imageUrl && normalizeUrl(project.imageUrl) ? project.imageUrl : null,
    footer: `Projet #${project.number} · ${created}mis à jour`,
    timestamp: project.updatedAt || now,
  });
}

/** Bouton persistant du module projets (préfixe historique `project:`). */
function projectButton(action, project, { label, emoji, style = ButtonStyle.Secondary }) {
  return new ButtonBuilder().setCustomId(`project:${action}:${project.id}`).setLabel(label).setEmoji(emoji).setStyle(style);
}

/**
 * Boutons d'une fiche : liens externes (max 5) puis actions persistantes.
 *   [ 🔗 GitHub ] [ 🔗 Site ]
 *   [ 🧩 Tâches ] [ 🔄 Actualiser ]
 * Les identifiants `project:refresh:<id>` / `project:tasks:<id>` restent inchangés.
 */
function buildProjectComponents(project, { hasTasks = false } = {}) {
  const links = (project.links || []).filter((l) => normalizeUrl(l.url)).slice(0, LIMITS.links);
  const rows = links.length ? buttonRows(links.map((l) => linkButton(truncate(l.label, 80), l.url, ICONS.link))) : [];
  const actions = [];
  if (hasTasks) actions.push(projectButton('tasks', project, { label: 'Tâches', emoji: ICONS.task, style: ButtonStyle.Primary }));
  actions.push(projectButton('refresh', project, { label: 'Actualiser', emoji: ICONS.refresh }));
  rows.push(new ActionRowBuilder().addComponents(actions));
  return rows;
}

/** Liste complète des tâches (réponse éphémère du bouton « Tâches »). */
function buildTaskListEmbed(project, tasks, { guild = null } = {}) {
  const done = tasks.filter((t) => t.done).length;
  const lines = tasks.map((t, i) => {
    const num = `\`${String(i + 1).padStart(2, '0')}\``;
    const title = t.done ? `~~${truncate(t.title, 100)}~~` : `**${truncate(t.title, 100)}**`;
    return `${num} ${t.done ? '✅' : '⬜'} ${title}${t.done && t.doneBy ? ` · <@${t.doneBy}>` : ''}`;
  });
  const percent = tasks.length ? Math.round((done / tasks.length) * 100) : 0;
  return card({
    tone: projectTone(project),
    section: projectSection(project, guild),
    icon: ICONS.task,
    title: `Tâches · ${project.name}`,
    description: lines.length ? lines : ['*Aucune tâche pour le moment.*', subtext('Ajoutez-en avec /projet tache-ajouter.')],
    fields: [
      field(ICONS.stats, 'Avancement', `\`${progressBar(percent / 100, BAR.tasks)}\` **${percent} %**`),
      field(ICONS.success, 'Terminées', `**${done}**`),
      field('⬜', 'Restantes', `**${tasks.length - done}**`),
    ],
    footer: 'Cocher une tâche : /projet tache-cocher',
  });
}

/** Ligne compacte d'une liste : titre « 🚧 #3 · Nom » + progression + infos. */
function projectSummaryField(project, counts, now = Date.now()) {
  const meta = statusMeta(project.status);
  const percent = computeProgress(project, counts);
  const lines = [progressLine(percent, counts, BAR.list)];
  const bits = [`${ICONS.owner} <@${project.ownerId}>`];
  if (project.deadline) bits.push(`${DEADLINE_ICON} ${discordTimestamp(project.deadline, 'R')}${isOverdue(project, now) ? ` ${ICONS.warning} **en retard**` : ''}`);
  lines.push(bits.join('  ·  '));
  const tags = tagsText(project.tags, 5);
  if (tags) lines.push(`${ICONS.tag} ${tags}`);
  return {
    name: truncate(`${meta.emoji} #${project.number} · ${project.name}`, 256),
    value: truncate(lines.join('\n'), 1024),
  };
}

/** Résumé « 🚧 En cours : 3 · ✅ Terminé : 1 ». */
function statusSummary(byStatus) {
  return Object.entries(STATUSES)
    .filter(([key]) => byStatus[key])
    .map(([key, s]) => `${s.emoji} ${s.label} **${byStatus[key]}**`)
    .join('  ·  ');
}

/**
 * Pages de la liste des projets (une carte par page).
 * @param {Array<{ project: object, counts: object }>} entries
 */
function buildProjectListPages(entries, { guildName = 'ce serveur', filterLabel = null, perPage = 6, now = Date.now() } = {}) {
  const pages = [];
  const byStatus = {};
  for (const { project } of entries) byStatus[project.status] = (byStatus[project.status] || 0) + 1;
  const summary = statusSummary(byStatus);
  const overdue = entries.filter(({ project }) => isOverdue(project, now)).length;

  for (let i = 0; i < entries.length; i += perPage) {
    const chunk = entries.slice(i, i + perPage);
    pages.push(
      card({
        tone: 'brand',
        section: 'projects',
        icon: ICONS.project,
        title: `Projets de ${guildName}${filterLabel ? ` · ${filterLabel}` : ''}`,
        description: [
          `**${plural(entries.length, 'projet')}**${overdue ? `  ·  ${ICONS.warning} **${overdue}** en retard` : ''}`,
          summary || null,
          subtext('Détail d\'un projet : /projet voir'),
        ],
        fields: chunk.map(({ project, counts }) => projectSummaryField(project, counts, now)),
        timestamp: now,
      }),
    );
  }
  return pages;
}

/**
 * Carte de statistiques des projets d'un serveur.
 * @param {{ total: number, byStatus: object, overdue: number, topOwners: Array<[string, number]>, tasks: { total: number, done: number } }} s
 */
function buildProjectStatsEmbed(s, { guildName = 'ce serveur', thumbnail = null } = {}) {
  const done = s.byStatus.termine || 0;
  const active = s.total - done - (s.byStatus.abandonne || 0);
  const lines = Object.entries(STATUSES)
    .filter(([key]) => s.byStatus[key])
    .map(([key, meta]) => {
      const n = s.byStatus[key];
      return `${meta.emoji} \`${progressBar(n / s.total, BAR.list)}\` **${n}** · ${meta.label}`;
    });
  const medals = ['🥇', '🥈', '🥉', '4.', '5.'];
  return card({
    tone: 'brand',
    section: 'projects',
    icon: ICONS.stats,
    title: `Statistiques · ${guildName}`,
    description: [`**${plural(s.total, 'projet')}** dont **${active}** actif${active > 1 ? 's' : ''}`, '', ...lines],
    thumbnail,
    fields: [
      field(ICONS.project, 'Total', `**${s.total}**`),
      field(ICONS.success, 'Taux de réussite', `**${s.total ? Math.round((done / s.total) * 100) : 0} %**`),
      field(ICONS.warning, 'En retard', s.overdue ? `**${s.overdue}**` : '**0** ✨'),
      wide(
        ICONS.task,
        'Tâches',
        s.tasks?.total ? `\`${progressBar(s.tasks.done / s.tasks.total, BAR.card)}\` **${s.tasks.done}/${s.tasks.total}** terminées` : '*Aucune tâche*',
      ),
      wide(
        ICONS.star,
        'Responsables les plus actifs',
        (s.topOwners || []).map(([id, n], i) => `${medals[i]} <@${id}> · ${plural(n, 'projet')}`).join('\n'),
      ),
    ],
  });
}

/** Carte des réglages du module projets. */
function buildProjectSettingsEmbed(settings, { changed = false } = {}) {
  return card({
    tone: changed ? 'success' : 'brand',
    section: 'projects',
    icon: ICONS.settings,
    title: changed ? 'Réglages des projets mis à jour' : 'Réglages des projets',
    description: changed ? `${ICONS.success} Les nouveaux réglages s'appliquent immédiatement.` : 'Réglages actuels du module projets.',
    fields: [
      field(ICONS.owner, 'Rôle gestionnaire', settings.managerRoleId ? `<@&${settings.managerRoleId}>` : '*Aucun*\n' + subtext('« Gérer le serveur » uniquement')),
      field('📢', 'Salon par défaut', settings.channelId ? `<#${settings.channelId}>` : '*Salon courant*'),
      field(settings.openCreation ? ICONS.unlock : ICONS.lock, 'Création', settings.openCreation ? '🟢 Ouverte à tous' : '🔴 Gestionnaires'),
      field(ICONS.count, 'Projets actifs / membre', `**${settings.maxPerUser}**`),
    ],
    footer: 'Modifier : /projet config',
  });
}

module.exports = {
  STATUSES,
  CLOSED_STATUSES,
  LIMITS,
  statusMeta,
  statusChoices,
  parseColor,
  formatColor,
  normalizeUrl,
  parseTags,
  parseDeadline,
  isOverdue,
  computeProgress,
  taskChecklist,
  progressLine,
  projectTone,
  projectSection,
  buildProjectEmbed,
  buildTaskListEmbed,
  buildProjectStatsEmbed,
  buildProjectSettingsEmbed,
  buildProjectComponents,
  buildProjectListPages,
  projectSummaryField,
};
