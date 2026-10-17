'use strict';

const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { progressBar } = require('../../utils/embeds');
const { card, field, wide, blank, subtext, status, ICONS, TONES, actionButton, buttonRows, ButtonStyle } = require('../../utils/ui');
const { hasForbiddenPermissions } = require('../roles/rolemenu');
const { UserError } = require('../../core/errors');
const { parseDuration } = require('../../utils/time');
const { decayDaysOf, MAX_DECAY_DAYS } = require('../../services/StrikeService');
const { safeName } = require('../../utils/safeText');
const { logCard } = require('../../services/LoggingService');
const { formatDuration } = require('../../utils/time');
const {
  BotProfileService, parseThemeColor, colorHex, validateNick, validateBio, assertImageAttachment,
  MAX_NICK, MAX_BIO, PROFILE_IMAGE_COOLDOWN_MS,
} = require('../../services/BotProfileService');

/** « Après 30 jours » / « Jamais ». Pur. */
function decayText(cfg) {
  const days = decayDaysOf(cfg);
  return days ? `Après **${days}** jour${days > 1 ? 's' : ''}` : 'Jamais';
}

/** Catégories de logs → libellé et icône (catalogue commun, cf. /logs). */
const LOG_CATEGORIES = Object.freeze(
  Object.fromEntries(Object.entries(require('../../utils/logCatalog').LOG_CATEGORIES).map(([k, c]) => [k, { label: c.label, emoji: c.emoji }])),
);

// « mute » est appliqué comme une exclusion temporaire par l'escalade (/warn).
const ACTION_LABELS = { warn: `${ICONS.warn} Avertissement`, mute: `${ICONS.mute} Exclusion temporaire`, timeout: `${ICONS.mute} Exclusion temporaire`, kick: `${ICONS.kick} Expulsion`, ban: `${ICONS.ban} Bannissement`, tempban: `${ICONS.ban} Ban temporaire` };

/** Paliers de strikes : bornes de saisie (cf. StrikeService et applyEscalation dans /warn). */
const MAX_THRESHOLDS = 10;
const MAX_THRESHOLD_STRIKES = 100;
/** Durée maximale d'une exclusion temporaire Discord (28 jours). */
const MAX_TIMEOUT_MS = 28 * 24 * 60 * 60 * 1000;
const THRESHOLD_ACTIONS = new Set(['mute', 'timeout', 'kick', 'ban']);
const THRESHOLDS_FORMAT = '`3=mute 1h, 5=kick, 7=ban` (ou `aucun` pour tout retirer)';

/**
 * Analyse strictement une liste de paliers « 3=mute 1h, 5=kick, 7=ban » au format
 * de `strikes.thresholds` : [{ strikes, action, duration }], triée par seuil.
 * Actions : mute | timeout (exclusion temporaire, durée ≤ 28 j, 1h par défaut) · kick · ban.
 * « aucun » : liste vide. Lève une UserError précise sinon. Pur.
 * @returns {Array<{ strikes: number, action: string, duration: string|null }>}
 */
function parseThresholds(input) {
  const text = String(input ?? '').trim();
  if (/^(aucun|none)$/i.test(text)) return [];
  const parts = text.split(/[,;\n]/).map((p) => p.trim());
  if (!text || parts.some((p) => !p)) throw new UserError(`Paliers invalides : élément vide. Format attendu : ${THRESHOLDS_FORMAT}.`);
  if (parts.length > MAX_THRESHOLDS) throw new UserError(`Au plus **${MAX_THRESHOLDS}** paliers.`);
  const seen = new Set();
  const out = parts.map((part) => {
    const m = /^(\d{1,3})\s*=\s*([a-z]+)(?:\s+(\S+))?$/i.exec(part);
    if (!m) throw new UserError(`Palier « ${part.slice(0, 50)} » invalide. Format attendu : ${THRESHOLDS_FORMAT}.`);
    const strikes = Number(m[1]);
    const action = m[2].toLowerCase();
    if (strikes < 1 || strikes > MAX_THRESHOLD_STRIKES) throw new UserError(`Palier « ${part} » : le nombre de strikes doit être entre 1 et ${MAX_THRESHOLD_STRIKES}.`);
    if (seen.has(strikes)) throw new UserError(`Le palier de **${strikes}** strikes est défini deux fois.`);
    seen.add(strikes);
    if (!THRESHOLD_ACTIONS.has(action)) throw new UserError(`Palier « ${part} » : action inconnue. Actions possibles : \`mute\`, \`timeout\`, \`kick\`, \`ban\`.`);
    if (action === 'kick' || action === 'ban') {
      if (m[3]) throw new UserError(`Palier « ${part} » : pas de durée pour \`${action}\` (seuls \`mute\`/\`timeout\` en prennent une).`);
      return { strikes, action, duration: null };
    }
    const duration = (m[3] ?? '1h').toLowerCase();
    const ms = parseDuration(duration);
    if (!ms) throw new UserError(`Palier « ${part} » : durée invalide (exemples : \`10m\`, \`1h\`, \`2d\`).`);
    if (ms > MAX_TIMEOUT_MS) throw new UserError(`Palier « ${part} » : une exclusion temporaire dure au plus 28 jours.`);
    return { strikes, action, duration };
  });
  return out.sort((a, b) => a.strikes - b.strikes);
}

