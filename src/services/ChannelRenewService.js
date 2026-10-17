'use strict';

const { ChannelType, PermissionFlagsBits, PermissionsBitField, ChannelFlags } = require('discord.js');
const channelRemap = require('../utils/channelRemap');
const { permissionLabel } = require('../utils/permissionNames');
const { UserError } = require('../core/errors');
const { createLogger } = require('../core/logger');

const logger = createLogger('channel-renew');

/**
 * /channel renouveler : recrée un salon À L'IDENTIQUE (type, nom, position, catégorie,
 * surcharges, sujet, mode lent, NSFW, réglages vocaux et de forum), reporte sur la copie
 * tout ce que le bot y rattache (configuration + base, via channelRemap de SEC1), puis
 * supprime l'original. Les messages, fils et épingles sont perdus — c'est le but (« nuke »).
 *
 * Instancié à la demande (aucun service permanent) ; seuls le verrou par salon et les lots
 * de diagnostic vivent au niveau du module. Le délai de 30 s par serveur passe par
 * client.cooldowns.
 *
 * Ordre (plan ADM2) :
 *  1. relire le salon ;
 *  2. créer la copie (champs de clone() + tags de forum sans id, réaction par défaut, tri,
 *     disposition, mode lent des fils, région, qualité vidéo, archivage) ;
 *  3. position au mieux ;
 *  4. report en place (transaction) AVANT la suppression ;
 *  5. suppression de l'original ; en cas d'échec : report inverse, copie supprimée → état identique ;
 *  6. salon système / AFK du serveur rebranchés ;
 *  puis la commande répond, signale l'action à Secur/AntiRaid et journalise.
 */

/** Délai entre deux renouvellements sur un même serveur. */
const RENEW_COOLDOWN_MS = 30_000;
/** Mot à recopier dans le formulaire de confirmation forte. */
const CONFIRM_WORD = 'RENOUVELER';

/** Types renouvelables (ni fil, ni catégorie). */
const RENEWABLE_TYPES = new Set([
  ChannelType.GuildText,
  ChannelType.GuildAnnouncement,
  ChannelType.GuildVoice,
  ChannelType.GuildStageVoice,
  ChannelType.GuildForum,
  ChannelType.GuildMedia,
]);
const VOICE_TYPES = new Set([ChannelType.GuildVoice, ChannelType.GuildStageVoice]);
const THREAD_TYPES = new Set([ChannelType.PublicThread, ChannelType.PrivateThread, ChannelType.AnnouncementThread]);

/** Salons en cours de renouvellement (un à la fois par salon). */
const running = new Set();

/** Libellés des lignes reportées (tables « carry » de channelRemap). */
const CARRY_LABELS = Object.freeze({
  'feeds.channel_id': 'Flux RSS / YouTube',
  'scheduled_announcements.channel_id': 'Annonces programmées',
  'auto_thread_counters.channel_id': 'Fils automatiques',
  'activity_daily.channel_id': 'Statistiques d\'activité',
  'sticky_messages.channel_id': 'Message épinglé (sticky, republié)',
  'application_forms.panel_channel_id': 'Panneaux de candidature (à republier)',
  'application_forms.review_channel_id': 'Salons d\'examen des candidatures',
  'projects.channel_id': 'Projets publiés',
  'lock_state.channel_id': 'États de verrouillage',
  'timed_channel_actions.channel_id': 'Levées programmées (mode lent)',
  'reminders.channel_id': 'Rappels',
});

/** Libellés des lignes perdues (tables « lost » de channelRemap). */
const LOST_LABELS = Object.freeze({
  role_menus: 'Menus de rôles publiés ici',
  starboard: 'Messages du starboard publiés ici',
  giveaways: 'Giveaways terminés publiés ici',
  suggestions: 'Suggestions publiées ici',
});

/** Libellé lisible d'un chemin de configuration (« logChannels.messages » → « Logs (messages) »). */
const CONFIG_LABELS = Object.freeze({
  logChannels: 'Logs',
  logs: 'Logs',
  welcome: 'Accueil',
  tickets: 'Tickets',
  modmail: 'ModMail',
  suggestions: 'Suggestions',
  levels: 'Niveaux',
  antiraid: 'AntiRaid',
  automod: 'AutoMod',
  starboard: 'Starboard',
  reports: 'Signalements',
  birthdays: 'Anniversaires',
  community: 'Communauté',
  ghostPing: 'Ghostping',
  projects: 'Projets',
  automations: 'Automatisations',
  secur: 'Secur',
  stats: 'Statistiques',
  feeds: 'Flux',
  support: 'Rôle soutien',
});

