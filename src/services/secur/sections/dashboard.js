'use strict';

const { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } = require('discord.js');
const { ICONS } = require('../../../utils/ui');
const { truncate } = require('../../../utils/embeds');
const { UserError } = require('../../../core/errors');
const { assertAdmin } = require('../../ModerationService');
const { defaultGuildConfig } = require('../../../config/defaults');
const S = require('../../../utils/secur');
const V = require('../../../utils/securViews');

/**
 * Sections « panneau », « on », « max », « off » et « module » de /secur (SEC2), chargées par la
 * coquille src/commands/security/secur.js. Rendus purs : src/utils/securViews.js.
 *
 * Permissions : lecture → Administrateur (coquille et chaque clic) ; modification → Administrateur
 * PUIS niveau owner (assertOwnerLevel), revérifiés à chaque clic. Un non-owner voit le panneau en
 * lecture seule (aucun composant de modification).
 *
 * CustomIds (cmd:secur:…) : nav, go:<vue>, preview:<préréglage>, apply:<préréglage>[:force],
 * trustbots:<préréglage>, mode:<clé>, punish:<clé>, undo:<clé>:on|off, limits:<clé> →
 * limitsubmit:<clé>, verrou:on|off, raidping, notify:on|off, ownersdm:on|off, botexec, restore,
 * grantdecide. Les gestionnaires owners et trust sont dans la section access.js.
 */

const SNOWFLAKE = /^\d{17,20}$/;
const JOURNAL_SIZE = 10;

/** Options des niveaux de sécurité (service Secur, sinon configuration du bot). */
function levelOpts(client) {
  return client.services?.secur?.levelOpts?.() ?? {
    botOwnerIds: client.config?.ownerIds ?? [],
    trustBotOwners: Boolean(client.config?.securTrustBotOwners),
    botId: client.user?.id ?? null,
  };
}

/** Accès en attente d'un utilisateur, d'après la liste déjà lue (même logique que SecurService). */
function pendingOfFactory(rows) {
  return (userId) => {
    const roles = new Set();
    let user = false;
    for (const g of rows) {
      if (g.kind === 'user' && g.subject_id === userId) user = true;
      else if (g.kind === 'role' && g.subject_id === userId && g.role_id) roles.add(g.role_id);
      else if (g.kind === 'wlrole') roles.add(g.subject_id);
    }
    return user || roles.size ? { user, roles } : null;
  };
}

/** État des modules sans service Secur (tous « non disponible »). */
function fallbackModules(cfg) {
  return S.MODULE_KEYS.map((key) => ({ key, ...S.SECUR_MODULES[key], loaded: false, mode: S.moduleMode(cfg, key), limit: S.effectiveLimit(cfg, key), suspendedUntil: null }));
}

/**
 * État du panneau (lecture des services et caches), passé aux rendus purs.
 * @returns {import('../../../utils/securViews').PanelState}
 */
function panelState(client, interaction, notice = null) {
  const guild = interaction.guild;
  const cfg = client.services.config.get(guild.id);
  const secur = client.services.secur ?? null;
  const opts = levelOpts(client);
  const userId = interaction.user.id;
  const pending = secur?.pendingGrants?.(guild.id) ?? [];
  const raidId = cfg.secur?.raidPingRoleId ?? null;
  const raid = raidId ? guild.roles?.cache?.get?.(raidId) ?? null : null;
  let incidents = [];
  try {
    incidents = client.repositories?.securityIncidents?.recent?.(guild.id, JOURNAL_SIZE) ?? [];
  } catch {
    incidents = [];
  }
  return {
    guildId: guild.id,
    ownerId: guild.ownerId ?? null,
    cfg,
    modules: secur?.moduleStatus?.(guild.id) ?? fallbackModules(cfg),
    canEdit: S.hasOwnerLevel(guild, userId, cfg, opts),
    canManageOwners: S.canManageOwners(guild, userId, opts),
    isGuildOwner: Boolean(guild.ownerId) && userId === guild.ownerId,
    pending,
    incidents,
    exposure: S.exposure(guild, cfg, { ...opts, pendingOf: pendingOfFactory(pending) }),
    partial: (guild.members?.cache?.size ?? 0) < (guild.memberCount ?? 0),
    botPerms: guild.members?.me?.permissions ?? null,
    raidRole: raid ? { id: raid.id, mention: `<@&${raid.id}>`, mentionable: Boolean(raid.mentionable), managed: Boolean(raid.managed), members: raid.members?.size ?? 0 } : null,
    antiraidEnabled: Boolean(cfg.antiraid?.enabled),
    notice,
  };
}

