'use strict';

const {
  ActionRowBuilder,
  StringSelectMenuBuilder,
  UserSelectMenuBuilder,
  RoleSelectMenuBuilder,
  PermissionFlagsBits,
} = require('discord.js');
const { card, field, wide, ICONS, subtext, bullets, actionButton, buttonRows, ButtonStyle } = require('./ui');
const { truncate } = require('./embeds');
const { discordTimestamp } = require('./time');
const { permissionLabel } = require('./permissionNames');
const S = require('./secur');
const { securRequirements } = require('./securityAudit');

/**
 * Rendus PURS du panneau /secur (SEC2) : aucune lecture de service ni de base, tout vient de
 * l'état `PanelState` préparé par la section (src/services/secur/sections/dashboard.js).
 *
 * Vues : home · module.<clé> · owners · acces · exposition · simulation · journal · attente,
 * plus la confirmation d'un préréglage (preset.<on|max|off>).
 *
 * @typedef {object} PanelState
 * @property {string} guildId
 * @property {string|null} ownerId propriétaire du serveur
 * @property {object} cfg configuration du serveur
 * @property {Array<object>} modules état des modules déclarés (services.secur.moduleStatus)
 * @property {boolean} canEdit niveau owner (modifications)
 * @property {boolean} canManageOwners propriétaire (ou OWNER_IDS de confiance)
 * @property {boolean} isGuildOwner
 * @property {Array<object>} pending accès de whitelist en attente
 * @property {Array<object>} incidents derniers incidents (lignes security_incidents)
 * @property {Array<object>} exposure membres exposés (utils/secur.exposure)
 * @property {boolean} partial cache des membres partiel
 * @property {object|null} botPerms permissions du bot (PermissionsBitField)
 * @property {{ id: string, mention: string, mentionable: boolean, managed: boolean, members: number }|null} raidRole
 * @property {boolean} antiraidEnabled
 * @property {string|null} [notice]
 */

const SECTION = 'security';
/** Membres listés dans l'exposition (puis « et N autres »). */
const EXPOSURE_LISTED = 20;
/** Incidents du journal. */
const JOURNAL_SIZE = 10;
/** Accès en attente proposés dans le menu (2 options chacun : 25 au plus). */
const PENDING_IN_MENU = 12;
/** Raid ping : avertissement au-delà de ce nombre de membres. */
const RAIDPING_MAX_MEMBERS = 50;

const NAV = [
  { value: 'home', label: 'Accueil', emoji: '🏠', description: 'Modules, préréglages on / max / off' },
  { value: 'owners', label: 'Owners et bots de confiance', emoji: ICONS.owner, description: 'Qui est exempté en mode max' },
  { value: 'acces', label: 'Accès et alertes', emoji: ICONS.lock, description: 'Verrou, raid ping, MP, bot auteur' },
  { value: 'exposition', label: 'Exposition', emoji: '🎯', description: 'Membres et bots aux permissions dangereuses' },
  { value: 'simulation', label: 'Simulation', emoji: '🧪', description: 'Ce que ferait Secur, permissions manquantes' },
  { value: 'journal', label: 'Journal', emoji: ICONS.history, description: 'Derniers incidents, rendre les rôles' },
  { value: 'attente', label: 'Accès en attente', emoji: '🔐', description: 'Approuver ou révoquer les accès de whitelist' },
];
const VIEWS = Object.freeze(NAV.map((n) => n.value));

const MODE_LABELS = Object.freeze({ off: '⚫ Coupé', on: '🟢 On', max: '🔴 Max' });
const MODE_OPTIONS = Object.freeze({
  off: { label: 'Coupé', emoji: '⚫', description: 'Le module ne compte rien' },
  on: { label: 'On', emoji: '🟢', description: 'La whitelist et les bots de confiance sont exemptés' },
  max: { label: 'Max', emoji: '🔴', description: 'Seuls les owners et les bots de confiance sont exemptés' },
});
const PUNISH_OPTIONS = Object.freeze({
  none: { label: 'Aucune (alerte seule)', emoji: '🔕', description: 'Carte d\'incident et MP, sans sanction' },
  derank: { label: 'Retrait des rôles', emoji: '🎭', description: 'Retire les rôles que je peux gérer' },
  kick: { label: 'Expulsion', emoji: ICONS.kick, description: 'Expulse l\'auteur' },
  ban: { label: 'Bannissement', emoji: ICONS.ban, description: 'Bannit l\'auteur' },
});
const BOT_EXECUTOR_OPTIONS = Object.freeze({
  recent: { label: 'Récent : expulsé s\'il a moins de 7 jours', emoji: '🆕', description: 'Recommandé : un bot ancien est signalé avec un bouton' },
  always: { label: 'Toujours expulsé', emoji: ICONS.kick, description: 'Tout bot auteur d\'un incident est expulsé' },
  never: { label: 'Jamais expulsé (carte seule)', emoji: '🔕', description: 'Carte avec bouton « Expulser ce bot »' },
});
const LEVEL_SHORT = Object.freeze({ ...S.LEVEL_LABELS });

