'use strict';

const crypto = require('node:crypto');
const { PermissionFlagsBits, escapeMarkdown } = require('discord.js');
const { card, field, ICONS, userLine } = require('../utils/ui');
const { truncate } = require('../utils/embeds');
const { discordTimestamp } = require('../utils/time');
const { LABELS: PERMISSION_LABELS } = require('../utils/permissionNames');
const { UserError } = require('../core/errors');
const { logCard } = require('./LoggingService');
const { applyRoles } = require('../utils/memberRoles');
const { createLogger } = require('../core/logger');

const logger = createLogger('welcome');

/**
 * Accueil des nouveaux membres : messages de bienvenue / départ, rôles
 * automatiques et vérification par bouton (question anti-robot facultative).
 *
 * Les fonctions exportées hors de la classe sont pures (testées) ; la classe
 * orchestre les appels Discord et garde en mémoire les défis anti-robot
 * (jamais côté client : le customId du formulaire ne contient pas la réponse).
 */

const DAY_MS = 86_400_000;
const MAX_AUTO_ROLES = 10;
const CHALLENGE_TTL_MS = 5 * 60_000;
const MAX_FAILURES = 5;
const FAILURE_WINDOW_MS = 10 * 60_000;
/** Membre sanctionné par l'AntiRaid : aucun message de départ pendant ce délai. */
const SILENCE_MS = 10 * 60_000;
/** Après une alerte de vague d'arrivées, les départs des arrivants récents sont tus. */
const RAID_QUIET_MS = 2 * 60_000;
const RAID_RECENT_JOIN_MS = 5 * 60_000;
/** Purge des entrées expirées (défis, échecs, silences) au plus une fois par minute. */
const PRUNE_INTERVAL_MS = 60_000;

/** Permissions nécessaires dans un salon d'accueil ou de vérification. */
const CHANNEL_PERMISSIONS = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks];

/** Variables disponibles dans les textes : clé → description. */
const VARIABLES = Object.freeze({
  membre: 'Mention du membre',
  pseudo: 'Pseudo du membre',
  serveur: 'Nom du serveur',
  nombre: 'Rang du membre (nombre de membres)',
  compte: 'Âge du compte',
});

/** Permissions qu'un rôle automatique ne devrait pas conférer (avertissement). */
const DANGEROUS_PERMISSIONS = Object.freeze([
  'ManageGuild',
  'ManageRoles',
  'ManageChannels',
  'ManageMessages',
  'ManageWebhooks',
  'ManageNicknames',
  'ManageGuildExpressions',
  'ManageEvents',
  'ManageThreads',
  'BanMembers',
  'KickMembers',
  'ModerateMembers',
  'MentionEveryone',
  'ViewAuditLog',
]);

// ---------------------------------------------------------------- fonctions pures

/** Neutralise @everyone et @here (espace de largeur nulle). Pur. */
function escapeMassMentions(text) {
  return String(text ?? '').replace(/@(everyone|here)/gi, '@​$1');
}

/** Âge lisible d'un compte (« 3 jours », « 5 mois », « 2 ans »). Pur. */
function accountAge(createdTimestamp, now = Date.now()) {
  const days = Math.floor(Math.max(0, now - (createdTimestamp ?? now)) / DAY_MS);
  if (days < 1) return 'moins d\'un jour';
  if (days < 30) return `${days} jour${days > 1 ? 's' : ''}`;
  if (days < 365) return `${Math.floor(days / 30)} mois`;
  const years = Math.floor(days / 365);
  return `${years} an${years > 1 ? 's' : ''}`;
}

/** Valeurs brutes des variables pour un membre. Pur. */
function memberVars(member, now = Date.now()) {
  const user = member?.user ?? member;
  return {
    id: /^\d{17,20}$/.test(user?.id ?? '') ? user.id : null,
    name: member?.displayName ?? user?.globalName ?? user?.username ?? 'membre',
    server: member?.guild?.name ?? 'le serveur',
    count: member?.guild?.memberCount ?? 0,
    age: accountAge(user?.createdTimestamp, now),
    avatar: user?.displayAvatarURL?.() ?? null,
  };
}

/** Exemple de valeurs (aperçu sans membre réel). */
const SAMPLE_VARS = Object.freeze({ id: null, name: 'Nouveau membre', server: 'Votre serveur', count: 1234, age: '2 ans', avatar: null });

/**
 * Remplace les variables d'un modèle en une seule passe (un pseudo contenant
 * « {membre} » n'est jamais réinterprété) puis neutralise @everyone / @here.
 * `plain` : rendu pour un titre (pas de markdown ni de mention affichés).
 * Pur.
 */