/** Rend une vue du panneau pour cette interaction. */
function view(client, interaction, name = 'home', notice = null) {
  return V.renderView(panelState(client, interaction, notice), name);
}

/** Modification : Administrateur PUIS niveau owner. */
function guardEdit(client, interaction) {
  assertAdmin(interaction);
  S.assertOwnerLevel(interaction.guild, interaction.user.id, client.services.config.get(interaction.guildId), levelOpts(client));
}

/** Copie profonde d'une tranche de configuration (journal avant / après). */
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

/** Journal des réglages de sécurité (SEC1), APRÈS la réponse. Best-effort. */
async function journalOf(client, interaction, before, after, changes = null) {
  try {
    await client.services.secur?.journal?.(interaction.guild, { actorId: interaction.user.id, actor: interaction.user, source: '/secur', before, after, changes });
  } catch {
    /* journal best-effort */
  }
}

/** Clé de module valide (catalogue SECUR_MODULES, jamais __proto__ / constructor). */
function moduleKey(key) {
  if (!S.own(S.SECUR_MODULES, key)) throw new UserError('Module inconnu.');
  return key;
}

/** Module chargé dans le registre (sinon « non disponible » : aucun réglage). */
function assertLoaded(client, guildId, key) {
  const status = client.services.secur?.moduleStatus?.(guildId)?.find((m) => m.key === key);
  if (!status?.loaded) throw new UserError(`Le module « ${S.SECUR_MODULES[key].label} » n'est pas disponible sur cette version.`);
}

/** Valeur voulue d'un bouton on/off. */
function target(state) {
  if (state === 'on') return true;
  if (state === 'off') return false;
  throw new UserError('Ce bouton est invalide.');
}

/** Préréglage valide. */
function presetName(name) {
  if (!S.own(S.SECUR_PRESETS, name)) throw new UserError('Préréglage inconnu.');
  return name;
}

const presetPatchOf = (name) => S.presetPatch(name, defaultGuildConfig.secur.modules);