const onOff = (v) => (v ? '🟢 Oui' : '🔴 Non');
const mention = (id) => `<@${id}>`;

/** Pastille d'un module (non chargé : non disponible). Pur. */
function moduleLine(m) {
  if (!m.loaded) return `▫️ ${m.emoji} ${m.label} · *non disponible*`;
  const suspended = m.suspendedUntil ? ` · ⏸️ jusqu'à ${discordTimestamp(m.suspendedUntil, 'T')}` : '';
  return `${MODE_LABELS[m.mode]?.split(' ')[0] ?? '⚫'} ${m.emoji} ${m.label}${m.mode === 'off' ? '' : ` · seuil ${m.limit}`}${suspended}`;
}

/** Préréglage reconnu dans la configuration (sinon « personnalisé »). Pur. */
function detectPreset(modules) {
  const loaded = modules.filter((m) => m.loaded);
  const list = loaded.length ? loaded : modules;
  for (const mode of ['off', 'on', 'max']) if (list.length && list.every((m) => m.mode === mode)) return mode;
  return null;
}

/** Bandeau de lecture seule (non-owner). Pur. */
function readOnlyBanner(state) {
  return state.canEdit ? null : `${ICONS.lock} **Lecture seule** : seuls le propriétaire du serveur et les owners de sécurité modifient Secur.`;
}

function noticeLine(notice) {
  return notice ? `${notice}\n` : null;
}

/** Menu de navigation. Pur. */
function navRow(current) {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('cmd:secur:nav')
      .setPlaceholder('Aller à…')
      .addOptions(NAV.map((o) => ({ ...o, default: o.value === current }))),
  );
}

const backHome = () => actionButton({ command: 'secur', action: 'go', args: ['home'], label: 'Accueil', emoji: '🏠' });

/** Menu « Ouvrir un module » (une option par module, 25 au plus). Pur. */
function moduleSelect(modules) {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('cmd:secur:go')
      .setPlaceholder('Ouvrir un module…')
      .addOptions(modules.slice(0, 25).map((m) => ({
        value: `module.${m.key}`,
        label: truncate(m.label, 100),
        emoji: m.emoji,
        description: truncate(m.loaded ? `${MODE_OPTIONS[m.mode]?.label ?? 'Coupé'}${m.mode === 'off' ? '' : ` · seuil ${m.limit}`}` : 'Non disponible sur cette version', 100),
      }))),
  );
}

/* ------------------------------------------------------------------ */
/* Accueil                                                              */
/* ------------------------------------------------------------------ */

function homeView(state) {
  const { cfg, modules } = state;
  const sc = cfg.secur ?? {};
  const loaded = modules.filter((m) => m.loaded);
  const active = loaded.filter((m) => m.mode !== 'off');
  const preset = detectPreset(modules);
  const half = Math.ceil(modules.length / 2);
  const presetText = preset ? `${S.SECUR_PRESETS[preset].emoji} ${S.SECUR_PRESETS[preset].label}` : '🎛️ Personnalisé';
  return {
    embeds: [
      card({
        tone: active.length ? 'info' : 'neutral',
        section: SECTION,
        icon: ICONS.shield,
        title: 'Secur · statut et réglages',
        description: [
          noticeLine(state.notice),
          readOnlyBanner(state),
          `**${active.length}** module(s) actif(s) sur **${modules.length}**${loaded.length < modules.length ? ` · **${modules.length - loaded.length}** non disponible(s) sur cette version` : ''}.`,
          `Préréglage : **${presetText}**${sc.verrou ? ` · ${ICONS.lock} verrou actif` : ''}`,
          state.antiraidEnabled ? subtext('L\'AntiRaid historique (/antiraid) reste actif pour les types qu\'aucun module ne couvre.') : subtext('L\'AntiRaid historique (/antiraid) est coupé.'),
        ],
        fields: [
          wide('🧩', 'Modules', modules.slice(0, half).map(moduleLine).join('\n') || '—'),
          wide('🧩', 'Modules (suite)', modules.slice(half).map(moduleLine).join('\n') || '—'),
          field(ICONS.owner, 'Owners', `**${(sc.owners ?? []).length}**`),
          field(ICONS.bot, 'Bots de confiance', `**${(sc.trustedBots ?? []).length}**`),
          field('🔐', 'Accès en attente', `**${state.pending.length}**`),
        ],
        footer: 'on : la whitelist est exemptée · max : seuls les owners et les bots de confiance',
      }),
    ],
    components: [
      navRow('home'),
      moduleSelect(modules),
      ...buttonRows(
        state.canEdit ? actionButton({ command: 'secur', action: 'preview', args: ['on'], label: 'On', emoji: '🟢', style: ButtonStyle.Success }) : null,
        state.canEdit ? actionButton({ command: 'secur', action: 'preview', args: ['max'], label: 'Max', emoji: '🔴', style: ButtonStyle.Danger }) : null,
        state.canEdit ? actionButton({ command: 'secur', action: 'preview', args: ['off'], label: 'Tout couper', emoji: '⚫' }) : null,
        actionButton({ command: 'secur', action: 'go', args: ['home'], label: 'Actualiser', emoji: ICONS.refresh }),
      ),
    ],
  };
}

