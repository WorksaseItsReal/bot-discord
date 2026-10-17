'use strict';

const { PermissionFlagsBits, PermissionsBitField } = require('discord.js');
const S = require('../../utils/secur');
const channelRemap = require('../../utils/channelRemap');

/**
 * Secur — modules « Structure » (SEC4) : briques communes aux modules salons, rôles, serveur,
 * webhooks et expressions (src/services/secur/modules/*.js) et à l'écouteur des instantanés
 * (src/events/securStructure.js).
 *
 *  - StructureStore : instantanés pris AVANT tout nettoyage (écouteurs `prepend`), orphelins d'une
 *    catégorie supprimée et surcharges retirées (channelUpdate), correspondance ancien → nouvel
 *    identifiant. Tout est borné (500 instantanés par serveur, 30 min ; 1 000 orphelins ou
 *    surcharges, 30 s ; 1 000 serveurs) et oublié au départ du serveur.
 *  - Captures (cache + base, synchrones) et planificateurs PURS (diff de permissions, filtres
 *    « on » / « max », clés de serveur restaurables, charges utiles de recréation).
 *
 * Ordre audit / événement (critique §5.4) : si l'entrée d'audit arrive AVANT l'événement, le module
 * capture l'objet dans le cache, encore intact, et dans la base ; les `changes` de l'entrée ne
 * servent qu'en dernier recours, et un salon dont le type (ticket, ModMail…) n'est pas
 * déterminable n'est JAMAIS recréé.
 */

/**
 * Instantanés, suppressions classées et correspondances ancien → nouvel identifiant : 30 min. La
 * file d'annulation peut rester occupée plusieurs minutes (membres rendus un par un, limites de
 * débit) : une mémoire plus courte expirait avant la recréation (salon hors de sa catégorie).
 */
const SNAPSHOT_TTL_MS = 30 * 60_000;
const MAX_SNAPSHOTS = 500;
const BUFFER_TTL_MS = 30_000;
const MAX_BUFFERED = 1_000;
const MAX_GUILDS = 1_000;
const PRUNE_EVERY_MS = 10_000;
/** Membres gardés dans l'instantané d'un rôle (250 au plus sont rendus). */
const MAX_SNAPSHOT_MEMBERS = 1_000;
const MAX_ROLE_MEMBERS_RESTORED = 250;
/** Plafonds par incident. */
const MAX_CHANNEL_RECREATIONS = 50;
const MAX_ROLE_RECREATIONS = 50;
const MAX_EXPRESSION_UPLOADS = 10;

const DANGEROUS_BITS = S.DANGEROUS.reduce((a, b) => a | b, 0n);
/** Refus d'@everyone dont le retrait ouvre un salon (critique : salon privé rendu public). */
const EVERYONE_GUARDS = PermissionFlagsBits.ViewChannel | PermissionFlagsBits.SendMessages;
const THREAD_TYPES = new Set([10, 11, 12]);
const CATEGORY = 4;

/** Types de salons jamais recréés (données purgées ou propres au salon). */
const KIND_LABELS = Object.freeze({
  ticket: 'ticket',
  modmail: 'conversation ModMail',
  tempvoice: 'vocal temporaire',
  compteur: 'compteur de statistiques',
  fil: 'fil',
  entretien: 'salon d\'entretien de candidature',
});

/** Champ de bits → BigInt (0n si illisible). Pur. */
function toBig(value) {
  if (typeof value === 'bigint') return value;
  if (value?.bitfield != null) return toBig(value.bitfield);
  try {
    return BigInt(String(value ?? 0));
  } catch {
    return 0n;
  }
}

/** Bits gagnés entre deux champs. Pur. */
function gainedBits(before, after) {
  return toBig(after) & ~toBig(before);
}

/** Le passage de `before` à `after` accorde-t-il une permission DANGEROUS ? Pur. */
function grantsDangerous(before, after) {
  return (gainedBits(before, after) & DANGEROUS_BITS) !== 0n;
}

/**
 * Surcharge à risque (mode « on ») : elle accorde une permission DANGEROUS, ou retire à @everyone
 * un refus « Voir le salon » / « Envoyer des messages ». Pur.
 * @param {{ isEveryone?: boolean, before?: { allow, deny }|null, after?: { allow, deny }|null }} ow
 */
function overwriteRisk({ isEveryone = false, before = null, after = null }) {
  if (grantsDangerous(before?.allow, after?.allow)) return true;
  if (isEveryone && ((toBig(before?.deny) & ~toBig(after?.deny)) & EVERYONE_GUARDS) !== 0n) return true;
  return false;
}

/** Comparaison « valeur d'API » (null et undefined confondus, permissions en chaîne). Pur. */
function sameValue(a, b) {
  const norm = (v) => (v === undefined ? null : typeof v === 'bigint' ? v.toString() : v);
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b));
}

/** Valeur d'une clé dans les `changes` d'une entrée d'audit (forme discord.js : old / new). Pur. */
function changeValue(entry, key, side = 'new') {
  const c = (entry?.changes ?? []).find((x) => x?.key === key);
  return c ? c[side] : undefined;
}

/* -------------------------------------------------------------------- */
/* Planificateurs purs                                                    */
/* -------------------------------------------------------------------- */

/** Clés de salon restaurables par PATCH (forme API). */
const CHANNEL_RESTORABLE = Object.freeze([
  'name', 'topic', 'nsfw', 'rate_limit_per_user', 'bitrate', 'user_limit', 'type', 'parent_id', 'rtc_region',
  'video_quality_mode', 'default_auto_archive_duration', 'default_thread_rate_limit_per_user', 'default_sort_order',
  'default_forum_layout', 'flags',
]);
/** Clés de salon comptées en « max » mais non restaurées (alerte). */
const CHANNEL_ALERT_ONLY = Object.freeze(['available_tags', 'default_reaction_emoji']);
/** Mode « on » (ignoreBenign) : seules ces clés comptent. */
const CHANNEL_SENSITIVE = Object.freeze(['name', 'nsfw', 'type', 'parent_id']);

