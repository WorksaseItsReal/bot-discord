'use strict';

const { EmbedBuilder, ButtonStyle } = require('discord.js');
const { config } = require('../config');
const { brandFooter, truncate, progressBar, listOrMore } = require('./embeds');
const { button, row } = require('./components');
const { parseDuration, discordTimestamp } = require('./time');

/**
 * Mise en forme des projets : statuts, validation des entrées et embeds.
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
  return STATUSES[status] || { label: status || 'Inconnu', emoji: '❔', color: config.colors.primary };
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

function progressLine(percent, counts) {
  const tasks = counts?.total ? ` · ${counts.done}/${counts.total} tâche${counts.total > 1 ? 's' : ''}` : '';
  return `\`${progressBar(percent / 100, 14)}\` **${percent} %**${tasks}`;
}

function deadlineText(project, now = Date.now()) {
  if (!project.deadline) return '*Non définie*';
  const base = `${discordTimestamp(project.deadline, 'D')}\n${discordTimestamp(project.deadline, 'R')}`;
  return isOverdue(project, now) ? `${base}\n⚠️ **En retard**` : base;
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
    const reserve = remaining > 1 ? 30 : 0; // place pour « … et N autres »
    if (used + line.length + 1 + reserve > maxChars) {
      lines.push(`*… et ${remaining} autre${remaining > 1 ? 's' : ''} (bouton « Tâches »)*`);
      break;
    }
    lines.push(line);
    used += line.length + 1;
  }
  return lines.join('\n') || '*Aucune tâche.*';
}

/**
 * Embed complet d'un projet.
 * @param {object} project projet hydraté
 * @param {{ tasks?: object[], members?: object[], guild?: { name: string, iconURL?: () => string|null } }} [extra]
 */
function buildProjectEmbed(project, { tasks = [], members = [], guild = null, now = Date.now() } = {}) {
  const meta = statusMeta(project.status);
  const counts = { total: tasks.length, done: tasks.filter((t) => t.done).length };
  const percent = computeProgress(project, counts);

  const embed = new EmbedBuilder()
    .setColor(project.color ?? meta.color)
    .setTitle(truncate(`${meta.emoji} ${project.name}`, 256))
    .setDescription(truncate(project.description?.trim() || '*Aucune description pour le moment.*', LIMITS.description))
    .setFooter(brandFooter(`Projet #${project.number} • créé le ${new Date(project.createdAt).toLocaleDateString('fr-FR')} • mis à jour`))
    .setTimestamp(project.updatedAt || now);

  const authorName = truncate(`📁 Projet #${project.number}${guild?.name ? ` · ${guild.name}` : ''}`, 256);
  const iconURL = typeof guild?.iconURL === 'function' ? guild.iconURL({ size: 64 }) : null;
  embed.setAuthor(iconURL ? { name: authorName, iconURL } : { name: authorName });

  const firstLink = project.links?.[0]?.url && normalizeUrl(project.links[0].url);
  if (firstLink) embed.setURL(firstLink);
  if (project.imageUrl && normalizeUrl(project.imageUrl)) embed.setImage(project.imageUrl);
  if (project.thumbnailUrl && normalizeUrl(project.thumbnailUrl)) embed.setThumbnail(project.thumbnailUrl);

  embed.addFields(
    { name: '📊 Progression', value: progressLine(percent, counts) },
    { name: '📌 Statut', value: `${meta.emoji} ${meta.label}`, inline: true },
    { name: '👑 Responsable', value: `<@${project.ownerId}>`, inline: true },
    { name: '⏰ Échéance', value: deadlineText(project, now), inline: true },
  );

  if (members.length) {
    embed.addFields({ name: `👥 Équipe (${members.length})`, value: truncate(listOrMore(members.map(memberLine), 12, '\n'), 1024) });
  }
  if (project.tags?.length) {
    embed.addFields({ name: '🏷️ Tags', value: truncate(project.tags.map((t) => `\`${t}\``).join(' '), 1024) });
  }
  if (tasks.length) {
    embed.addFields({ name: `🧩 Tâches (${counts.done}/${counts.total})`, value: taskChecklist(tasks) });
  }
  if (project.links?.length) {
    const links = project.links.map((l) => `[${truncate(l.label, LIMITS.linkLabel)}](${l.url})`).join(' · ');
    embed.addFields({ name: '🔗 Liens', value: truncate(links, 1024) });
  }
  return embed;
}

/** Boutons : liens externes (max 5) + actions persistantes (actualiser, tâches). */
function buildProjectComponents(project, { hasTasks = false } = {}) {
  const rows = [];
  const links = (project.links || []).filter((l) => normalizeUrl(l.url)).slice(0, LIMITS.links);
  if (links.length) {
    rows.push(row(...links.map((l) => button({ label: truncate(l.label, 80), url: l.url, emoji: '🔗' }))));
  }
  const actions = [button({ id: `project:refresh:${project.id}`, label: 'Actualiser', emoji: '🔄', style: ButtonStyle.Secondary })];
  if (hasTasks) actions.push(button({ id: `project:tasks:${project.id}`, label: 'Tâches', emoji: '🧩', style: ButtonStyle.Secondary }));
  rows.push(row(...actions));
  return rows;
}

/** Ligne compacte pour la liste : « 🚧 #3 · Nom » / barre + infos. */
function projectSummaryField(project, counts, now = Date.now()) {
  const meta = statusMeta(project.status);
  const percent = computeProgress(project, counts);
  const bits = [`\`${progressBar(percent / 100, 10)}\` **${percent} %**`, `👑 <@${project.ownerId}>`];
  if (project.deadline) bits.push(`⏰ ${discordTimestamp(project.deadline, 'R')}${isOverdue(project, now) ? ' ⚠️' : ''}`);
  const tags = project.tags?.length ? `\n🏷️ ${project.tags.slice(0, 5).map((t) => `\`${t}\``).join(' ')}` : '';
  return {
    name: truncate(`${meta.emoji} #${project.number} · ${project.name}`, 256),
    value: truncate(`${bits.join(' · ')}${tags}`, 1024),
  };
}

/**
 * Pages d'embeds pour la liste des projets.
 * @param {Array<{ project: object, counts: object }>} entries
 */
function buildProjectListPages(entries, { guildName = 'ce serveur', filterLabel = null, perPage = 6, now = Date.now() } = {}) {
  const pages = [];
  const byStatus = {};
  for (const { project } of entries) byStatus[project.status] = (byStatus[project.status] || 0) + 1;
  const summary = Object.entries(STATUSES)
    .filter(([key]) => byStatus[key])
    .map(([key, s]) => `${s.emoji} ${s.label} : **${byStatus[key]}**`)
    .join(' · ');

  for (let i = 0; i < entries.length; i += perPage) {
    const chunk = entries.slice(i, i + perPage);
    const embed = new EmbedBuilder()
      .setColor(config.colors.projects)
      .setTitle(truncate(`📁 Projets de ${guildName}${filterLabel ? ` — ${filterLabel}` : ''}`, 256))
      .setDescription(truncate(`${entries.length} projet${entries.length > 1 ? 's' : ''}${summary ? `\n${summary}` : ''}\n​`, 4096))
      .addFields(chunk.map(({ project, counts }) => projectSummaryField(project, counts, now)))
      .setFooter(brandFooter('Utilisez /projet voir pour le détail'))
      .setTimestamp(now);
    pages.push(embed);
  }
  return pages;
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
  buildProjectEmbed,
  buildProjectComponents,
  buildProjectListPages,
  projectSummaryField,
};