/* ------------------------------------------------------------------ */
/* Module                                                               */
/* ------------------------------------------------------------------ */

const OPTION_LABELS = Object.freeze({
  ignoreBenign: 'Ignorer les modifications bénignes',
  dangerousOnly: 'Seulement les permissions dangereuses',
  ignoreFollowers: 'Ignorer les webhooks de suivi',
  minMessages: 'Messages minimum par purge',
});

function moduleView(state, key) {
  const m = state.modules.find((x) => x.key === key);
  if (!m || !S.own(S.SECUR_MODULES, key)) return homeView({ ...state, notice: `${ICONS.warning} Module inconnu.` });
  const mc = S.moduleConfig(state.cfg, key);
  const inherited = !Number.isInteger(mc.limit);
  const windowS = Math.round(S.effectiveWindowMs(state.cfg, key) / 1000);
  const extras = Object.entries(OPTION_LABELS).filter(([opt]) => opt in mc).map(([opt, label]) => `${label} · ${typeof mc[opt] === 'boolean' ? onOff(mc[opt]) : `**${mc[opt]}**`}`);
  const editable = m.loaded && state.canEdit;
  return {
    embeds: [
      card({
        tone: !m.loaded ? 'neutral' : m.mode === 'max' ? 'danger' : m.mode === 'on' ? 'success' : 'neutral',
        section: SECTION,
        icon: m.emoji,
        title: `Module · ${m.label}`,
        description: [
          noticeLine(state.notice),
          m.loaded ? readOnlyBanner(state) : `${ICONS.warning} **Non disponible** sur cette version : ce module n'est pas chargé. Ses réglages ne s'appliquent pas.`,
          `Domaine : **${m.domain}** · ${m.undoable ? 'actions annulables' : 'actions non annulables (sanction seule)'}.`,
          m.suspendedUntil ? `⏸️ Annulations suspendues jusqu'à ${discordTimestamp(m.suspendedUntil, 'T')} (conflit d'annulation).` : null,
        ],
        fields: [
          field('🎚️', 'Mode', MODE_LABELS[m.mode] ?? m.mode),
          field(ICONS.warning, 'Seuil', `**${m.limit}** action(s)${inherited ? ' · hérité de /antiraid' : ''}`),
          field(ICONS.time, 'Fenêtre', `**${windowS}** s`),
          field(ICONS.shield, 'Sanction', PUNISH_OPTIONS[S.modulePunish(state.cfg, key)]?.label ?? '—'),
          field(ICONS.refresh, 'Annulation', m.undoable ? onOff(mc.undo === true) : '—'),
          field(ICONS.check, 'Exemptés', m.mode === 'max' ? 'Owners, bots de confiance' : m.mode === 'on' ? 'Whitelist, bots de confiance, owners' : '—'),
          extras.length ? wide(ICONS.settings, 'Options', extras.join('\n')) : null,
        ],
        footer: `Seuil : ${S.SECUR_BOUNDS.limit.join(' à ')} · Fenêtre : ${S.SECUR_BOUNDS.windowSeconds.join(' à ')} s`,
      }),
    ],
    components: [
      navRow(null),
      ...(editable
        ? [
          new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
              .setCustomId(`cmd:secur:mode:${key}`)
              .setPlaceholder('Mode du module…')
              .addOptions(Object.entries(MODE_OPTIONS).map(([value, o]) => ({ value, ...o, default: m.mode === value }))),
          ),
          new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
              .setCustomId(`cmd:secur:punish:${key}`)
              .setPlaceholder('Sanction…')
              .addOptions(Object.entries(PUNISH_OPTIONS).map(([value, o]) => ({ value, ...o, default: S.modulePunish(state.cfg, key) === value }))),
          ),
        ]
        : []),
      ...buttonRows(
        editable && m.undoable
          ? actionButton({ command: 'secur', action: 'undo', args: [key, mc.undo === true ? 'off' : 'on'], label: `Annulation : ${mc.undo === true ? 'oui' : 'non'}`, emoji: ICONS.refresh, style: mc.undo === true ? ButtonStyle.Success : ButtonStyle.Secondary })
          : null,
        editable ? actionButton({ command: 'secur', action: 'limits', args: [key], label: 'Seuil et fenêtre', emoji: ICONS.settings, style: ButtonStyle.Primary }) : null,
        backHome(),
      ),
    ],
  };
}

