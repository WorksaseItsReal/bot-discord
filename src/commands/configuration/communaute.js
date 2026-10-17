'use strict';

const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChannelType,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ChannelSelectMenuBuilder,
} = require('discord.js');
const { card, field, wide, ICONS, subtext, actionButton, buttonRows, ButtonStyle } = require('../../utils/ui');
const { truncate } = require('../../utils/embeds');
const { parseDuration } = require('../../utils/time');
const { fitList } = require('../../services/LoggingService');
const { requirePermission } = require('../../services/ModerationService');
const { parseEmoji, TRIGGER_MODES } = require('../../utils/community');
const {
  MAX_TRIGGERS,
  AUTO_REACT_MAX_CHANNELS,
  AUTO_REACT_MAX_EMOJIS,
  REACT_MODES,
  parseReactionEmojis,
} = require('../../services/AutoResponderService');
const { UserError } = require('../../core/errors');

/**
 * /communaute : tableau de bord unique du starboard et des réponses automatiques
 * (éphémère, « Gérer le serveur »). Les messages épinglés automatiquement ont leur
 * propre commande (/sticky, « Gérer les messages ») ; leur nombre est rappelé ici.
 * Vues : home · starboard · auto · trigger:<id> · confirmDel:<id> · react · rx:<salon>
 */

const SECTION = { emoji: '🌟', label: 'Communauté' };
const SNOWFLAKE = /^\d{17,20}$/;
const TRIGGER_ID = /^[a-z0-9]{4,12}$/;
const TEXT_TYPES = [ChannelType.GuildText, ChannelType.GuildAnnouncement];
const SOURCE_TYPES = [...TEXT_TYPES, ChannelType.GuildForum, ChannelType.GuildVoice, ChannelType.GuildStageVoice, ChannelType.GuildCategory];
const MAX_CHANNELS = 25;
const MAX_THRESHOLD = 100;
const MAX_PATTERN = 100;
const MIN_PATTERN = 2;
const MAX_RESPONSE = 1000;
const MAX_COOLDOWN_S = 3600;
const DEFAULT_COOLDOWN_S = 30;
const SEND_PERMS = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks];
/** Salons à réactions automatiques : textuels, annonces, forums (message d'ouverture des posts). */
const REACT_TYPES = [ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum];
const REACT_PERMS = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.AddReactions, PermissionFlagsBits.ReadMessageHistory];

const guard = (interaction) => requirePermission(interaction, 'ManageGuild');
const community = (client, guildId) => client.services.config.get(guildId).community ?? {};
const sbOf = (client, guildId) => community(client, guildId).starboard ?? {};
const arOf = (client, guildId) => community(client, guildId).autoResponses ?? {};
const rxOf = (client, guildId) => client.services.config.get(guildId).autoReact ?? {};
const row = (component) => new ActionRowBuilder().addComponents(component);
const homeButton = () => actionButton({ command: 'communaute', action: 'go', args: ['home'], label: 'Accueil', emoji: '🏠' });
/** Texte saisi affiché sans casser la mise en forme. */
const quote = (text, max = 200) => `\`${truncate(String(text ?? '').replace(/`/g, 'ˋ').replace(/\n/g, ' '), max)}\``;

const NAV = [
  { value: 'home', label: 'Accueil', emoji: '🏠', description: 'Vue d\'ensemble de la communauté' },
  { value: 'starboard', label: 'Starboard', emoji: '⭐', description: 'Reposter les messages les plus étoilés' },
  { value: 'auto', label: 'Réponses automatiques', emoji: '💬', description: 'Déclencheurs, réponses et réactions' },
  { value: 'react', label: 'Réactions automatiques', emoji: '😀', description: 'Réagir à chaque message de salons choisis' },
];

function navRow(current) {
  return row(
    new StringSelectMenuBuilder()
      .setCustomId('cmd:communaute:nav')
      .setPlaceholder('Aller à…')
      .addOptions(NAV.map((o) => ({ ...o, default: o.value === current }))),
  );
}

const input = (id, label, { value, placeholder, style = TextInputStyle.Short, max = 100, min, required = false } = {}) => {
  const t = new TextInputBuilder().setCustomId(id).setLabel(truncate(label, 45)).setStyle(style).setMaxLength(max).setRequired(required);
  if (min) t.setMinLength(min);
  if (value != null && String(value) !== '') t.setValue(String(value).slice(0, max));
  if (placeholder) t.setPlaceholder(placeholder.slice(0, 100));
  return row(t);
};

function textField(interaction, id) {
  try {
    const v = interaction.fields.getTextInputValue(id)?.trim();
    return v || undefined;
  } catch {
    return undefined;
  }
}

/** Valeur voulue par un bouton « on/off ». */
const target = (state) => {
  if (state !== 'on' && state !== 'off') throw new UserError('Ce bouton est invalide.');
  return state === 'on';
};

/** Délai saisi (« 30 », « 30s », « 5m ») en secondes, 0 à 1 h. Pur. */
function parseCooldown(raw) {
  const text = String(raw ?? '').trim().toLowerCase();
  if (!text) return DEFAULT_COOLDOWN_S;
  if (/^\d{1,4}$/.test(text)) {
    const n = Number(text);
    if (n <= MAX_COOLDOWN_S) return n;
  } else {
    const ms = parseDuration(text);
    if (ms != null && ms % 1000 === 0 && ms / 1000 <= MAX_COOLDOWN_S) return ms / 1000;
  }
  throw new UserError('Délai : entrez une durée entre 0 et 1 h (ex : `30`, `30s`, `5m`).');
}

/**
 * Déclencheur saisi : texte littéral (aucune expression régulière), 2 à 100 caractères. Pur.
 * Les caractères de contrôle et les retours à la ligne sont refusés.
 */
function parsePattern(raw) {
  const text = String(raw ?? '').trim().replace(/\s+/g, ' ');
  if (text.length < MIN_PATTERN || text.length > MAX_PATTERN) throw new UserError(`Déclencheur : de ${MIN_PATTERN} à ${MAX_PATTERN} caractères.`);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(text)) throw new UserError('Déclencheur : caractères invalides.');
  return text;
}

/** Nouvel identifiant de déclencheur (base 36, sûr dans un customId). */
function newTriggerId(existing) {
  const taken = new Set(existing.map((t) => t.id));
  let id;
  do id = Math.random().toString(36).slice(2, 8).padEnd(6, '0');
  while (taken.has(id));
  return id;
}