function renderTemplate(template, vars, { plain = false } = {}) {
  const name = plain ? vars.name : escapeMarkdown(String(vars.name));
  const server = plain ? vars.server : escapeMarkdown(String(vars.server));
  const values = {
    membre: plain ? vars.name : vars.id ? `<@${vars.id}>` : `@${name}`,
    pseudo: name,
    serveur: server,
    nombre: String(vars.count),
    compte: vars.age,
  };
  const out = String(template ?? '').replace(/\{(membre|pseudo|serveur|nombre|compte)\}/gi, (_, key) => values[key.toLowerCase()]);
  return escapeMassMentions(out);
}

/** Variables inconnues d'un modèle (« {prenom} »). Pur. */
function unknownVariables(template) {
  const found = [...String(template ?? '').matchAll(/\{([\p{L}\w]{1,30})\}/gu)].map((m) => m[1].toLowerCase());
  return [...new Set(found.filter((k) => !Object.hasOwn(VARIABLES, k)))];
}

/** « #5865F2 » / « 5865f2 » → nombre ; vide → null. Lève une UserError. Pur. */
function parseColor(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return null;
  const m = raw.match(/^#?([0-9a-f]{6})$/i);
  if (!m) throw new UserError('Couleur invalide : utilisez un code hexadécimal comme `#5865F2`.');
  return parseInt(m[1], 16);
}

/** Couleur enregistrée → « #5865F2 ». Pur. */
function colorHex(value) {
  return Number.isInteger(value) ? `#${value.toString(16).padStart(6, '0').toUpperCase()}` : null;
}

/** Adresse d'image (https uniquement) ; vide → null. Lève une UserError. Pur. */
function parseImageUrl(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    url = null;
  }
  if (!url || url.protocol !== 'https:' || raw.length > 500 || /\s/.test(raw)) {
    throw new UserError('Image invalide : indiquez une adresse qui commence par `https://` (500 caractères maximum).');
  }
  return url.toString();
}

/**
 * Raison pour laquelle un rôle ne peut pas être attribué automatiquement,
 * ou null s'il convient. Pur.
 */
function roleIssue(role, guild) {
  if (!role) return 'rôle introuvable';
  if (role.id === guild?.id) return '@everyone ne s\'attribue pas';
  if (role.managed) return 'rôle géré par une intégration';
  if (role.permissions?.has?.(PermissionFlagsBits.Administrator)) return 'il confère **Administrateur**';
  const top = guild?.members?.me?.roles?.highest?.position;
  if (top != null && role.position >= top) return 'il est au-dessus de mon rôle';
  return null;
}

/** Libellés des permissions sensibles qu'un rôle confère. Pur. */
function dangerousPermissions(role) {
  const perms = role?.permissions;
  if (!perms?.has) return [];
  return DANGEROUS_PERMISSIONS.filter((p) => perms.has(PermissionFlagsBits[p])).map((p) => PERMISSION_LABELS[p] ?? p);
}

/** Le membre a-t-il passé la vérification ? Pur. */
function isVerified(member, verification) {
  const has = member?.roles?.cache?.has?.(verification?.roleId);
  return verification?.mode === 'remove' ? !has : Boolean(has);
}

/**
 * Rôles à donner à l'arrivée. Avec la vérification active, les rôles humains
 * attendent la vérification ; seul le rôle « non vérifié » (mode retrait) est donné.
 * Pur.
 */
function joinRoles(welcome, member) {
  if (member?.user?.bot) return [...(welcome.autoRoles?.bots ?? [])];
  const v = welcome.verification ?? {};
  if (v.enabled && v.roleId) return v.mode === 'remove' ? [v.roleId] : [];
  return [...(welcome.autoRoles?.humans ?? [])];
}

/** Rôles ajoutés / retirés par une vérification réussie. Pur. */
function verifyRoles(welcome) {
  const v = welcome.verification ?? {};
  const humans = (welcome.autoRoles?.humans ?? []).filter((id) => id !== v.roleId);
  return v.mode === 'remove' ? { add: humans, remove: v.roleId ? [v.roleId] : [] } : { add: [...(v.roleId ? [v.roleId] : []), ...humans], remove: [] };
}

/**
 * Peut-il se vérifier ? Renvoie un message de refus clair, ou null. Pur.
 * @param {number} now
 */