/* ------------------------------------------------------------------ */
/* Owners et bots de confiance                                          */
/* ------------------------------------------------------------------ */

function ownersView(state) {
  const sc = state.cfg.secur ?? {};
  const owners = (sc.owners ?? []).slice(0, S.SECUR_BOUNDS.owners);
  const bots = (sc.trustedBots ?? []).slice(0, S.SECUR_BOUNDS.trustedBots);
  const rows = [navRow('owners')];
  if (state.canManageOwners) {
    const menu = new UserSelectMenuBuilder().setCustomId('cmd:secur:owners').setPlaceholder('Owners de sécurité (humains)').setMinValues(0).setMaxValues(S.SECUR_BOUNDS.owners);
    if (owners.length) menu.setDefaultUsers(...owners);
    rows.push(new ActionRowBuilder().addComponents(menu));
  }
  if (state.canEdit) {
    const menu = new UserSelectMenuBuilder().setCustomId('cmd:secur:trust').setPlaceholder('Bots de confiance').setMinValues(0).setMaxValues(S.SECUR_BOUNDS.trustedBots);
    if (bots.length) menu.setDefaultUsers(...bots);
    rows.push(new ActionRowBuilder().addComponents(menu));
  }
  rows.push(...buttonRows(backHome()));
  return {
    embeds: [
      card({
        tone: 'info',
        section: SECTION,
        icon: ICONS.owner,
        title: 'Owners et bots de confiance',
        description: [
          noticeLine(state.notice),
          readOnlyBanner(state),
          '**Owners** : exemptés en mode max, ils modifient Secur et approuvent les accès. Seul le propriétaire du serveur les nomme.',
          '**Bots de confiance** : exemptés en on **et** en max (bots de tickets, de rôles, autre anti-nuke).',
          `${ICONS.warning} Un bot de confiance compromis n'est plus surveillé : n'ajoutez que des bots que vous maîtrisez.`,
        ],
        fields: [
          wide(ICONS.owner, `Owners (${(sc.owners ?? []).length}/${S.SECUR_BOUNDS.owners})`, (sc.owners ?? []).length ? truncate((sc.owners ?? []).map(mention).join(', '), 1000) : '*Aucun*'),
          wide(ICONS.bot, `Bots de confiance (${(sc.trustedBots ?? []).length}/${S.SECUR_BOUNDS.trustedBots})`, (sc.trustedBots ?? []).length ? truncate((sc.trustedBots ?? []).map(mention).join(', '), 1000) : '*Aucun*'),
        ],
        footer: 'Les menus remplacent la sélection : humains présents pour les owners, bots présents pour la confiance',
      }),
    ],
    components: rows,
  };
}

/* ------------------------------------------------------------------ */
/* Accès et alertes                                                     */
/* ------------------------------------------------------------------ */

/** Avertissements du raid ping. Pur. */
function raidPingWarnings(state) {
  const r = state.raidRole;
  if (!r) return [];
  const out = [];
  if (!r.mentionable && !state.botPerms?.has?.(PermissionFlagsBits.MentionEveryone)) out.push(`${r.mention} n'est pas mentionnable et je n'ai pas « Mentionner @everyone » : le ping ne notifiera personne.`);
  if (r.members > RAIDPING_MAX_MEMBERS) out.push(`${r.mention} compte **${r.members}** membres : chaque alerte les notifiera tous.`);
  return out;
}