function findTrigger(client, guildId, id) {
  if (!TRIGGER_ID.test(id ?? '')) throw new UserError('Déclencheur invalide.');
  const trigger = (arOf(client, guildId).triggers ?? []).find((t) => t.id === id);
  if (!trigger) throw new UserError('Ce déclencheur n\'existe plus.');
  return trigger;
}

/** Remplace un déclencheur (ou le retire si `next` est null). */
function saveTrigger(client, guildId, id, next) {
  const triggers = arOf(client, guildId).triggers ?? [];
  const list = next ? triggers.map((t) => (t.id === id ? next : t)) : triggers.filter((t) => t.id !== id);
  client.services.config.update(guildId, { community: { autoResponses: { triggers: list } } });
}

/** Le bot peut-il écrire dans ce salon ? (null si oui, sinon un avertissement) */
function sendWarning(guild, channel) {
  const me = guild.members?.me;
  const perms = me && channel?.permissionsFor?.(me);
  if (perms && !perms.has(SEND_PERMS)) return `${ICONS.warning} Je ne peux pas écrire dans <#${channel.id}> : donnez-moi **Voir**, **Envoyer** et **Intégrer des liens**.`;
  return null;
}

const triggerLine = (t) => {
  const kinds = [t.response ? '💬' : null, t.reaction ? parseEmoji(t.reaction)?.text ?? '😀' : null].filter(Boolean).join(' ');
  return `${t.enabled === false ? '⏸️' : '🟢'} ${quote(t.pattern, 60)} · ${TRIGGER_MODES[t.mode] ?? t.mode} → ${kinds || '—'}`;
};

// ---------------------------------------------------------------- vues

function homeView(client, guild, notice) {
  const sb = sbOf(client, guild.id);
  const ar = arOf(client, guild.id);
  const triggers = ar.triggers ?? [];
  const stickies = client.services.sticky?.list(guild.id).length ?? 0;
  const starred = client.repositories.starboard?.count(guild.id) ?? 0;
  const rx = rxOf(client, guild.id);
  const rxCount = (rx.channels ?? []).length;
  const anyOn = sb.enabled || ar.enabled || rx.enabled;
  return {
    embeds: [
      card({
        tone: anyOn ? 'success' : 'neutral',
        section: SECTION,
        icon: '🌟',
        title: 'Communauté · Tableau de bord',
        description: [
          notice ? `${notice}\n` : null,
          `${sb.enabled ? '🟢' : '🔴'} **Starboard** ${sb.enabled ? 'actif' : 'désactivé'}${sb.enabled && !sb.channelId ? ` · ${ICONS.warning} *aucun salon choisi*` : ''}`,
          `${ar.enabled ? '🟢' : '🔴'} **Réponses automatiques** ${ar.enabled ? 'actives' : 'désactivées'}`,
          `${rx.enabled ? '🟢' : '🔴'} **Réactions automatiques** ${rx.enabled ? 'actives' : 'désactivées'}${rx.enabled && !rxCount ? ` · ${ICONS.warning} *aucun salon choisi*` : ''}`,
          '',
          subtext('Les messages épinglés automatiquement (réaffichés en bas d\'un salon) se gèrent avec /sticky.'),
        ],
        fields: [
          field(ICONS.star, 'Starboard', sb.channelId ? `<#${sb.channelId}>\n${sb.emoji || '⭐'} × ${sb.threshold ?? 3}` : '*Aucun salon*'),
          field('💬', 'Déclencheurs', `${triggers.filter((t) => t.enabled !== false).length} actif(s) / ${triggers.length}`),
          field(ICONS.status, 'Messages épinglés', `${stickies}`),
          field(ICONS.stats, 'Messages au starboard', `${starred}`),
          field(ICONS.emoji, 'Salons à réactions', `${rxCount} / ${AUTO_REACT_MAX_CHANNELS}`),
        ],
        footer: 'Choisissez une section dans le menu',
      }),
    ],
    components: [
      navRow('home'),
      ...buttonRows(
        sb.enabled
          ? actionButton({ command: 'communaute', action: 'sbtoggle', args: ['off', 'home'], label: 'Starboard ✅', emoji: ICONS.star })
          : actionButton({ command: 'communaute', action: 'sbtoggle', args: ['on', 'home'], label: 'Starboard ❌', emoji: ICONS.star }),
        ar.enabled
          ? actionButton({ command: 'communaute', action: 'artoggleall', args: ['off', 'home'], label: 'Réponses auto ✅', emoji: '💬' })
          : actionButton({ command: 'communaute', action: 'artoggleall', args: ['on', 'home'], label: 'Réponses auto ❌', emoji: '💬' }),
        rx.enabled
          ? actionButton({ command: 'communaute', action: 'rxtoggle', args: ['off', 'home'], label: 'Réactions auto ✅', emoji: ICONS.emoji })
          : actionButton({ command: 'communaute', action: 'rxtoggle', args: ['on', 'home'], label: 'Réactions auto ❌', emoji: ICONS.emoji }),
        actionButton({ command: 'communaute', action: 'go', args: ['home'], label: 'Actualiser', emoji: ICONS.refresh }),
      ),
    ],
  };
}