/** Échelle lisible des paliers (une ligne par palier). */
function ladderLines(thresholds) {
  return [...thresholds].sort((a, b) => a.strikes - b.strikes).map((t) => `**${t.strikes}** strikes → ${ACTION_LABELS[t.action] ?? t.action}${t.duration ? ` · ${t.duration}` : ''}`);
}

const ON = '🟢';
const OFF = '🔴';
const UNSET = '—';

const onOff = (value, on = 'Activé', off = 'Désactivé') => (value ? `${ON} ${on}` : `${OFF} ${off}`);

/** Les boutons revérifient la permission par défaut de la commande. */
function assertManageGuild(interaction) {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    throw new UserError('Il faut la permission **Gérer le serveur** pour consulter la configuration.');
  }
}

/**
 * État d'un salon de logs : [pastille, texte].
 * 🟢 OK · ⚠️ je ne peux pas écrire · ❌ introuvable · — non défini
 */
function logChannelState(guild, id) {
  if (!id) return [UNSET, '*Non défini*'];
  const channel = guild.channels.cache.get(id);
  if (!channel) return [ICONS.error, `\`${id}\` · *introuvable*`];
  const me = guild.members.me;
  const perms = me ? channel.permissionsFor(me) : null;
  const canWrite = !perms || perms.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks]);
  return canWrite ? [ON, `${channel}`] : [ICONS.warning, `${channel} · *accès refusé*`];
}

/** Parties actives de l'accueil (/bienvenue). */
function welcomeParts(cfg) {
  const w = cfg.welcome || {};
  return [
    w.join?.enabled ? 'arrivées' : null,
    w.leave?.enabled ? 'départs' : null,
    (w.autoRoles?.humans?.length || 0) + (w.autoRoles?.bots?.length || 0) ? 'rôles auto' : null,
    w.verification?.enabled ? 'vérification' : null,
  ].filter(Boolean);
}

function welcomeActive(cfg) {
  return welcomeParts(cfg).length > 0;
}

