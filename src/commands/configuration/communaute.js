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
const { MAX_TRIGGERS } = require('../../services/AutoResponderService');
const { UserError } = require('../../core/errors');

/**
 * /communaute : tableau de bord unique du starboard et des réponses automatiques
 * (éphémère, « Gérer le serveur »). Les messages épinglés automatiquement ont leur
 * propre commande (/sticky, « Gérer les messages ») ; leur nombre est rappelé ici.
 * Vues : home · starboard · auto · trigger:<id> · confirmDel:<id>
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

const guard = (interaction) => requirePermission(interaction, 'ManageGuild');
const community = (client, guildId) => client.services.config.get(guildId).community ?? {};
const sbOf = (client, guildId) => community(client, guildId).starboard ?? {};
const arOf = (client, guildId) => community(client, guildId).autoResponses ?? {};
const row = (component) => new ActionRowBuilder().addComponents(component);
const homeButton = () => actionButton({ command: 'communaute', action: 'go', args: ['home'], label: 'Accueil', emoji: '🏠' });
/** Texte saisi affiché sans casser la mise en forme. */
const quote = (text, max = 200) => `\`${truncate(String(text ?? '').replace(/`/g, 'ˋ').replace(/\n/g, ' '), max)}\``;

const NAV = [
  { value: 'home', label: 'Accueil', emoji: '🏠', description: 'Vue d\'ensemble de la communauté' },
  { value: 'starboard', label: 'Starboard', emoji: '⭐', description: 'Reposter les messages les plus étoilés' },
  { value: 'auto', label: 'Réponses automatiques', emoji: '💬', description: 'Déclencheurs, réponses et réactions' },
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
  const anyOn = sb.enabled || ar.enabled;
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
          '',
          subtext('Les messages épinglés automatiquement (réaffichés en bas d\'un salon) se gèrent avec /sticky.'),
        ],
        fields: [
          field(ICONS.star, 'Starboard', sb.channelId ? `<#${sb.channelId}>\n${sb.emoji || '⭐'} × ${sb.threshold ?? 3}` : '*Aucun salon*'),
          field('💬', 'Déclencheurs', `${triggers.filter((t) => t.enabled !== false).length} actif(s) / ${triggers.length}`),
          field(ICONS.status, 'Messages épinglés', `${stickies}`),
          field(ICONS.stats, 'Messages au starboard', `${starred}`),
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
    .setDescription('Ouvre le tableau de bord communauté : starboard et réponses automatiques.')
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
  },
};