function accessView(state) {
  const sc = state.cfg.secur ?? {};
  const policy = S.BOT_EXECUTOR_POLICIES.includes(sc.botExecutor) ? sc.botExecutor : 'recent';
  const pingId = sc.raidPingRoleId ?? null;
  const warnings = raidPingWarnings(state);
  const rows = [navRow('acces')];
  if (state.canEdit) {
    const ping = new RoleSelectMenuBuilder().setCustomId('cmd:secur:raidping').setPlaceholder('Raid ping : rôle mentionné aux alertes (vide : aucun)').setMinValues(0).setMaxValues(1);
    if (pingId && state.raidRole) ping.setDefaultRoles(pingId);
    rows.push(new ActionRowBuilder().addComponents(ping));
    rows.push(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('cmd:secur:botexec')
        .setPlaceholder('Bot auteur d\'un incident…')
        .addOptions(Object.entries(BOT_EXECUTOR_OPTIONS).map(([value, o]) => ({ value, ...o, default: policy === value }))),
    ));
  }
  const notifyOn = sc.notifyOwner !== false;
  const dmOn = sc.alertOwnersDm !== false;
  rows.push(...buttonRows(
    state.canEdit ? actionButton({ command: 'secur', action: 'verrou', args: [sc.verrou ? 'off' : 'on'], label: `Verrou : ${sc.verrou ? 'oui' : 'non'}`, emoji: ICONS.lock, style: sc.verrou ? ButtonStyle.Success : ButtonStyle.Secondary }) : null,
    // Seul le propriétaire du serveur coupe ses propres MP ; un owner peut seulement les réactiver.
    state.canEdit ? actionButton({ command: 'secur', action: 'notify', args: [notifyOn ? 'off' : 'on'], label: `MP au propriétaire : ${notifyOn ? 'oui' : 'non'}`, emoji: ICONS.mail, style: notifyOn ? ButtonStyle.Success : ButtonStyle.Secondary, disabled: notifyOn && !state.isGuildOwner }) : null,
    state.canEdit ? actionButton({ command: 'secur', action: 'ownersdm', args: [dmOn ? 'off' : 'on'], label: `MP aux owners : ${dmOn ? 'oui' : 'non'}`, emoji: ICONS.mail, style: dmOn ? ButtonStyle.Success : ButtonStyle.Secondary }) : null,
    backHome(),
  ));
  return {
    embeds: [
      card({
        tone: 'info',
        section: SECTION,
        icon: ICONS.lock,
        title: 'Accès et alertes',
        description: [
          noticeLine(state.notice),
          readOnlyBanner(state),
          `**Verrou** : ${sc.verrou ? 'actif' : 'inactif'}. Actif, il réserve aux owners /whitelist add et remove et les réglages de /antiraid (navigation, simulation et test d'alerte restent ouverts aux administrateurs).`,
          warnings.length ? `\n${ICONS.warning} ${warnings.join(`\n${ICONS.warning} `)}` : null,
        ],
        fields: [
          field(ICONS.lock, 'Verrou', onOff(sc.verrou)),
          field('📢', 'Raid ping', pingId ? (state.raidRole ? state.raidRole.mention : '*Rôle introuvable*') : '*Aucun*'),
          field(ICONS.bot, 'Bot auteur', BOT_EXECUTOR_OPTIONS[policy].label),
          field(ICONS.mail, 'MP au propriétaire', onOff(notifyOn)),
          field(ICONS.mail, 'MP aux owners', onOff(dmOn)),
        ],
        footer: 'Raid ping : jamais @everyone, une mention par minute au plus',
      }),
    ],
    components: rows,
  };
}

/* ------------------------------------------------------------------ */
/* Exposition                                                           */
/* ------------------------------------------------------------------ */

/** Ligne d'un membre exposé. Pure. */
function exposureLine(e, mode = null) {
  const exempt = mode === 'max' ? e.exemptMax : mode === 'on' ? e.exemptOn : null;
  const state = mode
    ? (exempt ? `${ICONS.success} exempté` : e.bot ? '⛔ **surveillé (bot)**' : '👁️ surveillé')
    : `on : ${e.exemptOn ? 'exempté' : 'surveillé'} · max : ${e.exemptMax ? 'exempté' : 'surveillé'}`;
  return `${e.bot ? ICONS.bot : ICONS.user} ${mention(e.id)} · ${truncate(e.perms.join(', '), 60)} · ${LEVEL_SHORT[e.level] ?? e.level} · ${state}`;
}