/** Tableau de bord : un module = un champ, avec son état. */
function renderDashboard(guild, cfg) {
  const logIds = Object.keys(LOG_CATEGORIES).map((k) => cfg.logChannels?.[k]);
  const logsSet = logIds.filter(Boolean).length;
  const filters = Object.values(cfg.automod?.filters || {});
  const activeFilters = filters.filter((f) => f.enabled).length;
  const thresholds = cfg.strikes?.thresholds || [];
  const whitelist = (cfg.whitelist?.users?.length ?? 0) + (cfg.whitelist?.roles?.length ?? 0);

  const modules = [
    ['Salons de logs', logsSet > 0],
    ['Strikes', cfg.strikes?.enabled],
    ['AutoMod', cfg.automod?.enabled],
    ['AntiRaid', cfg.antiraid?.enabled],
    ['Tickets', Boolean(cfg.tickets?.categoryId)],
    ['Modmail', cfg.modmail?.enabled],
    ['Suggestions', Boolean(cfg.suggestions?.channelId)],
    ['Vocaux temporaires', cfg.tempVoice?.enabled],
    ['Sauvegardes auto', cfg.autobackup?.enabled],
    ['Bienvenue', welcomeActive(cfg)],
    ['Niveaux', cfg.levels?.enabled],
  ];
  const active = modules.filter(([, on]) => on).length;

  const fields = [
    field(ICONS.moderator, 'Modération', [onOff(cfg.moderation?.dmOnSanction, 'DM au sanctionné', 'Pas de DM'), onOff(cfg.moderation?.confirmDangerous, 'Confirmations', 'Sans confirmation')].join('\n')),
    field('⚖️', 'Strikes', cfg.strikes?.enabled ? `${ON} Activés\n${subtext(`${thresholds.length} palier${thresholds.length > 1 ? 's' : ''}`)}` : `${OFF} Désactivés`),
    field(ICONS.automod, 'AutoMod', cfg.automod?.enabled ? `${ON} Actif\n${subtext(`${activeFilters}/${filters.length} filtres`)}` : `${OFF} Inactif`),
    field('🚨', 'AntiRaid', cfg.antiraid?.enabled ? `${ON} Actif\n${subtext(`Seuil : ${cfg.antiraid.joinThreshold} arrivées / ${cfg.antiraid.joinWindowSeconds} s`)}` : `${OFF} Inactif`),
    field(ICONS.ticket, 'Tickets', cfg.tickets?.categoryId ? `${ON} Configurés\n${subtext(`${cfg.tickets.maxPerUser ?? 1} par membre${cfg.tickets.reasons?.length ? ` · ${cfg.tickets.reasons.length} motif(s)` : ''}`)}` : `${UNSET} Non configurés`),
    field(ICONS.mail, 'Modmail', onOff(cfg.modmail?.enabled, 'Actif', 'Inactif')),
    field(ICONS.idea, 'Suggestions', cfg.suggestions?.channelId ? `${ON} <#${cfg.suggestions.channelId}>` : `${UNSET} Non configurées`),
    field(ICONS.voice, 'Vocaux temporaires', onOff(cfg.tempVoice?.enabled, 'Actifs', 'Inactifs')),
    field(ICONS.memory, 'Sauvegardes auto', cfg.autobackup?.enabled ? `${ON} Toutes les ${cfg.autobackup.intervalHours} h` : `${OFF} Désactivées`),
    field(ICONS.project, 'Projets', cfg.projects?.openCreation ? `${ON} Création ouverte` : `${OFF} Gestionnaires`),
    field(ICONS.check, 'Whitelist', whitelist ? `${ON} **${whitelist}** entrée${whitelist > 1 ? 's' : ''}` : `${UNSET} Vide`),
    field('👋', 'Bienvenue', welcomeActive(cfg) ? `${ON} Actif\n${subtext(welcomeParts(cfg).join(' · '))}` : `${OFF} Inactif`),
    field('📈', 'Niveaux', onOff(cfg.levels?.enabled, 'Actifs', 'Inactifs')),
  ];

  // Grille des salons de logs sur deux colonnes.
  const keys = Object.keys(LOG_CATEGORIES);
  const half = Math.ceil(keys.length / 2);
  const column = (list) =>
    list
      .map((k) => {
        const [dot, text] = logChannelState(guild, cfg.logChannels?.[k]);
        return `${dot} **${LOG_CATEGORIES[k].label}** · ${text}`;
      })
      .join('\n');
  // 13 modules + 2 espaceurs : la grille des logs commence toujours sur une nouvelle ligne.
  while (fields.length % 3) fields.push(blank());
  fields.push(
    field(ICONS.list, `Salons de logs · ${logsSet}/${logIds.length}`, column(keys.slice(0, half))),
    { name: '​', value: column(keys.slice(half)), inline: true },
  );

  return card({
    tone: 'brand',
    section: 'configuration',
    icon: ICONS.settings,
    title: 'Configuration du serveur',
    description: [
      `Vue d'ensemble des réglages de **${guild.name}**.`,
      `\`${progressBar(active / modules.length, 16)}\` **${active}/${modules.length}** modules actifs`,
      subtext(`${ON} actif · ${OFF} désactivé · ${UNSET} non configuré`),
    ],
    thumbnail: guild.iconURL?.({ size: 128 }) ?? null,
    fields,
    footer: 'Modifier : /logs · /antiraid · /tickets · /settings moderation',
  });
}

/** Détail des salons de logs : une case par catégorie, avec vérification d'accès. */
function renderLogs(guild, cfg) {
  const entries = Object.entries(LOG_CATEGORIES).map(([key, meta]) => {
    const [dot, text] = logChannelState(guild, cfg.logChannels?.[key]);
    return { key, meta, dot, text };
  });
  const ok = entries.filter((e) => e.dot === ON).length;
  const broken = entries.filter((e) => e.dot === ICONS.error || e.dot === ICONS.warning).length;
  return card({
    tone: broken ? 'warning' : 'brand',
    section: 'configuration',
    icon: ICONS.list,
    title: 'Salons de logs',
    description: [
      `**${ok}/${entries.length}** catégories journalisées.`,
      broken ? `${ICONS.warning} **${broken}** salon${broken > 1 ? 's' : ''} à corriger (supprimé ou accès refusé).` : null,
      subtext(`${ON} opérationnel · ${ICONS.warning} accès refusé · ${ICONS.error} introuvable · ${UNSET} non défini`),
    ],
    fields: entries.map((e) => field(e.meta.emoji, e.meta.label, `${e.dot} ${e.text}`)),
    footer: 'Tout se configure dans /logs (bouton ci-dessous)',
  });
}