/** Écrit la tranche `secur.modules[key]` et journalise (après la réponse faite par `respond`). */
async function writeModule(client, interaction, key, patch, notice, respond) {
  const guildId = interaction.guildId;
  const before = clone(S.moduleConfig(client.services.config.get(guildId), key));
  client.services.config.update(guildId, { secur: { modules: { [key]: patch } } });
  const after = clone(S.moduleConfig(client.services.config.get(guildId), key));
  const changed = Object.keys(patch).some((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
  await respond(view(client, interaction, `module.${key}`, changed ? `${ICONS.success} ${notice}` : `${ICONS.info} Aucun changement.`));
  if (changed) await journalOf(client, interaction, { secur: { modules: { [key]: before } } }, { secur: { modules: { [key]: after } } });
}

/** Écrit une clé de `secur` et journalise. */
async function writeSecur(client, interaction, patch, viewName, notice) {
  const guildId = interaction.guildId;
  const sc = client.services.config.get(guildId).secur ?? {};
  const before = Object.fromEntries(Object.keys(patch).map((k) => [k, clone(sc[k])]));
  const changed = Object.entries(patch).some(([k, v]) => JSON.stringify(before[k]) !== JSON.stringify(v));
  if (changed) client.services.config.update(guildId, { secur: patch });
  await interaction.update(view(client, interaction, viewName, changed ? `${ICONS.success} ${notice}` : `${ICONS.info} Aucun changement.`));
  if (changed) await journalOf(client, interaction, { secur: before }, { secur: clone(patch) });
}

/** Entier borné d'un champ de formulaire (vide : inchangé). */
function intField(interaction, id, [min, max], label) {
  let raw;
  try {
    raw = interaction.fields.getTextInputValue(id)?.trim();
  } catch {
    return undefined;
  }
  if (!raw) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new UserError(`${label} : entrez un nombre entier entre ${min} et ${max}.`);
  return n;
}

const input = (id, label, { value, placeholder, max = 4 } = {}) => {
  const t = new TextInputBuilder().setCustomId(id).setLabel(truncate(label, 45)).setStyle(TextInputStyle.Short).setMaxLength(max).setRequired(false);
  if (value != null && String(value) !== '') t.setValue(String(value).slice(0, max));
  if (placeholder) t.setPlaceholder(truncate(placeholder, 100));
  return new ActionRowBuilder().addComponents(t);
};

/** Formulaire « Seuil et fenêtre » d'un module. */
function limitsModal(cfg, key) {
  const mc = S.moduleConfig(cfg, key);
  const inherited = !Number.isInteger(mc.limit);
  const rows = [
    input('limit', `Seuil : actions avant sanction (${S.SECUR_BOUNDS.limit.join(' à ')})`, { value: inherited ? null : mc.limit, max: 3, placeholder: inherited ? `Vide : hérité de /antiraid (${S.effectiveLimit(cfg, key)})` : undefined }),
    input('windowSeconds', `Fenêtre en secondes (${S.SECUR_BOUNDS.windowSeconds.join(' à ')})`, { value: Math.round(S.effectiveWindowMs(cfg, key) / 1000), max: 4 }),
  ];
  if ('minMessages' in mc) rows.push(input('minMessages', `Messages minimum par purge (${S.SECUR_BOUNDS.minMessages.join(' à ')})`, { value: mc.minMessages, max: 3 }));
  return new ModalBuilder().setCustomId(`cmd:secur:limitsubmit:${key}`).setTitle(truncate(`Module · ${S.SECUR_MODULES[key].label}`, 45)).addComponents(...rows);
}

/* ------------------------------------------------------------------ */
/* Préréglages                                                          */
/* ------------------------------------------------------------------ */

/** Écran de confirmation d'un préréglage (exposition, blocage des bots non traités). */
function confirmView(client, interaction, preset, notice = null) {
  return V.presetConfirmView(panelState(client, interaction, notice), preset, presetPatchOf(preset));
}

/** Slash /secur on|max|off : deferReply, puis la confirmation (rien n'est encore appliqué). */
async function executePreset(interaction, client, preset) {
  guardEdit(client, interaction);
  await interaction.deferReply({ ephemeral: true });
  await interaction.editReply(confirmView(client, interaction, preset));
}

const presetSection = (preset) => ({
  name: preset,
  type: 'subcommand',
  build(sub) {
    const meta = S.SECUR_PRESETS[preset];
    return sub.setName(preset).setDescription(truncate(`${meta.label} : ${meta.description} (confirmation avec l'exposition)`, 100));
  },
  execute(interaction, client) {
    return executePreset(interaction, client, preset);
  },
});

/* ------------------------------------------------------------------ */
/* Gestionnaires                                                        */
/* ------------------------------------------------------------------ */

const buttons = {
  /** Menu de navigation (lecture : Administrateur). */
  async nav(interaction, client) {
    assertAdmin(interaction);
    await interaction.update(view(client, interaction, interaction.values?.[0] ?? 'home'));
  },
  /** cmd:secur:go:<vue> (bouton) ou menu « Ouvrir un module » (valeur module.<clé>). */
  async go(interaction, client, [name]) {
    assertAdmin(interaction);
    await interaction.update(view(client, interaction, name ?? interaction.values?.[0] ?? 'home'));
  },
  /** cmd:secur:preview:<on|max|off> — confirmation (niveau owner). */
  async preview(interaction, client, [preset]) {
    guardEdit(client, interaction);
    await interaction.update(confirmView(client, interaction, presetName(preset)));
  },
  /**
   * cmd:secur:apply:<on|max|off>[:force] — application idempotente (punitions et annulations
   * conservées). Refusée tant qu'un bot dangereux n'est pas traité, sauf « force ». Écriture
   * synchrone avant toute attente : un double clic n'écrit (et ne journalise) qu'une fois.
   */
  async apply(interaction, client, [preset, force]) {
    guardEdit(client, interaction);
    presetName(preset);
    const guildId = interaction.guildId;
    const meta = S.SECUR_PRESETS[preset];
    const st = panelState(client, interaction);
    const blocking = V.blockingBots(st.exposure, preset);
    if (blocking.length && force !== 'force') throw new UserError('Des bots aux permissions dangereuses ne sont pas traités : ajoutez-les aux bots de confiance, ou appliquez en acceptant le risque.');
    const patch = presetPatchOf(preset);
    const before = st.cfg;
    const changed = V.presetChanges(before, patch);
    if (!changed.length) {
      await interaction.update(view(client, interaction, 'home', `${ICONS.info} Préréglage ${meta.emoji} **${meta.label}** déjà appliqué : rien n'a changé.`));
      return;
    }
    const beforeModules = clone(before.secur?.modules ?? {});
    client.services.config.update(guildId, { secur: { modules: patch } });
    const afterModules = clone(client.services.config.get(guildId).secur?.modules ?? {});
    const risk = blocking.length ? ` Risque accepté : ${blocking.slice(0, 5).map((b) => `<@${b.id}>`).join(', ')}${blocking.length > 5 ? '…' : ''} non exempté(s).` : '';
    await interaction.update(view(client, interaction, 'home', `${ICONS.success} Préréglage ${meta.emoji} **${meta.label}** appliqué : ${changed.length} module(s) modifié(s), sanctions et annulations conservées.${risk}`));
    const changes = [`Préréglage ${meta.label} (${preset}) appliqué : ${changed.length} module(s) modifié(s)`];
    if (blocking.length) changes.push(`Appliqué en acceptant le risque : ${blocking.map((b) => `<@${b.id}>`).join(', ')} non exempté(s)`);
    await journalOf(client, interaction, { secur: { modules: beforeModules } }, { secur: { modules: afterModules } }, changes);
  },
  /** cmd:secur:trustbots:<préréglage> — bots listés non traités → bots de confiance (niveau owner). */
  async trustbots(interaction, client, [preset]) {
    guardEdit(client, interaction);
    presetName(preset);
    const guildId = interaction.guildId;
    const st = panelState(client, interaction);
    const blocking = V.blockingBots(st.exposure, preset).filter((b) => interaction.guild.members?.cache?.get?.(b.id)?.user?.bot);
    if (!blocking.length) {
      await interaction.update(confirmView(client, interaction, preset, `${ICONS.info} Aucun bot à ajouter.`));
      return;
    }
    const before = [...(st.cfg.secur?.trustedBots ?? [])];
    const after = [...new Set([...before, ...blocking.map((b) => b.id)])];
    if (after.length > S.SECUR_BOUNDS.trustedBots) throw new UserError(`${S.SECUR_BOUNDS.trustedBots} bots de confiance au plus : retirez-en d'abord (/secur confiance retirer).`);
    client.services.config.update(guildId, { secur: { trustedBots: after } });
    await interaction.update(confirmView(client, interaction, preset, `${ICONS.success} ${blocking.map((b) => `<@${b.id}>`).join(', ')} ajouté(s) aux bots de confiance.`));
    await journalOf(client, interaction, { secur: { trustedBots: before } }, { secur: { trustedBots: after } });
  },
  /** Menu cmd:secur:mode:<clé>. */
  async mode(interaction, client, [key]) {
    guardEdit(client, interaction);
    moduleKey(key);
    assertLoaded(client, interaction.guildId, key);
    const mode = interaction.values?.[0];
    if (!S.MODES.includes(mode)) throw new UserError('Mode inconnu.');
    await writeModule(client, interaction, key, { mode }, `Mode : **${V.MODE_OPTIONS[mode].label}**.`, (p) => interaction.update(p));
  },
  /** Menu cmd:secur:punish:<clé>. */
  async punish(interaction, client, [key]) {
    guardEdit(client, interaction);
    moduleKey(key);
    assertLoaded(client, interaction.guildId, key);
    const punish = interaction.values?.[0];
    if (!S.PUNISH_ORDER.includes(punish)) throw new UserError('Sanction inconnue.');
    await writeModule(client, interaction, key, { punish }, `Sanction : **${V.PUNISH_OPTIONS[punish].label}**.`, (p) => interaction.update(p));
  },
  /** cmd:secur:undo:<clé>:<on|off>. */
  async undo(interaction, client, [key, state]) {
    guardEdit(client, interaction);
    moduleKey(key);
    assertLoaded(client, interaction.guildId, key);
    if (!S.SECUR_MODULES[key].undoable) throw new UserError('Les actions de ce module ne peuvent pas être annulées.');
    const undo = target(state);
    await writeModule(client, interaction, key, { undo }, `Annulation **${undo ? 'activée' : 'coupée'}**.`, (p) => interaction.update(p));
  },
  /** cmd:secur:limits:<clé> — formulaire seuil et fenêtre. */
  async limits(interaction, client, [key]) {
    guardEdit(client, interaction);
    moduleKey(key);
    assertLoaded(client, interaction.guildId, key);
    await interaction.showModal(limitsModal(client.services.config.get(interaction.guildId), key));
  },
  /** Formulaire cmd:secur:limitsubmit:<clé> (champ vide : inchangé). */
  async limitsubmit(interaction, client, [key]) {
    guardEdit(client, interaction);
    moduleKey(key);
    assertLoaded(client, interaction.guildId, key);
    const patch = {};
    const limit = intField(interaction, 'limit', S.SECUR_BOUNDS.limit, 'Seuil');
    const windowSeconds = intField(interaction, 'windowSeconds', S.SECUR_BOUNDS.windowSeconds, 'Fenêtre');
    if (limit !== undefined) patch.limit = limit;
    if (windowSeconds !== undefined) patch.windowSeconds = windowSeconds;
    if ('minMessages' in S.moduleConfig(client.services.config.get(interaction.guildId), key)) {
      const minMessages = intField(interaction, 'minMessages', S.SECUR_BOUNDS.minMessages, 'Messages minimum');
      if (minMessages !== undefined) patch.minMessages = minMessages;
    }
    if (!Object.keys(patch).length) throw new UserError('Aucune valeur saisie : rien n\'a été modifié.');
    const respond = (p) => (interaction.isFromMessage?.() ? interaction.update(p) : interaction.reply({ ...p, ephemeral: true }));
    await writeModule(client, interaction, key, patch, `${Object.keys(patch).length} réglage(s) mis à jour.`, respond);
  },
  /** cmd:secur:verrou:<on|off>. */
  async verrou(interaction, client, [state]) {
    guardEdit(client, interaction);
    const verrou = target(state);
    await writeSecur(client, interaction, { verrou }, 'acces', `Verrou **${verrou ? 'activé' : 'retiré'}**.`);
  },
  /** Menu de rôle cmd:secur:raidping (vide : aucun). @everyone et rôles gérés refusés. */
  async raidping(interaction, client) {
    guardEdit(client, interaction);
    const id = interaction.values?.[0] ?? null;
    let warn = '';
    if (id) {
      if (!SNOWFLAKE.test(id)) throw new UserError('Rôle invalide.');
      if (id === interaction.guildId) throw new UserError('@everyone ne peut pas servir de raid ping : choisissez un rôle dédié aux modérateurs.');
      const role = interaction.guild.roles?.cache?.get?.(id) ?? interaction.roles?.get?.(id) ?? null;
      if (role?.managed) throw new UserError(`${role} est géré par une intégration : choisissez un rôle ordinaire.`);
      const st = V.raidPingWarnings({ raidRole: role ? { id, mention: `<@&${id}>`, mentionable: Boolean(role.mentionable), managed: false, members: role.members?.size ?? 0 } : null, botPerms: interaction.guild.members?.me?.permissions ?? null });
      if (st.length) warn = `\n${ICONS.warning} ${st.join(`\n${ICONS.warning} `)}`;
    }
    await writeSecur(client, interaction, { raidPingRoleId: id }, 'acces', `${id ? `Raid ping : <@&${id}>.` : 'Raid ping retiré.'}${warn}`);
  },
  /** cmd:secur:notify:<on|off> — MP au propriétaire ; seul le propriétaire peut les couper. */
  async notify(interaction, client, [state]) {
    guardEdit(client, interaction);
    const notifyOwner = target(state);
    if (!notifyOwner && interaction.user.id !== interaction.guild.ownerId) throw new UserError('Seul le propriétaire du serveur peut couper ses propres messages privés de sécurité.');
    await writeSecur(client, interaction, { notifyOwner }, 'acces', `MP au propriétaire **${notifyOwner ? 'activés' : 'coupés'}**.`);
  },
  /** cmd:secur:ownersdm:<on|off> — MP aux owners de sécurité. */
  async ownersdm(interaction, client, [state]) {
    guardEdit(client, interaction);
    const alertOwnersDm = target(state);
    await writeSecur(client, interaction, { alertOwnersDm }, 'acces', `MP aux owners **${alertOwnersDm ? 'activés' : 'coupés'}**.`);
  },
  /** Menu cmd:secur:botexec — politique « bot auteur ». */
  async botexec(interaction, client) {
    guardEdit(client, interaction);
    const botExecutor = interaction.values?.[0];
    if (!S.BOT_EXECUTOR_POLICIES.includes(botExecutor)) throw new UserError('Réglage inconnu.');
    await writeSecur(client, interaction, { botExecutor }, 'acces', `Bot auteur : **${V.BOT_EXECUTOR_OPTIONS[botExecutor].label}**.`);
  },
  /**
   * Menu cmd:secur:restore (journal) : « Rendre les rôles » / « Débannir » d'un incident, via
   * secur.restore (SEC1) qui fait deferUpdate AVANT tout appel lent puis prend le verrou SQL.
   */
  async restore(interaction, client) {
    guardEdit(client, interaction);
    const id = Number(interaction.values?.[0]);
    if (!Number.isSafeInteger(id) || id <= 0) throw new UserError('Incident invalide.');
    const secur = client.services.secur;
    if (!secur?.restore) throw new UserError('Secur est indisponible pour le moment.');
    await secur.restore(interaction, id);
  },
  /** Menu cmd:secur:grantdecide (approve.<id> | revoke.<id>) : gestionnaire de SEC1. */
  async grantdecide(interaction, client) {
    guardEdit(client, interaction);
    const [action, raw] = String(interaction.values?.[0] ?? '').split('.');
    const id = Number(raw);
    if ((action !== 'approve' && action !== 'revoke') || !Number.isSafeInteger(id) || id <= 0) throw new UserError('Choix invalide.');
    const secur = client.services.secur;
    if (!secur?.decideGrant) throw new UserError('Secur est indisponible pour le moment.');
    await secur.decideGrant(interaction, id, action);
  },
};

/** Vues ouvrables par cmd:secur:open:<vue> (réponse éphémère de la coquille). */
const views = Object.fromEntries(V.VIEWS.map((name) => [name, (client, interaction) => view(client, interaction, name)]));

module.exports = [
  {
    name: 'panneau',
    type: 'subcommand',
    panelState,
    levelOpts,
    build(sub) {
      return sub.setName('panneau').setDescription('Ouvre le panneau de Secur : modules, préréglages, owners, accès, journal.');
    },
    async execute(interaction, client) {
      await interaction.reply({ ...view(client, interaction, 'home'), ephemeral: true });
    },
    buttons,
    views,
  },
  presetSection('on'),
  presetSection('max'),
  presetSection('off'),
  {
    name: 'module',
    type: 'subcommand',
    build(sub) {
      return sub
        .setName('module')
        .setDescription('Règle un module de Secur (mode, sanction, annulation, seuil, fenêtre).')
        .addStringOption((o) => o.setName('module').setDescription('Module à régler').setRequired(true)
          .addChoices(...S.MODULE_KEYS.map((key) => ({ name: truncate(`${S.SECUR_MODULES[key].label}`, 100), value: key }))))
        .addStringOption((o) => o.setName('mode').setDescription('Mode du module').setRequired(true)
          .addChoices(...S.MODES.map((m) => ({ name: V.MODE_OPTIONS[m].label, value: m }))))
        .addStringOption((o) => o.setName('punition').setDescription('Sanction de l\'auteur')
          .addChoices(...S.PUNISH_ORDER.map((p) => ({ name: V.PUNISH_OPTIONS[p].label, value: p }))))
        .addBooleanOption((o) => o.setName('annulation').setDescription('Annuler automatiquement les actions détectées'))
        .addIntegerOption((o) => o.setName('seuil').setDescription('Actions tolérées avant la sanction (1 à 100)').setMinValue(S.SECUR_BOUNDS.limit[0]).setMaxValue(S.SECUR_BOUNDS.limit[1]))
        .addIntegerOption((o) => o.setName('fenetre').setDescription('Fenêtre de comptage, en secondes (1 à 3600)').setMinValue(S.SECUR_BOUNDS.windowSeconds[0]).setMaxValue(S.SECUR_BOUNDS.windowSeconds[1]));
    },
    async execute(interaction, client) {
      guardEdit(client, interaction);
      const key = moduleKey(interaction.options.getString('module', true));
      assertLoaded(client, interaction.guildId, key);
      const mode = interaction.options.getString('mode', true);
      if (!S.MODES.includes(mode)) throw new UserError('Mode inconnu.');
      const patch = { mode };
      const punish = interaction.options.getString('punition');
      if (punish != null) {
        if (!S.PUNISH_ORDER.includes(punish)) throw new UserError('Sanction inconnue.');
        patch.punish = punish;
      }
      const undo = interaction.options.getBoolean('annulation');
      if (undo != null) {
        if (!S.SECUR_MODULES[key].undoable && undo) throw new UserError('Les actions de ce module ne peuvent pas être annulées.');
        patch.undo = undo;
      }
      const limit = interaction.options.getInteger('seuil');
      if (limit != null) patch.limit = Math.min(S.SECUR_BOUNDS.limit[1], Math.max(S.SECUR_BOUNDS.limit[0], limit));
      const windowSeconds = interaction.options.getInteger('fenetre');
      if (windowSeconds != null) patch.windowSeconds = Math.min(S.SECUR_BOUNDS.windowSeconds[1], Math.max(S.SECUR_BOUNDS.windowSeconds[0], windowSeconds));
      await writeModule(client, interaction, key, patch, 'Module mis à jour.', (p) => interaction.reply({ ...p, ephemeral: true }));
    },
  },
];