function starboardView(client, guild, notice) {
  const sb = sbOf(client, guild.id);
  const cache = guild.channels?.cache;
  const channelId = sb.channelId;
  const channel = channelId ? cache?.get(channelId) : null;
  const excluded = (sb.excludedChannels ?? []).filter((id) => !cache || SOURCE_TYPES.includes(cache.get(id)?.type)).slice(0, MAX_CHANNELS);
  const channelMenu = new ChannelSelectMenuBuilder()
    .setCustomId('cmd:communaute:sbchannel')
    .setPlaceholder('Salon du starboard…')
    .setChannelTypes(...TEXT_TYPES)
    .setMinValues(0)
    .setMaxValues(1);
  if (channel) channelMenu.setDefaultChannels(channelId);
  const exclMenu = new ChannelSelectMenuBuilder()
    .setCustomId('cmd:communaute:sbexcl')
    .setPlaceholder('Salons exclus (aucun)')
    .setChannelTypes(...SOURCE_TYPES)
    .setMinValues(0)
    .setMaxValues(MAX_CHANNELS);
  if (excluded.length) exclMenu.setDefaultChannels(...excluded);
  const warning = !channelId
    ? `${ICONS.warning} Choisissez un **salon** ci-dessous, sinon rien ne sera reposté.`
    : !channel
      ? `${ICONS.warning} Le salon du starboard n'existe plus : choisissez-en un autre.`
      : sendWarning(guild, channel);
  return {
    embeds: [
      card({
        tone: sb.enabled ? (warning ? 'warning' : 'success') : 'neutral',
        section: SECTION,
        icon: ICONS.star,
        title: 'Starboard',
        description: [
          notice ? `${notice}\n` : null,
          `Un message qui reçoit **${sb.threshold ?? 3}** réaction(s) ${sb.emoji || '⭐'} est reposté dans le salon du starboard, avec un compteur mis à jour en direct.`,
          subtext('Ne comptent pas : l\'auteur du message et les bots. Les messages d\'un salon NSFW ne sont repostés que si le starboard est lui aussi NSFW.'),
          subtext('Confidentialité : les fils privés ne sont jamais repostés, ni les salons qu\'un rôle voyant le starboard ne voit pas (salons du staff, tickets).'),
          warning ? `\n${warning}` : null,
        ],
        fields: [
          field(ICONS.status, 'Statut', sb.enabled ? '🟢 Actif' : '🔴 Désactivé'),
          field(ICONS.channel, 'Salon', channelId ? `<#${channelId}>` : '*Aucun*'),
          field(ICONS.emoji, 'Emoji · seuil', `${sb.emoji || '⭐'} × **${sb.threshold ?? 3}**`),
          field('📉', 'Sous le seuil', sb.removeBelow !== false ? 'Carte retirée' : 'Carte conservée'),
          field(ICONS.stats, 'Messages repostés', `${client.repositories.starboard?.count(guild.id) ?? 0}`),
          field('🚫', 'Salons exclus', fitList(excluded.map((id) => `<#${id}>`), 1000) ?? '*Aucun*'),
        ],
        footer: 'Exclure une catégorie exclut tous ses salons ; les fils suivent leur salon',
      }),
    ],
    components: [
      navRow('starboard'),
      row(channelMenu),
      row(exclMenu),
      ...buttonRows(
        sb.enabled
          ? actionButton({ command: 'communaute', action: 'sbtoggle', args: ['off', 'starboard'], label: 'Désactiver', emoji: '🔴', style: ButtonStyle.Danger })
          : actionButton({ command: 'communaute', action: 'sbtoggle', args: ['on', 'starboard'], label: 'Activer', emoji: '🟢', style: ButtonStyle.Success }),
        actionButton({ command: 'communaute', action: 'sbsettings', label: 'Emoji et seuil', emoji: ICONS.settings, style: ButtonStyle.Primary }),
        sb.removeBelow !== false
          ? actionButton({ command: 'communaute', action: 'sbremove', args: ['off'], label: 'Sous le seuil : retirer', emoji: '📉' })
          : actionButton({ command: 'communaute', action: 'sbremove', args: ['on'], label: 'Sous le seuil : garder', emoji: '📌' }),
        homeButton(),
      ),
    ],
  };
}

function autoView(client, guild, notice) {
  const ar = arOf(client, guild.id);
  const triggers = ar.triggers ?? [];
  const components = [navRow('auto')];
  if (triggers.length) {
    components.push(row(
      new StringSelectMenuBuilder()
        .setCustomId('cmd:communaute:arpick')
        .setPlaceholder('Modifier un déclencheur…')
        .addOptions(triggers.slice(0, MAX_TRIGGERS).map((t) => ({
          value: t.id,
          label: truncate(t.pattern, 100),
          description: truncate(`${TRIGGER_MODES[t.mode] ?? t.mode}${t.enabled === false ? ' · en pause' : ''}`, 100),
          emoji: t.enabled === false ? '⏸️' : '💬',
        }))),
    ));
  }
  components.push(...buttonRows(
    actionButton({ command: 'communaute', action: 'aradd', label: 'Ajouter', emoji: '➕', style: ButtonStyle.Primary, disabled: triggers.length >= MAX_TRIGGERS }),
    ar.enabled
      ? actionButton({ command: 'communaute', action: 'artoggleall', args: ['off', 'auto'], label: 'Désactiver', emoji: '🔴', style: ButtonStyle.Danger })
      : actionButton({ command: 'communaute', action: 'artoggleall', args: ['on', 'auto'], label: 'Activer', emoji: '🟢', style: ButtonStyle.Success }),
    homeButton(),
  ));
  const lines = triggers.map(triggerLine);
  return {
    embeds: [
      card({
        tone: ar.enabled ? 'success' : 'neutral',
        section: SECTION,
        icon: '💬',
        title: 'Réponses automatiques',
        description: [
          notice ? `${notice}\n` : null,
          ar.enabled ? '🟢 Les réponses automatiques sont **actives**.' : '🔴 Les réponses automatiques sont **désactivées**.',
          subtext('Modes sûrs uniquement (mot entier, contient, commence par, message exact) : pas d\'expression régulière. Majuscules et accents ignorés. Les bots et les messages supprimés par l\'AutoMod sont ignorés ; aucune mention ne notifie.'),
          '',
          lines.length ? truncate(lines.join('\n'), 3000) : '*Aucun déclencheur pour l\'instant : cliquez sur « Ajouter ».*',
        ],
        fields: [field(ICONS.count, 'Déclencheurs', `${triggers.length} / ${MAX_TRIGGERS}`)],
        footer: 'Variables : {membre} (mention, sans notification) et {serveur}',
      }),
    ],
    components,
  };
}