function verifyRefusal(member, verification, now = Date.now()) {
  if (!verification?.enabled || !verification.roleId) return 'La vérification n\'est pas active sur ce serveur.';
  if (member?.user?.bot) return 'Les bots ne passent pas la vérification.';
  if (member?.pending) return 'Acceptez d\'abord le règlement du serveur (écran d\'adhésion de Discord), puis réessayez.';
  if (isVerified(member, verification)) return 'Vous êtes déjà vérifié(e) : vous avez accès au serveur.';
  const minDays = verification.minAccountAgeDays ?? 0;
  const created = member?.user?.createdTimestamp;
  if (minDays > 0 && created && now - created < minDays * DAY_MS) {
    return `Votre compte Discord est trop récent : il doit avoir au moins **${minDays} jour${minDays > 1 ? 's' : ''}**. Vous pourrez vous vérifier ${discordTimestamp(created + minDays * DAY_MS, 'R')}.`;
  }
  return null;
}

/** État d'un salon d'accueil : 'unset' | 'missing' | 'noperm' | 'ok'. Pur. */
function channelState(guild, channelId) {
  if (!channelId) return 'unset';
  const channel = guild?.channels?.cache?.get(channelId);
  if (!channel) return 'missing';
  const me = guild.members?.me;
  const perms = me && typeof channel.permissionsFor === 'function' ? channel.permissionsFor(me) : null;
  if (perms && !perms.has(CHANNEL_PERMISSIONS)) return 'noperm';
  return 'ok';
}

/**
 * Carte d'accueil ou de départ rendue pour des variables données. Pur.
 * @param {'join'|'leave'} kind
 */
function messageCard(kind, msg, vars) {
  return card({
    tone: Number.isInteger(msg?.color) ? msg.color : kind === 'join' ? 'brand' : 'neutral',
    title: truncate(renderTemplate(msg?.title, vars, { plain: true }), 256),
    description: renderTemplate(msg?.description, vars),
    thumbnail: vars.avatar,
    image: msg?.image ?? null,
  });
}

/**
 * Message complet : la mention (si activée) va dans `content` pour notifier ;
 * `allowedMentions` est limité à ce membre (jamais @everyone, @here ni rôles). Pur.
 */
function messagePayload(kind, msg, vars) {
  const mention = kind === 'join' && msg?.mention !== false && vars.id;
  return {
    ...(mention ? { content: `<@${vars.id}>` } : {}),
    embeds: [messageCard(kind, msg, vars)],
    allowedMentions: { parse: [], users: mention ? [vars.id] : [] },
  };
}

/** Panneau public de vérification (le bouton est ajouté par la commande). Pur. */
function panelCard(guild, verification) {
  const minDays = verification?.minAccountAgeDays ?? 0;
  return card({
    tone: 'brand',
    section: { emoji: ICONS.shield, label: 'Vérification' },
    icon: ICONS.success,
    title: `Bienvenue sur ${escapeMassMentions(guild?.name ?? 'le serveur')}`,
    description: [
      'Pour accéder au serveur, confirmez que vous êtes bien une personne en cliquant sur le bouton ci-dessous.',
      verification?.captcha ? `${ICONS.info} Une petite question vous sera posée.` : null,
      minDays > 0 ? `${ICONS.date} Votre compte Discord doit avoir au moins **${minDays} jour${minDays > 1 ? 's' : ''}**.` : null,
    ],
    footer: 'Vérification anti-robot',
  });
}

// ---------------------------------------------------------------- service

class WelcomeService {
  /**
   * @param {{ client?: object, config: import('./ConfigService').ConfigService, logging?: import('./LoggingService').LoggingService,
   *           now?: () => number, randomInt?: (min: number, max: number) => number }} deps
   *   randomInt : entier dans [min, max] inclus (crypto par défaut, injectable pour les tests).
   */
  constructor({ client, config, logging, now = Date.now, randomInt = (min, max) => crypto.randomInt(min, max + 1) }) {
    this.client = client;
    this.config = config;
    this.logging = logging;
    this.now = now;
    this.randomInt = randomInt;
    /** @type {Map<string, { answer: string, expires: number }>} défis en cours, par serveur:membre */
    this.challenges = new Map();
    /** @type {Map<string, number[]>} horodatages des mauvaises réponses */
    this.failures = new Map();
    /** @type {Map<string, number>} membres sanctionnés par l'AntiRaid → fin du silence */
    this.silenced = new Map();
    /** @type {Map<string, number>} serveurs en pleine vague sanctionnée par l'AntiRaid → fin du silence */
    this.waves = new Map();
    /** @type {Map<Map<string, any>, number>} dernière purge de chaque table */
    this.lastPrune = new Map();
  }