/**
 * Changements de salon (audit 11) retenus : en « on », nom, NSFW, type et catégorie ; en « max »,
 * tout ce qui est restaurable ou signalable. Pur.
 */
function filterChannelChanges(changes, { lenient = true } = {}) {
  const keep = new Set(lenient ? CHANNEL_SENSITIVE : [...CHANNEL_RESTORABLE, ...CHANNEL_ALERT_ONLY]);
  return (changes ?? []).filter((c) => c && keep.has(c.key) && !sameValue(c.old, c.new));
}

/** Clés de rôle restaurables par PATCH (forme API). */
const ROLE_RESTORABLE = Object.freeze(['name', 'permissions', 'color', 'colors', 'hoist', 'mentionable', 'unicode_emoji']);
const ROLE_ALERT_ONLY = Object.freeze(['icon_hash', 'icon']);

/**
 * Changements de rôle (audit 31) retenus. En « on » (dangerousOnly) : seulement les permissions,
 * et seulement si elles gagnent un bit DANGEROUS. En « max » : tout. Pur.
 */
function filterRoleChanges(changes, { lenient = true } = {}) {
  const list = (changes ?? []).filter((c) => c && !sameValue(c.old, c.new));
  if (lenient) return list.filter((c) => c.key === 'permissions' && grantsDangerous(c.old, c.new));
  return list.filter((c) => ROLE_RESTORABLE.includes(c.key) || ROLE_ALERT_ONLY.includes(c.key));
}

/** Paramètres du serveur rétablis après relecture de la valeur actuelle. */
const SERVER_RESTORABLE = Object.freeze([
  'name', 'description', 'preferred_locale', 'premium_progress_bar_enabled', 'verification_level',
  'default_message_notifications', 'explicit_content_filter', 'afk_channel_id', 'afk_timeout', 'system_channel_id',
  'system_channel_flags', 'rules_channel_id', 'public_updates_channel_id', 'safety_alerts_channel_id',
]);
const SERVER_CHANNEL_KEYS = Object.freeze(['afk_channel_id', 'system_channel_id', 'rules_channel_id', 'public_updates_channel_id', 'safety_alerts_channel_id']);
/** Images (clé d'audit → champ du serveur) : rétablies AU MIEUX via le CDN de Discord. */
const SERVER_IMAGES = Object.freeze({ icon_hash: 'icon', icon: 'icon', banner_hash: 'banner', banner: 'banner', splash_hash: 'splash', splash: 'splash' });
/** Signalées seulement (un bot ne peut pas les rétablir). */
const SERVER_ALERT_ONLY = Object.freeze(['vanity_url_code', 'mfa_level', 'owner_id', 'features']);
const SERVER_LABELS = Object.freeze({
  name: 'nom', description: 'description', preferred_locale: 'langue', premium_progress_bar_enabled: 'barre des boosts',
  verification_level: 'niveau de vérification', default_message_notifications: 'notifications par défaut',
  explicit_content_filter: 'filtre de contenu', afk_channel_id: 'salon AFK', afk_timeout: 'délai AFK',
  system_channel_id: 'salon système', system_channel_flags: 'options du salon système', rules_channel_id: 'salon des règles',
  public_updates_channel_id: 'salon des mises à jour', safety_alerts_channel_id: 'salon des alertes de sécurité',
  icon: 'icône', banner: 'bannière', splash: 'image d\'invitation', vanity_url_code: 'URL personnalisée',
  mfa_level: 'niveau A2F', owner_id: 'propriétaire', features: 'fonctionnalités',
});

/**
 * Plan d'une modification du serveur (audit 1) : clés restaurables, images (au mieux), alertes
 * seules ; les autres clés sont ignorées. Pur.
 * @returns {{ restore: object[], images: object[], alertOnly: object[] }}
 */
function planServerRestore(changes) {
  const out = { restore: [], images: [], alertOnly: [] };
  for (const c of changes ?? []) {
    if (!c || sameValue(c.old, c.new)) continue;
    if (SERVER_RESTORABLE.includes(c.key)) out.restore.push(c);
    else if (S.own(SERVER_IMAGES, c.key)) out.images.push({ ...c, field: SERVER_IMAGES[c.key] });
    else if (SERVER_ALERT_ONLY.includes(c.key)) out.alertOnly.push(c);
  }
  return out;
}

/** Adresse CDN d'une image du serveur (ancien hash). Pur. */
function guildImageUrl(guildId, field, hash) {
  if (!hash || !/^(a_)?[a-f0-9]{8,64}$/i.test(String(hash))) return null;
  const dir = { icon: 'icons', banner: 'banners', splash: 'splashes' }[field];
  if (!dir) return null;
  return `https://cdn.discordapp.com/${dir}/${guildId}/${hash}.${String(hash).startsWith('a_') ? 'gif' : 'png'}?size=4096`;
}

/**
 * Surcharges d'un instantané rapportées aux identifiants actuels : cibles disparues ignorées,
 * bits limités à `mask` (permissions du bot s'il n'est pas Administrateur). Pur.
 * @param {{ id: string, type: number, allow: string, deny: string }[]} overwrites
 * @param {(id: string, type: number) => string|null} resolve
 */