function triggerView(client, guild, id, notice) {
  const t = findTrigger(client, guild.id, id);
  const cache = guild.channels?.cache;
  const known = (ids) => (ids ?? []).filter((c) => !cache || SOURCE_TYPES.includes(cache.get(c)?.type)).slice(0, MAX_CHANNELS);
  const allowed = known(t.channels);
  const excluded = known(t.excludedChannels);
  const allowMenu = new ChannelSelectMenuBuilder()
    .setCustomId(`cmd:communaute:archan:${t.id}`)
    .setPlaceholder('Salons autorisés (tous)')
    .setChannelTypes(...SOURCE_TYPES)
    .setMinValues(0)
    .setMaxValues(MAX_CHANNELS);
  if (allowed.length) allowMenu.setDefaultChannels(...allowed);
  const exclMenu = new ChannelSelectMenuBuilder()
    .setCustomId(`cmd:communaute:arexcl:${t.id}`)
    .setPlaceholder('Salons exclus (aucun)')
    .setChannelTypes(...SOURCE_TYPES)
    .setMinValues(0)
    .setMaxValues(MAX_CHANNELS);
  if (excluded.length) exclMenu.setDefaultChannels(...excluded);
  const on = t.enabled !== false;
  return {
    embeds: [
      card({
        tone: on ? 'info' : 'neutral',
        section: SECTION,
        icon: '💬',
        title: 'Déclencheur',
        description: [
          notice ? `${notice}\n` : null,
          `${on ? '🟢 Actif' : '⏸️ En pause'} · ${quote(t.pattern, 100)}`,
        ],
        fields: [
          field(ICONS.search, 'Mode', TRIGGER_MODES[t.mode] ?? t.mode),
          field(ICONS.duration, 'Délai par salon', t.cooldownSeconds ? `${t.cooldownSeconds} s` : 'Aucun'),
          field(ICONS.emoji, 'Réaction', t.reaction ? parseEmoji(t.reaction)?.text ?? '—' : '*Aucune*'),
          field(ICONS.channel, 'Salons autorisés', fitList(allowed.map((c) => `<#${c}>`), 1000) ?? 'Tous'),
          field('🚫', 'Salons exclus', fitList(excluded.map((c) => `<#${c}>`), 1000) ?? '*Aucun*'),
          wide('📝', 'Réponse', t.response ? `\`\`\`\n${truncate(String(t.response).replace(/`/g, 'ˋ'), 900)}\n\`\`\`` : '*Aucune (réaction seulement)*'),
        ],
        footer: `Déclencheur ${t.id}`,
      }),
    ],
    components: [
      row(
        new StringSelectMenuBuilder()
          .setCustomId(`cmd:communaute:armode:${t.id}`)
          .setPlaceholder('Mode de déclenchement')
          .addOptions(Object.entries(TRIGGER_MODES).map(([value, label]) => ({ value, label, default: value === t.mode }))),
      ),
      row(allowMenu),
      row(exclMenu),
      ...buttonRows(
        actionButton({ command: 'communaute', action: 'aredit', args: [t.id], label: 'Modifier', emoji: '📝', style: ButtonStyle.Primary }),
        on
          ? actionButton({ command: 'communaute', action: 'artoggle', args: [t.id, 'off'], label: 'Mettre en pause', emoji: '⏸️' })
          : actionButton({ command: 'communaute', action: 'artoggle', args: [t.id, 'on'], label: 'Réactiver', emoji: '▶️', style: ButtonStyle.Success }),
        actionButton({ command: 'communaute', action: 'go', args: [`confirmDel.${t.id}`], label: 'Supprimer', emoji: ICONS.delete, style: ButtonStyle.Danger }),
        actionButton({ command: 'communaute', action: 'go', args: ['auto'], label: 'Retour', emoji: ICONS.back }),
      ),
    ],
  };
}

function confirmDeleteView(client, guild, id) {
  const t = findTrigger(client, guild.id, id);
  return {
    embeds: [
      card({
        tone: 'danger',
        section: SECTION,
        icon: ICONS.warning,
        title: 'Supprimer ce déclencheur ?',
        description: [`Le déclencheur ${quote(t.pattern, 100)} et sa réponse seront **définitivement supprimés**.`],
      }),
    ],
    components: buttonRows(
      actionButton({ command: 'communaute', action: 'ardelete', args: [t.id], label: 'Oui, supprimer', emoji: ICONS.delete, style: ButtonStyle.Danger }),
      actionButton({ command: 'communaute', action: 'go', args: [`trigger.${t.id}`], label: 'Annuler', emoji: ICONS.back }),
    ),
  };
}

// ---------------------------------------------------------------- réactions automatiques

/** Emoji lisible dans un libellé de menu (les emojis personnalisés n'y sont pas rendus). */
const emojiLabel = (text) => {
  const e = parseEmoji(text);
  return e?.id ? `:${e.name}:` : e?.text ?? String(text ?? '');
};

/** Même emoji (variante U+FE0F ignorée) ? */
function sameEmoji(a, b) {
  const x = parseEmoji(a);
  const y = parseEmoji(b);
  if (!x || !y) return false;
  if (x.id || y.id) return x.id === y.id;
  return x.name.replace(/\uFE0F/g, '') === y.name.replace(/\uFE0F/g, '');
}

function findReactEntry(client, guildId, channelId) {
  if (!SNOWFLAKE.test(channelId ?? '')) throw new UserError('Salon invalide.');
  const entry = (rxOf(client, guildId).channels ?? []).find((e) => e.channelId === channelId);
  if (!entry) throw new UserError('Ce salon n\'a plus de réactions automatiques.');
  return entry;
}

/** Remplace (ou retire si `next` est null) le réglage d'un salon. */
function saveReactEntry(client, guildId, channelId, next) {
  const list = rxOf(client, guildId).channels ?? [];
  const channels = next
    ? (list.some((e) => e.channelId === channelId) ? list.map((e) => (e.channelId === channelId ? next : e)) : [...list, next])
    : list.filter((e) => e.channelId !== channelId);
  client.services.config.update(guildId, { autoReact: { channels } });
}

/** Problèmes d'un salon à réactions : salon disparu, permissions du bot, emoji du starboard. */
function reactIssues(client, guild, entry) {
  const issues = [];
  const channel = guild.channels?.cache?.get(entry.channelId);
  if (guild.channels?.cache && !channel) issues.push('salon introuvable');
  const me = guild.members?.me;
  const perms = channel && me ? channel.permissionsFor?.(me) : null;
  if (perms && !perms.has(REACT_PERMS)) issues.push('il me manque **Voir le salon**, **Ajouter des réactions** ou **Lire l\'historique**');
  const sb = sbOf(client, guild.id);
  const star = sb.emoji || '⭐';
  if (sb.enabled && (entry.emojis ?? []).some((e) => sameEmoji(e, star))) issues.push(`${star} est aussi l'emoji du starboard : un clic des membres le ferait monter au starboard`);
  for (const text of entry.emojis ?? []) {
    const e = parseEmoji(text);
    if (e?.id && guild.emojis?.cache && !guild.emojis.cache.has(e.id)) issues.push(`l'emoji \`:${e.name}:\` n'existe plus`);
  }
  return issues;
}

const isForum = (guild, channelId) => guild.channels?.cache?.get(channelId)?.type === ChannelType.GuildForum;

function reactLine(client, guild, entry) {
  const forum = isForum(guild, entry.channelId);
  const scope = forum ? 'ouverture des posts' : entry.threads ? 'salon et fils' : 'salon';
  const issues = reactIssues(client, guild, entry);
  return `${issues.length ? ICONS.warning : '🟢'} <#${entry.channelId}> · ${(entry.emojis ?? []).join(' ') || '—'} · ${REACT_MODES[entry.mode] ?? REACT_MODES.all} · ${scope}`;
}