/** Détail des options de modération et des paliers de strikes. */
function renderModeration(cfg) {
  const m = cfg.moderation || {};
  const thresholds = cfg.strikes?.thresholds || [];
  const ladder = ladderLines(thresholds);
  return card({
    tone: 'brand',
    section: 'configuration',
    icon: ICONS.moderator,
    title: 'Options de modération',
    description: 'Comportement des commandes de sanction sur ce serveur.',
    fields: [
      field(ICONS.mail, 'DM au sanctionné', onOff(m.dmOnSanction, 'Oui', 'Non')),
      field(ICONS.warning, 'Confirmation', onOff(m.confirmDangerous, 'Demandée', 'Désactivée')),
      field(ICONS.reason, 'Raison obligatoire', onOff(m.requireReason, 'Oui', 'Non')),
      field(ICONS.mute, 'Rôle muet', m.mutedRoleId ? `<@&${m.mutedRoleId}>` : `${UNSET} Aucun`),
      field('⚖️', 'Strikes', onOff(cfg.strikes?.enabled, 'Activés', 'Désactivés')),
      field(ICONS.count, 'Paliers', `**${thresholds.length}**`),
      field(ICONS.expires, 'Expiration des strikes', decayText(cfg)),
      wide('📈', 'Paliers de strikes', cfg.strikes?.enabled ? ladder.join('\n') || '*Aucun palier : les strikes sont seulement comptés.*' : '*Système désactivé.*'),
    ],
    footer: 'Modifier : /settings moderation (raison_obligatoire, strikes, paliers, decroissance, role_muet…)',
  });
}

/**
 * Lit les options de /settings moderation et construit le patch de configuration
 * (`moderation.*` et `strikes.*`). Valide le rôle muet et les paliers (UserError).
 * @returns {{ patch: object, edited: Set<string> }}
 */
function readModerationOptions(interaction, client) {
  const { options, guild } = interaction;
  const moderation = {};
  const strikes = {};
  const edited = new Set();
  const bool = (name, target, key) => {
    const value = options.getBoolean(name);
    if (value !== null) {
      target[key] = value;
      edited.add(name);
    }
  };
  bool('dm_sanction', moderation, 'dmOnSanction');
  bool('confirmation', moderation, 'confirmDangerous');
  bool('raison_obligatoire', moderation, 'requireReason');
  bool('strikes', strikes, 'enabled');
  const ladder = options.getString('paliers');
  if (ladder !== null) {
    strikes.thresholds = parseThresholds(ladder);
    edited.add('paliers');
  }
  const decay = options.getInteger?.('decroissance') ?? null;
  if (decay !== null) {
    if (!Number.isInteger(decay) || decay < 0 || decay > MAX_DECAY_DAYS) throw new UserError(`Décroissance : entre 0 (jamais) et ${MAX_DECAY_DAYS} jours.`);
    strikes.decayDays = decay;
    edited.add('decroissance');
  }
  const role = options.getRole('role_muet');
  if (role) {
    assertMutedRole(interaction, client, guild.roles?.cache?.get(role.id) ?? role);
    moderation.mutedRoleId = role.id;
    edited.add('role_muet');
  }
  const patch = {};
  if (Object.keys(moderation).length) patch.moderation = moderation;
  if (Object.keys(strikes).length) patch.strikes = strikes;
  return { patch, edited };
}

/** Le rôle muet doit être attribuable par le bot (ni @everyone, ni géré, sous mon rôle le plus haut). */
function assertMutedRole(interaction, client, role) {
  const guild = interaction.guild;
  if (role.id === guild.id) throw new UserError('@everyone ne peut pas servir de rôle muet.');
  if (role.managed) throw new UserError(`${role} est géré par une intégration : il ne peut pas servir de rôle muet.`);
  const highest = guild.members?.me?.roles?.highest;
  if (highest && role.position >= highest.position) {
    throw new UserError(`${role} est au-dessus de mon rôle le plus haut : je ne pourrais pas l'attribuer. Remontez mon rôle ou choisissez un rôle plus bas.`);
  }
  // Chaque /mute donnera ce rôle à la cible : il ne doit conférer AUCUNE permission en plus
  // de @everyone (sinon /mute devient un moyen d'attribuer un rôle de modération).
  const everyone = guild.roles?.everyone?.permissions?.bitfield ?? 0n;
  const extra = BigInt(role.permissions?.bitfield ?? 0n) & ~BigInt(everyone);
  if (extra !== 0n || (role.permissions?.any && hasForbiddenPermissions(role))) {
    throw new UserError(`${role} donne des permissions supplémentaires : un rôle muet ne doit en avoir aucune. Choisissez un rôle dédié.`);
  }
  if (interaction.user?.id !== guild.ownerId && role.position >= (interaction.member?.roles?.highest?.position ?? 0)) {
    throw new UserError(`${role} est au-dessus (ou au niveau) de votre rôle le plus haut.`);
  }
  // Ses refus seront posés dans tous les salons : il ne doit pas être porté par des membres non muets.
  const muted = new Set((client.services.moderation?.sanctions?.listActiveByType?.(guild.id, 'mute') ?? []).map((r) => r.user_id));
  const holders = [...(role.members?.values?.() ?? [])].filter((m) => !m.user?.bot && !muted.has(m.id));
  if (holders.length) {
    throw new UserError(`${role} est déjà porté par **${holders.length}** membre(s) non muet(s) : ils seraient tous réduits au silence. Choisissez un rôle dédié.`);
  }
}

