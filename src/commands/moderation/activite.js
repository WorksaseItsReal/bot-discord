'use strict';

const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  ActionRowBuilder,
  RoleSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');
const { card, field, wide, ICONS, subtext, status, actionButton, labelButton, buttonRows, ButtonStyle } = require('../../utils/ui');
const { truncate } = require('../../utils/embeds');
const { discordTimestamp } = require('../../utils/time');
const { UserError } = require('../../core/errors');
const { requirePermission } = require('../../services/ModerationService');
const { logCard, fitList } = require('../../services/LoggingService');
const { hasForbiddenPermissions } = require('../roles/rolemenu');
const { canActOnByHierarchy } = require('../../utils/permissions');
const { applyRoles } = require('../../utils/memberRoles');
const { DAY_MS, formatDay, fr } = require('../../utils/activity');
const { createLogger } = require('../../core/logger');

const logger = createLogger('activite');

/**
 * /activite : membres inactifs (aucun message ni vocal depuis N jours, arrivés depuis plus
 * de N jours), liste paginée et actions groupées confirmées : donner / retirer un rôle,
 * MP (une fois par semaine et par membre), expulsion (50 max, confirmation forte).
 * Les actions sont refusées tant que la collecte des statistiques a moins de N jours :
 * avant elle, tout le monde paraît inactif.
 */

const SECTION = { emoji: '💤', label: 'Membres inactifs' };
const PAGE_SIZE = 10;
const DEFAULT_DAYS = 30;
const MIN_DAYS = 7;
const MAX_DAYS = 365;
const MAX_EXCLUDED = 10;
/** Membres traités au plus par exécution. */
const LIMITS = Object.freeze({ give: 100, take: 100, dm: 25, kick: 50 });
const MAX_DM = 1000;
const MAX_REASON = 200;
const KICK_WORD = 'EXPULSER';
const DEFAULT_DM = 'Bonjour {membre} ! Nous ne vous avons pas vu sur **{serveur}** depuis plus de {jours} jours. Vous nous manquez : revenez nous dire bonjour quand vous voulez 👋';
const SNOWFLAKE = /^\d{17,20}$/;
/** Pause entre deux MP (anti-spam côté Discord). Réglable pour les tests. */
const timing = { dmDelayMs: 1_000 };

const ACTIONS = {
  give: { label: 'Donner un rôle', emoji: ICONS.role, verb: 'a donné un rôle à', done: 'Rôle donné', permission: 'ManageRoles' },
  take: { label: 'Retirer un rôle', emoji: '➖', verb: 'a retiré un rôle à', done: 'Rôle retiré', permission: 'ManageRoles' },
  dm: { label: 'Envoyer un MP', emoji: ICONS.mail, verb: 'a envoyé un MP à', done: 'MP envoyé', permission: null },
  kick: { label: 'Expulser', emoji: ICONS.kick, verb: 'a expulsé', done: 'Expulsé', permission: 'KickMembers' },
};