function mapOverwrites(overwrites, resolve, mask = null) {
  const out = [];
  const seen = new Set();
  for (const o of overwrites ?? []) {
    const id = resolve(o.id, Number(o.type));
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const m = mask == null ? null : toBig(mask);
    const allow = m == null ? toBig(o.allow) : toBig(o.allow) & m;
    const deny = m == null ? toBig(o.deny) : toBig(o.deny) & m;
    out.push({ id, type: Number(o.type), allow, deny });
  }
  return out;
}

/** Rôle à ne jamais recréer : 'managed' (bot, intégration, booster) ou 'subscription', sinon null. Pur. */
function protectedRoleKind(snap) {
  if (!snap) return null;
  const t = snap.tags ?? {};
  if (snap.managed || t.botId || t.integrationId || t.premiumSubscriberRole) return 'managed';
  if (t.subscriptionListingId || t.availableForPurchase || t.guildConnections) return 'subscription';
  return null;
}

/**
 * Options de guild.channels.create pour recréer un salon (champs selon le type). Pur.
 * @param {object} snap instantané (captureChannel)
 * @param {{ community?: boolean, maximumBitrate?: number, parentId?: string|null, overwrites?: object[], reason?: string }} opts
 */
function buildChannelCreate(snap, { community = false, maximumBitrate = 96_000, parentId = null, overwrites = [], reason } = {}) {
  let type = Number(snap.type ?? 0);
  if (type === 13 && !community) type = 2;
  if (type === 5 && !community) type = 0;
  const text = [0, 5, 15, 16].includes(type);
  const voice = [2, 13].includes(type);
  const forum = [15, 16].includes(type);
  const opts = { name: String(snap.name ?? 'salon').slice(0, 100), type, permissionOverwrites: overwrites, reason };
  if (type !== CATEGORY) opts.parent = parentId ?? null;
  if (Number.isInteger(snap.position)) opts.position = snap.position;
  if (type !== CATEGORY) opts.nsfw = Boolean(snap.nsfw);
  if (text && snap.topic) opts.topic = String(snap.topic).slice(0, forum ? 4096 : 1024);
  if ((text || voice) && Number.isInteger(snap.rateLimitPerUser)) opts.rateLimitPerUser = snap.rateLimitPerUser;
  if (voice) {
    if (Number.isInteger(snap.bitrate)) opts.bitrate = Math.max(8_000, Math.min(snap.bitrate, maximumBitrate));
    if (Number.isInteger(snap.userLimit)) opts.userLimit = snap.userLimit;
    if (snap.rtcRegion) opts.rtcRegion = snap.rtcRegion;
    if (Number.isInteger(snap.videoQualityMode)) opts.videoQualityMode = snap.videoQualityMode;
  }
  if ((type === 0 || type === 5 || forum) && Number.isInteger(snap.defaultAutoArchiveDuration)) opts.defaultAutoArchiveDuration = snap.defaultAutoArchiveDuration;
  if (forum) {
    if (snap.availableTags?.length) opts.availableTags = snap.availableTags.slice(0, 20).map((t) => ({ name: t.name, moderated: Boolean(t.moderated), emoji: t.emoji ?? null }));
    if (snap.defaultReactionEmoji) opts.defaultReactionEmoji = snap.defaultReactionEmoji;
    if (Number.isInteger(snap.defaultSortOrder)) opts.defaultSortOrder = snap.defaultSortOrder;
    if (Number.isInteger(snap.defaultForumLayout)) opts.defaultForumLayout = snap.defaultForumLayout;
    if (Number.isInteger(snap.defaultThreadRateLimitPerUser)) opts.defaultThreadRateLimitPerUser = snap.defaultThreadRateLimitPerUser;
  }
  return opts;
}

/**
 * Options de guild.roles.create pour recréer un rôle : permissions limitées à celles du bot s'il
 * n'est pas Administrateur, emoji Unicode seulement avec ROLE_ICONS, position sous le bot. Pur.
 */
function buildRoleCreate(snap, { botAdmin = false, botPermissions = 0n, roleIcons = false, enhancedColors = false, maxPosition = 1, reason } = {}) {
  let permissions = toBig(snap.permissions);
  if (!botAdmin) permissions &= toBig(botPermissions);
  const colors = { primaryColor: Number(snap.colors?.primary ?? 0) || 0 };
  if (enhancedColors && snap.colors?.secondary != null) colors.secondaryColor = snap.colors.secondary;
  if (enhancedColors && snap.colors?.tertiary != null) colors.tertiaryColor = snap.colors.tertiary;
  const opts = {
    name: String(snap.name ?? 'rôle').slice(0, 100),
    colors,
    hoist: Boolean(snap.hoist),
    mentionable: Boolean(snap.mentionable),
    permissions,
    reason,
  };
  if (roleIcons && snap.unicodeEmoji) opts.unicodeEmoji = snap.unicodeEmoji;
  const position = Math.min(Number(snap.position) || 1, Math.max(1, maxPosition));
  if (position > 1) opts.position = position;
  return opts;
}

/* -------------------------------------------------------------------- */
/* Instantanés                                                            */
/* -------------------------------------------------------------------- */

/**
 * Mémoire des instantanés d'un client. Par serveur : instantanés (salon, rôle, emoji, sticker),
 * orphelins (enfant → ancienne catégorie), surcharges retirées, report d'identifiants et
 * suppressions récentes (auteur), tous bornés et expirés.
 */