/** Liste bornée des membres exposés (bots en tête), « et N autres ». Pure. */
function exposureList(list, mode = null) {
  if (!list.length) return '*Aucun membre en cache n\'a de permission dangereuse.*';
  const shown = list.slice(0, EXPOSURE_LISTED).map((e) => exposureLine(e, mode));
  return truncate(shown.join('\n') + (list.length > EXPOSURE_LISTED ? `\n… et ${list.length - EXPOSURE_LISTED} autre(s)` : ''), 3_500);
}

function exposureView(state) {
  const list = state.exposure;
  const bots = list.filter((e) => e.bot);
  return {
    embeds: [
      card({
        tone: 'info',
        section: SECTION,
        icon: '🎯',
        title: 'Exposition',
        description: [
          noticeLine(state.notice),
          'Membres et bots ayant une permission dangereuse (Administrateur, gérer le serveur, les rôles, les salons, les webhooks, bannir, expulser, mentionner @everyone, exclure).',
          '',
          exposureList(list),
          state.partial ? `\n${subtext('≈ cache partiel des membres : la liste peut être incomplète sur un grand serveur.')}` : null,
        ],
        fields: [
          field(ICONS.members, 'Exposés', `**${list.length}**`),
          field(ICONS.bot, 'Dont bots', `**${bots.length}**`),
          field(ICONS.warning, 'Bots surveillés en max', `**${bots.filter((e) => !e.exemptMax).length}**`),
        ],
        footer: 'Un bot surveillé qui annule nos corrections peut déclencher une guerre entre anti-nuke',
      }),
    ],
    components: [navRow('exposition'), ...buttonRows(backHome())],
  };
}

/* ------------------------------------------------------------------ */
/* Simulation                                                           */
/* ------------------------------------------------------------------ */

function simulationView(state) {
  const { cfg, modules } = state;
  const active = modules.filter((m) => m.loaded && m.mode !== 'off');
  const lines = active.map((m) => `${m.emoji} **${m.label}** : ${m.limit} action(s) en ${Math.round(S.effectiveWindowMs(cfg, m.key) / 1000)} s → ${PUNISH_OPTIONS[S.modulePunish(cfg, m.key)]?.label.toLowerCase() ?? '—'}${S.moduleConfig(cfg, m.key).undo === true && m.undoable ? ', actions annulées' : ''} (${m.mode}).`);
  const warnings = [];
  const req = securRequirements(cfg);
  const perms = state.botPerms;
  if (perms?.has && !perms.has(PermissionFlagsBits.Administrator)) {
    for (const [perm, labels] of req) if (!perms.has(PermissionFlagsBits[perm])) warnings.push(`Il me manque **${permissionLabel(perm)}** (${labels.slice(0, 3).join(', ')}${labels.length > 3 ? '…' : ''}).`);
  }
  const unavailable = modules.filter((m) => !m.loaded && m.mode !== 'off');
  if (unavailable.length) warnings.push(`${unavailable.length} module(s) réglé(s) mais non disponible(s) : ${unavailable.map((m) => m.label).slice(0, 5).join(', ')}.`);
  const watchedOn = state.exposure.filter((e) => !e.exemptOn).length;
  const watchedMax = state.exposure.filter((e) => !e.exemptMax).length;
  warnings.push(...raidPingWarnings(state));
  if (!active.length) warnings.push('Aucun module actif : Secur ne ferait rien.');
  return {
    embeds: [
      card({
        tone: warnings.length ? 'warning' : 'success',
        section: SECTION,
        icon: '🧪',
        title: 'Simulation de Secur',
        description: [
          noticeLine(state.notice),
          active.length ? lines.join('\n') : '*Aucun module actif.*',
          '',
          `🎯 Membres exposés surveillés : **${watchedOn}** en on, **${watchedMax}** en max${state.partial ? ' (≈ cache partiel)' : ''}.`,
        ],
        fields: [warnings.length ? wide(ICONS.warning, 'À vérifier', truncate(bullets(warnings), 1024)) : null],
        footer: 'Simulation : aucune sanction ni alerte réelle',
      }),
    ],
    components: [navRow('simulation'), ...buttonRows(backHome())],
  };
}

/* ------------------------------------------------------------------ */
/* Journal                                                              */
/* ------------------------------------------------------------------ */

const PUNISH_SHORT = Object.freeze({ none: 'alerte seule', derank: 'rôles retirés', kick: 'expulsion', ban: 'bannissement', pending: 'en cours' });