/** Carte de confirmation de /settings moderation (✏️ = modifié). */
function moderationUpdatedView(cfg, edited) {
  const mark = (name) => (edited.has(name) ? ' ✏️' : '');
  const m = cfg.moderation || {};
  const thresholds = cfg.strikes?.thresholds || [];
  return {
    embeds: [
      card({
        tone: 'success',
        section: 'configuration',
        icon: ICONS.success,
        title: 'Options de modération mises à jour',
        description: 'Les nouveaux réglages s\'appliquent immédiatement.',
        fields: [
          field(ICONS.mail, 'DM au sanctionné', `${onOff(m.dmOnSanction, 'Oui', 'Non')}${mark('dm_sanction')}`),
          field(ICONS.warning, 'Confirmation', `${onOff(m.confirmDangerous, 'Demandée', 'Désactivée')}${mark('confirmation')}`),
          field(ICONS.reason, 'Raison obligatoire', `${onOff(m.requireReason, 'Oui', 'Non')}${mark('raison_obligatoire')}`),
          field(ICONS.mute, 'Rôle muet', `${m.mutedRoleId ? `<@&${m.mutedRoleId}>` : `${UNSET} Aucun`}${mark('role_muet')}`),
          field('⚖️', 'Strikes', `${onOff(cfg.strikes?.enabled, 'Activés', 'Désactivés')}${mark('strikes')}`),
          field(ICONS.count, 'Paliers', `**${thresholds.length}**${mark('paliers')}`),
          field(ICONS.expires, 'Expiration des strikes', `${decayText(cfg)}${mark('decroissance')}`),
          wide('📈', 'Paliers de strikes', ladderLines(thresholds).join('\n') || '*Aucun palier : les strikes sont seulement comptés.*'),
          edited.has('decroissance') ? wide(ICONS.info, 'Décroissance', 'Les strikes plus anciens ne comptent plus dans le palier : ils restent enregistrés (remettre `0` les fait recompter).') : null,
        ],
        footer: '✏️ = modifié',
      }),
    ],
    components: buttonRows(actionButton({ command: 'settings', action: 'moderation', label: 'Modération', emoji: ICONS.moderator }), actionButton({ command: 'settings', action: 'view', label: 'Vue d\'ensemble', emoji: ICONS.settings })),
  };
}

// ---------------------------------------------------------------- apparence (/settings theme, profil)

/** Carte d'aperçu du thème (ton « marque » : elle prend elle-même la couleur choisie). */
function themeView(color) {
  const hex = colorHex(color);
  return {
    embeds: [
      card({
        tone: 'brand',
        section: 'configuration',
        icon: ICONS.color,
        title: 'Thème du bot',
        description: [
          color == null ? `Couleur par défaut rétablie (${colorHex(TONES.brand)}).` : `Les cartes du bot prennent désormais la couleur **${hex}** sur ce serveur.`,
          subtext('Cette carte est un aperçu.'),
        ],
        fields: [
          field(ICONS.color, 'Couleur', color == null ? `Par défaut · \`${colorHex(TONES.brand)}\`` : `\`${hex}\``),
          wide(ICONS.success, 'Appliquée à', 'Réponses du bot (cartes générales), logs d\'information, messages épinglés, cartes des annonces, signalements, candidatures et absences.'),
          wide(ICONS.info, 'Jamais modifiées', 'Couleurs choisies (/couleur, /embed, couleur d\'un rôle, annonces colorées) et couleurs de sens : succès, erreur, avertissement, sanction.'),
          wide(ICONS.warning, 'Pas encore thémés', 'Messages d\'accueil, giveaways et panneaux (tickets, rôles, vérification) : couleur par défaut.'),
        ],
        footer: 'Revenir à la couleur d\'origine : /settings theme couleur: défaut',
      }),
    ],
  };
}