class StructureStore {
  constructor({ now = () => Date.now(), maxSnapshots = MAX_SNAPSHOTS, snapshotTtlMs = SNAPSHOT_TTL_MS, maxBuffered = MAX_BUFFERED, bufferTtlMs = BUFFER_TTL_MS, maxGuilds = MAX_GUILDS } = {}) {
    this.now = now;
    this.maxSnapshots = maxSnapshots;
    this.snapshotTtlMs = snapshotTtlMs;
    this.maxBuffered = maxBuffered;
    this.bufferTtlMs = bufferTtlMs;
    this.maxGuilds = maxGuilds;
    /** @type {Map<string, { snaps: Map, orphans: Map, overwrites: Map, remap: Map, origin: Map, deleted: Map, chains: Map, prunedAt: number }>} */
    this.guilds = new Map();
    this.chainSeq = 0;
  }

  static #put(map, key, value, max) {
    map.delete(key);
    map.set(key, value);
    while (map.size > max) map.delete(map.keys().next().value);
  }

  #state(guildId, create = true) {
    if (!guildId) return null;
    let st = this.guilds.get(guildId);
    if (!st && create) {
      st = { snaps: new Map(), orphans: new Map(), overwrites: new Map(), remap: new Map(), origin: new Map(), deleted: new Map(), chains: new Map(), prunedAt: this.now() };
      StructureStore.#put(this.guilds, guildId, st, this.maxGuilds);
    }
    if (st && this.now() - st.prunedAt > PRUNE_EVERY_MS) this.#prune(st);
    return st ?? null;
  }

  #prune(st, now = this.now()) {
    st.prunedAt = now;
    for (const [map, ttl] of [[st.snaps, this.snapshotTtlMs], [st.remap, this.snapshotTtlMs], [st.origin, this.snapshotTtlMs], [st.deleted, this.snapshotTtlMs], [st.chains, this.snapshotTtlMs], [st.orphans, this.bufferTtlMs], [st.overwrites, this.bufferTtlMs]]) {
      for (const [k, v] of map) if (now - v.at >= ttl) map.delete(k);
    }
  }

  #fresh(map, key, ttl) {
    const v = map.get(key);
    if (!v) return null;
    if (this.now() - v.at >= ttl) {
      map.delete(key);
      return null;
    }
    return v;
  }

  /** Enregistre un instantané (kind : channel | role | emoji | sticker). */
  put(guildId, kind, id, snapshot) {
    const st = this.#state(guildId);
    if (!st || !id || !snapshot) return snapshot;
    StructureStore.#put(st.snaps, `${kind}:${id}`, { snapshot, at: this.now() }, this.maxSnapshots);
    return snapshot;
  }

  get(guildId, kind, id) {
    const st = this.#state(guildId, false);
    return st ? this.#fresh(st.snaps, `${kind}:${id}`, this.snapshotTtlMs)?.snapshot ?? null : null;
  }

  /** Nombre d'instantanés gardés pour un serveur. */
  count(guildId) {
    return this.guilds.get(guildId)?.snaps.size ?? 0;
  }

  /** Salon sorti de sa catégorie (parentId passé à null) : rattachable 30 s. */
  noteOrphan(guildId, childId, parentId) {
    const st = this.#state(guildId);
    if (st && childId && parentId) StructureStore.#put(st.orphans, childId, { parentId, at: this.now() }, this.maxBuffered);
  }

  /** Ancienne catégorie d'un salon sorti de sa catégorie il y a moins de 30 s, ou null. */
  orphanParentOf(guildId, childId) {
    const st = this.#state(guildId, false);
    return st ? this.#fresh(st.orphans, childId, this.bufferTtlMs)?.parentId ?? null : null;
  }

  orphansOf(guildId, parentId) {
    const st = this.#state(guildId, false);
    if (!st) return [];
    const out = [];
    for (const [childId, v] of st.orphans) if (v.parentId === parentId && this.now() - v.at < this.bufferTtlMs) out.push(childId);
    return out;
  }

  /** Surcharge disparue d'un salon (rôle supprimé : Discord retire ses surcharges). */
  noteRemovedOverwrite(guildId, channelId, ow) {
    const st = this.#state(guildId);
    if (st && channelId && ow?.id) StructureStore.#put(st.overwrites, `${ow.id}:${channelId}`, { channelId, id: ow.id, type: Number(ow.type ?? 0), allow: String(ow.allow ?? '0'), deny: String(ow.deny ?? '0'), at: this.now() }, this.maxBuffered);
  }

  removedOverwritesOf(guildId, targetId) {
    const st = this.#state(guildId, false);
    if (!st) return [];
    return [...st.overwrites.values()].filter((v) => v.id === targetId && this.now() - v.at < this.bufferTtlMs);
  }

  /**
   * Ancien identifiant (salon ou rôle recréé) → nouveau, 30 min (entre incidents). Le nouveau garde
   * l'identifiant d'ORIGINE de la chaîne (originOf) : clé du disjoncteur, qui suit un objet recréé
   * puis supprimé de nouveau sans confondre deux homonymes.
   */
  setRemap(guildId, oldId, newId) {
    const st = this.#state(guildId);
    if (!st || !oldId || !newId) return;
    StructureStore.#put(st.remap, oldId, { id: newId, at: this.now() }, this.maxSnapshots);
    const root = this.#fresh(st.origin, oldId, this.snapshotTtlMs)?.id ?? oldId;
    StructureStore.#put(st.origin, newId, { id: root, at: this.now() }, this.maxSnapshots);
  }

  /** Identifiant d'origine d'un salon ou rôle recréé par Secur (lui-même s'il ne l'a pas été). */
  originOf(guildId, id) {
    const st = this.#state(guildId, false);
    return (st && id ? this.#fresh(st.origin, id, this.snapshotTtlMs)?.id : null) ?? id ?? null;
  }

  remapOf(guildId, oldId) {
    const st = this.#state(guildId, false);
    return st ? this.#fresh(st.remap, oldId, this.snapshotTtlMs)?.id ?? null : null;
  }

  /**
   * Modifications successives d'un même champ par un même auteur (A → B puis B → C) : une chaîne,
   * dont l'origine (A) et la dernière valeur (C) servent à toutes ses annulations, quel que soit
   * leur ordre dans la file. @returns {{ id: number, origin: unknown }}
   */
  chainChange(guildId, key, executorId, oldValue, newValue) {
    const st = this.#state(guildId);
    if (!st || !key || !executorId) return { id: 0, origin: oldValue };
    const prev = this.#fresh(st.chains, key, this.snapshotTtlMs);
    const linked = prev && prev.executorId === executorId && sameValue(prev.last, oldValue);
    const link = linked ? { ...prev, last: newValue, at: this.now() } : { id: (this.chainSeq += 1), executorId, origin: oldValue, last: newValue, at: this.now() };
    StructureStore.#put(st.chains, key, link, this.maxSnapshots);
    return { id: link.id, origin: link.origin };
  }

  /** Chaîne de modifications d'un champ (voir chainChange), ou null. */
  chainOf(guildId, key) {
    const st = this.#state(guildId, false);
    return st ? this.#fresh(st.chains, key, this.snapshotTtlMs) : null;
  }

  /**
   * Première annulation effective d'une chaîne (disjoncteur par objet) ? Les tâches suivantes de la
   * même chaîne (rafale d'un auteur, modifications enchaînées) répondent false. Chaîne inconnue,
   * expirée ou remplacée : true (comptée).
   */
  firstChainUndo(guildId, key, chainId) {
    const st = this.#state(guildId, false);
    const chain = st && chainId ? this.#fresh(st.chains, key, this.snapshotTtlMs) : null;
    if (!chain || chain.id !== chainId) return true;
    if (chain.undone) return false;
    chain.undone = true;
    return true;
  }

  /** Suppression classée (auteur) : une catégorie supprimée dans le même incident est recréée d'abord. */
  markDeleted(guildId, id, executorId) {
    const st = this.#state(guildId);
    if (st && id && executorId) StructureStore.#put(st.deleted, id, { executorId, at: this.now() }, this.maxSnapshots);
  }

  deletedBy(guildId, id) {
    const st = this.#state(guildId, false);
    return st ? this.#fresh(st.deleted, id, this.snapshotTtlMs)?.executorId ?? null : null;
  }

  forgetGuild(guildId) {
    this.guilds.delete(guildId);
  }

  prune(now = this.now()) {
    for (const st of this.guilds.values()) this.#prune(st, now);
  }
}