  settings(guildId) {
    return this.config.get(guildId).welcome;
  }

  // ------------------------------------------------------------ défis anti-robot

  /** Retire les entrées expirées d'une table (au plus une fois par minute et par table). */
  #prune(map, keep) {
    const now = this.now();
    if (now - (this.lastPrune.get(map) ?? 0) < PRUNE_INTERVAL_MS) return;
    this.lastPrune.set(map, now);
    for (const [k, v] of map) if (!keep(v)) map.delete(k);
  }

  /** Trop de mauvaises réponses récentes ? Renvoie la date de fin du blocage, ou 0. */
  lockedUntil(guildId, userId) {
    const now = this.now();
    const list = (this.failures.get(`${guildId}:${userId}`) ?? []).filter((t) => now - t < FAILURE_WINDOW_MS);
    if (list.length < MAX_FAILURES) return 0;
    return list[0] + FAILURE_WINDOW_MS;
  }

  /**
   * Nouveau défi (remplace le précédent). Petit calcul ou mot à recopier, tiré
   * au hasard côté serveur ; la réponse reste en mémoire 5 minutes.
   * @returns {{ label: string }} libellé du champ de formulaire (≤ 45 caractères)
   */
  createChallenge(guildId, userId) {
    const now = this.now();
    let label;
    let answer;
    if (this.randomInt(0, 1) === 0) {
      const a = this.randomInt(2, 15);
      const b = this.randomInt(2, 15);
      if (this.randomInt(0, 1) === 0) {
        label = `Combien font ${a} + ${b} ?`;
        answer = String(a + b);
      } else {
        const [hi, lo] = a >= b ? [a + 5, b] : [b + 5, a];
        label = `Combien font ${hi} − ${lo} ?`;
        answer = String(hi - lo);
      }
    } else {
      const consonants = 'BCDFGHJKLMNPRSTVZ';
      const vowels = 'AEIOU';
      let word = '';
      for (let i = 0; i < 6; i++) {
        const set = i % 2 ? vowels : consonants;
        word += set[this.randomInt(0, set.length - 1)];
      }
      label = `Recopiez ce mot : ${word}`;
      answer = word;
    }
    this.#prune(this.challenges, (c) => c.expires > now);
    this.challenges.set(`${guildId}:${userId}`, { answer, expires: now + CHALLENGE_TTL_MS });
    return { label };
  }

  /**
   * Vérifie une réponse. Le défi est à usage unique (consommé même en cas d'erreur).
   * @returns {'ok'|'expired'|'wrong'|'locked'}
   */
  checkChallenge(guildId, userId, input) {
    const key = `${guildId}:${userId}`;
    if (this.lockedUntil(guildId, userId)) return 'locked';
    const challenge = this.challenges.get(key);
    this.challenges.delete(key);
    const now = this.now();
    if (!challenge || challenge.expires <= now) return 'expired';
    const given = String(input ?? '').replace(/\s+/g, '').toUpperCase();
    if (given && given === challenge.answer) {
      this.failures.delete(key);
      return 'ok';
    }
    const list = (this.failures.get(key) ?? []).filter((t) => now - t < FAILURE_WINDOW_MS);
    list.push(now);
    this.#prune(this.failures, (l) => l.some((t) => now - t < FAILURE_WINDOW_MS));
    this.failures.set(key, list);
    return 'wrong';
  }

  // ------------------------------------------------------------ rôles

  /** Rôles attribuables parmi `ids` (existants, sous mon rôle, ni gérés ni administrateurs). */
  assignable(guild, ids) {
    return [...new Set(ids ?? [])].filter((id) => !roleIssue(guild.roles?.cache?.get(id), guild));
  }

  // ------------------------------------------------------------ événements

  /**
   * Appelé par guildMemberAdd APRÈS l'AntiRaid. Membre sanctionné : rien n'est
   * envoyé (et son départ sera tu). Membre en attente (écran d'adhésion) :
   * l'accueil attend guildMemberUpdate.
   */
  async handleJoin(member, { raid } = {}) {
    if (raid?.punished) {
      this.silence(member.guild.id, member.id);
      return { skipped: 'antiraid' };
    }
    if (member.pending) return { skipped: 'pending' };
    return this.welcome(member);
  }

  /**
   * Tait le départ d'un membre pendant 10 minutes. Synchrone : l'AntiRaid l'appelle
   * JUSTE AVANT d'expulser / bannir, car guildMemberRemove arrive avant que
   * handleJoin ne reçoive le résultat de la sanction.
   */
  silence(guildId, userId) {
    const now = this.now();
    this.#prune(this.silenced, (t) => t > now);
    this.silenced.set(`${guildId}:${userId}`, now + SILENCE_MS);
  }

  /**
   * Vague d'arrivées en cours de sanction (≈ 2 minutes) : les départs des arrivants
   * récents sont tus. Synchrone, appelé par l'AntiRaid avant de sanctionner la vague.
   */
  /** Annule un silence posé avant une sanction qui a finalement échoué. */
  unsilence(guildId, userId) {
    this.silenced.delete(`${guildId}:${userId}`);
  }

  silenceWave(guildId) {
    const now = this.now();
    this.#prune(this.waves, (t) => t > now);
    this.waves.set(guildId, now + RAID_QUIET_MS);
  }

  /**
   * Écran d'adhésion accepté (pending → false) : l'accueil a lieu maintenant.
   * Ancien membre partiel (absent du cache, ex. après un redémarrage) : son ancien
   * `pending` est inconnu. Il est accueilli s'il est arrivé il y a moins de 24 h et
   * n'a encore aucun des rôles d'arrivée (sinon, en mode « retrait », il échapperait
   * à la vérification). Sans rôle d'arrivée configuré, rien ne permet de savoir s'il
   * a déjà été accueilli : on s'abstient (pas de message de bienvenue en double).
   */
  async handleScreeningPassed(oldMember, newMember) {
    if (newMember?.pending !== false) return null;
    if (oldMember?.pending === true) return this.welcome(newMember);
    if (oldMember?.partial && this.#missedWelcome(newMember)) return this.welcome(newMember);
    return null;
  }

  /** Membre récent qui n'a reçu aucun des rôles d'arrivée (accueil manqué). */
  #missedWelcome(member) {
    const joined = member?.joinedTimestamp;
    if (!member?.guild || member.user?.bot || !joined || this.now() - joined >= DAY_MS) return false;
    const expected = this.assignable(member.guild, joinRoles(this.settings(member.guild.id), member));
    return expected.length > 0 && !expected.some((id) => member.roles?.cache?.has(id));
  }

  /** Rôles automatiques, message de bienvenue et MP. */
  async welcome(member) {
    const guild = member.guild;
    const cfg = this.settings(guild.id);
    const result = { roles: [], sent: false, dm: false };

    const roles = this.assignable(guild, joinRoles(cfg, member)).filter((id) => !member.roles?.cache?.has(id)).slice(0, MAX_AUTO_ROLES);
    if (roles.length) {
      // Un rôle à la fois : un PATCH de liste effacerait le rôle Muted remis juste avant.
      const { added } = await applyRoles(member, { add: roles }, 'Rôles automatiques (arrivée)', (id, e) =>
        logger.debug(`Rôle automatique ${id} sur ${guild.id} :`, e?.message));
      result.roles = added;
    }

    if (member.user?.bot) return result;
    const join = cfg.join ?? {};
    const vars = memberVars(member, this.now());
    if (join.enabled && channelState(guild, join.channelId) === 'ok') {
      try {
        await guild.channels.cache.get(join.channelId).send(messagePayload('join', join, vars));
        result.sent = true;
      } catch (e) {
        logger.debug(`Message de bienvenue sur ${guild.id} :`, e?.message);
      }
    }
    if (join.dm) {
      try {
        await member.send({ embeds: [messageCard('join', join, vars)], allowedMentions: { parse: [] } });
        result.dm = true;
      } catch {
        /* MP fermés : ignoré */
      }
    }
    return result;
  }

  /** Départ tu ? (sanctionné par l'AntiRaid, ou arrivant récent d'une vague détectée) */
  #quietLeave(member) {
    const now = this.now();
    const key = `${member.guild.id}:${member.id}`;
    const until = this.silenced.get(key);
    if (until) {
      this.silenced.delete(key);
      if (until > now) return true;
    }
    const recent = Boolean(member.joinedTimestamp && now - member.joinedTimestamp < RAID_RECENT_JOIN_MS);
    if (recent && (this.waves.get(member.guild.id) ?? 0) > now) return true;
    const alertAt = this.client?.services?.antiraid?.joinAlertAt?.get?.(member.guild.id);
    return Boolean(alertAt && now - alertAt < RAID_QUIET_MS && member.joinedTimestamp && now - member.joinedTimestamp < RAID_RECENT_JOIN_MS);
  }

  /** Message de départ. */
  async handleLeave(member) {
    const guild = member.guild;
    if (member.user?.bot || this.#quietLeave(member)) return { sent: false };
    const leave = this.settings(guild.id).leave ?? {};
    if (!leave.enabled || channelState(guild, leave.channelId) !== 'ok') return { sent: false };
    try {
      await guild.channels.cache.get(leave.channelId).send(messagePayload('leave', leave, memberVars(member, this.now())));
      return { sent: true };
    } catch (e) {
      logger.debug(`Message de départ sur ${guild.id} :`, e?.message);
      return { sent: false };
    }
  }

  // ------------------------------------------------------------ vérification

  /** Lève une UserError claire si le membre ne peut pas se vérifier maintenant. */
  assertCanVerify(member) {
    const cfg = this.settings(member.guild.id).verification;
    const refusal = verifyRefusal(member, cfg, this.now());
    if (refusal) throw new UserError(refusal);
    const locked = this.lockedUntil(member.guild.id, member.id);
    if (locked) throw new UserError(`Trop de mauvaises réponses. Vous pourrez réessayer ${discordTimestamp(locked, 'R')}.`);
  }

  /**
   * Vérification réussie : rôle « vérifié » donné (ou « non vérifié » retiré),
   * rôles automatiques humains donnés, log « Vérifications réussies ».
   * @param {{ captcha?: boolean }} [ctx]
   */
  async verify(member, { captcha = false } = {}) {
    const guild = member.guild;
    const cfg = this.settings(guild.id);
    const v = cfg.verification;
    if (roleIssue(guild.roles?.cache?.get(v.roleId), guild)) {
      throw new UserError('Je ne peux pas gérer le rôle de vérification : prévenez un administrateur (mon rôle doit être placé au-dessus).');
    }
    const plan = verifyRoles(cfg);
    const wanted = this.assignable(guild, plan.add).filter((id) => !member.roles.cache.has(id));
    const unwanted = plan.remove.filter((id) => member.roles.cache.has(id));
    // Un rôle à la fois (routes par rôle) : un PATCH de liste annulerait l'appel précédent.
    // Le rôle de vérification d'abord : s'il échoue, rien d'autre n'est touché.
    const isKey = (id) => id === v.roleId;
    const log = (id, e) => logger.debug(`Vérification sur ${guild.id} (rôle ${id}) :`, e?.message);
    const key = await applyRoles(member, { add: wanted.filter(isKey), remove: unwanted.filter(isKey) }, 'Vérification réussie', log);
    if (key.failed.length) throw new UserError('Je n\'ai pas pu mettre à jour vos rôles. Prévenez un administrateur.');
    const rest = await applyRoles(member, { add: wanted.filter((id) => !isKey(id)), remove: unwanted.filter((id) => !isKey(id)) }, 'Vérification réussie', log);
    const add = [...key.added, ...rest.added];
    const remove = [...key.removed, ...rest.removed];
    const user = member.user;
    const embed = logCard({
      category: 'members',
      tone: 'success',
      icon: ICONS.success,
      title: 'Membre vérifié',
      description: `${user} a passé la vérification.`,
      user,
      fields: [
        field(ICONS.user, 'Membre', userLine(user)),
        field(ICONS.date, 'Compte créé', user.createdTimestamp ? discordTimestamp(user.createdTimestamp, 'R') : '—'),
        field('🧩', 'Question anti-robot', captcha ? 'Réussie' : 'Non demandée'),
        add.length ? field(ICONS.role, 'Rôles ajoutés', add.map((id) => `<@&${id}>`).join(' ')) : null,
        remove.length ? field(ICONS.role, 'Rôles retirés', remove.map((id) => `<@&${id}>`).join(' ')) : null,
      ],
    });
    await this.logging?.send(guild.id, 'members', embed, undefined, { event: 'memberVerify' }).catch(() => {});
    return { added: add, removed: remove };
  }
}

module.exports = {
  WelcomeService,
  VARIABLES,
  SAMPLE_VARS,
  MAX_AUTO_ROLES,
  CHANNEL_PERMISSIONS,
  escapeMassMentions,
  accountAge,
  memberVars,
  renderTemplate,
  unknownVariables,
  parseColor,
  colorHex,
  parseImageUrl,
  roleIssue,
  dangerousPermissions,
  isVerified,
  joinRoles,
  verifyRoles,
  verifyRefusal,
  channelState,
  messageCard,
  messagePayload,
  panelCard,
};