/** Options de profil reçues → changements à appliquer (validés). Lève une UserError. Pur (hors options). */
function readProfileOptions(interaction, cfg) {
  const { options } = interaction;
  const nickIn = options.getString('pseudo');
  const bioIn = options.getString('bio');
  const avatar = options.getAttachment('avatar');
  const banner = options.getAttachment('banniere');
  const reset = options.getString('reinitialiser');
  const resets = new Set(reset === 'tout' ? ['pseudo', 'avatar', 'banniere', 'bio'] : reset ? [reset] : []);
  const given = { pseudo: nickIn != null, avatar: Boolean(avatar), banniere: Boolean(banner), bio: bioIn != null };
  for (const key of resets) if (given[key]) throw new UserError(`\`${key}\` est à la fois fourni et réinitialisé : choisissez l'un ou l'autre.`);
  const changes = {};
  if (given.pseudo) changes.nick = validateNick(nickIn, cfg);
  if (given.bio) changes.bio = validateBio(bioIn, cfg);
  if (avatar) assertImageAttachment(avatar, 'Avatar');
  if (banner) assertImageAttachment(banner, 'Bannière');
  if (resets.has('pseudo')) changes.nick = null;
  if (resets.has('avatar')) changes.avatar = null;
  if (resets.has('banniere')) changes.banner = null;
  if (resets.has('bio')) changes.bio = null;
  return { changes, avatar, banner, resets };
}

/** Temps restant avant un nouveau changement d'image (avatar ou bannière) sur ce serveur. */
function imageCooldownLeft(client, guildId, kind) {
  return client.cooldowns.remaining(BotProfileService.imageCooldownKey(guildId, kind));
}

/** Carte « profil du bot sur ce serveur » (état actuel, champs modifiés marqués ✏️). */
function profileView(client, guild, edited = new Set()) {
  const me = guild.members?.me;
  const mark = (key) => (edited.has(key) ? ' ✏️' : '');
  const cooldown = (kind) => {
    const left = imageCooldownLeft(client, guild.id, kind);
    return left ? `\n${subtext(`Prochain changement dans ${formatDuration(left)}`)}` : '';
  };
  return {
    embeds: [
      card({
        tone: 'brand',
        section: 'configuration',
        icon: ICONS.bot,
        title: edited.size ? 'Profil du bot mis à jour' : 'Profil du bot sur ce serveur',
        description: [
          edited.size ? 'Les changements ne concernent que **ce serveur** : le profil global du bot est inchangé.' : 'Personnalisez mon pseudo, mon avatar, ma bannière et ma bio **sur ce serveur uniquement**.',
          subtext('Options : pseudo, avatar, banniere, bio, reinitialiser.'),
        ],
        thumbnail: me?.displayAvatarURL?.({ size: 128 }) ?? null,
        fields: [
          field('🏷️', 'Pseudo', `${me?.nickname ? `**${safeNick(me.nickname)}**` : `*Aucun (nom global : ${safeNick(client.user?.username ?? 'bot')})*`}${mark('nick')}`),
          field(ICONS.image, 'Avatar', `${me?.avatar ? 'Propre à ce serveur' : 'Avatar global'}${mark('avatar')}${cooldown('avatar')}`),
          field('🖼️', 'Bannière', `${me?.banner ? 'Propre à ce serveur' : 'Bannière globale'}${mark('banner')}${cooldown('banner')}`),
          edited.has('bio') ? wide(ICONS.reason, 'Bio', 'Modifiée ✏️') : null,
        ],
        footer: `Pseudo ${MAX_NICK} caractères · bio ${MAX_BIO} · images 8 Mo, une fois par 10 min`,
      }),
    ],
  };
}

/** Pseudo affiché sans Markdown actif. */
function safeNick(name) {
  return safeName(String(name ?? '').slice(0, 64));
}

/** /settings theme */
async function runTheme(interaction, client) {
  const { config, logging } = client.services;
  const guild = interaction.guild;
  const color = parseThemeColor(interaction.options.getString('couleur', true));
  const before = config.get(guild.id).appearance?.color ?? null;
  config.update(guild.id, { appearance: { color } });
  await interaction.reply({ ...themeView(color), ephemeral: true });
  await logging.send(guild.id, 'server', logCard({
    category: 'server',
    icon: ICONS.color,
    title: 'Thème du bot modifié',
    user: interaction.user,
    description: `${interaction.user} a changé la couleur des cartes du bot.`,
    fields: [
      field(null, 'Avant', colorHex(before) ? `\`${colorHex(before)}\`` : 'Par défaut'),
      field(null, 'Après', colorHex(color) ? `\`${colorHex(color)}\`` : 'Par défaut'),
    ],
  }), [], { event: 'botProfile' });
}