/** Mémoire des instantanés d'un client (créée à la demande). */
const stores = new WeakMap();
function storeFor(client) {
  if (!client || typeof client !== 'object') return new StructureStore();
  let store = stores.get(client);
  if (!store) {
    store = new StructureStore();
    stores.set(client, store);
  }
  return store;
}

/** Base SQLite du client (better-sqlite3), ou null. */
function dbOf(client) {
  return client?.database?.db ?? client?.database?.raw ?? null;
}

/** Configuration STOCKÉE d'un serveur (sans les défauts). */
function storedConfig(config, guildId) {
  const repo = config?.repo;
  if (!repo) return null;
  if (typeof repo.read === 'function') return repo.read(guildId)?.data ?? null;
  return repo.get?.(guildId) ?? null;
}

/** Valeur d'un chemin « a.b.0 ». Pur. */
function getPath(obj, pathStr) {
  let cur = obj;
  for (const k of String(pathStr).split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[k];
  }
  return cur;
}

/** Copie où le chemin reçoit `value`. Pur. */
function setPathValue(obj, pathStr, value) {
  const root = JSON.parse(JSON.stringify(obj ?? {}));
  const keys = String(pathStr).split('.');
  let cur = root;
  for (let i = 0; i < keys.length - 1; i += 1) {
    if (cur[keys[i]] == null || typeof cur[keys[i]] !== 'object') return root;
    cur = cur[keys[i]];
  }
  cur[keys[keys.length - 1]] = value;
  return root;
}

/**
 * Références de configuration rebranchées sur le nouvel identifiant : chaque chemin capturé qui
 * vaut encore l'ancien identifiant (ou null : débranché par un nettoyage, ex. salon de logs)
 * reçoit le nouveau. Écrit seulement les clés de premier niveau touchées.
 * @returns {string[]} chemins rebranchés
 */
function replugConfig(config, guildId, paths, oldId, newId, { nulls = true } = {}) {
  if (!config?.update || !paths?.length) return [];
  let stored = storedConfig(config, guildId);
  if (!stored) return [];
  const done = [];
  for (const p of paths) {
    const cur = getPath(stored, p);
    if (cur === oldId || (nulls && cur === null)) {
      stored = setPathValue(stored, p, newId);
      done.push(p);
    }
  }
  if (!done.length) return [];
  const tops = [...new Set(done.map((p) => p.split('.')[0]))];
  config.update(guildId, Object.fromEntries(tops.map((k) => [k, stored[k]])));
  return done;
}

/** Surcharges d'un salon (forme brute). */
function overwritesOf(channel) {
  return [...(channel?.permissionOverwrites?.cache?.values?.() ?? [])].map((o) => ({
    id: o.id,
    type: Number(o.type ?? 0),
    allow: toBig(o.allow).toString(),
    deny: toBig(o.deny).toString(),
  }));
}

/**
 * Type de salon lu en base et en configuration au moment de l'événement : ticket, modmail,
 * tempvoice, compteur, fil, entretien ou normal ; null si indéterminable (jamais recréé).
 */