function reactView(client, guild, notice) {
  const rx = rxOf(client, guild.id);
  const entries = (rx.channels ?? []).slice(0, AUTO_REACT_MAX_CHANNELS);
  const stats = client.services.autoResponses?.reactionStats?.(guild.id) ?? { pending: 0, dropped: 0 };
  const warnings = entries.flatMap((e) => reactIssues(client, guild, e).map((issue) => `<#${e.channelId}> : ${issue}`));
  const components = [navRow('react')];
  if (entries.length) {
    components.push(row(
      new StringSelectMenuBuilder()
        .setCustomId('cmd:communaute:rxpick')
        .setPlaceholder('Modifier un salon…')
        .addOptions(entries.map((e) => ({
          value: e.channelId,
          label: truncate(`#${guild.channels?.cache?.get(e.channelId)?.name ?? 'salon supprimé'}`, 100),
          description: truncate(`${(e.emojis ?? []).map(emojiLabel).join(' ')} · ${REACT_MODES[e.mode] ?? REACT_MODES.all}`, 100),
          emoji: ICONS.emoji,
        }))),
    ));
  }
  const full = entries.length >= AUTO_REACT_MAX_CHANNELS;
  components.push(row(
    new ChannelSelectMenuBuilder()
      .setCustomId('cmd:communaute:rxadd')
      .setPlaceholder(full ? `${AUTO_REACT_MAX_CHANNELS} salons au plus : retirez-en un` : 'Ajouter un salon…')
      .setChannelTypes(...REACT_TYPES)
      .setMinValues(1)
      .setMaxValues(1)
      .setDisabled(full),
  ));
  components.push(...buttonRows(
    rx.enabled
      ? actionButton({ command: 'communaute', action: 'rxtoggle', args: ['off', 'react'], label: 'Désactiver', emoji: '🔴', style: ButtonStyle.Danger })
      : actionButton({ command: 'communaute', action: 'rxtoggle', args: ['on', 'react'], label: 'Activer', emoji: '🟢', style: ButtonStyle.Success }),
    actionButton({ command: 'communaute', action: 'go', args: ['react'], label: 'Actualiser', emoji: ICONS.refresh }),
    homeButton(),
  ));
  return {
    embeds: [
      card({
        tone: rx.enabled ? (warnings.length ? 'warning' : 'success') : 'neutral',
        section: SECTION,
        icon: ICONS.emoji,
        title: 'Réactions automatiques',
        description: [
          notice ? `${notice}\n` : null,
          rx.enabled ? '🟢 Les réactions automatiques sont **actives**.' : '🔴 Les réactions automatiques sont **désactivées**.',
          `Chaque nouveau message des salons choisis reçoit de **1 à ${AUTO_REACT_MAX_EMOJIS}** réactions, dans l'ordre (idéal pour les salons de suggestions, de mèmes ou de présentations). Dans un forum : le message d'ouverture de chaque post.`,
          subtext('Bots, webhooks et messages système ignorés. Délai de 1,5 s : un message supprimé par l\'AutoMod ne reçoit rien. Indépendant des réponses automatiques : un message peut recevoir les deux.'),
          '',
          entries.length ? truncate(entries.map((e) => reactLine(client, guild, e)).join('\n'), 2500) : '*Aucun salon pour l\'instant : choisissez-en un ci-dessous.*',
          warnings.length ? `\n${ICONS.warning} **À corriger**\n${truncate(warnings.join('\n'), 900)}` : null,
          rx.enabled && !entries.length ? `\n${ICONS.warning} Choisissez au moins un **salon** ci-dessous.` : null,
        ],
        fields: [
          field(ICONS.count, 'Salons', `${entries.length} / ${AUTO_REACT_MAX_CHANNELS}`),
          field(ICONS.loading, 'En attente', `${stats.pending}`),
          field('🚫', 'Abandonnées', stats.dropped ? `${stats.dropped} (file pleine)` : 'Aucune'),
        ],
        footer: 'Emojis Unicode ou de ce serveur · 20 messages en attente au plus par salon',
      }),
    ],
    components,
  };
}

function reactChannelView(client, guild, channelId, notice) {
  const entry = findReactEntry(client, guild.id, channelId);
  const channel = guild.channels?.cache?.get(channelId);
  const forum = channel?.type === ChannelType.GuildForum;
  const issues = reactIssues(client, guild, entry);
  const mode = Object.hasOwn(REACT_MODES, entry.mode ?? '') ? entry.mode : 'all';
  return {
    embeds: [
      card({
        tone: issues.length ? 'warning' : 'info',
        section: SECTION,
        icon: ICONS.emoji,
        title: `Réactions · #${truncate(channel?.name ?? 'salon supprimé', 80)}`,
        description: [
          notice ? `${notice}\n` : null,
          forum ? `Le message d'ouverture de chaque post de <#${channelId}> reçoit ces réactions.` : `Chaque nouveau message de <#${channelId}> reçoit ces réactions${entry.threads ? ', y compris dans ses fils' : ''}.`,
          issues.length ? `\n${ICONS.warning} ${issues.join('\n')}` : null,
        ],
        fields: [
          field(ICONS.channel, 'Salon', `<#${channelId}>`),
          field(ICONS.emoji, 'Réactions', (entry.emojis ?? []).join(' ') || '—'),
          field(ICONS.search, 'Messages', REACT_MODES[mode]),
          field('🧵', 'Fils', forum ? 'Ouverture des posts' : entry.threads ? '✅ Inclus' : '❌ Exclus'),
        ],
        footer: `Salon ${channelId}`,
      }),
    ],
    components: [
      navRow('react'),
      row(
        new StringSelectMenuBuilder()
          .setCustomId(`cmd:communaute:rxmode:${channelId}`)
          .setPlaceholder('Messages concernés')
          .addOptions(Object.entries(REACT_MODES).map(([value, label]) => ({ value, label, default: value === mode }))),
      ),
      ...buttonRows(
        actionButton({ command: 'communaute', action: 'rxemojis', args: [channelId], label: 'Emojis', emoji: ICONS.emoji, style: ButtonStyle.Primary }),
        forum ? null : actionButton({ command: 'communaute', action: 'rxthreads', args: [channelId, entry.threads ? 'off' : 'on'], label: entry.threads ? 'Fils ✅' : 'Fils ❌', emoji: '🧵' }),
        actionButton({ command: 'communaute', action: 'rxdel', args: [channelId], label: 'Retirer', emoji: ICONS.delete, style: ButtonStyle.Danger }),
        actionButton({ command: 'communaute', action: 'go', args: ['react'], label: 'Retour', emoji: ICONS.back }),
      ),
    ],
  };
}