/** /settings profil */
async function runProfile(interaction, client) {
  const { config, logging, botProfile } = client.services;
  const guild = interaction.guild;
  const { changes, avatar, banner } = readProfileOptions(interaction, config.get(guild.id));
  if (!Object.keys(changes).length && !avatar && !banner) return interaction.reply({ ...profileView(client, guild), ephemeral: true });
  for (const [kind, label, wanted] of [['avatar', 'l\'avatar', avatar || changes.avatar === null], ['banner', 'la bannière', banner || changes.banner === null]]) {
    const left = wanted ? imageCooldownLeft(client, guild.id, kind) : 0;
    if (left) throw new UserError(`Je ne peux changer ${label} qu'une fois toutes les 10 minutes sur ce serveur : réessayez dans ${formatDuration(left)}.`);
  }
  await interaction.deferReply({ ephemeral: true });
  if (avatar) changes.avatar = await botProfile.fetchImage(avatar.url);
  if (banner) changes.banner = await botProfile.fetchImage(banner.url);
  await botProfile.applyGuildProfile(guild, changes, { reason: `Profil du bot modifié par ${interaction.user.tag ?? interaction.user.id} (/settings profil)` });
  for (const kind of ['avatar', 'banner']) {
    if (changes[kind] !== undefined) client.cooldowns.hit(BotProfileService.imageCooldownKey(guild.id, kind), PROFILE_IMAGE_COOLDOWN_MS);
  }
  const edited = new Set(Object.keys(changes));
  await interaction.editReply(profileView(client, guild, edited));
  const label = { nick: 'pseudo', avatar: 'avatar', banner: 'bannière', bio: 'bio' };
  await logging.send(guild.id, 'server', logCard({
    category: 'server',
    icon: ICONS.bot,
    title: 'Profil du bot modifié',
    user: interaction.user,
    description: `${interaction.user} a modifié mon profil sur ce serveur.`,
    fields: Object.entries(changes).map(([key, value]) => field(null, label[key], value === null ? 'Réinitialisé' : key === 'nick' ? `**${safeNick(value)}**` : key === 'bio' ? 'Modifiée' : 'Changé')),
  }), [], { event: 'botProfile' });
}

function dashboardView(guild, cfg) {
  return { embeds: [renderDashboard(guild, cfg)], components: [...tabsFor('view'), ...shortcuts()] };
}

/** Raccourcis vers les tableaux de bord de configuration (chacun revérifie sa permission). */
function shortcuts() {
  return buttonRows(
    actionButton({ command: 'automod', action: 'go', args: ['home'], label: 'AutoMod', emoji: ICONS.automod }),
    actionButton({ command: 'antiraid', action: 'go', args: ['home'], label: 'AntiRaid', emoji: '🚨' }),
    actionButton({ command: 'tickets', action: 'go', args: ['home'], label: 'Tickets', emoji: ICONS.ticket }),
    actionButton({ command: 'bienvenue', action: 'go', args: ['home'], label: 'Bienvenue', emoji: '👋' }),
    actionButton({ command: 'niveaux', action: 'go', args: ['home'], label: 'Niveaux', emoji: '📈' }),
  );
}

/**
 * Onglets : [⚙️ Vue d'ensemble | 🔄 Actualiser] [📋 Logs] [🛡️ Modération] — l'onglet courant est désactivé.
 * `primaryTab: false` quand la vue a sa propre action principale (une seule action Primary par message).
 */
function tabsFor(current, { primaryTab = true } = {}) {
  const style = (tab) => (current === tab && primaryTab ? ButtonStyle.Primary : ButtonStyle.Secondary);
  return buttonRows(
    current === 'view'
      ? actionButton({ command: 'settings', action: 'view', label: 'Actualiser', emoji: ICONS.refresh, style: ButtonStyle.Primary })
      : actionButton({ command: 'settings', action: 'view', label: 'Vue d\'ensemble', emoji: ICONS.settings }),
    actionButton({ command: 'settings', action: 'logs', label: 'Logs', emoji: ICONS.list, style: style('logs'), disabled: current === 'logs' }),
    actionButton({ command: 'settings', action: 'moderation', label: 'Modération', emoji: ICONS.moderator, style: style('moderation'), disabled: current === 'moderation' }),
  );
}