/** Incident restaurable (rôles retirés ou bannissement, pas encore restauré). Pur. */
function restorable(row) {
  if (row.restored_at) return false;
  return row.punishment === 'ban' || (row.punishment === 'derank' && Array.isArray(row.removed_roles) && row.removed_roles.length > 0);
}

function journalView(state) {
  const rows = state.incidents.slice(0, JOURNAL_SIZE);
  const lines = rows.map((r) => {
    const mods = (r.modules ?? []).map((k) => (S.own(S.SECUR_MODULES, k) ? S.SECUR_MODULES[k].emoji : '•')).join('');
    return `**#${r.id}** · ${mention(r.executor_id)} · ${mods || '—'} ×${r.actions} · ${PUNISH_SHORT[r.punishment] ?? r.punishment} · ${discordTimestamp(r.created_at, 'R')}${r.restored_at ? ` · ${ICONS.success} restauré` : ''}`;
  });
  const candidates = rows.filter(restorable);
  const components = [navRow('journal')];
  if (state.canEdit && candidates.length) {
    components.push(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('cmd:secur:restore')
        .setPlaceholder('Rendre les rôles / débannir…')
        .addOptions(candidates.slice(0, 25).map((r) => ({
          value: String(r.id),
          label: truncate(`Incident #${r.id} · ${r.punishment === 'ban' ? 'Débannir' : 'Rendre les rôles'}`, 100),
          emoji: r.punishment === 'ban' ? ICONS.unlock : '🎭',
          description: truncate(`Auteur ${r.executor_id} · ×${r.actions}`, 100),
        }))),
    ));
  }
  components.push(...buttonRows(backHome()));
  return {
    embeds: [
      card({
        tone: rows.length ? 'info' : 'neutral',
        section: SECTION,
        icon: ICONS.history,
        title: 'Journal des incidents',
        description: [
          noticeLine(state.notice),
          readOnlyBanner(state),
          rows.length ? truncate(lines.join('\n'), 3_500) : '*Aucun incident enregistré.*',
        ],
        footer: `${JOURNAL_SIZE} derniers incidents · conservés 90 jours`,
      }),
    ],
    components,
  };
}

/* ------------------------------------------------------------------ */
/* Accès en attente                                                     */
/* ------------------------------------------------------------------ */

/** Description courte d'un accès en attente. Pure. */
function grantLine(g) {
  const who = g.kind === 'wlrole' ? `rôle <@&${g.subject_id}> ajouté à la whitelist` : g.kind === 'user' ? `${mention(g.subject_id)} ajouté à la whitelist` : `rôle <@&${g.role_id}> donné à ${mention(g.subject_id)}`;
  return `**#${g.id}** · ${who} · par ${mention(g.granted_by)} ${discordTimestamp(g.granted_at, 'R')}`;
}

function pendingView(state) {
  const list = state.pending;
  const components = [navRow('attente')];
  if (state.canEdit && list.length) {
    components.push(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('cmd:secur:grantdecide')
        .setPlaceholder('Approuver ou révoquer un accès…')
        .addOptions(list.slice(0, PENDING_IN_MENU).flatMap((g) => [
          { value: `approve.${g.id}`, label: `Approuver l'accès #${g.id}`, emoji: ICONS.success, description: 'Il exempte de nouveau' },
          { value: `revoke.${g.id}`, label: `Révoquer l'accès #${g.id}`, emoji: ICONS.delete, description: 'Retire le rôle ou l\'entrée de whitelist' },
        ])),
    ));
  }
  components.push(...buttonRows(backHome()));
  return {
    embeds: [
      card({
        tone: list.length ? 'warning' : 'neutral',
        section: SECTION,
        icon: '🔐',
        title: 'Accès de whitelist en attente',
        description: [
          noticeLine(state.notice),
          readOnlyBanner(state),
          'Un accès de whitelist donné par quelqu\'un qui n\'est pas owner **n\'exempte pas** tant qu\'un owner ne l\'a pas approuvé (jamais d\'activation automatique).',
          '',
          list.length ? truncate(list.slice(0, 15).map(grantLine).join('\n') + (list.length > 15 ? `\n… et ${list.length - 15} autre(s)` : ''), 3_000) : '*Aucun accès en attente.*',
        ],
        footer: list.length > PENDING_IN_MENU ? `Menu : les ${PENDING_IN_MENU} plus récents` : 'Approbation et révocation verrouillées : un seul clic gagne',
      }),
    ],
    components,
  };
}

/* ------------------------------------------------------------------ */
/* Préréglages on / max / off                                           */
/* ------------------------------------------------------------------ */