function channelKind(client, channel, bundle = null) {
  if (channel?.isThread?.() || THREAD_TYPES.has(Number(channel?.type))) return 'fil';
  const repos = client?.repositories;
  if (typeof repos?.tickets?.getByChannel !== 'function' || typeof repos?.modmail?.getByChannel !== 'function' || typeof repos?.tempVoice?.get !== 'function') return null;
  if (repos.tickets.getByChannel(channel.id)) return 'ticket';
  if (repos.modmail.getByChannel(channel.id)) return 'modmail';
  if (repos.tempVoice.get(channel.id)) return 'tempvoice';
  const never = bundle?.never ?? {};
  if (never.tickets) return 'ticket';
  if (never.modmail_threads) return 'modmail';
  if (never.temp_voice) return 'tempvoice';
  if (never.applications) return 'entretien';
  const cfg = client.services?.config?.get?.(channel.guild?.id ?? channel.guildId);
  if (!cfg) return null;
  const sc = cfg.statsCounters ?? {};
  if (sc.categoryId === channel.id || Object.values(sc.counters ?? {}).some((c) => c?.channelId === channel.id)) return 'compteur';
  return 'normal';
}

/**
 * Instantané complet d'un salon (cache + base), SYNCHRONE : à prendre avant tout nettoyage.
 * bundle = channelRemap.capture (configuration et lignes de base « carry »).
 */
function captureChannel(client, channel, now = Date.now()) {
  const guild = channel.guild;
  let bundle = null;
  let kind = null;
  try {
    const db = dbOf(client);
    if (db && client.services?.config) bundle = channelRemap.capture(db, client.services.config, guild.id, channel.id);
    kind = channelKind(client, channel, bundle);
  } catch {
    kind = null; // base illisible : type indéterminable, jamais recréé
  }
  const isCategory = Number(channel.type) === CATEGORY;
  return {
    id: channel.id,
    guildId: guild?.id ?? channel.guildId,
    name: channel.name,
    type: Number(channel.type),
    topic: channel.topic ?? null,
    nsfw: Boolean(channel.nsfw),
    rateLimitPerUser: channel.rateLimitPerUser ?? null,
    bitrate: channel.bitrate ?? null,
    userLimit: channel.userLimit ?? null,
    rtcRegion: channel.rtcRegion ?? null,
    videoQualityMode: channel.videoQualityMode ?? null,
    defaultAutoArchiveDuration: channel.defaultAutoArchiveDuration ?? null,
    defaultThreadRateLimitPerUser: channel.defaultThreadRateLimitPerUser ?? null,
    availableTags: (channel.availableTags ?? []).map((t) => ({ name: t.name, moderated: Boolean(t.moderated), emoji: t.emoji ? { id: t.emoji.id ?? null, name: t.emoji.name ?? null } : null })),
    defaultReactionEmoji: channel.defaultReactionEmoji ? { id: channel.defaultReactionEmoji.id ?? null, name: channel.defaultReactionEmoji.name ?? null } : null,
    defaultSortOrder: channel.defaultSortOrder ?? null,
    defaultForumLayout: channel.defaultForumLayout ?? null,
    // Catégorie perdue juste avant (catégorie supprimée d'abord : Discord sort l'enfant) figée dans
    // l'instantané, le tampon des orphelins ne durant que 30 s.
    parentId: channel.parentId ?? (isCategory ? null : storeFor(client).orphanParentOf(guild?.id ?? channel.guildId, channel.id)) ?? null,
    position: Number.isInteger(channel.rawPosition) ? channel.rawPosition : null,
    overwrites: overwritesOf(channel),
    children: isCategory ? [...(guild?.channels?.cache?.values?.() ?? [])].filter((c) => c.parentId === channel.id && !c.isThread?.()).map((c) => c.id) : [],
    kind,
    bundle,
    source: 'cache',
    at: now,
  };
}

/** Instantané de dernier recours : les `changes` d'une entrée 12 (type jamais déterminable). Pur. */
function channelFromChanges(entry, now = Date.now()) {
  const old = Object.fromEntries((entry?.changes ?? []).map((c) => [c.key, c.old]));
  return {
    id: entry?.targetId ?? null,
    name: old.name ?? null,
    type: old.type ?? null,
    parentId: null,
    overwrites: (old.permission_overwrites ?? []).map((o) => ({ id: o.id, type: Number(o.type ?? 0), allow: String(o.allow ?? '0'), deny: String(o.deny ?? '0') })),
    children: [],
    kind: null,
    bundle: null,
    source: 'audit',
    at: now,
  };
}

/**
 * Instantané d'un rôle : champs, membres du cache (member._roles, que discord.js ne nettoie pas
 * à la suppression d'un rôle), surcharges lues dans le cache des salons (plus celles retirées
 * juste avant, tampon de channelUpdate) et chemins de configuration.
 */