module.exports = {
  category: 'configuration',
  LOG_CATEGORIES,
  renderDashboard,
  renderModeration,
  parseThresholds,
  readModerationOptions,
  themeView,
  readProfileOptions,
  data: new SlashCommandBuilder()
    .setName('settings')
    .setDescription('Configure le bot pour ce serveur.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((s) => s.setName('view').setDescription('Affiche la configuration actuelle.'))
    .addSubcommand((s) =>
      s
        .setName('moderation')
        .setDescription('Règle les options de modération.')
        .addBooleanOption((o) => o.setName('dm_sanction').setDescription('Envoyer un DM au membre sanctionné.'))
        .addBooleanOption((o) => o.setName('confirmation').setDescription('Demander confirmation pour les actions dangereuses.'))
        .addBooleanOption((o) => o.setName('raison_obligatoire').setDescription('Exiger une raison pour chaque sanction.'))
        .addBooleanOption((o) => o.setName('strikes').setDescription('Activer l\'escalade automatique des sanctions par strikes.'))
        .addStringOption((o) => o.setName('paliers').setDescription('Paliers de strikes, ex : 3=mute 1h, 5=kick, 7=ban (ou « aucun »)').setMaxLength(300))
        .addIntegerOption((o) => o.setName('decroissance').setDescription('Les strikes de plus de N jours ne comptent plus (0 = jamais)').setMinValue(0).setMaxValue(MAX_DECAY_DAYS))
        .addRoleOption((o) => o.setName('role_muet').setDescription('Rôle utilisé par /mute (sinon un rôle « Muted » est créé).')),
    )
    .addSubcommand((s) =>
      s
        .setName('theme')
        .setDescription('Change la couleur des cartes du bot sur ce serveur.')
        .addStringOption((o) => o.setName('couleur').setDescription('#hex, rgb(r, v, b), un nom (rouge, bleu…) ou « défaut »').setRequired(true).setMaxLength(40)),
    )
    .addSubcommand((s) =>
      s
        .setName('profil')
        .setDescription('Pseudo, avatar, bannière et bio du bot sur ce serveur uniquement.')
        .addStringOption((o) => o.setName('pseudo').setDescription(`Pseudo du bot sur ce serveur (${MAX_NICK} caractères au plus)`).setMaxLength(MAX_NICK))
        .addAttachmentOption((o) => o.setName('avatar').setDescription('Avatar du bot sur ce serveur (PNG, JPEG, GIF, WebP, 8 Mo)'))
        .addAttachmentOption((o) => o.setName('banniere').setDescription('Bannière du bot sur ce serveur (PNG, JPEG, GIF, WebP, 8 Mo)'))
        .addStringOption((o) => o.setName('bio').setDescription(`Bio du bot sur ce serveur (${MAX_BIO} caractères au plus)`).setMaxLength(MAX_BIO))
        .addStringOption((o) =>
          o
            .setName('reinitialiser')
            .setDescription('Revenir au profil global pour un élément')
            .addChoices(
              { name: 'Pseudo', value: 'pseudo' },
              { name: 'Avatar', value: 'avatar' },
              { name: 'Bannière', value: 'banniere' },
              { name: 'Bio', value: 'bio' },
              { name: 'Tout', value: 'tout' },
            ),
        ),
    ),

  /** @param {import('discord.js').ChatInputCommandInteraction} interaction */
  async execute(interaction, client) {
    const sub = interaction.options.getSubcommand();
    const { config } = client.services;
    const guild = interaction.guild;

    if (sub === 'view') {
      return interaction.reply({ ...dashboardView(guild, config.get(guild.id)), ephemeral: true });
    }

    if (sub === 'moderation') {
      const { patch, edited } = readModerationOptions(interaction, client);
      if (!Object.keys(patch).length) {
        return interaction.reply({
          embeds: [status.warn('Aucune option fournie. Précisez au moins une option : `dm_sanction`, `confirmation`, `raison_obligatoire`, `strikes`, `paliers`, `decroissance` ou `role_muet`.', 'Rien à modifier')],
          components: buttonRows(actionButton({ command: 'settings', action: 'moderation', label: 'Voir les options', emoji: ICONS.moderator })),
          ephemeral: true,
        });
      }
      const cfg = config.update(guild.id, patch);
      return interaction.reply({ ...moderationUpdatedView(cfg, edited), ephemeral: true });
    }
    if (sub === 'theme') return runTheme(interaction, client);
    if (sub === 'profil') return runProfile(interaction, client);
    throw new UserError('Sous-commande inconnue.');
  },

  buttons: {
    /** cmd:settings:view — tableau de bord (actualise / revient à la vue d'ensemble). */
    async view(interaction, client) {
      assertManageGuild(interaction);
      await interaction.update(dashboardView(interaction.guild, client.services.config.get(interaction.guildId)));
    },
    /** cmd:settings:logs — détail des salons de logs. */
    async logs(interaction, client) {
      assertManageGuild(interaction);
      await interaction.update({
        embeds: [renderLogs(interaction.guild, client.services.config.get(interaction.guildId))],
        components: [
          ...tabsFor('logs', { primaryTab: false }),
          ...buttonRows(actionButton({ command: 'logs', action: 'go', args: ['home'], label: 'Configurer les logs', emoji: '📋', style: ButtonStyle.Primary })),
        ],
      });
    },
    /** cmd:settings:moderation — options de modération et paliers de strikes. */
    async moderation(interaction, client) {
      assertManageGuild(interaction);
      await interaction.update({ embeds: [renderModeration(client.services.config.get(interaction.guildId))], components: tabsFor('moderation') });
    },
  },
};