function configLabel(path) {
  const [head, ...rest] = String(path).split('.');
  const label = CONFIG_LABELS[head] ?? 'Réglage';
  return `${label} (\`${[head, ...rest].join('.')}\`)`;
}

function tableExists(db, table) {
  return Boolean(db?.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

/** Une ligne correspondante existe-t-elle (table absente → non) ? */
function hasRow(db, table, where, ...params) {
  if (!tableExists(db, table)) return false;
  return Boolean(db.prepare(`SELECT 1 FROM "${table}" WHERE ${where} LIMIT 1`).get(...params));
}

/** Permissions accordées par les surcharges que le bot ne possède pas (noms de flags). Pur. */
function missingGrantedPermissions(overwrites, botPerms) {
  const have = new PermissionsBitField(botPerms ?? 0n);
  if (have.has(PermissionFlagsBits.Administrator)) return [];
  let granted = 0n;
  for (const o of overwrites) granted |= BigInt(o.allow?.bitfield ?? o.allow ?? 0n);
  return new PermissionsBitField(granted).toArray().filter((flag) => !have.has(PermissionsBitField.Flags[flag]));
}

/**
 * Bilan d'un renouvellement (pur, à partir de la base et de la configuration) : refus,
 * ce qui est reporté, ce qui est perdu.
 * @param {{ channel: object, guild: object, cfg: object, db?: object, config?: object }} ctx
 * @returns {{ refusals: string[], carried: string[], lost: string[], configPaths: string[], resetPanels: string[] }}
 */
function buildPlan({ channel, guild, cfg = {}, db = null, config = null }) {
  const refusals = [];
  const id = channel.id;
  const gid = guild.id;
  if (THREAD_TYPES.has(channel.type) || channel.isThread?.()) refusals.push('Un fil ne se renouvelle pas : choisissez un salon.');
  else if (channel.type === ChannelType.GuildCategory) refusals.push('Une catégorie ne se renouvelle pas : renouvelez ses salons un par un.');
  else if (!RENEWABLE_TYPES.has(channel.type)) refusals.push('Ce type de salon ne peut pas être renouvelé.');

  if (id === guild.rulesChannelId) refusals.push('C\'est le salon des règles de la communauté : changez-le d\'abord dans les paramètres du serveur.');
  if (id === guild.publicUpdatesChannelId) refusals.push('C\'est le salon des mises à jour de Discord (communauté) : changez-le d\'abord dans les paramètres du serveur.');
  if (id === guild.safetyAlertsChannelId) refusals.push('C\'est le salon des alertes de sécurité de Discord : changez-le d\'abord dans les paramètres du serveur.');

  if (db) {
    if (hasRow(db, 'tickets', "guild_id = ? AND channel_id = ? AND status != 'closed'", gid, id)) refusals.push('Ce salon est un ticket ouvert : fermez-le plutôt.');
    if (hasRow(db, 'modmail_threads', "guild_id = ? AND channel_id = ? AND status = 'open'", gid, id)) refusals.push('Ce salon est une conversation ModMail ouverte.');
    if (hasRow(db, 'temp_voice', 'guild_id = ? AND channel_id = ?', gid, id)) refusals.push('Ce salon est un vocal temporaire : il disparaît de lui-même.');
    if (hasRow(db, 'applications', "guild_id = ? AND interview_channel_id = ? AND status = 'pending'", gid, id)) refusals.push('Ce salon sert à un entretien de candidature en cours.');
    if (hasRow(db, 'giveaways', 'guild_id = ? AND channel_id = ? AND ended = 0', gid, id)) refusals.push('Un giveaway est en cours dans ce salon : attendez sa fin.');
    if (hasRow(db, 'lock_state', 'guild_id = ? AND channel_id = ?', gid, id)
      || hasRow(db, 'timed_channel_actions', "guild_id = ? AND channel_id = ? AND active = 1 AND kind IN ('lock', 'lockdown')", gid, id)) {
      refusals.push('Ce salon est verrouillé (/lock ou /lockdown) : déverrouillez-le d\'abord.');
    }
  }
  if (cfg.tempVoice?.hubChannelId === id) refusals.push('C\'est le salon créateur des vocaux temporaires.');
  if (Object.values(cfg.statsCounters?.counters ?? {}).some((c) => c?.channelId === id)) refusals.push('C\'est un compteur de statistiques (/compteurs).');

  const carried = [];
  const lost = ['Tous les messages, fils et messages épinglés du salon', 'Webhooks, abonnements (suivis) et invitations vers ce salon'];
  let configPaths = [];
  const resetPanels = [];
  if (VOICE_TYPES.has(channel.type)) {
    const connected = channel.members?.size ?? 0;
    if (connected) lost.push(`${connected} membre(s) connecté(s), déconnecté(s) par la suppression`);
  }
  if (db && config) {
    const bundle = channelRemap.capture(db, config, gid, id);
    for (const [key, rows] of Object.entries(bundle.rows)) carried.push(`${CARRY_LABELS[key] ?? key} · **${rows.length}**`);
    for (const [table, n] of Object.entries(bundle.lost)) lost.push(`${LOST_LABELS[table] ?? table} · **${n}**`);
    configPaths = bundle.configPaths;
  }
  for (const p of configPaths) carried.push(configLabel(p));
  if (cfg.tickets?.panelChannelId === id && cfg.tickets?.panelMessageId) resetPanels.push('Panneau des tickets (à republier depuis /tickets)');
  if (cfg.welcome?.verification?.panelChannelId === id && cfg.welcome?.verification?.panelMessageId) resetPanels.push('Panneau de vérification (à republier depuis /bienvenue)');
  if (guild.systemChannelId === id) carried.push('Salon système du serveur');
  if (guild.afkChannelId === id) carried.push('Salon AFK du serveur');
  lost.push(...resetPanels);
  return { refusals, carried, lost, configPaths, resetPanels };
}

/** Options de création de la copie (champs de clone() et réglages propres au type). Pur. */
function cloneOptions(source, reason) {
  const opts = {
    name: source.name,
    type: source.type,
    parent: source.parentId ?? null,
    permissionOverwrites: source.permissionOverwrites?.cache ?? [],
    position: source.rawPosition,
    reason,
  };
  const set = (key, value) => {
    if (value !== undefined && value !== null) opts[key] = value;
  };
  set('topic', source.topic);
  if ('nsfw' in source) opts.nsfw = Boolean(source.nsfw);
  set('rateLimitPerUser', source.rateLimitPerUser);
  if (VOICE_TYPES.has(source.type)) {
    set('bitrate', source.bitrate);
    set('userLimit', source.userLimit);
    set('rtcRegion', source.rtcRegion);
    set('videoQualityMode', source.videoQualityMode);
  }
  set('defaultAutoArchiveDuration', source.defaultAutoArchiveDuration);
  if (source.type === ChannelType.GuildForum || source.type === ChannelType.GuildMedia) {
    // Tags SANS identifiant : Discord en attribue de nouveaux à la copie.
    if (Array.isArray(source.availableTags)) {
      opts.availableTags = source.availableTags.map((t) => ({ name: t.name, moderated: Boolean(t.moderated), emoji: t.emoji ? { id: t.emoji.id ?? null, name: t.emoji.name ?? null } : null }));
    }
    set('defaultReactionEmoji', source.defaultReactionEmoji);
    set('defaultSortOrder', source.defaultSortOrder);
    set('defaultForumLayout', source.defaultForumLayout);
    set('defaultThreadRateLimitPerUser', source.defaultThreadRateLimitPerUser);
  }
  return opts;
}

/** Remise à NULL des messages liés aux lignes reportées (le message est resté dans l'ancien salon). */
function clearMessageRefs(db, guildId, channelId) {
  for (const [key, columns] of Object.entries(channelRemap.RESETS)) {
    const [table, column] = key.split('.');
    if (!tableExists(db, table) || !columns.length) continue;
    db.prepare(`UPDATE "${table}" SET ${columns.map((c) => `"${c}" = NULL`).join(', ')} WHERE guild_id = ? AND "${column}" = ?`).run(guildId, channelId);
  }
}

class ChannelRenewService {
  /**
   * @param {{ client: import('../core/GadgetClient').GadgetClient, db?: object, config?: object }} deps
   */
  constructor({ client, db = client?.database?.db ?? null, config = client?.services?.config ?? null }) {
    this.client = client;
    this.db = db;
    this.config = config;
  }

  plan(channel, guild = channel.guild) {
    return buildPlan({ channel, guild, cfg: this.config?.get?.(guild.id) ?? {}, db: this.db, config: this.config });
  }

  /**
   * Contrôles « auteur » NATIFS (jamais délégables : ni requirePermission, ni grant). Lève une UserError.
   * @param {import('discord.js').Interaction} interaction
   */
  assertAuthor(interaction, channel) {
    const member = interaction.member;
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageChannels)) {
      throw new UserError('Il vous faut la permission **Gérer les salons** pour renouveler un salon.');
    }
    if (!channel.permissionsFor?.(member)?.has(PermissionFlagsBits.ManageChannels)) {
      throw new UserError(`Il vous faut la permission **Gérer les salons** dans ${channel}.`);
    }
    const parent = channel.parent ?? null;
    if (parent && !parent.permissionsFor?.(member)?.has(PermissionFlagsBits.ManageChannels)) {
      throw new UserError(`Il vous faut la permission **Gérer les salons** dans la catégorie **${parent.name}** pour y recréer le salon.`);
    }
  }

  /** Le bot peut-il supprimer l'original et recréer la copie (surcharges comprises) ? Lève une UserError. */
  assertBot(channel) {
    const parent = channel.parent ?? null;
    const me = channel.guild.members.me;
    if (channel.manageable === false || channel.deletable === false) {
      throw new UserError(`Je ne peux pas gérer ${channel} : il me faut la permission **Gérer les salons** sur ce salon.`);
    }
    const botPerms = parent ? parent.permissionsFor?.(me) : me?.permissions;
    if (botPerms && !botPerms.has(PermissionFlagsBits.ManageChannels)) {
      throw new UserError('Il me manque la permission **Gérer les salons** pour recréer ce salon.');
    }
    const overwrites = [...(channel.permissionOverwrites?.cache?.values?.() ?? [])];
    if (overwrites.length && botPerms) {
      if (!botPerms.has(PermissionFlagsBits.ManageRoles)) {
        throw new UserError('Ce salon a des permissions propres : il me faut la permission **Gérer les rôles** pour les recopier.');
      }
      const missing = missingGrantedPermissions(overwrites, botPerms.bitfield);
      if (missing.length) {
        throw new UserError(`Les permissions de ce salon accordent des droits que je n'ai pas : ${missing.slice(0, 6).map((f) => `**${permissionLabel(f)}**`).join(', ')}${missing.length > 6 ? '…' : ''}.`);
      }
    }
  }

  /** Auteur, puis refus du bilan, puis bot (dans cet ordre : le motif le plus utile d'abord). */
  #assertAll(interaction, channel) {
    this.assertAuthor(interaction, channel);
    const plan = this.plan(channel, interaction.guild);
    if (plan.refusals.length) throw new UserError(plan.refusals.join('\n'));
    this.assertBot(channel);
    return plan;
  }

  /** Pré-contrôle Secur / AntiRaid AVANT toute requête (suppression + création). */
  assertSecurity(interaction) {
    const secur = this.client?.services?.secur;
    secur?.assertAllowed?.(interaction, 'channelDelete');
    secur?.assertAllowed?.(interaction, 'channelCreate');
  }

  /** Secondes restantes du délai par serveur (0 : libre). */
  cooldownLeft(guildId) {
    return this.client?.cooldowns?.remaining?.(`channel-renew:${guildId}`) ?? 0;
  }

  /** Tous les contrôles, sans rien modifier (commande et formulaire). Lève une UserError. */
  check(interaction, channel) {
    const plan = this.#assertAll(interaction, channel);
    if (running.has(channel.id)) throw new UserError('Ce salon est déjà en cours de renouvellement.');
    const left = this.cooldownLeft(interaction.guildId);
    if (left > 0) throw new UserError(`Un salon vient d'être renouvelé sur ce serveur : réessayez dans **${Math.ceil(left / 1000)} s**.`);
    this.assertSecurity(interaction);
    return plan;
  }

  /**
   * Renouvellement complet (après la confirmation forte). Revérifie TOUT, prend le verrou,
   * puis suit l'ordre du plan. Lève une UserError en cas de refus ou d'échec (état intact).
   * @returns {Promise<{ created: object, oldId: string, name: string, plan: object, report: object, notes: string[], wasCurrent: boolean }>}
   */
  async renew(interaction, channelId, { onLocked = null } = {}) {
    const guild = interaction.guild;
    const cached = guild.channels.cache.get(channelId);
    if (!cached) throw new UserError('Ce salon n\'existe plus (déjà renouvelé ou supprimé).');
    this.check(interaction, cached);
    // Verrou et délai pris AVANT toute requête : un double clic n'exécute qu'une fois.
    running.add(channelId);
    this.client?.cooldowns?.hit?.(`channel-renew:${guild.id}`, RENEW_COOLDOWN_MS);
    try {
      await onLocked?.();
      // 1. Relire le salon (surcharges et réglages à jour).
      const source = await guild.channels.fetch(channelId, { force: true }).catch(() => null);
      if (!source) throw new UserError('Ce salon n\'existe plus (supprimé entre-temps).');
      const plan = this.#assertAll(interaction, source);
      const reason = `Salon renouvelé par ${interaction.user.tag}`.slice(0, 400);
      const wasSystem = guild.systemChannelId === source.id;
      const wasAfk = guild.afkChannelId === source.id;
      const wasCurrent = interaction.channelId === source.id;
      const name = source.name;

      // 2. Copie.
      const created = await guild.channels.create(cloneOptions(source, reason));
      // Drapeau « tag obligatoire » d'un forum : non accepté à la création, posé ensuite (au mieux).
      if (source.flags?.has?.(ChannelFlags.RequireTag)) await created.edit({ flags: ChannelFlags.RequireTag, reason }).catch(() => {});
      // 3. Position au mieux.
      if (source.rawPosition != null && created.rawPosition !== source.rawPosition) {
        await created.setPosition(source.rawPosition, { reason }).catch((e) => logger.debug('Position non rétablie :', e?.message));
      }

      // 4. Report en place (transaction) AVANT la suppression : les écouteurs de suppression ne
      // trouvent plus rien à nettoyer sous l'ancien identifiant.
      let report;
      try {
        report = this.db ? channelRemap.remapInPlace(this.db, this.config, guild.id, source.id, created.id, { resetMessages: false }) : { configPaths: [], carried: {}, lost: {}, never: {} };
      } catch (err) {
        await created.delete('Renouvellement annulé (report impossible)').catch(() => {});
        logger.warn('Report du salon impossible :', err?.message);
        throw new UserError('Le report des réglages a échoué : la copie a été supprimée, rien n\'a changé.');
      }
      const sticky = this.client?.services?.sticky?.get?.(source.id) ?? null;

      // 5. Suppression de l'original ; en cas d'échec, retour arrière complet.
      try {
        await source.delete(reason);
      } catch (err) {
        let rolledBack = true;
        try {
          if (this.db) channelRemap.remapInPlace(this.db, this.config, guild.id, created.id, source.id, { resetMessages: false });
        } catch (e) {
          rolledBack = false;
          logger.error('Retour arrière du report impossible :', e);
        }
        await created.delete('Renouvellement annulé (original non supprimé)').catch(() => {});
        throw new UserError(rolledBack
          ? `Je n'ai pas pu supprimer l'original (${err?.message ?? 'erreur Discord'}) : la copie a été supprimée et les réglages remis, rien n'a changé.`
          : 'Je n\'ai pas pu supprimer l\'original et le retour arrière des réglages a échoué : vérifiez la configuration.');
      }

      // Après succès : messages liés remis à NULL, panneaux à republier.
      const notes = [];
      if (this.db) clearMessageRefs(this.db, guild.id, created.id);
      const cfg = this.config?.get?.(guild.id) ?? {};
      const panels = {};
      if (cfg.tickets?.panelChannelId === created.id && cfg.tickets?.panelMessageId) panels.tickets = { panelMessageId: null };
      if (cfg.welcome?.verification?.panelChannelId === created.id && cfg.welcome?.verification?.panelMessageId) panels.welcome = { verification: { panelMessageId: null } };
      if (Object.keys(panels).length) this.config.update(guild.id, panels);
      // Message épinglé : republié dans la copie (cache du service resynchronisé).
      if (sticky && this.client?.services?.sticky?.set) {
        try {
          await this.client.services.sticky.set({ guildId: guild.id, channel: created, title: sticky.title ?? null, content: sticky.content, threshold: sticky.threshold, authorId: sticky.author_id ?? null });
        } catch (e) {
          notes.push('Message épinglé (sticky) non republié : relancez /sticky.');
          logger.debug('Sticky non republié :', e?.message);
        }
      }

      // 6. Salon système / AFK du serveur.
      const edit = {};
      if (wasSystem) edit.systemChannel = created.id;
      if (wasAfk) edit.afkChannel = created.id;
      if (Object.keys(edit).length) {
        await guild.edit({ ...edit, reason }).catch((e) => {
          notes.push(`${wasSystem ? 'Salon système' : 'Salon AFK'} du serveur non rebranché : réglez-le dans les paramètres du serveur.`);
          logger.debug('guild.edit :', e?.message);
        });
      }
      return { created, oldId: source.id, name, plan, report, notes, wasCurrent };
    } finally {
      running.delete(channelId);
    }
  }
}

module.exports = {
  ChannelRenewService,
  buildPlan,
  cloneOptions,
  missingGrantedPermissions,
  clearMessageRefs,
  configLabel,
  RENEW_COOLDOWN_MS,
  CONFIRM_WORD,
  RENEWABLE_TYPES,
  _running: running,
};