function captureRole(client, role, store = null, now = Date.now()) {
  const guild = role.guild;
  const members = [];
  for (const m of guild?.members?.cache?.values?.() ?? []) {
    const ids = Array.isArray(m._roles) ? m._roles : [...(m.roles?.cache?.keys?.() ?? [])];
    if (!ids.includes(role.id)) continue;
    members.push(m.id);
    if (members.length >= MAX_SNAPSHOT_MEMBERS) break;
  }
  const overwrites = new Map();
  for (const ch of guild?.channels?.cache?.values?.() ?? []) {
    const o = ch.permissionOverwrites?.cache?.get?.(role.id);
    if (o) overwrites.set(ch.id, { channelId: ch.id, allow: toBig(o.allow).toString(), deny: toBig(o.deny).toString() });
  }
  for (const o of store?.removedOverwritesOf(guild?.id, role.id) ?? []) if (!overwrites.has(o.channelId)) overwrites.set(o.channelId, { channelId: o.channelId, allow: o.allow, deny: o.deny });
  let configPaths = [];
  try {
    configPaths = channelRemap.findPaths(storedConfig(client?.services?.config, guild?.id) ?? {}, role.id);
  } catch {
    configPaths = [];
  }
  const tags = role.tags ?? {};
  return {
    id: role.id,
    guildId: guild?.id ?? null,
    name: role.name,
    colors: { primary: role.colors?.primaryColor ?? 0, secondary: role.colors?.secondaryColor ?? null, tertiary: role.colors?.tertiaryColor ?? null },
    hoist: Boolean(role.hoist),
    mentionable: Boolean(role.mentionable),
    permissions: toBig(role.permissions).toString(),
    unicodeEmoji: role.unicodeEmoji ?? null,
    position: Number.isInteger(role.rawPosition) ? role.rawPosition : Number(role.position) || 0,
    managed: Boolean(role.managed),
    tags: {
      botId: tags.botId ?? null,
      integrationId: tags.integrationId ?? null,
      premiumSubscriberRole: Boolean(tags.premiumSubscriberRole),
      subscriptionListingId: tags.subscriptionListingId ?? null,
      availableForPurchase: Boolean(tags.availableForPurchase),
      guildConnections: Boolean(tags.guildConnections),
    },
    members,
    overwrites: [...overwrites.values()],
    configPaths,
    source: 'cache',
    at: now,
  };
}

/** Instantané d'un emoji (nom, adresse CDN, rôles autorisés). */
function captureEmoji(emoji, now = Date.now()) {
  return {
    kind: 'emoji',
    id: emoji.id,
    name: emoji.name,
    animated: Boolean(emoji.animated),
    roles: [...(emoji.roles?.cache?.keys?.() ?? emoji._roles ?? [])],
    url: `https://cdn.discordapp.com/emojis/${emoji.id}.${emoji.animated ? 'gif' : 'png'}`,
    at: now,
  };
}

/** Instantané d'un autocollant (nom, description, tags, format, adresse CDN). */
function captureSticker(sticker, now = Date.now()) {
  const format = Number(sticker.format ?? 1);
  return {
    kind: 'sticker',
    id: sticker.id,
    name: sticker.name,
    description: sticker.description ?? '',
    tags: sticker.tags ?? '',
    format,
    url: format === 3 ? null : `https://media.discordapp.net/stickers/${sticker.id}.${format === 4 ? 'gif' : 'png'}`,
    at: now,
  };
}

/* -------------------------------------------------------------------- */
/* Annulations : contexte d'incident                                     */
/* -------------------------------------------------------------------- */

/** Mode « tolérant » : option à vrai ET module en « on » (le mode max est toujours strict). */
function isLenient(ctx, key, option) {
  return ctx?.moduleCfg?.[option] === true && S.moduleMode(ctx.cfg, key) === 'on';
}

const budgets = new WeakMap();
/** Prend une unité du plafond `kind` de l'incident (idMap partagée). @returns {boolean} */
function takeBudget(ctx, kind, max) {
  const key = ctx?.idMap;
  if (!key || typeof key !== 'object') return true;
  let per = budgets.get(key);
  if (!per) budgets.set(key, (per = new Map()));
  const n = per.get(kind) ?? 0;
  if (n >= max) return false;
  per.set(kind, n + 1);
  return true;
}

/** Incident ouvert qui partage cette idMap (moteur SEC1), ou null. */
function incidentOf(ctx) {
  for (const state of ctx?.service?.open?.values?.() ?? []) if (state?.idMap && state.idMap === ctx.idMap) return state;
  return null;
}

/**
 * Incident Secur encore ouvert dont `userId` est l'auteur (moteur SEC1), ou null. Lecture seule :
 * un incident expiré n'est jamais retiré d'ici.
 */
function openIncidentOf(ctx, guildId, userId) {
  const state = ctx?.service?.open?.get?.(`${guildId}:${userId}`);
  if (!state) return null;
  const now = typeof ctx.service.now === 'function' ? ctx.service.now() : Date.now();
  return now <= state.expiresAt ? state : null;
}

/**
 * Auteur d'un incident ouvert à sanctionner (sanction visée au moins le derank) : une recréation ne
 * doit rien lui rendre (rôle, surcharge membre), sinon elle défait sa sanction.
 */
function sanctionedIncidentOf(ctx, guildId, userId) {
  const state = openIncidentOf(ctx, guildId, userId);
  return state && S.PUNISH_ORDER.indexOf(state.target) >= S.PUNISH_ORDER.indexOf('derank') ? state : null;
}

const summaries = new WeakMap();
/**
 * Ligne de synthèse d'un incident (une par `key`, mise à jour sur place) : les annulations
 * réussies du moteur n'ont pas de note, d'où cette ligne (ex. « Salons recréés : 3 … »).
 */
function noteSummary(ctx, key, mutate, render) {
  if (!ctx?.idMap || typeof ctx.idMap !== 'object') return;
  let per = summaries.get(ctx.idMap);
  if (!per) summaries.set(ctx.idMap, (per = new Map()));
  const data = per.get(key) ?? { line: null };
  mutate(data);
  per.set(key, data);
  const state = incidentOf(ctx);
  if (!Array.isArray(state?.details)) return;
  const line = String(render(data)).slice(0, 300);
  const idx = data.line ? state.details.indexOf(data.line) : -1;
  if (idx >= 0) state.details[idx] = line;
  else if (state.details.length < 8) state.details.push(line);
  else return;
  data.line = line;
}