function reactModal(channelId, entry) {
  return new ModalBuilder()
    .setCustomId(`cmd:communaute:rxsubmit:${channelId}`)
    .setTitle('Réactions automatiques')
    .addComponents(
      input('emojis', `Emojis (1 à ${AUTO_REACT_MAX_EMOJIS}, séparés par des espaces)`, {
        value: entry?.emojis?.join(' '),
        max: 200,
        required: true,
        placeholder: '👍 👎 ou :nom: / <:nom:id> (emojis de ce serveur)',
      }),
    );
}

/** Rend une vue (« trigger:<id> » depuis un menu, « trigger.<id> » depuis un bouton). */
function render(client, guild, view = 'home', notice) {
  const [name, arg] = String(view).split(/[:.]/);
  switch (name) {
    case 'starboard':
      return starboardView(client, guild, notice);
    case 'auto':
      return autoView(client, guild, notice);
    case 'trigger':
      return triggerView(client, guild, arg, notice);
    case 'confirmDel':
      return confirmDeleteView(client, guild, arg);
    case 'react':
      return reactView(client, guild, notice);
    case 'rx':
      return reactChannelView(client, guild, arg, notice);
    default:
      return homeView(client, guild, notice);
  }
}

// ---------------------------------------------------------------- formulaires

function starboardModal(sb) {
  return new ModalBuilder()
    .setCustomId('cmd:communaute:sbsubmit')
    .setTitle('Starboard : emoji et seuil')
    .addComponents(
      input('emoji', 'Emoji (Unicode ou <:nom:id>)', { value: sb.emoji || '⭐', max: 64, required: true, placeholder: '⭐' }),
      input('threshold', `Seuil : réactions nécessaires (1 à ${MAX_THRESHOLD})`, { value: sb.threshold ?? 3, max: 3, required: true, placeholder: '3' }),
    );
}

function triggerModal(trigger) {
  return new ModalBuilder()
    .setCustomId(trigger ? `cmd:communaute:arsubmit:${trigger.id}` : 'cmd:communaute:arsubmit')
    .setTitle(trigger ? 'Modifier le déclencheur' : 'Nouveau déclencheur')
    .addComponents(
      input('pattern', 'Déclencheur (mot ou expression)', { value: trigger?.pattern, min: MIN_PATTERN, max: MAX_PATTERN, required: true, placeholder: 'bonjour' }),
      input('response', 'Réponse ({membre}, {serveur})', { value: trigger?.response, style: TextInputStyle.Paragraph, max: MAX_RESPONSE, placeholder: 'Bienvenue {membre} sur {serveur} !' }),
      input('reaction', 'Réaction (emoji, facultatif)', { value: trigger?.reaction, max: 64, placeholder: '👋' }),
      input('cooldown', 'Délai par salon (ex : 30s, 5m ; 0 = aucun)', { value: trigger ? `${trigger.cooldownSeconds ?? DEFAULT_COOLDOWN_S}s` : `${DEFAULT_COOLDOWN_S}s`, max: 10, placeholder: '30s' }),
    );
}

/** Lit et valide un sélecteur de salons (remplace la liste). */
function pickChannels(interaction) {
  const cache = interaction.guild.channels.cache;
  return (interaction.values ?? []).filter((id) => SNOWFLAKE.test(id) && SOURCE_TYPES.includes(cache.get(id)?.type)).slice(0, MAX_CHANNELS);
}

// ---------------------------------------------------------------- commande