const row = (component) => new ActionRowBuilder().addComponents(component);
const guard = (interaction) => requirePermission(interaction, 'ManageGuild');
const statsOf = (client, guildId) => client.services.config.get(guildId).stats ?? {};
const inactivityOf = (client, guildId) => statsOf(client, guildId).inactivity ?? {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Nombre de jours valide (7 à 365, et pas au-delà de la conservation). */
function parseDays(client, guildId, raw) {
  const days = Number(raw ?? DEFAULT_DAYS);
  if (!Number.isInteger(days) || days < MIN_DAYS || days > MAX_DAYS) throw new UserError(`Nombre de jours : entre ${MIN_DAYS} et ${MAX_DAYS}.`);
  const retention = client.services.activity.retention(guildId);
  if (days > retention) {
    throw new UserError(`Les statistiques ne sont conservées que **${retention} jours** : choisissez au plus ${retention} jours, ou allongez la conservation avec \`/statistiques reglages\`.`);
  }
  return days;
}

function parseAction(raw) {
  if (!Object.hasOwn(ACTIONS, raw ?? '')) throw new UserError('Action inconnue.');
  return raw;
}

/** Remplit le modèle de MP ({membre}, {pseudo}, {serveur}, {jours}). Pur. */
function renderDm(template, { member, name, server, days }) {
  return truncate(
    String(template || DEFAULT_DM)
      .replace(/\{(membre|member)\}/gi, member ?? '')
      .replace(/\{(pseudo|name)\}/gi, name ?? '')
      .replace(/\{(serveur|server)\}/gi, server ?? '')
      .replace(/\{(jours|days)\}/gi, String(days ?? '')),
    2000,
  );
}

/** Carte du MP envoyé aux inactifs (contenu du staff, en embed : aucune mention ne notifie). */
function dmCard(guild, member, template, days) {
  return card({
    tone: 'info',
    section: { emoji: ICONS.server, label: guild.name },
    icon: '👋',
    title: 'Vous nous manquez !',
    description: renderDm(template, { member: `${member}`, name: member.displayName ?? member.user?.username, server: guild.name, days }),
    thumbnail: guild.iconURL?.({ size: 128 }) ?? null,
    footer: `Message de l'équipe de ${guild.name}`,
  });
}

/** Les actions groupées sont-elles possibles ? (sinon, la raison) */
function blockedReason(client, guildId, days, now = Date.now()) {
  const activity = client.services.activity;
  if (!activity.collecting(guildId)) return 'La collecte des statistiques est **désactivée** (`/statistiques reglages`) : impossible de savoir qui est inactif.';
  const since = activity.since(guildId);
  if (!since) return 'La collecte des statistiques n\'a pas encore commencé.';
  if (now - since < days * DAY_MS) {
    return `La collecte tourne depuis **${activity.collectedDays(guildId, now)} jour(s)** seulement : avant elle, tout le monde paraît inactif. Actions disponibles ${discordTimestamp(since + days * DAY_MS, 'R')} (ou choisissez moins de jours).`;
  }
  return null;
}

function assertReady(client, guildId, days) {
  const reason = blockedReason(client, guildId, days);
  if (reason) throw new UserError(reason);
}

/** Rôle choisi pour une action groupée : existe, gérable par le bot ET par l'auteur, sans permission sensible (ajout). */
function checkRole(interaction, roleId, action) {
  const guild = interaction.guild;
  if (!SNOWFLAKE.test(roleId ?? '')) throw new UserError('Rôle invalide.');
  const role = guild.roles.cache.get(roleId);
  if (!role) throw new UserError('Ce rôle n\'existe plus.');
  if (role.id === guild.id || role.managed) throw new UserError('Ce rôle ne peut pas être attribué (rôle @everyone ou géré par une intégration).');
  const me = guild.members.me;
  if (!me?.permissions?.has(PermissionFlagsBits.ManageRoles)) throw new UserError('Il me manque la permission **Gérer les rôles**.');
  if (role.position >= (me.roles?.highest?.position ?? 0)) throw new UserError(`Le rôle ${role} est au-dessus (ou au niveau) de mon rôle le plus haut : je ne peux pas le gérer.`);
  const actor = interaction.member;
  if (interaction.user.id !== guild.ownerId && role.position >= (actor?.roles?.highest?.position ?? 0)) {
    throw new UserError(`Le rôle ${role} est au-dessus (ou au niveau) de votre rôle le plus haut.`);
  }
  if (action === 'give' && hasForbiddenPermissions(role)) {
    throw new UserError(`Le rôle ${role} donne des permissions sensibles (administration, modération…) : choisissez un rôle sans permission dangereuse.`);
  }
  return role;
}

/** Permission de l'auteur et du bot pour une action. */
function assertActionPermissions(interaction, action) {
  guard(interaction);
  const perm = ACTIONS[action].permission;
  if (perm) {
    requirePermission(interaction, perm);
    if (!interaction.guild.members.me?.permissions?.has(PermissionFlagsBits[perm])) {
      throw new UserError(`Il me manque la permission **${perm === 'KickMembers' ? 'Expulser des membres' : 'Gérer les rôles'}**.`);
    }
  }
}

/**
 * Membres visés par une action (relus au moment de l'action), limités par exécution.
 * @returns {Promise<{ targets: import('discord.js').GuildMember[], total: number, eligible: number, skipped: { done: number, recent: number, protected: number }, partial: boolean }>}
 */
async function plan(client, interaction, days, action, roleId) {
  const guild = interaction.guild;
  const activity = client.services.activity;
  const { list, partial } = await activity.inactiveMembers(guild, days);
  const actorIsOwner = interaction.user.id === guild.ownerId;
  const actorTop = interaction.member?.roles?.highest?.position ?? 0;
  const recent = action === 'dm' ? activity.recentDms(guild.id) : null;
  const skipped = { done: 0, recent: 0, protected: 0 };
  const eligible = [];
  for (const { member } of list) {
    // L'auteur n'est jamais visé par sa propre action (les commandes slash ne comptent pas comme activité).
    if (member.id === interaction.user.id) skipped.protected += 1;
    else if (action === 'give' && member.roles.cache.has(roleId)) skipped.done += 1;
    else if (action === 'take' && !member.roles.cache.has(roleId)) skipped.done += 1;
    else if (action === 'dm' && recent.has(member.id)) skipped.recent += 1;
    else if (action === 'kick' && !canKick(member, interaction.user.id, guild.ownerId, actorIsOwner, actorTop)) skipped.protected += 1;
    else eligible.push(member);
  }
  return { targets: eligible.slice(0, LIMITS[action]), total: list.length, eligible: eligible.length, skipped, partial };
}

/** Expulsable : ni le propriétaire, ni l'auteur, sous le bot (kickable) et sous l'auteur (sauf propriétaire). */
function canKick(member, actorId, ownerId, actorIsOwner, actorTop) {
  if (member.id === ownerId || member.id === actorId || !member.kickable) return false;
  return canActOnByHierarchy({ isOwner: actorIsOwner, highestRolePosition: actorTop }, { isOwner: false, highestRolePosition: member.roles?.highest?.position ?? 0 });
}

// ---------------------------------------------------------------- vues

function excludedMenu(client, guild, days) {
  const excluded = (inactivityOf(client, guild.id).excludedRoles ?? []).filter((id) => guild.roles.cache.has(id)).slice(0, MAX_EXCLUDED);
  const menu = new RoleSelectMenuBuilder()
    .setCustomId(`cmd:activite:excl:${days}`)
    .setPlaceholder('Rôles jamais concernés (staff)…')
    .setMinValues(0)
    .setMaxValues(MAX_EXCLUDED);
  if (excluded.length) menu.setDefaultRoles(...excluded);
  return { menu, excluded };
}

/** Liste paginée des inactifs. */
async function listView(client, interaction, days, page = 0, notice) {
  const guild = interaction.guild;
  const activity = client.services.activity;
  const now = Date.now();
  const { list, partial } = await activity.inactiveMembers(guild, days, now);
  const since = activity.since(guild.id);
  const blocked = blockedReason(client, guild.id, days, now);
  const pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
  const p = Math.min(Math.max(0, Number(page) || 0), pages - 1);
  const lines = list.slice(p * PAGE_SIZE, (p + 1) * PAGE_SIZE).map(({ member, lastDay }) =>
    `› ${member} · arrivé·e ${discordTimestamp(member.joinedTimestamp, 'R')} · ${lastDay ? `dernière activité le ${formatDay(lastDay)}` : 'aucune activité enregistrée'}`);
  const { menu, excluded } = excludedMenu(client, guild, days);
  const roleId = inactivityOf(client, guild.id).roleId;
  const canAct = !blocked && list.length > 0;
  const act = (action, style = ButtonStyle.Secondary) => actionButton({ command: 'activite', action: 'act', args: [days, action], label: ACTIONS[action].label, emoji: ACTIONS[action].emoji, style, disabled: !canAct });
  return {
    embeds: [
      card({
        tone: blocked ? 'warning' : list.length ? 'caution' : 'success',
        section: SECTION,
        icon: '💤',
        title: `Membres inactifs depuis ${days} jours`,
        description: [
          notice ? `${notice}\n` : null,
          since ? `${ICONS.date} Collecte des statistiques depuis le ${discordTimestamp(since, 'D')} (${discordTimestamp(since, 'R')}).` : null,
          blocked ? `${ICONS.warning} ${blocked}` : null,
          '',
          `**${fr(list.length)}** membre(s) sans message ni vocal depuis **${days} jours**, arrivé(s) depuis plus de ${days} jours.`,
          subtext('Bots et rôles exclus ne sont jamais concernés. Les commandes slash ne comptent pas comme activité.'),
          partial ? `${ICONS.warning} Liste des membres incomplète (Discord n'a pas tout renvoyé) : réessayez dans un instant.` : null,
          '',
          lines.length ? lines.join('\n') : '*Aucun membre inactif.*',
        ],
        fields: [
          field(ICONS.shield, 'Rôles exclus', excluded.length ? excluded.map((id) => `<@&${id}>`).join(' ') : '*Aucun*'),
          field(ICONS.role, 'Rôle « inactif »', roleId && guild.roles.cache.has(roleId) ? `<@&${roleId}>` : '*À choisir*'),
          field(ICONS.count, 'Limites par exécution', `Rôles : ${LIMITS.give} · MP : ${LIMITS.dm}\nExpulsions : ${LIMITS.kick}`),
        ],
        footer: `Page ${p + 1}/${pages} · inactifs depuis ${days} jours`,
      }),
    ],
    components: [
      row(menu),
      ...buttonRows(
        actionButton({ command: 'activite', action: 'page', args: [days, Math.max(0, p - 1), 'p'], emoji: ICONS.back, disabled: p === 0 }),
        labelButton(`Page ${p + 1}/${pages}`),
        actionButton({ command: 'activite', action: 'page', args: [days, Math.min(pages - 1, p + 1), 'n'], emoji: ICONS.next, disabled: p >= pages - 1 }),
        actionButton({ command: 'activite', action: 'page', args: [days, p, 'r'], label: 'Actualiser', emoji: ICONS.refresh }),
      ),
      ...buttonRows(act('give', ButtonStyle.Primary), act('take'), act('dm'), act('kick', ButtonStyle.Danger)),
    ],
  };
}

const backButton = (days) => actionButton({ command: 'activite', action: 'page', args: [days, 0, 'b'], label: 'Retour à la liste', emoji: ICONS.back });

/** Choix du rôle à donner / retirer. */
function roleView(client, guild, days, action) {
  const roleId = inactivityOf(client, guild.id).roleId;
  const menu = new RoleSelectMenuBuilder()
    .setCustomId(`cmd:activite:role:${days}:${action}`)
    .setPlaceholder(action === 'give' ? 'Rôle à donner aux inactifs…' : 'Rôle à retirer aux inactifs…')
    .setMinValues(1)
    .setMaxValues(1);
  if (roleId && guild.roles.cache.has(roleId)) menu.setDefaultRoles(roleId);
  return {
    embeds: [
      card({
        tone: 'info',
        section: SECTION,
        icon: ACTIONS[action].emoji,
        title: `${ACTIONS[action].label} aux inactifs`,
        description: [
          `Choisissez le rôle à ${action === 'give' ? 'donner aux' : 'retirer des'} membres inactifs depuis **${days} jours**. Une confirmation vous sera demandée.`,
          subtext(`Au plus ${LIMITS[action]} membres par exécution. Le rôle doit être sous le mien et sous le vôtre${action === 'give' ? ', sans permission sensible' : ''}.`),
        ],
      }),
    ],
    components: [row(menu), ...buttonRows(backButton(days))],
  };
}

/** Résumé avant exécution. */
function confirmView(days, action, planned, { role, template, guild, sample } = {}) {
  const { targets, eligible, skipped } = planned;
  const over = Math.max(0, eligible - targets.length);
  const names = fitList(targets.map((m) => `${m}`), 900);
  const embeds = [
    card({
      tone: action === 'kick' ? 'danger' : 'warning',
      section: SECTION,
      icon: action === 'kick' ? ICONS.warning : ACTIONS[action].emoji,
      title: action === 'kick' ? `Expulser ${targets.length} membre(s) ?` : `${ACTIONS[action].label} : confirmation`,
      description: [
        action === 'give' ? `Donner ${role} à **${targets.length}** membre(s) inactif(s) depuis **${days} jours**.` : null,
        action === 'take' ? `Retirer ${role} à **${targets.length}** membre(s) inactif(s) depuis **${days} jours**.` : null,
        action === 'dm' ? `Envoyer le message ci-dessous en MP à **${targets.length}** membre(s) inactif(s) depuis **${days} jours**.` : null,
        action === 'kick' ? `**${targets.length}** membre(s) inactif(s) depuis **${days} jours** seront **expulsés** du serveur. Ils pourront revenir avec une invitation.` : null,
        over ? `${ICONS.warning} ${over} autre(s) membre(s) attendront une prochaine exécution (limite de ${LIMITS[action]}).` : null,
        skipped.done ? subtext(`${skipped.done} membre(s) déjà dans l'état voulu, ignoré(s).`) : null,
        skipped.recent ? subtext(`${skipped.recent} membre(s) ont déjà reçu un MP ces 7 derniers jours : ignoré(s).`) : null,
        skipped.protected ? subtext(`${skipped.protected} membre(s) protégé(s) (propriétaire, vous-même, ou rôle trop haut) : ignoré(s).`) : null,
        action === 'kick' ? `\n${ICONS.warning} Action **irréversible** : vous devrez taper \`${KICK_WORD}\` pour confirmer.` : null,
      ],
      fields: [wide(ICONS.members, 'Membres concernés', names ?? '*Aucun*')],
    }),
  ];
  // Aperçu du MP, rendu pour l'auteur de l'action.
  if (action === 'dm') embeds.push(dmCard(guild, sample, template, days));
  const confirm = action === 'kick'
    ? actionButton({ command: 'activite', action: 'kickform', args: [days], label: 'Expulser…', emoji: ICONS.kick, style: ButtonStyle.Danger, disabled: !targets.length })
    : actionButton({ command: 'activite', action: 'run', args: action === 'dm' ? [days, action] : [days, action, role.id], label: 'Confirmer', emoji: ICONS.success, style: ButtonStyle.Danger, disabled: !targets.length });
  return {
    embeds,
    components: buttonRows(
      confirm,
      action === 'dm' ? actionButton({ command: 'activite', action: 'act', args: [days, 'dm'], label: 'Modifier le message', emoji: '📝' }) : null,
      backButton(days),
    ),
  };
}

function resultView(days, action, outcome, role) {
  const { done, failed, skipped, total, stopped } = outcome;
  return {
    embeds: [
      card({
        tone: failed ? 'warning' : 'success',
        section: SECTION,
        icon: failed ? ICONS.warning : ICONS.success,
        title: `${ACTIONS[action].label} : terminé`,
        description: [
          `**${done}** membre(s) traité(s) sur ${total}.${role ? ` Rôle : ${role}.` : ''}`,
          stopped ? `${ICONS.warning} Interrompu : le bot s'arrête.` : null,
          failed ? subtext('Échecs : MP fermés, membre parti entre-temps ou permission refusée par Discord.') : null,
        ],
        fields: [
          field(ICONS.success, ACTIONS[action].done, `**${done}**`),
          field(ICONS.error, 'Échecs', `**${failed}**`),
          field('⏭️', 'Ignorés', `**${skipped}**`),
        ],
        footer: `Inactifs depuis ${days} jours`,
      }),
    ],
    components: buttonRows(backButton(days)),
  };
}

// ---------------------------------------------------------------- formulaires

function dmModal(days, template) {
  return new ModalBuilder()
    .setCustomId(`cmd:activite:dmform:${days}`)
    .setTitle('Message aux membres inactifs')
    .addComponents(
      row(
        new TextInputBuilder()
          .setCustomId('message')
          .setLabel('Message ({membre} {pseudo} {serveur} {jours})')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMinLength(10)
          .setMaxLength(MAX_DM)
          .setValue(String(template || DEFAULT_DM).slice(0, MAX_DM)),
      ),
    );
}

function kickModal(days) {
  return new ModalBuilder()
    .setCustomId(`cmd:activite:kick:${days}`)
    .setTitle('Expulser les membres inactifs')
    .addComponents(
      row(new TextInputBuilder().setCustomId('confirmation').setLabel(`Tapez ${KICK_WORD} pour confirmer`).setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(20).setPlaceholder(KICK_WORD)),
      row(new TextInputBuilder().setCustomId('raison').setLabel('Raison (journal d\'audit, facultatif)').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(MAX_REASON).setPlaceholder(`Inactif depuis plus de ${days} jours`)),
    );
}

function textField(interaction, id) {
  try {
    return interaction.fields.getTextInputValue(id)?.trim() || undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------- exécution

/**
 * Action groupée : relit la liste, applique membre par membre (interrompue à l'arrêt du bot),
 * puis affiche le bilan et le journalise.
 */
async function runBulk(interaction, client, { days, action, roleId = null, reason = null }) {
  assertActionPermissions(interaction, action);
  assertReady(client, interaction.guildId, days);
  const guild = interaction.guild;
  const activity = client.services.activity;
  const role = roleId ? checkRole(interaction, roleId, action) : null;
  if (activity.running.has(guild.id)) throw new UserError('Une action groupée est déjà en cours sur ce serveur : attendez qu\'elle se termine.');
  activity.running.add(guild.id);
  try {
    // Acquitte tout de suite : l'action peut durer (une requête par membre).
    await interaction.update({ embeds: [status.wait(`${ACTIONS[action].label} : traitement en cours…`)], components: [] });
    const planned = await plan(client, interaction, days, action, roleId);
    const template = inactivityOf(client, guild.id).dmMessage;
    const auditReason = truncate(reason || `Inactif depuis plus de ${days} jours (/activite par ${interaction.user.username})`, 400);
    const affected = [];
    let failed = 0;
    let stopped = false;
    for (const [i, member] of planned.targets.entries()) {
      if (activity.stopped) {
        stopped = true;
        break;
      }
      try {
        if (action === 'give' || action === 'take') {
          const res = await applyRoles(member, action === 'give' ? { add: [roleId] } : { remove: [roleId] }, auditReason);
          if (res.failed.length) throw new Error('rôle refusé');
        } else if (action === 'dm') {
          // Réservé AVANT l'envoi : jamais deux MP la même semaine, même en cas d'exécutions simultanées.
          if (!activity.claimDm(guild.id, member.id)) continue;
          if (i > 0 && timing.dmDelayMs) await sleep(timing.dmDelayMs);
          await member.send({ embeds: [dmCard(guild, member, template, days)] });
        } else if (action === 'kick') {
          await member.kick(auditReason);
        }
        affected.push(member.id);
      } catch (err) {
        failed += 1;
        logger.debug(`${action} de ${member.id} (serveur ${guild.id}) :`, err?.message);
      }
    }
    const skipped = planned.skipped.done + planned.skipped.recent + planned.skipped.protected + Math.max(0, planned.eligible - planned.targets.length);
    const outcome = { done: affected.length, failed, skipped, total: planned.total, stopped };
    await interaction.editReply(resultView(days, action, outcome, role)).catch(() => {});
    if (affected.length || failed) {
      await client.services.logging.send(guild.id, 'moderation', logCard({
        category: 'moderation',
        tone: action === 'kick' ? 'caution' : 'info',
        icon: '💤',
        title: `Membres inactifs : ${ACTIONS[action].label.toLowerCase()}`,
        description: `${interaction.user} ${ACTIONS[action].verb} **${affected.length}** membre(s) inactif(s) depuis **${days} jours**.`,
        user: interaction.user,
        fields: [
          field(ICONS.moderator, 'Par', `${interaction.user}`),
          role ? field(ICONS.role, 'Rôle', `${role}`) : null,
          field(ICONS.error, 'Échecs', `${failed}`),
          action === 'kick' ? wide(ICONS.reason, 'Raison', auditReason) : null,
          wide(ICONS.members, 'Membres', fitList(affected.map((id) => `<@${id}>`), 1000) ?? '*Aucun*'),
        ],
      }), undefined, { event: 'inactivity' });
    }
  } finally {
    activity.running.delete(guild.id);
  }
}

// ---------------------------------------------------------------- commande

module.exports = {
  category: 'moderation',
  cooldown: 3_000,
  timing,
  renderDm,
  blockedReason,
  LIMITS,
  data: new SlashCommandBuilder()
    .setName('activite')
    .setDescription('Membres inactifs (ni message ni vocal) et actions groupées : rôle, MP, expulsion.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addIntegerOption((o) => o.setName('jours').setDescription('Inactifs depuis au moins ce nombre de jours (par défaut : 30)').setMinValue(MIN_DAYS).setMaxValue(MAX_DAYS)),

  async execute(interaction, client) {
    guard(interaction);
    const days = parseDays(client, interaction.guildId, interaction.options.getInteger('jours') ?? DEFAULT_DAYS);
    // La liste des membres peut devoir être téléchargée : on diffère d'abord.
    await interaction.deferReply({ ephemeral: true });
    await interaction.editReply(await listView(client, interaction, days, 0));
  },

  buttons: {
    /** cmd:activite:page:<jours>:<page>:<p|n|r|b> */
    async page(interaction, client, [rawDays, page]) {
      guard(interaction);
      const days = parseDays(client, interaction.guildId, rawDays);
      await interaction.deferUpdate();
      await interaction.editReply(await listView(client, interaction, days, page));
    },
    /** cmd:activite:excl:<jours> — rôles exclus (remplace la liste). */
    async excl(interaction, client, [rawDays]) {
      guard(interaction);
      const days = parseDays(client, interaction.guildId, rawDays);
      const cache = interaction.guild.roles.cache;
      const ids = (interaction.values ?? []).filter((id) => SNOWFLAKE.test(id) && cache.has(id) && id !== interaction.guildId).slice(0, MAX_EXCLUDED);
      client.services.config.update(interaction.guildId, { stats: { inactivity: { excludedRoles: ids } } });
      await interaction.deferUpdate();
      await interaction.editReply(await listView(client, interaction, days, 0, `${ICONS.success} ${ids.length ? `${ids.length} rôle(s) exclu(s)` : 'Aucun rôle exclu'}.`));
    },
    /** cmd:activite:act:<jours>:<give|take|dm|kick> — étape suivante de l'action. */
    async act(interaction, client, [rawDays, rawAction]) {
      const action = parseAction(rawAction);
      assertActionPermissions(interaction, action);
      const days = parseDays(client, interaction.guildId, rawDays);
      assertReady(client, interaction.guildId, days);
      if (action === 'dm') return interaction.showModal(dmModal(days, inactivityOf(client, interaction.guildId).dmMessage));
      if (action === 'give' || action === 'take') return interaction.update(roleView(client, interaction.guild, days, action));
      await interaction.deferUpdate();
      return interaction.editReply(confirmView(days, 'kick', await plan(client, interaction, days, 'kick')));
    },
    /** cmd:activite:role:<jours>:<give|take> — rôle choisi : résumé avant confirmation. */
    async role(interaction, client, [rawDays, rawAction]) {
      const action = parseAction(rawAction);
      if (action !== 'give' && action !== 'take') throw new UserError('Action inconnue.');
      assertActionPermissions(interaction, action);
      const days = parseDays(client, interaction.guildId, rawDays);
      assertReady(client, interaction.guildId, days);
      const role = checkRole(interaction, interaction.values?.[0], action);
      client.services.config.update(interaction.guildId, { stats: { inactivity: { roleId: role.id } } });
      await interaction.deferUpdate();
      await interaction.editReply(confirmView(days, action, await plan(client, interaction, days, action, role.id), { role }));
    },
    /** cmd:activite:dmform:<jours> — modèle du MP saisi : résumé avant confirmation. */
    async dmform(interaction, client, [rawDays]) {
      assertActionPermissions(interaction, 'dm');
      const days = parseDays(client, interaction.guildId, rawDays);
      assertReady(client, interaction.guildId, days);
      const message = textField(interaction, 'message');
      if (!message || message.length < 10 || message.length > MAX_DM) throw new UserError(`Le message doit faire de 10 à ${MAX_DM} caractères.`);
      client.services.config.update(interaction.guildId, { stats: { inactivity: { dmMessage: message } } });
      await interaction.deferUpdate();
      await interaction.editReply(confirmView(days, 'dm', await plan(client, interaction, days, 'dm'), { template: message, guild: interaction.guild, sample: interaction.member }));
    },
    /** cmd:activite:kickform:<jours> — confirmation forte (formulaire). */
    async kickform(interaction, client, [rawDays]) {
      assertActionPermissions(interaction, 'kick');
      const days = parseDays(client, interaction.guildId, rawDays);
      assertReady(client, interaction.guildId, days);
      await interaction.showModal(kickModal(days));
    },
    /** cmd:activite:kick:<jours> — formulaire soumis. */
    async kick(interaction, client, [rawDays]) {
      assertActionPermissions(interaction, 'kick');
      const days = parseDays(client, interaction.guildId, rawDays);
      if ((textField(interaction, 'confirmation') ?? '').toUpperCase() !== KICK_WORD) {
        throw new UserError(`Confirmation incorrecte : tapez exactement \`${KICK_WORD}\`. Aucun membre n'a été expulsé.`);
      }
      await runBulk(interaction, client, { days, action: 'kick', reason: textField(interaction, 'raison') ?? null });
    },
    /** cmd:activite:run:<jours>:<give|take|dm>[:<roleId>] — après confirmation. */
    async run(interaction, client, [rawDays, rawAction, roleId]) {
      const action = parseAction(rawAction);
      if (action === 'kick') throw new UserError('L\'expulsion se confirme par le formulaire.');
      const days = parseDays(client, interaction.guildId, rawDays);
      if ((action === 'give' || action === 'take') && !roleId) throw new UserError('Rôle manquant.');
      await runBulk(interaction, client, { days, action, roleId: action === 'dm' ? null : roleId });
    },
  },
};