/**
 * Bots dangereux NON traités pour un préréglage : bots ayant une permission DANGEROUS qui ne
 * seraient pas exemptés dans ce mode (on : ni whitelistés ni de confiance ; max : pas de
 * confiance). Coupé : aucun. Pur.
 */
function blockingBots(exposureList_, preset) {
  if (preset === 'off') return [];
  return exposureList_.filter((e) => e.bot && !(preset === 'max' ? e.exemptMax : e.exemptOn));
}

/**
 * Modules dont le préréglage changerait la configuration (mode, limite, fenêtre, options
 * tolérantes). Pur : vide = déjà appliqué.
 */
function presetChanges(cfg, patch) {
  const out = [];
  for (const [key, p] of Object.entries(patch)) {
    const mc = S.moduleConfig(cfg, key);
    if (Object.entries(p).some(([k, v]) => mc[k] !== v)) out.push(key);
  }
  return out;
}

function presetConfirmView(state, preset, patch) {
  const meta = S.SECUR_PRESETS[preset];
  const blocking = blockingBots(state.exposure, preset);
  const changed = presetChanges(state.cfg, patch);
  const list = preset === 'off' ? [] : state.exposure;
  return {
    embeds: [
      card({
        tone: blocking.length ? 'danger' : 'warning',
        section: SECTION,
        icon: meta.emoji,
        title: `Appliquer « ${meta.label} » ?`,
        description: [
          noticeLine(state.notice),
          meta.description,
          changed.length ? `**${changed.length}** module(s) modifié(s) · sanctions et annulations conservées.` : `${ICONS.info} Ce préréglage est **déjà appliqué** : rien ne changera.`,
          blocking.length
            ? `\n⛔ **Appliquer est désactivé** : ${blocking.length} bot(s) aux permissions dangereuses ne seraient pas exemptés. S'il s'agit d'un autre anti-nuke, nos annulations et les siennes s'affronteraient. Ajoutez-les aux bots de confiance, ou appliquez en acceptant le risque.`
            : null,
          list.length ? `\n**Exposition** (${list.length}) :\n${exposureList(list, preset)}` : null,
          state.partial && list.length ? subtext('≈ cache partiel des membres : la liste peut être incomplète.') : null,
        ],
        footer: preset === 'max' ? 'En max, la whitelist n\'exempte plus : seuls les owners et les bots de confiance' : 'Confirmez avec un bouton ci-dessous',
      }),
    ],
    components: buttonRows(
      actionButton({ command: 'secur', action: 'apply', args: [preset], label: 'Appliquer', emoji: ICONS.success, style: ButtonStyle.Success, disabled: blocking.length > 0 }),
      blocking.length ? actionButton({ command: 'secur', action: 'trustbots', args: [preset], label: 'Ajouter les bots listés aux bots de confiance', emoji: ICONS.bot, style: ButtonStyle.Primary }) : null,
      blocking.length ? actionButton({ command: 'secur', action: 'apply', args: [preset, 'force'], label: 'Appliquer en acceptant le risque', emoji: ICONS.warning, style: ButtonStyle.Danger }) : null,
      actionButton({ command: 'secur', action: 'go', args: ['home'], label: 'Annuler', emoji: ICONS.back }),
    ),
  };
}

/* ------------------------------------------------------------------ */
/* Routage                                                              */
/* ------------------------------------------------------------------ */

/**
 * Rend une vue à partir de son identifiant (« home », « module.<clé> », « owners »…). Vue
 * inconnue : accueil. Pur.
 */
function renderView(state, view = 'home') {
  const [name, arg] = String(view ?? 'home').split('.');
  switch (name) {
    case 'module':
      return moduleView(state, arg);
    case 'owners':
      return ownersView(state);
    case 'acces':
      return accessView(state);
    case 'exposition':
      return exposureView(state);
    case 'simulation':
      return simulationView(state);
    case 'journal':
      return journalView(state);
    case 'attente':
      return pendingView(state);
    default:
      return homeView(state);
  }
}

module.exports = {
  NAV,
  VIEWS,
  MODE_OPTIONS,
  PUNISH_OPTIONS,
  BOT_EXECUTOR_OPTIONS,
  EXPOSURE_LISTED,
  RAIDPING_MAX_MEMBERS,
  renderView,
  homeView,
  moduleView,
  ownersView,
  accessView,
  exposureView,
  simulationView,
  journalView,
  pendingView,
  presetConfirmView,
  blockingBots,
  presetChanges,
  detectPreset,
  restorable,
  raidPingWarnings,
  moduleLine,
  exposureList,
};
