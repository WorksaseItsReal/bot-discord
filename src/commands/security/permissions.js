'use strict';

const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  PermissionsBitField,
  StringSelectMenuBuilder,
  RoleSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  escapeMarkdown,
} = require('discord.js');
const { card, field, wide, ICONS, subtext, actionButton, buttonRows, ButtonStyle } = require('../../utils/ui');
const { row } = require('../../utils/components');
const { truncate } = require('../../utils/embeds');
const { permissionLabel } = require('../../utils/permissionNames');
const { requirePermission } = require('../../services/ModerationService');
const { PermissionService, roleIdsOf, defaultLevelName, MAX_LEVEL_ROLES, MAX_LEVEL_NAME } = require('../../services/PermissionService');
const {
  LEVELS,
  DELEGATION_TIERS,
  tierOf,
  declaredFlags,
  isAssignable,
  isDelegable,
  sensitiveLabels,
} = require('../../utils/access');
const { UserError } = require('../../core/errors');

/**
 * /permissions : niveaux 1/2/3 (rôles → commandes), parité « perm » de CrowBot SANS rouvrir la
 * faille corrigée en 0.6.0 (Administrateur, réponses éphémères).
 * Vues : home · l1 · l2 · l3 · cmds[.page] · cmd.<nom> · strict · checks
 * customIds : cmd:permissions:<action>:<args> (100 caractères au plus).
 */

const SECTION = { emoji: '🔑', label: 'Permissions' };
/** Toute action du panneau : Administrateur (comme la commande). */
const guard = (interaction) => requirePermission(interaction, 'Administrator');
const svc = (client) => client.services.permissions;
const PAGE_SIZE = 25;
/** Lignes de commandes listées dans une carte, au plus. */
const MAX_LINES = 30;

const LEVEL_EMOJIS = { 1: '1️⃣', 2: '2️⃣', 3: '3️⃣' };
const TIER_ORDER = ['low', 'moderation', 'high'];

/* ---------------------------------------------------------------------- */
/* Aides                                                                   */
/* ---------------------------------------------------------------------- */

const levelLabel = (client, guildId, n) => escapeMarkdown(svc(client).levelName(guildId, n));