/**
 * Changements d'une entrée rattachés à la chaîne de leur champ (classify, dans l'ordre du journal) :
 * old ← origine de la chaîne (valeur d'avant la 1re modification de cet auteur), chain ← identifiant.
 * Sans magasin, serveur ou auteur : inchangés.
 */
function chainChanges(store, guildId, prefix, executorId, changes) {
  if (!store || !guildId || !executorId) return changes;
  return changes.map((c) => {
    const { id, origin } = store.chainChange(guildId, `${prefix}:${c.key}`, executorId, c.old, c.new);
    return { ...c, old: origin, chain: id };
  });
}

/**
 * La valeur actuelle vient-elle encore de cette modification (sa nouvelle valeur, ou celle d'une
 * modification suivante du même auteur sur le même champ) ? Sinon, quelqu'un d'autre l'a changée.
 */
function chainMatches(store, guildId, prefix, c, now) {
  if (sameValue(now, c.new)) return true;
  if (!c.chain || !store) return false;
  const chain = store.chainOf(guildId, `${prefix}:${c.key}`);
  return Boolean(chain && chain.id === c.chain && sameValue(now, chain.last));
}

/** Identifiant actuel d'un salon (recréé : idMap, puis report entre incidents). */
function resolveChannelId(guild, ctx, store, id) {
  if (!id) return null;
  const mapped = ctx?.idMap?.get?.(id) ?? store?.remapOf(guild.id, id) ?? null;
  if (mapped && guild.channels?.cache?.has?.(mapped)) return mapped;
  return guild.channels?.cache?.has?.(id) ? id : null;
}

/** Identifiant actuel d'un rôle (recréé : idMap, puis report entre incidents). */
function resolveRoleId(guild, ctx, store, id) {
  if (!id) return null;
  if (id === guild.id) return id;
  const mapped = ctx?.idMap?.get?.(id) ?? store?.remapOf(guild.id, id) ?? null;
  if (mapped && guild.roles?.cache?.has?.(mapped)) return mapped;
  return guild.roles?.cache?.has?.(id) ? id : null;
}

/**
 * Permissions du bot : masque appliqué aux recréations s'il n'est pas Administrateur. « Gérer les
 * permissions » (bit ManageRoles) dans une surcharge est réservé à un Administrateur : retiré du
 * masque, sinon Discord refuse toute la recréation (50013).
 */
function botMask(guild) {
  const me = guild.members?.me;
  if (!me?.permissions) return null;
  return me.permissions.has(PermissionFlagsBits.Administrator) ? null : toBig(me.permissions) & ~PermissionFlagsBits.ManageRoles;
}

/** discordCdn (ADM3), chargé paresseusement : null s'il est absent. */
function cdn() {
  try {
    return require('../../utils/discordCdn');
  } catch {
    return null;
  }
}

/**
 * Image du CDN de Discord en data URI (jamais une chaîne d'URL ou de chemin donnée à discord.js).
 * @returns {Promise<{ ok: true, data: string }|{ ok: false, reason: string }>}
 */
async function fetchImageDataUri(url, { maxBytes } = {}) {
  const lib = cdn();
  if (!lib?.fetchDiscordImage) return { ok: false, reason: 'téléchargement indisponible sur cette instance' };
  if (!url) return { ok: false, reason: 'adresse inconnue' };
  try {
    const buffer = await lib.fetchDiscordImage(url, maxBytes ? { maxBytes } : {});
    const kind = lib.sniffImage?.(buffer) ?? 'png';
    return { ok: true, data: `data:image/${kind};base64,${buffer.toString('base64')}`, buffer };
  } catch (e) {
    return { ok: false, reason: String(e?.message ?? e).slice(0, 120) };
  }
}

const ALL_PERMISSIONS = PermissionsBitField.All;

module.exports = {
  SNAPSHOT_TTL_MS,
  MAX_SNAPSHOTS,
  BUFFER_TTL_MS,
  MAX_BUFFERED,
  MAX_SNAPSHOT_MEMBERS,
  MAX_ROLE_MEMBERS_RESTORED,
  MAX_CHANNEL_RECREATIONS,
  MAX_ROLE_RECREATIONS,
  MAX_EXPRESSION_UPLOADS,
  DANGEROUS_BITS,
  EVERYONE_GUARDS,
  ALL_PERMISSIONS,
  KIND_LABELS,
  CHANNEL_RESTORABLE,
  CHANNEL_ALERT_ONLY,
  CHANNEL_SENSITIVE,
  ROLE_RESTORABLE,
  ROLE_ALERT_ONLY,
  SERVER_RESTORABLE,
  SERVER_CHANNEL_KEYS,
  SERVER_IMAGES,
  SERVER_ALERT_ONLY,
  SERVER_LABELS,
  toBig,
  gainedBits,
  grantsDangerous,
  overwriteRisk,
  sameValue,
  changeValue,
  filterChannelChanges,
  filterRoleChanges,
  planServerRestore,
  guildImageUrl,
  mapOverwrites,
  protectedRoleKind,
  buildChannelCreate,
  buildRoleCreate,
  StructureStore,
  storeFor,
  dbOf,
  storedConfig,
  getPath,
  replugConfig,
  overwritesOf,
  channelKind,
  captureChannel,
  channelFromChanges,
  captureRole,
  captureEmoji,
  captureSticker,
  isLenient,
  takeBudget,
  incidentOf,
  openIncidentOf,
  sanctionedIncidentOf,
  noteSummary,
  chainChanges,
  chainMatches,
  resolveChannelId,
  resolveRoleId,
  botMask,
  cdn,
  fetchImageDataUri,
};