module.exports = {
  category: 'configuration',
  cooldown: 3_000,
  render,
  parseCooldown,
  parsePattern,
  data: new SlashCommandBuilder()
    .setName('communaute')
    .setDescription('Ouvre le tableau de bord communauté : starboard, réponses et réactions automatiques.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction, client) {
    guard(interaction);
    await interaction.reply({ ...render(client, interaction.guild, 'home'), ephemeral: true });
  },

  buttons: {
    /** Menu de navigation. */
    async nav(interaction, client) {
      guard(interaction);
      await interaction.update(render(client, interaction.guild, interaction.values?.[0] ?? 'home'));
    },
    /** cmd:communaute:go:<vue> */
    async go(interaction, client, [view]) {
      guard(interaction);
      await interaction.update(render(client, interaction.guild, view ?? 'home'));
    },

    // ------------------------------------------------------------ starboard

    /** cmd:communaute:sbtoggle:<on|off>:<vue> */
    async sbtoggle(interaction, client, [state, view]) {
      guard(interaction);
      const enabled = target(state);
      client.services.config.update(interaction.guildId, { community: { starboard: { enabled } } });
      const back = view === 'starboard' ? 'starboard' : 'home';
      await interaction.update(render(client, interaction.guild, back, `${ICONS.success} Starboard **${enabled ? 'activé' : 'désactivé'}**.`));
    },
    /** Salon du starboard. */
    async sbchannel(interaction, client) {
      guard(interaction);
      const id = interaction.values?.[0] ?? null;
      let notice = `${ICONS.success} Salon du starboard retiré.`;
      if (id) {
        if (!SNOWFLAKE.test(id)) throw new UserError('Salon invalide.');
        const ch = interaction.guild.channels.cache.get(id);
        if (!ch || !TEXT_TYPES.includes(ch.type)) throw new UserError('Choisissez un salon textuel du serveur.');
        notice = sendWarning(interaction.guild, ch) ?? `${ICONS.success} Starboard dans <#${id}>${ch.nsfw ? ' (NSFW : les messages des salons NSFW y sont acceptés)' : ''}.`;
      }
      client.services.config.update(interaction.guildId, { community: { starboard: { channelId: id } } });
      await interaction.update(starboardView(client, interaction.guild, notice));
    },
    /** Salons exclus du starboard (remplace la liste). */
    async sbexcl(interaction, client) {
      guard(interaction);
      const ids = pickChannels(interaction);
      client.services.config.update(interaction.guildId, { community: { starboard: { excludedChannels: ids } } });
      await interaction.update(starboardView(client, interaction.guild, `${ICONS.success} ${ids.length} salon(s) exclu(s).`));
    },
    /** cmd:communaute:sbremove:<on|off> — retirer la carte sous le seuil. */
    async sbremove(interaction, client, [state]) {
      guard(interaction);
      const removeBelow = target(state);
      client.services.config.update(interaction.guildId, { community: { starboard: { removeBelow } } });
      await interaction.update(starboardView(client, interaction.guild, `${ICONS.success} Sous le seuil, la carte sera **${removeBelow ? 'retirée' : 'conservée'}**.`));
    },
    /** Formulaire emoji + seuil. */
    async sbsettings(interaction, client) {
      guard(interaction);
      await interaction.showModal(starboardModal(sbOf(client, interaction.guildId)));
    },
    async sbsubmit(interaction, client) {
      guard(interaction);
      const emoji = parseEmoji(textField(interaction, 'emoji') ?? '⭐');
      if (!emoji) throw new UserError('Emoji invalide : entrez un seul emoji Unicode (⭐) ou personnalisé (`<:nom:id>`).');
      if (emoji.id && !interaction.guild.emojis?.cache?.has(emoji.id)) throw new UserError('Cet emoji personnalisé n\'appartient pas à ce serveur.');
      const raw = textField(interaction, 'threshold') ?? '3';
      const threshold = Number(raw.replace(/\s/g, ''));
      if (!Number.isInteger(threshold) || threshold < 1 || threshold > MAX_THRESHOLD) throw new UserError(`Seuil : entrez un nombre entier entre 1 et ${MAX_THRESHOLD}.`);
      client.services.config.update(interaction.guildId, { community: { starboard: { emoji: emoji.text, threshold } } });
      await interaction.update(starboardView(client, interaction.guild, `${ICONS.success} ${emoji.text} × **${threshold}** pour entrer au starboard.`));
    },

    // ------------------------------------------------------------ réponses automatiques

    /** cmd:communaute:artoggleall:<on|off>:<vue> */
    async artoggleall(interaction, client, [state, view]) {
      guard(interaction);
      const enabled = target(state);
      client.services.config.update(interaction.guildId, { community: { autoResponses: { enabled } } });
      const back = view === 'auto' ? 'auto' : 'home';
      await interaction.update(render(client, interaction.guild, back, `${ICONS.success} Réponses automatiques **${enabled ? 'activées' : 'désactivées'}**.`));
    },
    /** Menu « Modifier un déclencheur ». */
    async arpick(interaction, client) {
      guard(interaction);
      await interaction.update(triggerView(client, interaction.guild, interaction.values?.[0]));
    },
    /** Nouveau déclencheur : formulaire. */
    async aradd(interaction, client) {
      guard(interaction);
      if ((arOf(client, interaction.guildId).triggers ?? []).length >= MAX_TRIGGERS) throw new UserError(`${MAX_TRIGGERS} déclencheurs maximum : supprimez-en un d'abord.`);
      await interaction.showModal(triggerModal(null));
    },
    /** cmd:communaute:aredit:<id> */
    async aredit(interaction, client, [id]) {
      guard(interaction);
      await interaction.showModal(triggerModal(findTrigger(client, interaction.guildId, id)));
    },
    /** cmd:communaute:arsubmit[:<id>] — création ou modification. */
    async arsubmit(interaction, client, [id]) {
      guard(interaction);
      const triggers = arOf(client, interaction.guildId).triggers ?? [];
      const current = id ? findTrigger(client, interaction.guildId, id) : null;
      if (!current && triggers.length >= MAX_TRIGGERS) throw new UserError(`${MAX_TRIGGERS} déclencheurs maximum : supprimez-en un d'abord.`);
      const pattern = parsePattern(textField(interaction, 'pattern'));
      const response = textField(interaction, 'response') ?? null;
      if (response && response.length > MAX_RESPONSE) throw new UserError(`La réponse est limitée à ${MAX_RESPONSE} caractères.`);
      const reactionRaw = textField(interaction, 'reaction');
      const reaction = reactionRaw ? parseEmoji(reactionRaw) : null;
      if (reactionRaw && !reaction) throw new UserError('Réaction : entrez un seul emoji Unicode (👋) ou personnalisé (`<:nom:id>`).');
      if (reaction?.id && !interaction.guild.emojis?.cache?.has(reaction.id)) throw new UserError('Réaction : cet emoji personnalisé n\'appartient pas à ce serveur.');
      if (!response && !reaction) throw new UserError('Indiquez une réponse, une réaction, ou les deux.');
      const cooldownSeconds = parseCooldown(textField(interaction, 'cooldown'));
      const duplicate = triggers.find((t) => t.id !== current?.id && t.pattern.toLowerCase() === pattern.toLowerCase());
      if (duplicate) throw new UserError(`Le déclencheur ${quote(pattern, 60)} existe déjà.`);
      const next = {
        id: current?.id ?? newTriggerId(triggers),
        pattern,
        mode: current?.mode ?? 'word',
        response,
        reaction: reaction?.text ?? null,
        cooldownSeconds,
        channels: current?.channels ?? [],
        excludedChannels: current?.excludedChannels ?? [],
        enabled: current?.enabled ?? true,
      };
      const list = current ? triggers.map((t) => (t.id === current.id ? next : t)) : [...triggers, next];
      client.services.config.update(interaction.guildId, { community: { autoResponses: { triggers: list } } });
      const enabledHint = arOf(client, interaction.guildId).enabled ? '' : `\n${ICONS.warning} Les réponses automatiques sont désactivées : activez-les depuis la liste.`;
      await interaction.update(triggerView(client, interaction.guild, next.id, `${ICONS.success} Déclencheur ${current ? 'modifié' : 'ajouté'}.${enabledHint}`));
    },
    /** cmd:communaute:armode:<id> — mode de déclenchement. */
    async armode(interaction, client, [id]) {
      guard(interaction);
      const t = findTrigger(client, interaction.guildId, id);
      const mode = interaction.values?.[0];
      if (!Object.hasOwn(TRIGGER_MODES, mode ?? '')) throw new UserError('Mode inconnu.');
      saveTrigger(client, interaction.guildId, t.id, { ...t, mode });
      await interaction.update(triggerView(client, interaction.guild, t.id, `${ICONS.success} Mode : **${TRIGGER_MODES[mode]}**.`));
    },
    /** cmd:communaute:archan:<id> — salons autorisés (vide = tous). */
    async archan(interaction, client, [id]) {
      guard(interaction);
      const t = findTrigger(client, interaction.guildId, id);
      const channels = pickChannels(interaction);
      saveTrigger(client, interaction.guildId, t.id, { ...t, channels });
      await interaction.update(triggerView(client, interaction.guild, t.id, `${ICONS.success} ${channels.length ? `${channels.length} salon(s) autorisé(s)` : 'Autorisé dans tous les salons'}.`));
    },
    /** cmd:communaute:arexcl:<id> — salons exclus. */
    async arexcl(interaction, client, [id]) {
      guard(interaction);
      const t = findTrigger(client, interaction.guildId, id);
      const excludedChannels = pickChannels(interaction);
      saveTrigger(client, interaction.guildId, t.id, { ...t, excludedChannels });
      await interaction.update(triggerView(client, interaction.guild, t.id, `${ICONS.success} ${excludedChannels.length} salon(s) exclu(s).`));
    },
    /** cmd:communaute:artoggle:<id>:<on|off> */
    async artoggle(interaction, client, [id, state]) {
      guard(interaction);
      const t = findTrigger(client, interaction.guildId, id);
      const enabled = target(state);
      saveTrigger(client, interaction.guildId, t.id, { ...t, enabled });
      await interaction.update(triggerView(client, interaction.guild, t.id, `${ICONS.success} Déclencheur **${enabled ? 'réactivé' : 'mis en pause'}**.`));
    },
    /** cmd:communaute:ardelete:<id> — après confirmation. */
    async ardelete(interaction, client, [id]) {
      guard(interaction);
      const t = findTrigger(client, interaction.guildId, id);
      saveTrigger(client, interaction.guildId, t.id, null);
      await interaction.update(autoView(client, interaction.guild, `${ICONS.success} Déclencheur ${quote(t.pattern, 60)} supprimé.`));
    },

    // ------------------------------------------------------------ réactions automatiques

    /** cmd:communaute:rxtoggle:<on|off>:<vue> */
    async rxtoggle(interaction, client, [state, view]) {
      guard(interaction);
      const enabled = target(state);
      client.services.config.update(interaction.guildId, { autoReact: { enabled } });
      const back = view === 'react' ? 'react' : 'home';
      const empty = enabled && !(rxOf(client, interaction.guildId).channels ?? []).length ? `\n${ICONS.warning} Aucun salon choisi : ajoutez-en un dans « Réactions automatiques ».` : '';
      await interaction.update(render(client, interaction.guild, back, `${ICONS.success} Réactions automatiques **${enabled ? 'activées' : 'désactivées'}**.${empty}`));
    },
    /** Menu « Modifier un salon ». */
    async rxpick(interaction, client) {
      guard(interaction);
      await interaction.update(reactChannelView(client, interaction.guild, interaction.values?.[0]));
    },
    /** Sélecteur « Ajouter un salon » : réglage existant affiché, sinon formulaire des emojis. */
    async rxadd(interaction, client) {
      guard(interaction);
      const id = interaction.values?.[0];
      if (!SNOWFLAKE.test(id ?? '')) throw new UserError('Salon invalide.');
      const channel = interaction.guild.channels.cache.get(id);
      if (!channel || !REACT_TYPES.includes(channel.type)) throw new UserError('Choisissez un salon textuel, d\'annonces ou un forum du serveur.');
      const perms = interaction.member && typeof channel.permissionsFor === 'function' ? channel.permissionsFor(interaction.member) : null;
      if (perms && !perms.has(PermissionFlagsBits.ViewChannel)) throw new UserError(`Vous ne voyez pas <#${id}> : choisissez un salon auquel vous avez accès.`);
      const list = rxOf(client, interaction.guildId).channels ?? [];
      if (list.some((e) => e.channelId === id)) {
        await interaction.update(reactChannelView(client, interaction.guild, id, `${ICONS.info} Ce salon a déjà des réactions automatiques.`));
        return;
      }
      if (list.length >= AUTO_REACT_MAX_CHANNELS) throw new UserError(`${AUTO_REACT_MAX_CHANNELS} salons au plus : retirez-en un d'abord.`);
      await interaction.showModal(reactModal(id, null));
    },
    /** cmd:communaute:rxemojis:<salon> — formulaire des emojis. */
    async rxemojis(interaction, client, [channelId]) {
      guard(interaction);
      await interaction.showModal(reactModal(channelId, findReactEntry(client, interaction.guildId, channelId)));
    },
    /** cmd:communaute:rxsubmit:<salon> — création ou modification des emojis d'un salon. */
    async rxsubmit(interaction, client, [channelId]) {
      guard(interaction);
      if (!SNOWFLAKE.test(channelId ?? '')) throw new UserError('Salon invalide.');
      const channel = interaction.guild.channels.cache.get(channelId);
      if (!channel || !REACT_TYPES.includes(channel.type)) throw new UserError('Ce salon n\'existe plus.');
      const parsed = parseReactionEmojis(textField(interaction, 'emojis'), interaction.guild);
      if (parsed.error) throw new UserError(parsed.error);
      const list = rxOf(client, interaction.guildId).channels ?? [];
      const current = list.find((e) => e.channelId === channelId);
      if (!current && list.length >= AUTO_REACT_MAX_CHANNELS) throw new UserError(`${AUTO_REACT_MAX_CHANNELS} salons au plus : retirez-en un d'abord.`);
      const next = current ? { ...current, emojis: parsed.emojis } : { channelId, emojis: parsed.emojis, mode: 'all', threads: false };
      saveReactEntry(client, interaction.guildId, channelId, next);
      const hint = rxOf(client, interaction.guildId).enabled ? '' : `\n${ICONS.warning} Les réactions automatiques sont désactivées : activez-les depuis la liste.`;
      await interaction.update(reactChannelView(client, interaction.guild, channelId, `${ICONS.success} Réactions ${current ? 'modifiées' : 'ajoutées'} : ${parsed.emojis.join(' ')}.${hint}`));
    },
    /** cmd:communaute:rxmode:<salon> — messages concernés. */
    async rxmode(interaction, client, [channelId]) {
      guard(interaction);
      const entry = findReactEntry(client, interaction.guildId, channelId);
      const mode = interaction.values?.[0];
      if (!Object.hasOwn(REACT_MODES, mode ?? '')) throw new UserError('Choix inconnu.');
      saveReactEntry(client, interaction.guildId, channelId, { ...entry, mode });
      await interaction.update(reactChannelView(client, interaction.guild, channelId, `${ICONS.success} Messages concernés : **${REACT_MODES[mode]}**.`));
    },
    /** cmd:communaute:rxthreads:<salon>:<on|off> — fils du salon inclus. */
    async rxthreads(interaction, client, [channelId, state]) {
      guard(interaction);
      const entry = findReactEntry(client, interaction.guildId, channelId);
      const threads = target(state);
      saveReactEntry(client, interaction.guildId, channelId, { ...entry, threads });
      await interaction.update(reactChannelView(client, interaction.guild, channelId, `${ICONS.success} Fils **${threads ? 'inclus' : 'exclus'}**.`));
    },
    /** cmd:communaute:rxdel:<salon> — retire le salon. */
    async rxdel(interaction, client, [channelId]) {
      guard(interaction);
      findReactEntry(client, interaction.guildId, channelId);
      saveReactEntry(client, interaction.guildId, channelId, null);
      await interaction.update(reactView(client, interaction.guild, `${ICONS.success} Réactions automatiques retirées de <#${channelId}>.`));
    },
  },
};