/** Commandes attribuables, triées : palier courant, modération, sanctions lourdes, puis le reste. */
function assignableCommands(client) {
  const names = [...client.commands.keys()].filter((n) => isAssignable(n, client.commands.get(n)));
  const rank = (n) => {
    const t = tierOf(n);
    return t ? TIER_ORDER.indexOf(t.key) * 100 + t.commands.indexOf(n) : 1000;
  };
  return names.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

/** Mode d'une commande attribuée : délégation ou restriction (mode strict). */
function modeOf(name, command) {
  return isDelegable(name, command) ? 'délégation' : 'restriction';
}

/** Libellé du palier d'une commande. */
function tierLabel(name) {
  const t = tierOf(name);
  return t ? `${t.emoji} ${t.label}` : '⚪ Hors palier';
}

/** Permission déclarée, lisible. */
function declaredLabel(command) {
  const flags = declaredFlags(command);
  if (flags == null) return 'Aucune (ouverte à tous)';
  return new PermissionsBitField(flags).toArray().map((p) => permissionLabel(p)).join(', ');
}

/** Rang de l'auteur de l'interaction. */
function viewerRank(client, interaction) {
  return svc(client).rankOf(interaction.member, { guild: interaction.guild, permissions: interaction.memberPermissions });
}

/** Qui peut attribuer (ou retirer) une commande. */
function assignerLabel(name) {
  const t = tierOf(name);
  if (!t || t.assigner === 'admin') return 'Administrateur';
  return t.assigner === 5 ? 'Propriétaire du serveur' : 'Owner de sécurité (/secur owner) ou propriétaire';
}

/**
 * L'auteur peut-il attribuer (ou retirer) cette commande ? UserError sinon.
 * Palier courant : Administrateur ou rang 4 et plus ; modération : rang 4 et plus ; sanctions
 * lourdes : rang 5 ; hors palier (restriction) : Administrateur. Personne ne délègue une
 * permission qu'il n'a pas.
 */
function assertCanAssign(client, interaction, name, command) {
  if (!isAssignable(name, command)) {
    throw new UserError('Cette commande ne peut pas être attribuée à un niveau (menu contextuel, console des propriétaires du bot ou /permissions elle-même).');
  }
  const t = tierOf(name);
  const rank = viewerRank(client, interaction);
  const admin = interaction.memberPermissions?.has(PermissionFlagsBits.Administrator);
  if (t?.assigner === 5 && rank < 5) {
    throw new UserError(`Seul le **propriétaire du serveur** peut attribuer ou retirer une commande du palier « ${t.label} » (/${name}).`);
  }
  if (t?.assigner === 4 && rank < 4) {
    throw new UserError(`Seuls les **owners de sécurité** (/secur owner) et le propriétaire peuvent attribuer ou retirer une commande du palier « ${t.label} » (/${name}).`);
  }
  if (!admin && rank < 4) throw new UserError('Il vous faut la permission **Administrateur**.');
  const flags = declaredFlags(command);
  if (isDelegable(name, command) && flags && !interaction.memberPermissions?.has(flags)) {
    throw new UserError(`Vous ne pouvez pas déléguer une permission que vous n'avez pas (**${declaredLabel(command)}**).`);
  }
}

/** Commande (par nom saisi ou choisi) ; UserError si elle n'existe pas. */
function commandByName(client, raw) {
  const name = String(raw ?? '').trim().replace(/^\//, '').toLowerCase();
  const command = /^[-_\p{Ll}\p{N}]{1,32}$/u.test(name) ? client.commands.get(name) : null;
  if (!command) throw new UserError('Commande introuvable : choisissez-la dans la liste proposée.');
  return { name, command };
}

/**
 * Attribue `name` au niveau `level` (0 = retirer). Lecture, contrôle et écriture synchrones : un
 * double clic ne produit qu'un changement (et qu'un log).
 * @returns {{ changed: boolean, line: string|null, before: number }}
 */
function assignCommand(client, interaction, name, command, level) {
  if (![0, ...LEVELS].includes(level)) throw new UserError('Niveau invalide (0 à 3).');
  assertCanAssign(client, interaction, name, command);
  const guildId = interaction.guildId;
  const before = svc(client).assignedLevel(guildId, name);
  if (before === level) return { changed: false, line: null, before };
  client.services.config.update(guildId, { permissions: { commands: { [name]: level || null } } });
  const label = (n) => (n ? `niveau ${n}` : 'aucun');
  return { changed: true, before, line: `/${name} (${modeOf(name, command)}) : ${label(before)} → ${label(level)}` };
}

/** Raison de refuser `role` comme rôle de niveau (ajout ou retrait), ou null. */
function levelRoleIssue(client, interaction, role, { adding }) {
  const guild = interaction.guild;
  if (!role) return 'rôle introuvable';
  if (role.id === guild.id) return '@everyone ne peut pas être un rôle de niveau';
  const rank = viewerRank(client, interaction);
  const highest = interaction.member?.roles?.highest?.position ?? 0;
  if (rank < 5 && role.position >= highest) return 'il est au niveau de votre rôle le plus haut ou au-dessus';
  if (!adding) return null;
  if (role.managed) return 'il est géré par une intégration (bot, Boost…)';
  const used = svc(client).autoRoleUse(guild.id, role.id);
  if (used) return `il est déjà utilisé par ${used} : tous ceux qui le reçoivent auraient ce niveau`;
  return null;
}

/**
 * Remplace les rôles du niveau `n` par `wanted` (contrôles rôle par rôle). Synchrone.
 * @returns {{ changed: boolean, refused: string[], lines: string[] }}
 */
function setLevelRoles(client, interaction, n, wanted) {
  const guild = interaction.guild;
  const settings = svc(client).settings(guild.id);
  const current = settings.levels[n].roles;
  const next = [...current];
  const refused = [];
  const lines = [];
  for (const id of wanted) {
    if (next.includes(id)) continue;
    const role = guild.roles.cache.get(id);
    const other = LEVELS.find((l) => l !== n && settings.levels[l].roles.includes(id));
    const issue = other ? `déjà au ${defaultLevelName(other).toLowerCase()} : retirez-le d'abord` : levelRoleIssue(client, interaction, role, { adding: true });
    if (issue) refused.push(`<@&${id}> : ${issue}`);
    else if (next.length >= MAX_LEVEL_ROLES) refused.push(`<@&${id}> : ${MAX_LEVEL_ROLES} rôles au plus par niveau`);
    else next.push(id);
  }
  for (const id of current) {
    if (wanted.includes(id)) continue;
    const role = guild.roles.cache.get(id);
    // Rôle supprimé du serveur : toujours retirable.
    const issue = role ? levelRoleIssue(client, interaction, role, { adding: false }) : null;
    if (issue) refused.push(`<@&${id}> (retrait) : ${issue}`);
    else next.splice(next.indexOf(id), 1);
  }
  const added = next.filter((id) => !current.includes(id));
  const removed = current.filter((id) => !next.includes(id));
  if (!added.length && !removed.length) return { changed: false, refused, lines };
  client.services.config.update(guild.id, { permissions: { levels: { [`l${n}`]: { roles: next } } } });
  const name = escapeMarkdown(svc(client).levelName(guild.id, n));
  if (added.length) lines.push(`${name} : + ${added.map((id) => `<@&${id}>`).join(', ')}`);
  if (removed.length) lines.push(`${name} : − ${removed.map((id) => `<@&${id}>`).join(', ')}`);
  return { changed: true, refused, lines };
}

/** Notice après une modification des rôles d'un niveau. */
function rolesNotice({ changed, refused }) {
  return [
    changed ? `${ICONS.success} Rôles du niveau enregistrés.` : refused.length ? null : `${ICONS.info} Aucun changement.`,
    refused.length ? `${ICONS.warning} Refusé : ${refused.slice(0, 5).join(' · ')}${refused.length > 5 ? ` · +${refused.length - 5}` : ''}` : null,
  ].filter(Boolean).join('\n');
}

/** Rôles de niveau ≥ n (ceux qui profitent d'une commande attribuée au niveau n). */
function rolesFrom(settings, n) {
  return LEVELS.filter((l) => l >= n).flatMap((l) => settings.levels[l].roles);
}

/* ---------------------------------------------------------------------- */
/* Vues                                                                    */
/* ---------------------------------------------------------------------- */

function navRow(client, guildId, current) {
  const nav = [
    { value: 'home', label: 'Accueil', emoji: '🏠', description: 'Hiérarchie, résumé et explications' },
    ...LEVELS.map((n) => ({ value: `l${n}`, label: truncate(svc(client).levelName(guildId, n), 100), emoji: LEVEL_EMOJIS[n], description: `Rôles du niveau ${n} et commandes attribuées` })),
    { value: 'cmds', label: 'Commandes', emoji: '📋', description: 'Attribuer une commande à un niveau' },
    { value: 'strict', label: 'Mode strict', emoji: '🔒', description: 'Restreindre les commandes attribuées (aperçu)' },
    { value: 'checks', label: 'Vérifications', emoji: '🩺', description: 'Intégrations de Discord, rôles disparus' },
  ];
  return row(
    new StringSelectMenuBuilder()
      .setCustomId('cmd:permissions:nav')
      .setPlaceholder('Aller à…')
      .addOptions(nav.map((o) => ({ ...o, default: o.value === current }))),
  );
}

const homeButton = () => actionButton({ command: 'permissions', action: 'go', args: ['home'], label: 'Accueil', emoji: '🏠' });

/** Ligne d'une commande attribuée. */
function assignmentLine({ name, level, delegable }, client, guildId) {
  return `${delegable ? '🟢' : '🔒'} **/${name}** → ${levelLabel(client, guildId, level)} · ${delegable ? 'délégation' : 'restriction'}`;
}

function homeView(client, guild, notice) {
  const s = svc(client);
  const settings = s.settings(guild.id);
  const assignments = s.assignments(guild.id);
  const delegated = assignments.filter((a) => a.delegable).length;
  const owners = client.services.config.get(guild.id)?.secur?.owners ?? [];
  const cached = s.overrides.get(guild.id);
  const hidden = cached && !cached.error
    ? assignments.filter((a) => a.delegable && PermissionService.visibility(cached, guild, a.name, rolesFrom(settings, a.level)) === 'hidden').length
    : 0;
  const levelField = (n) => {
    const roles = settings.levels[n].roles;
    return field(LEVEL_EMOJIS[n], levelLabel(client, guild.id, n), roles.length ? roles.map((id) => `<@&${id}>`).join(' ') : '*Aucun rôle*');
  };
  return {
    embeds: [
      card({
        tone: hidden ? 'warning' : 'brand',
        section: SECTION,
        icon: '🔑',
        title: 'Permissions par niveaux',
        description: [
          notice ? `${notice}\n` : null,
          '**Hiérarchie** : propriétaire (5) › owners de sécurité (4, /secur owner) › niveaux 3, 2, 1 › membres. Un administrateur vaut le niveau 3.',
          '',
          `${ICONS.success} **Délégation** : seules **/embed**, **/clear**, **/slowmode** et **/pseudo** (palier courant) peuvent être utilisées par un niveau **sans** leur permission Discord.`,
          `${ICONS.lock} **Restriction** : en mode strict, une commande attribuée au niveau N est refusée en dessous de N, même avec la permission (administrateurs et owners exemptés).`,
          `${ICONS.shield} Les commandes de sanction (/ban, /kick, /timeout, /warn…) ne sont **jamais** déléguées : la permission Discord reste exigée.`,
          `${ICONS.info} Deux clés : Discord **affiche** une commande selon Paramètres du serveur → Intégrations ; le bot l'**autorise** selon le niveau. Voir « Vérifications ».`,
          hidden ? `\n${ICONS.warning} **${hidden}** commande(s) déléguée(s) masquée(s) par Discord aux rôles de leur niveau.` : null,
        ],
        fields: [
          ...LEVELS.map(levelField),
          field(ICONS.list, 'Commandes', `${delegated} déléguée(s) · ${assignments.length - delegated} restriction(s)`),
          field(ICONS.lock, 'Mode strict', settings.strict ? '🟢 Activé' : '⚪ Désactivé'),
          field(ICONS.owner, 'Owners de sécurité', `${owners.length}`),
        ],
        footer: 'Les attributions automatiques (menus de rôles, boutique…) refusent les rôles de niveau',
      }),
    ],
    components: [
      navRow(client, guild.id, 'home'),
      ...buttonRows(
        actionButton({ command: 'permissions', action: 'go', args: ['cmds'], label: 'Attribuer une commande', emoji: '📋', style: ButtonStyle.Primary }),
        actionButton({ command: 'permissions', action: 'go', args: ['home'], label: 'Actualiser', emoji: ICONS.refresh }),
      ),
    ],
  };
}

function levelView(client, guild, n, notice) {
  const s = svc(client);
  const settings = s.settings(guild.id);
  const level = settings.levels[n];
  const assigned = s.assignments(guild.id).filter((a) => a.level === n);
  const members = (id) => guild.roles.cache.get(id)?.members?.size ?? 0;
  const roleLines = level.roles.map((id) => (guild.roles.cache.has(id) ? `<@&${id}> · ${members(id)} membre(s) en cache` : `${ICONS.warning} rôle supprimé (\`${id}\`)`));
  const select = new RoleSelectMenuBuilder()
    .setCustomId(`cmd:permissions:roles:${n}`)
    .setPlaceholder(`Rôles du niveau ${n} (${MAX_LEVEL_ROLES} au plus)`)
    .setMinValues(0)
    .setMaxValues(MAX_LEVEL_ROLES);
  const present = level.roles.filter((id) => guild.roles.cache.has(id));
  if (present.length) select.setDefaultRoles(...present);
  return {
    embeds: [
      card({
        tone: 'brand',
        section: SECTION,
        icon: LEVEL_EMOJIS[n],
        title: `${levelLabel(client, guild.id, n)}${level.name ? ` · niveau ${n}` : ''}`,
        description: [
          notice ? `${notice}\n` : null,
          `Les membres qui ont l'un de ces rôles sont de **rang ${n}** (le plus haut niveau l'emporte). Ils utilisent les commandes **déléguées** au niveau ${n} ou moins, et ne peuvent être sanctionnés que par un rang égal ou supérieur.`,
          '',
          roleLines.length ? roleLines.join('\n') : '*Aucun rôle : choisissez-en dans le menu ci-dessous.*',
          '',
          subtext('Refusés : @everyone, rôles gérés, rôles donnés automatiquement (arrivée, niveaux, menus de rôles, boutique…), rôles au niveau du vôtre ou au-dessus.'),
        ],
        fields: [
          wide(ICONS.list, 'Commandes attribuées à ce niveau', assigned.length ? assigned.slice(0, MAX_LINES).map((a) => assignmentLine(a, client, guild.id)).join('\n') : '*Aucune*'),
        ],
        footer: `Nom du niveau : ${MAX_LEVEL_NAME} caractères au plus`,
      }),
    ],
    components: [
      navRow(client, guild.id, `l${n}`),
      row(select),
      ...buttonRows(
        actionButton({ command: 'permissions', action: 'rename', args: [n], label: 'Renommer', emoji: '✏️', style: ButtonStyle.Primary }),
        level.name ? actionButton({ command: 'permissions', action: 'unname', args: [n], label: 'Nom par défaut', emoji: '↩️' }) : null,
        homeButton(),
      ),
    ],
  };
}

function commandsView(client, guild, page = 0, notice) {
  const s = svc(client);
  const names = assignableCommands(client);
  const pages = Math.max(1, Math.ceil(names.length / PAGE_SIZE));
  const p = Math.min(Math.max(0, Number.parseInt(page, 10) || 0), pages - 1);
  const slice = names.slice(p * PAGE_SIZE, (p + 1) * PAGE_SIZE);
  const assignments = s.assignments(guild.id);
  const lines = assignments.slice(0, MAX_LINES).map((a) => assignmentLine(a, client, guild.id));
  const picker = new StringSelectMenuBuilder()
    .setCustomId(`cmd:permissions:pick:${p}`)
    .setPlaceholder(`Choisir une commande… (page ${p + 1}/${pages})`)
    .addOptions(slice.map((name) => {
      const command = client.commands.get(name);
      const level = s.assignedLevel(guild.id, name);
      return {
        value: name,
        label: `/${name}`,
        description: truncate(`${tierLabel(name)} · ${isDelegable(name, command) ? 'délégable' : 'restriction seulement'} · ${level ? `niveau ${level}` : 'non attribuée'}`, 100),
      };
    }));
  return {
    embeds: [
      card({
        tone: 'brand',
        section: SECTION,
        icon: ICONS.list,
        title: 'Permissions · Commandes',
        description: [
          notice ? `${notice}\n` : null,
          'Choisissez une commande pour l\'attribuer à un niveau.',
          `${DELEGATION_TIERS.low.emoji} **Courant** (délégable) : ${DELEGATION_TIERS.low.commands.map((c) => `/${c}`).join(', ')} — Administrateur.`,
          `${DELEGATION_TIERS.moderation.emoji} **Modération** (restriction seulement) : owners de sécurité et propriétaire.`,
          `${DELEGATION_TIERS.high.emoji} **Sanctions lourdes** (restriction seulement) : propriétaire.`,
          '⚪ **Hors palier** (restriction seulement) : Administrateur.',
          '',
          lines.length ? lines.join('\n') : '*Aucune commande attribuée.*',
          assignments.length > MAX_LINES ? subtext(`… et ${assignments.length - MAX_LINES} autre(s).`) : null,
        ],
        footer: `${assignments.length} commande(s) attribuée(s) · ${names.length} attribuable(s)`,
      }),
    ],
    components: [
      navRow(client, guild.id, 'cmds'),
      row(picker),
      ...buttonRows(
        pages > 1 ? actionButton({ command: 'permissions', action: 'go', args: [`cmds.${(p + pages - 1) % pages}`], label: 'Précédente', emoji: ICONS.back }) : null,
        pages > 1 ? actionButton({ command: 'permissions', action: 'go', args: [`cmds.${(p + 1) % pages}`], label: 'Suivante', emoji: ICONS.next }) : null,
        homeButton(),
      ),
    ],
  };
}

function commandView(client, interaction, name, notice) {
  const guild = interaction.guild;
  const command = client.commands.get(name);
  if (!isAssignable(name, command)) throw new UserError('Cette commande ne peut pas être attribuée à un niveau.');
  const s = svc(client);
  const level = s.assignedLevel(guild.id, name);
  const delegable = isDelegable(name, command);
  const sensitive = sensitiveLabels(command);
  let canAssign = true;
  try {
    assertCanAssign(client, interaction, name, command);
  } catch {
    canAssign = false;
  }
  const why = delegable
    ? `Un membre de niveau ≥ N utilise **/${name}** même sans **${declaredLabel(command)}** ; l'action reste contrôlée (salon visible, hiérarchie) et journalisée.`
    : sensitive.length
      ? `**/${name}** protège une action sensible (**${sensitive.join(', ')}**) : elle n'est **jamais** déléguée. L'attribuer à un niveau la **restreint** (mode strict) ; la permission Discord reste exigée.`
      : `**/${name}** est hors des paliers délégables : l'attribuer à un niveau la **restreint** en mode strict.`;
  return {
    embeds: [
      card({
        tone: level ? (delegable ? 'success' : 'caution') : 'neutral',
        section: SECTION,
        icon: delegable ? '🟢' : ICONS.lock,
        title: `Commande · /${name}`,
        description: [notice ? `${notice}\n` : null, why, canAssign ? null : `\n${ICONS.warning} Réservé à : **${assignerLabel(name)}**.`],
        fields: [
          field(ICONS.tag, 'Palier', tierLabel(name)),
          field(ICONS.shield, 'Permission déclarée', declaredLabel(command)),
          field('🔑', 'Niveau', level ? levelLabel(client, guild.id, level) : 'Non attribuée'),
          field(ICONS.settings, 'Mode', delegable ? 'Délégation' : 'Restriction'),
          field(ICONS.owner, 'Attribuable par', assignerLabel(name)),
          field(ICONS.lock, 'Mode strict', s.settings(guild.id).strict ? 'Activé' : 'Désactivé'),
        ],
      }),
    ],
    components: [
      navRow(client, guild.id, 'cmds'),
      ...buttonRows(
        ...LEVELS.map((n) => actionButton({ command: 'permissions', action: 'set', args: [name, n], label: `Niveau ${n}`, emoji: LEVEL_EMOJIS[n], style: level === n ? ButtonStyle.Success : ButtonStyle.Secondary, disabled: !canAssign || level === n })),
        level ? actionButton({ command: 'permissions', action: 'set', args: [name, 0], label: 'Retirer', emoji: ICONS.delete, style: ButtonStyle.Danger, disabled: !canAssign }) : null,
        actionButton({ command: 'permissions', action: 'go', args: ['cmds'], label: 'Retour', emoji: ICONS.back }),
      ),
    ],
  };
}

/** Membres en cache qui perdraient l'accès à une commande en mode strict. */
function strictImpact(client, guild, name, level) {
  const command = client.commands.get(name);
  const flags = declaredFlags(command);
  let n = 0;
  for (const m of guild.members.cache.values()) {
    if (m.user?.bot) continue;
    const perms = m.permissions;
    if (perms?.has?.(PermissionFlagsBits.Administrator)) continue;
    if (flags != null && !perms?.has?.(flags)) continue;
    const rank = svc(client).rankOf(m, { guild });
    if (rank >= 4 || rank >= level) continue;
    n += 1;
  }
  return n;
}

function strictView(client, guild, notice) {
  const s = svc(client);
  const { strict } = s.settings(guild.id);
  const assignments = s.assignments(guild.id);
  const lines = assignments.slice(0, MAX_LINES).map((a) => `${assignmentLine(a, client, guild.id)} · ${strictImpact(client, guild, a.name, a.level)} membre(s) bloqué(s)`);
  return {
    embeds: [
      card({
        tone: strict ? 'caution' : 'neutral',
        section: SECTION,
        icon: ICONS.lock,
        title: `Mode strict · ${strict ? 'activé' : 'désactivé'}`,
        description: [
          notice ? `${notice}\n` : null,
          'En mode strict, une commande attribuée au **niveau N** est refusée aux membres de rang inférieur, **même s\'ils ont la permission Discord** (ex : réserver /ban au niveau 3). Administrateurs et owners de sécurité ne sont jamais bloqués.',
          '',
          lines.length ? `**Aperçu** (membres en cache qui ont la permission mais pas le niveau) :\n${lines.join('\n')}` : '*Aucune commande attribuée : le mode strict n\'a aucun effet.*',
          '',
          subtext('Le mode strict s\'applique aux commandes et à leurs boutons ; il ne donne jamais d\'accès.'),
        ],
        fields: [field(ICONS.status, 'État', strict ? '🟢 Activé' : '⚪ Désactivé'), field(ICONS.list, 'Commandes attribuées', `${assignments.length}`)],
      }),
    ],
    components: [
      navRow(client, guild.id, 'strict'),
      ...buttonRows(
        strict
          ? actionButton({ command: 'permissions', action: 'strict', args: ['off'], label: 'Désactiver', emoji: '⏸️', style: ButtonStyle.Danger })
          : actionButton({ command: 'permissions', action: 'strict', args: ['on'], label: 'Activer', emoji: '▶️', style: ButtonStyle.Success }),
        homeButton(),
      ),
    ],
  };
}

async function checksView(client, guild, { force = false, notice } = {}) {
  const s = svc(client);
  const settings = s.settings(guild.id);
  const assignments = s.assignments(guild.id);
  const status = await s.integrationOverrides(guild, { force });
  const delegated = assignments.filter((a) => a.delegable);
  const lines = delegated.slice(0, MAX_LINES).map((a) => {
    const roles = rolesFrom(settings, a.level);
    if (!roles.length) return `${ICONS.warning} **/${a.name}** (niveau ${a.level}) : aucun rôle à ce niveau ou au-dessus.`;
    const v = PermissionService.visibility(status, guild, a.name, roles);
    if (v === 'visible') return `${ICONS.success} **/${a.name}** (niveau ${a.level}) : visible pour au moins un rôle du niveau.`;
    if (v === 'hidden') return `${ICONS.warning} **/${a.name}** (niveau ${a.level}) : **masquée par Discord** aux membres sans **${declaredLabel(a.command)}**. Paramètres du serveur → Intégrations → ${escapeMarkdown(client.user?.username ?? 'le bot')} → /${a.name} : autorisez les rôles du niveau.`;
    return `❔ **/${a.name}** (niveau ${a.level}) : visibilité inconnue (commande non enregistrée ici, ou lecture impossible).`;
  });
  const gone = LEVELS.flatMap((n) => settings.levels[n].roles.filter((id) => !guild.roles.cache.has(id)).map((id) => `${defaultLevelName(n)} : rôle supprimé \`${id}\``));
  const unknown = Object.keys(settings.commands).filter((name) => !isAssignable(name, client.commands.get(name)));
  const extra = [
    ...gone.map((l) => `${ICONS.warning} ${l}`),
    unknown.length ? `${ICONS.info} Commande(s) inconnue(s) ignorée(s) : ${unknown.slice(0, 10).map((n) => `\`${n}\``).join(', ')}` : null,
  ].filter(Boolean);
  return {
    embeds: [
      card({
        tone: lines.some((l) => l.startsWith(ICONS.warning)) || extra.length ? 'warning' : 'info',
        section: SECTION,
        icon: '🩺',
        title: 'Permissions · Vérifications',
        description: [
          notice ? `${notice}\n` : null,
          'Un bot ne peut pas modifier les surcharges de Paramètres du serveur → Intégrations : il les **lit** pour signaler une commande déléguée que Discord n\'affiche pas aux rôles de son niveau.',
          status.error ? `\n${ICONS.warning} Lecture des surcharges impossible (${escapeMarkdown(status.error)}) : vérification de visibilité ignorée.` : null,
          '',
          lines.length ? lines.join('\n') : '*Aucune commande déléguée.*',
          extra.length ? `\n${extra.join('\n')}` : null,
        ],
        footer: status.error ? 'Lecture des surcharges en échec · nouvel essai dans 5 minutes' : 'Surcharges lues · cache de 5 minutes',
        timestamp: status.at,
      }),
    ],
    components: [
      navRow(client, guild.id, 'checks'),
      ...buttonRows(actionButton({ command: 'permissions', action: 'recheck', label: 'Relire', emoji: ICONS.refresh }), homeButton()),
    ],
  };
}

/** Vue synchrone (les vérifications passent par checksView, asynchrone). */
function render(client, interaction, view = 'home', notice) {
  const guild = interaction.guild;
  const [name, arg] = String(view).split('.');
  if (/^l[123]$/.test(name)) return levelView(client, guild, Number(name.slice(1)), notice);
  if (name === 'cmds') return commandsView(client, guild, arg, notice);
  if (name === 'cmd') return commandView(client, interaction, arg, notice);
  if (name === 'strict') return strictView(client, guild, notice);
  return homeView(client, guild, notice);
}

/** Affiche une vue par mise à jour du message (vérifications : différées). */
async function show(client, interaction, view, notice) {
  if (view === 'checks') {
    await interaction.deferUpdate();
    await interaction.editReply(await checksView(client, interaction.guild, { notice }));
    return;
  }
  await interaction.update(render(client, interaction, view, notice));
}

/* ---------------------------------------------------------------------- */
/* Vérification d'un membre                                                 */
/* ---------------------------------------------------------------------- */

function memberCheckView(client, guild, member) {
  const s = svc(client);
  const settings = s.settings(guild.id);
  const rank = s.rankOf(member, { guild });
  const perms = member.permissions;
  const admin = perms?.has?.(PermissionFlagsBits.Administrator);
  const assignments = s.assignments(guild.id);
  const delegated = assignments.filter((a) => a.delegable && a.level <= rank && !perms?.has?.(declaredFlags(a.command)));
  const blocked = settings.strict && !admin && rank < 4
    ? assignments.filter((a) => a.level > rank && (declaredFlags(a.command) == null || perms?.has?.(declaredFlags(a.command))))
    : [];
  const protection = rank >= 4
    ? 'Seul le propriétaire du serveur peut le sanctionner.'
    : rank > 0 ? `Ne peut être sanctionné que par un membre de rang ${rank} ou plus (et au-dessus dans la hiérarchie des rôles).` : 'Hiérarchie des rôles habituelle.';
  const level = s.memberLevel(guild.id, roleIdsOf(member));
  return {
    embeds: [
      card({
        tone: 'info',
        section: SECTION,
        icon: ICONS.search,
        title: `Vérification · ${truncate(member.displayName ?? member.user?.username ?? 'membre', 100)}`,
        description: `${member} est de **rang ${rank}** : ${s.rankSource(member, { guild })}.`,
        thumbnail: member.displayAvatarURL?.(),
        fields: [
          field('🔑', 'Rang', `${rank} / 5`),
          field(ICONS.role, 'Niveau par les rôles', level ? levelLabel(client, guild.id, level) : 'Aucun'),
          field(ICONS.shield, 'Administrateur', admin ? 'Oui (vaut le niveau 3)' : 'Non'),
          wide(ICONS.success, 'Commandes déléguées utilisables', delegated.length ? delegated.slice(0, MAX_LINES).map((a) => `/${a.name} (niveau ${a.level})`).join(', ') : '*Aucune*'),
          wide(ICONS.lock, 'Bloquées par le mode strict', blocked.length ? blocked.slice(0, MAX_LINES).map((a) => `/${a.name} (niveau ${a.level})`).join(', ') : '*Aucune*'),
          wide(ICONS.moderator, 'Protection', protection),
        ],
      }),
    ],
  };
}

/* ---------------------------------------------------------------------- */
/* Commande                                                                */
/* ---------------------------------------------------------------------- */

module.exports = {
  category: 'security',
  cooldown: 3_000,
  render,
  checksView,
  memberCheckView,
  assignableCommands,
  assertCanAssign,
  assignCommand,
  setLevelRoles,
  levelRoleIssue,
  data: new SlashCommandBuilder()
    .setName('permissions')
    .setDescription('Niveaux de permissions : rôles des niveaux 1 à 3, commandes attribuées, mode strict.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand((s) => s.setName('panneau').setDescription('Ouvre le tableau de bord des niveaux de permissions.'))
    .addSubcommand((s) =>
      s
        .setName('commande')
        .setDescription('Attribue une commande à un niveau (0 pour la retirer).')
        .addStringOption((o) => o.setName('nom').setDescription('Commande à attribuer (liste proposée)').setRequired(true).setAutocomplete(true).setMaxLength(33))
        .addIntegerOption((o) =>
          o
            .setName('niveau')
            .setDescription('Niveau requis : 1, 2 ou 3 (0 retire l\'attribution)')
            .setRequired(true)
            .addChoices({ name: 'Retirer (aucun niveau)', value: 0 }, { name: 'Niveau 1', value: 1 }, { name: 'Niveau 2', value: 2 }, { name: 'Niveau 3', value: 3 }),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName('niveau')
        .setDescription('Ajoute ou retire un rôle d\'un niveau.')
        .addIntegerOption((o) => o.setName('numero').setDescription('Numéro du niveau (1 à 3)').setRequired(true).addChoices({ name: 'Niveau 1', value: 1 }, { name: 'Niveau 2', value: 2 }, { name: 'Niveau 3', value: 3 }))
        .addStringOption((o) => o.setName('action').setDescription('Ajouter ou retirer le rôle').setRequired(true).addChoices({ name: 'Ajouter', value: 'ajouter' }, { name: 'Retirer', value: 'retirer' }))
        .addRoleOption((o) => o.setName('role').setDescription('Rôle à ajouter au niveau ou à en retirer').setRequired(true)),
    )
    .addSubcommand((s) =>
      s
        .setName('verifier')
        .setDescription('Affiche le rang d\'un membre et les commandes que ses niveaux lui ouvrent ou ferment.')
        .addUserOption((o) => o.setName('membre').setDescription('Membre à vérifier').setRequired(true)),
    ),

  async autocomplete(interaction, client) {
    // L'autocomplétion ne passe pas par preflight : contrôle refait ici.
    if (!interaction.inGuild() || !interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) return interaction.respond([]);
    const focused = interaction.options.getFocused(true);
    if (focused?.name !== 'nom') return interaction.respond([]);
    const q = String(focused.value ?? '').trim().replace(/^\//, '').toLowerCase();
    const choices = assignableCommands(client)
      .filter((name) => !q || name.includes(q))
      .slice(0, 25)
      .map((name) => {
        const level = svc(client).assignedLevel(interaction.guildId, name);
        const mode = isDelegable(name, client.commands.get(name)) ? 'délégable' : 'restriction';
        return { name: truncate(`/${name} — ${tierLabel(name).replace(/^\S+\s/, '')} · ${mode}${level ? ` · niveau ${level}` : ''}`, 100), value: name };
      });
    return interaction.respond(choices);
  },

  async execute(interaction, client) {
    guard(interaction);
    const sub = interaction.options.getSubcommand();

    if (sub === 'panneau') {
      return interaction.reply({ ...render(client, interaction, 'home'), ephemeral: true });
    }

    if (sub === 'commande') {
      const { name, command } = commandByName(client, interaction.options.getString('nom'));
      const level = interaction.options.getInteger('niveau');
      const result = assignCommand(client, interaction, name, command, level);
      const delegable = isDelegable(name, command);
      const notice = !result.changed
        ? `${ICONS.info} Aucun changement : /${name} est déjà ${level ? `au niveau ${level}` : 'sans niveau'}.`
        : level
          ? `${ICONS.success} **/${name}** est attribuée au **niveau ${level}** (${delegable ? 'délégation' : 'restriction en mode strict'}).`
          : `${ICONS.success} **/${name}** n'est plus attribuée à aucun niveau.`;
      await interaction.reply({ ...commandView(client, interaction, name, notice), ephemeral: true });
      if (result.changed) await svc(client).logChange(interaction.guild, interaction.user, [result.line]);
      return undefined;
    }

    if (sub === 'niveau') {
      const n = interaction.options.getInteger('numero');
      if (!LEVELS.includes(n)) throw new UserError('Niveau invalide (1 à 3).');
      const action = interaction.options.getString('action');
      const picked = interaction.options.getRole('role');
      const role = picked ? interaction.guild.roles.cache.get(picked.id) ?? null : null;
      if (!role) throw new UserError('Ce rôle est introuvable : il a peut-être été supprimé.');
      const current = svc(client).settings(interaction.guildId).levels[n].roles;
      if (action === 'ajouter' && current.includes(role.id)) throw new UserError(`${role} est déjà au niveau ${n}.`);
      if (action === 'retirer' && !current.includes(role.id)) throw new UserError(`${role} n'est pas au niveau ${n}.`);
      const wanted = action === 'ajouter' ? [...current, role.id] : current.filter((id) => id !== role.id);
      const result = setLevelRoles(client, interaction, n, wanted);
      if (!result.changed) throw new UserError(`Impossible : ${result.refused[0]?.replace(/^<@&\d+>( \(retrait\))? : /, '') ?? 'aucun changement'}.`);
      await interaction.reply({ ...levelView(client, interaction.guild, n, rolesNotice(result)), ephemeral: true });
      await svc(client).logChange(interaction.guild, interaction.user, result.lines);
      return undefined;
    }

    if (sub === 'verifier') {
      const user = interaction.options.getUser('membre');
      await interaction.deferReply({ ephemeral: true });
      const member = interaction.guild.members.cache.get(user.id) ?? (await interaction.guild.members.fetch(user.id).catch(() => null));
      if (!member) throw new UserError('Ce membre n\'est pas sur le serveur.');
      return interaction.editReply(memberCheckView(client, interaction.guild, member));
    }
    return undefined;
  },

  buttons: {
    /** Menu de navigation. */
    async nav(interaction, client) {
      guard(interaction);
      await show(client, interaction, interaction.values?.[0] ?? 'home');
    },
    /** cmd:permissions:go:<vue> */
    async go(interaction, client, [view]) {
      guard(interaction);
      await show(client, interaction, view ?? 'home');
    },
    /** cmd:permissions:roles:<n> — rôles du niveau (menu de rôles, liste complète). */
    async roles(interaction, client, [rawN]) {
      guard(interaction);
      const n = Number(rawN);
      if (!LEVELS.includes(n)) throw new UserError('Ce menu est invalide.');
      const wanted = [...new Set((interaction.values ?? []).filter((id) => /^\d{17,20}$/.test(id)))].slice(0, MAX_LEVEL_ROLES);
      const result = setLevelRoles(client, interaction, n, wanted);
      await interaction.update(levelView(client, interaction.guild, n, rolesNotice(result)));
      if (result.changed) await svc(client).logChange(interaction.guild, interaction.user, result.lines);
    },
    /** cmd:permissions:rename:<n> — formulaire du nom. */
    async rename(interaction, client, [rawN]) {
      guard(interaction);
      const n = Number(rawN);
      if (!LEVELS.includes(n)) throw new UserError('Ce bouton est invalide.');
      const input = new TextInputBuilder()
        .setCustomId('nom')
        .setLabel(`Nom du niveau (${MAX_LEVEL_NAME} caractères au plus)`)
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMinLength(1)
        .setMaxLength(MAX_LEVEL_NAME)
        .setPlaceholder(`ex : Helpers (niveau ${n})`);
      const current = svc(client).settings(interaction.guildId).levels[n].name;
      if (current) input.setValue(current);
      await interaction.showModal(new ModalBuilder().setCustomId(`cmd:permissions:name:${n}`).setTitle(`Renommer le niveau ${n}`).addComponents(row(input)));
    },
    /** cmd:permissions:name:<n> — formulaire soumis. */
    async name(interaction, client, [rawN]) {
      guard(interaction);
      const n = Number(rawN);
      if (!LEVELS.includes(n)) throw new UserError('Ce formulaire est invalide.');
      // eslint-disable-next-line no-control-regex
      const value = String(interaction.fields.getTextInputValue('nom') ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
      if (!value) throw new UserError('Le nom ne peut pas être vide.');
      if ([...value].length > MAX_LEVEL_NAME) throw new UserError(`Le nom est trop long (${MAX_LEVEL_NAME} caractères au plus).`);
      const before = svc(client).levelName(interaction.guildId, n);
      client.services.config.update(interaction.guildId, { permissions: { levels: { [`l${n}`]: { name: value } } } });
      const view = levelView(client, interaction.guild, n, `${ICONS.success} Niveau ${n} renommé.`);
      if (interaction.isFromMessage?.()) await interaction.update(view);
      else await interaction.reply({ ...view, ephemeral: true });
      if (before !== value) await svc(client).logChange(interaction.guild, interaction.user, [`Niveau ${n} : nom « ${escapeMarkdown(before)} » → « ${escapeMarkdown(value)} »`]);
    },
    /** cmd:permissions:unname:<n> — nom par défaut. */
    async unname(interaction, client, [rawN]) {
      guard(interaction);
      const n = Number(rawN);
      if (!LEVELS.includes(n)) throw new UserError('Ce bouton est invalide.');
      const before = svc(client).settings(interaction.guildId).levels[n].name;
      if (before) client.services.config.update(interaction.guildId, { permissions: { levels: { [`l${n}`]: { name: null } } } });
      await interaction.update(levelView(client, interaction.guild, n, `${ICONS.success} Nom par défaut rétabli.`));
      if (before) await svc(client).logChange(interaction.guild, interaction.user, [`Niveau ${n} : nom « ${escapeMarkdown(before)} » → par défaut`]);
    },
    /** cmd:permissions:pick:<page> — commande choisie. */
    async pick(interaction, client) {
      guard(interaction);
      const { name } = commandByName(client, interaction.values?.[0]);
      await interaction.update(commandView(client, interaction, name));
    },
    /** cmd:permissions:set:<commande>:<niveau> — valeur cible (un double clic ne change rien). */
    async set(interaction, client, [rawName, rawLevel]) {
      guard(interaction);
      const { name, command } = commandByName(client, rawName);
      const level = Number(rawLevel);
      const result = assignCommand(client, interaction, name, command, level);
      const notice = result.changed ? `${ICONS.success} ${level ? `Attribuée au **niveau ${level}**.` : 'Attribution retirée.'}` : `${ICONS.info} Aucun changement.`;
      await interaction.update(commandView(client, interaction, name, notice));
      if (result.changed) await svc(client).logChange(interaction.guild, interaction.user, [result.line]);
    },
    /** cmd:permissions:strict:<on|off> — valeur cible. */
    async strict(interaction, client, [state]) {
      guard(interaction);
      if (state !== 'on' && state !== 'off') throw new UserError('Ce bouton est invalide.');
      const wanted = state === 'on';
      const before = svc(client).settings(interaction.guildId).strict;
      if (before !== wanted) client.services.config.update(interaction.guildId, { permissions: { strict: wanted } });
      await interaction.update(strictView(client, interaction.guild, before === wanted ? `${ICONS.info} Aucun changement.` : `${ICONS.success} Mode strict **${wanted ? 'activé' : 'désactivé'}**.`));
      if (before !== wanted) await svc(client).logChange(interaction.guild, interaction.user, [`Mode strict : ${before ? 'activé' : 'désactivé'} → ${wanted ? 'activé' : 'désactivé'}`]);
    },
    /** cmd:permissions:recheck — relecture des surcharges (au plus une fois par 30 s). */
    async recheck(interaction, client) {
      guard(interaction);
      await interaction.deferUpdate();
      await interaction.editReply(await checksView(client, interaction.guild, { force: true }));
    },
  },
};
