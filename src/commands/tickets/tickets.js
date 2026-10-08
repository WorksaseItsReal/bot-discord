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
  RoleSelectMenuBuilder,
} = require('discord.js');
const { truncate } = require('../../utils/embeds');
const { card, field, wide, ICONS, subtext, bullets, actionButton, linkButton, buttonRows, ButtonStyle } = require('../../utils/ui');
const { discordTimestamp } = require('../../utils/time');
const { fitList } = require('../../services/LoggingService');
const { requirePermission } = require('../../services/ModerationService');
const { supportRoles, MAX_REASONS } = require('../../services/TicketService');
const { UserError } = require('../../core/errors');
const { describeApiError } = require('../../core/apiErrors');

/**
 * /tickets : tableau de bord unique (éphémère) de configuration des tickets.
 * Les actions DANS un ticket restent sur /ticket (fermer, ajouter, renommer…).
 * « Gérer le serveur » est revérifiée à chaque clic.
 *
 * Vues : home · setup · panel · reasons · open
 */

const SECTION = 'tickets';
const TEXT_TYPES = [ChannelType.GuildText, ChannelType.GuildAnnouncement];
const MAX_STAFF = 10;
const MAX_LIMIT = 10;
const OPEN_SHOWN = 20;

const NAV = [
  { value: 'home', label: 'Accueil', emoji: '🏠', description: 'État, statistiques et publication du panneau' },
  { value: 'setup', label: 'Salons & staff', emoji: '⚙️', description: 'Catégorie, rôles staff, transcripts, limite' },
  { value: 'panel', label: 'Panneau', emoji: '📣', description: 'Salon et message du panneau d\'ouverture' },
  { value: 'reasons', label: 'Motifs', emoji: '🏷️', description: 'Motifs proposés à l\'ouverture d\'un ticket' },
  { value: 'open', label: 'Tickets ouverts', emoji: '📂', description: 'Liste des tickets en cours, avec liens' },
];

// ---------------------------------------------------------------- helpers purs

const EMOJI_RE = /^(<a?:\w{2,32}:\d{17,20}>|(?:\p{Extended_Pictographic}|\p{Regional_Indicator})(?:️|⃣|\p{Emoji_Modifier}|\p{Regional_Indicator}|‍\p{Extended_Pictographic})*)\s*(.*)$/u;

/** « Signalement » → « signalement » (valeur de menu stable). Pur. */
function slug(label) {
  return String(label)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'motif';
}

/**
 * « 🛠️ Support technique | Un bug, un souci » (une ligne par motif) → motifs validés. Pur.
 * @param {{ hasEmoji?: (id: string) => boolean }} [opts] hasEmoji : emoji personnalisé utilisable
 *   par le bot (sinon la publication du panneau échoue avec « Invalid emoji »)
 * @returns {Array<{ value: string, label: string, emoji: string|null, description: string|null }>}
 */
function parseReasons(text, { hasEmoji } = {}) {
  const out = [];
  const used = new Set();
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(EMOJI_RE);
    const emoji = m ? m[1] : null;
    const customId = emoji?.match(/:(\d{17,20})>$/)?.[1];
    if (customId && hasEmoji && !hasEmoji(customId)) {
      throw new UserError(`Emoji inconnu ${emoji} : je ne peux utiliser que les emojis des serveurs où je suis présent. Choisissez un emoji standard ou de ce serveur.`);
    }
    const rest = (m ? m[2] : line).trim();
    const [labelPart, ...descParts] = rest.split('|');
    const label = labelPart.trim();
    const description = descParts.join('|').trim() || null;
    if (!label) throw new UserError(`Motif sans libellé : « ${truncate(line, 40)} ».`);
    if (label.length > 50) throw new UserError(`Libellé trop long (50 caractères max) : « ${truncate(label, 40)} ».`);
    if (description && description.length > 100) throw new UserError(`Description trop longue (100 caractères max) pour « ${label} ».`);
    let value = slug(label);
    for (let n = 2; used.has(value); n++) value = `${slug(label).slice(0, 36)}-${n}`;
    used.add(value);
    out.push({ value, label, emoji, description });
  }
  if (out.length > MAX_REASONS) throw new UserError(`${MAX_REASONS} motifs maximum.`);
  return out;
}

/**
 * Message d'échec de publication du panneau : la vraie cause (emoji invalide,
 * texte trop long…) plutôt qu'un message générique sur les permissions. Pur.
 */
function publishFailure(channel, err) {
  const { friendly, code } = describeApiError(err);
  const permission = code === 50001 || code === 50013;
  if (!err || permission) {
    return `${ICONS.error} Je ne peux pas écrire dans ${channel} : il me faut **Voir le salon**, **Envoyer des messages** et **Intégrer des liens**.`;
  }
  const raw = truncate(String(err?.message ?? err).replace(/\s+/g, ' '), 300);
  // 50035 (formulaire invalide) : le détail de Discord nomme le champ fautif (ex : emoji).
  const detail = !friendly ? raw : code === 50035 ? `${friendly} — ${raw}` : friendly;
  return `${ICONS.error} Publication du panneau refusée par Discord dans ${channel} : ${detail}${code ? ` (code ${code})` : ''}`;
}

/** Inverse de parseReasons (préremplissage du formulaire). Pur. */
const reasonsToText = (reasons = []) => reasons.map((r) => `${r.emoji ? `${r.emoji} ` : ''}${r.label}${r.description ? ` | ${r.description}` : ''}`).join('\n');

/** Lien vers un message publié. Pur. */
const messageUrl = (guildId, channelId, messageId) => `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;

// ---------------------------------------------------------------- composants

const guard = (interaction) => requirePermission(interaction, 'ManageGuild');
const cfgOf = (client, guildId) => client.services.config.get(guildId).tickets ?? {};

function navRow(current) {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('cmd:tickets:nav')
      .setPlaceholder('Aller à…')
      .addOptions(NAV.map((o) => ({ ...o, default: o.value === current }))),
  );
}

const backHome = () => actionButton({ command: 'tickets', action: 'go', args: ['home'], label: 'Accueil', emoji: '🏠' });

const input = (id, label, { value, placeholder, style = TextInputStyle.Short, max = 100, required = false } = {}) => {
  const t = new TextInputBuilder().setCustomId(id).setLabel(truncate(label, 45)).setStyle(style).setMaxLength(max).setRequired(required);
  if (value != null && String(value) !== '') t.setValue(String(value).slice(0, max));
  if (placeholder) t.setPlaceholder(placeholder.slice(0, 100));
  return new ActionRowBuilder().addComponents(t);
};

/** Tickets en cours du serveur (ouverts ou pris en charge), du plus récent au plus ancien. */
function openTickets(client, guildId) {
  const rows = client.repositories?.tickets?.listByGuild?.(guildId) ?? [];
  return rows.filter((t) => t.status !== 'closed').sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0));
}

/** Lien du panneau publié, s'il est connu. */
function panelLink(guildId, cfg) {
  return cfg.panelChannelId && cfg.panelMessageId ? messageUrl(guildId, cfg.panelChannelId, cfg.panelMessageId) : null;
}

const has = (cache, id) => Boolean(id) && (!cache || cache.has(id));

// ---------------------------------------------------------------- vues

function homeView(client, guild, notice) {
  const cfg = cfgOf(client, guild.id);
  const channels = guild.channels?.cache;
  const roles = supportRoles(cfg);
  const open = openTickets(client, guild.id);
  const claimed = open.filter((t) => t.status === 'claimed').length;
  const link = panelLink(guild.id, cfg);
  const checks = [
    [has(channels, cfg.categoryId), 'Catégorie des tickets', cfg.categoryId ? `<#${cfg.categoryId}>` : null],
    [roles.length > 0, 'Rôle(s) staff', roles.length ? roles.map((r) => `<@&${r}>`).join(' ') : null],
    [has(channels, cfg.logChannel), 'Salon des transcripts', cfg.logChannel ? `<#${cfg.logChannel}>` : null],
    [Boolean(link), 'Panneau publié', cfg.panelChannelId && link ? `<#${cfg.panelChannelId}>` : null],
  ];
  const done = checks.filter(([ok]) => ok).length;
  return {
    embeds: [
      card({
        tone: done === checks.length ? 'success' : done ? 'info' : 'neutral',
        section: SECTION,
        icon: ICONS.ticket,
        title: 'Tickets · Tableau de bord',
        description: [
          notice ? `${notice}\n` : null,
          done === checks.length ? '🟢 Le système de tickets est **prêt**.' : `🟡 Configuration : **${done}** / ${checks.length} étapes.`,
          '',
          ...checks.map(([ok, label, value]) => `${ok ? '✅' : '⬜'} **${label}**${value ? ` · ${value}` : ''}`),
        ],
        fields: [
          field('📂', 'Ouverts', `**${open.length}**`),
          field('🙋', 'Pris en charge', `**${claimed}**`),
          field(ICONS.lock, 'Fermés', `**${cfg.stats?.closed ?? 0}**`),
          field(ICONS.stats, 'Ouverts au total', `**${cfg.stats?.opened ?? 0}**`),
          field(ICONS.count, 'Limite par membre', `**${cfg.maxPerUser || 1}**`),
          field(ICONS.tag, 'Motifs', cfg.reasons?.length ? `**${cfg.reasons.length}**` : '*Aucun*'),
        ],
        footer: 'Actions dans un ticket : /ticket (fermer, ajouter, renommer…)',
      }),
    ],
    components: [
      navRow('home'),
      ...buttonRows(
        actionButton({ command: 'tickets', action: 'publish', label: link ? 'Republier le panneau' : 'Publier le panneau', emoji: '📣', style: ButtonStyle.Primary }),
        actionButton({ command: 'tickets', action: 'go', args: ['open'], label: 'Tickets ouverts', emoji: '📂' }),
        link ? linkButton('Voir le panneau', link, ICONS.link) : null,
        actionButton({ command: 'tickets', action: 'go', args: ['home'], label: 'Actualiser', emoji: ICONS.refresh }),
      ),
    ],
  };
}

function setupView(client, guild, notice) {
  const cfg = cfgOf(client, guild.id);
  const channels = guild.channels?.cache;
  const roleCache = guild.roles?.cache;
  const roles = supportRoles(cfg).filter((r) => !roleCache || roleCache.has(r)).slice(0, MAX_STAFF);
  const max = cfg.maxPerUser || 1;

  const category = new ChannelSelectMenuBuilder()
    .setCustomId('cmd:tickets:category')
    .setPlaceholder('Catégorie où créer les tickets (aucune)')
    .setChannelTypes(ChannelType.GuildCategory)
    .setMinValues(0)
    .setMaxValues(1);
  if (cfg.categoryId && channels?.has(cfg.categoryId)) category.setDefaultChannels(cfg.categoryId);

  const staff = new RoleSelectMenuBuilder().setCustomId('cmd:tickets:staff').setPlaceholder('Rôle(s) staff qui voient les tickets (aucun)').setMinValues(0).setMaxValues(MAX_STAFF);
  if (roles.length) staff.setDefaultRoles(...roles);

  const transcripts = new ChannelSelectMenuBuilder()
    .setCustomId('cmd:tickets:transcripts')
    .setPlaceholder('Salon des transcripts et archives (aucun)')
    .setChannelTypes(...TEXT_TYPES)
    .setMinValues(0)
    .setMaxValues(1);
  if (cfg.logChannel && channels?.has(cfg.logChannel)) transcripts.setDefaultChannels(cfg.logChannel);

  return {
    embeds: [
      card({
        tone: 'info',
        section: SECTION,
        icon: ICONS.settings,
        title: 'Salons & staff',
        description: [
          notice ? `${notice}\n` : null,
          'Chaque ticket est un salon privé créé dans la **catégorie** choisie, visible par son auteur et les **rôles staff**. À la fermeture, le transcript est archivé dans le **salon des transcripts**.',
          subtext('Les membres pouvant « Gérer les salons » font toujours partie du support.'),
        ],
        fields: [
          field(ICONS.category, 'Catégorie', cfg.categoryId ? `<#${cfg.categoryId}>` : '*Aucune* (haut du serveur)'),
          field(ICONS.role, 'Staff', fitList(roles.map((r) => `<@&${r}>`), 1000) ?? '*Gérer les salons*'),
          field(ICONS.history, 'Transcripts', cfg.logChannel ? `<#${cfg.logChannel}>` : '*Désactivés*'),
          field(ICONS.count, 'Limite par membre', `**${max}** ticket${max > 1 ? 's' : ''} ouvert${max > 1 ? 's' : ''}`),
        ],
        footer: 'Videz un menu pour retirer le réglage',
      }),
    ],
    components: [
      navRow('setup'),
      new ActionRowBuilder().addComponents(category),
      new ActionRowBuilder().addComponents(staff),
      new ActionRowBuilder().addComponents(transcripts),
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('cmd:tickets:limit')
          .setPlaceholder('Tickets ouverts par membre…')
          .addOptions(Array.from({ length: MAX_LIMIT }, (_, i) => ({ value: String(i + 1), label: `${i + 1} ticket${i ? 's' : ''} ouvert${i ? 's' : ''} par membre`, default: max === i + 1 }))),
      ),
    ],
  };
}

function panelView(client, guild, notice) {
  const cfg = cfgOf(client, guild.id);
  const link = panelLink(guild.id, cfg);
  const menu = new ChannelSelectMenuBuilder()
    .setCustomId('cmd:tickets:panelch')
    .setPlaceholder('Salon où publier le panneau…')
    .setChannelTypes(...TEXT_TYPES)
    .setMinValues(1)
    .setMaxValues(1);
  if (cfg.panelChannelId && guild.channels?.cache?.has(cfg.panelChannelId)) menu.setDefaultChannels(cfg.panelChannelId);
  const custom = cfg.panel ?? {};
  const customized = Boolean(custom.title || custom.description || custom.buttonLabel);
  const preview = client.services.tickets.panel(guild);
  return {
    embeds: [
      card({
        tone: 'info',
        section: SECTION,
        icon: '📣',
        title: 'Panneau d\'ouverture',
        description: [
          notice ? `${notice}\n` : null,
          'Le panneau permet aux membres d\'ouvrir un ticket. Choisissez son salon, personnalisez son message, puis publiez-le. **Aperçu ci-dessous.**',
          cfg.reasons?.length ? subtext(`${cfg.reasons.length} motif(s) : le panneau affiche un menu de motifs au lieu du bouton.`) : null,
        ],
        fields: [
          field(ICONS.channel, 'Salon', cfg.panelChannelId ? `<#${cfg.panelChannelId}>` : '*À choisir*'),
          field(ICONS.status, 'Publication', link ? `[Voir le message](${link})` : '*Pas encore publié*'),
          field('✏️', 'Message', customized ? 'Personnalisé' : 'Par défaut'),
        ],
        footer: 'Republier met à jour le panneau existant au lieu d\'en créer un second',
      }),
      ...preview.embeds,
    ],
    components: [
      navRow('panel'),
      new ActionRowBuilder().addComponents(menu),
      ...buttonRows(
        actionButton({ command: 'tickets', action: 'publish', label: link ? 'Republier' : 'Publier le panneau', emoji: '📣', style: ButtonStyle.Primary }),
        actionButton({ command: 'tickets', action: 'panelmsg', label: 'Modifier le message', emoji: '✏️' }),
        customized ? actionButton({ command: 'tickets', action: 'panelreset', label: 'Texte par défaut', emoji: ICONS.refresh }) : null,
        link ? linkButton('Voir', link, ICONS.link) : null,
        backHome(),
      ),
    ],
  };
}

function reasonsView(client, guild, notice) {
  const cfg = cfgOf(client, guild.id);
  const reasons = cfg.reasons ?? [];
  return {
    embeds: [
      card({
        tone: 'info',
        section: SECTION,
        icon: ICONS.tag,
        title: 'Motifs de ticket',
        description: [
          notice ? `${notice}\n` : null,
          'Avec des motifs, le membre choisit la raison de sa demande à l\'ouverture : elle s\'affiche dans le ticket, son sujet et les logs.',
          subtext('Sans motif, le panneau affiche un simple bouton « Ouvrir un ticket ».'),
        ],
        fields: [
          wide(ICONS.list, `Motifs (${reasons.length}/${MAX_REASONS})`, reasons.length
            ? truncate(reasons.map((r) => `${r.emoji ?? ICONS.ticket} **${r.label}**${r.description ? ` — ${r.description}` : ''}`).join('\n'), 1024)
            : '*Aucun*'),
        ],
        footer: 'Pensez à republier le panneau après modification',
      }),
    ],
    components: [
      navRow('reasons'),
      ...buttonRows(
        actionButton({ command: 'tickets', action: 'reasons', label: 'Modifier les motifs', emoji: '✏️', style: ButtonStyle.Primary }),
        reasons.length ? actionButton({ command: 'tickets', action: 'reasonsclear', label: 'Tout retirer', emoji: ICONS.delete, style: ButtonStyle.Danger }) : null,
        backHome(),
      ),
    ],
  };
}

function openView(client, guild, notice) {
  const open = openTickets(client, guild.id);
  const lines = open.slice(0, OPEN_SHOWN).map((t) => {
    const state = t.status === 'claimed' ? `🟡 <@${t.claimed_by}>` : '🟢 en attente';
    return `<#${t.channel_id}> · <@${t.user_id}> · ${state} · ${discordTimestamp(t.created_at ?? Date.now(), 'R')}`;
  });
  return {
    embeds: [
      card({
        tone: open.length ? 'info' : 'success',
        section: SECTION,
        icon: '📂',
        title: `Tickets ouverts · ${open.length}`,
        description: [
          notice ? `${notice}\n` : null,
          open.length ? bullets(lines) : 'Aucun ticket en cours. ✨',
          open.length > OPEN_SHOWN ? subtext(`… et ${open.length - OPEN_SHOWN} autre(s), les plus anciens.`) : null,
        ],
        footer: 'Cliquez sur un salon pour l\'ouvrir · 🟢 en attente · 🟡 pris en charge',
      }),
    ],
    components: [
      navRow('open'),
      ...buttonRows(
        actionButton({ command: 'tickets', action: 'go', args: ['open'], label: 'Actualiser', emoji: ICONS.refresh, style: ButtonStyle.Primary }),
        backHome(),
      ),
    ],
  };
}

function render(client, guild, view = 'home', notice) {
  const [name] = String(view).split(/[:.]/);
  switch (name) {
    case 'setup':
      return setupView(client, guild, notice);
    case 'panel':
      return panelView(client, guild, notice);
    case 'reasons':
      return reasonsView(client, guild, notice);
    case 'open':
      return openView(client, guild, notice);
    default:
      return homeView(client, guild, notice);
  }
}

// ---------------------------------------------------------------- formulaires

function panelModal(cfg) {
  const p = cfg.panel ?? {};
  return new ModalBuilder()
    .setCustomId('cmd:tickets:panelmsgsubmit')
    .setTitle('Message du panneau')
    .addComponents(
      input('title', 'Titre (vide : texte par défaut)', { value: p.title, max: 200, placeholder: 'Besoin d\'aide ? Contactez le support' }),
      input('description', 'Message (vide : texte par défaut)', { value: p.description, max: 2000, style: TextInputStyle.Paragraph }),
      input('buttonLabel', 'Texte du bouton ou du menu (vide : défaut)', { value: p.buttonLabel, max: 40, placeholder: 'Ouvrir un ticket' }),
    );
}

function reasonsModal(cfg) {
  return new ModalBuilder()
    .setCustomId('cmd:tickets:reasonssubmit')
    .setTitle('Motifs de ticket')
    .addComponents(
      input('reasons', 'Un motif par ligne : emoji Libellé | détail', {
        value: reasonsToText(cfg.reasons),
        max: 2000,
        style: TextInputStyle.Paragraph,
        placeholder: '🛠️ Support technique | Un bug, un souci\n🚨 Signalement | Signaler un membre',
      }),
    );
}

const textValue = (interaction, id) => {
  try {
    return interaction.fields.getTextInputValue(id)?.trim() || null;
  } catch {
    return null;
  }
};

// ---------------------------------------------------------------- commande

module.exports = {
  category: 'tickets',
  cooldown: 3_000,
  render,
  parseReasons,
  reasonsToText,
  publishFailure,
  data: new SlashCommandBuilder()
    .setName('tickets')
    .setDescription('Ouvre le tableau de bord des tickets : salons, staff, panneau, motifs, statistiques.')
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
    /** cmd:tickets:go:<vue> */
    async go(interaction, client, [view]) {
      guard(interaction);
      await interaction.update(render(client, interaction.guild, view ?? 'home'));
    },
    /** Catégorie des tickets (vide : aucune). */
    async category(interaction, client) {
      guard(interaction);
      const id = interaction.values?.[0] ?? null;
      if (id) {
        if (!/^\d{17,20}$/.test(id)) throw new UserError('Catégorie invalide.');
        const ch = interaction.guild.channels?.cache?.get(id);
        if (ch && ch.type !== ChannelType.GuildCategory) throw new UserError('Choisissez une catégorie.');
      }
      client.services.config.update(interaction.guildId, { tickets: { categoryId: id } });
      await interaction.update(setupView(client, interaction.guild, id ? `${ICONS.success} Les tickets seront créés dans <#${id}>.` : `${ICONS.success} Catégorie retirée.`));
    },
    /** Rôles staff (remplace la sélection ; @everyone et rôles d'intégration refusés). */
    async staff(interaction, client) {
      guard(interaction);
      const ids = (interaction.values ?? []).filter((id) => /^\d{17,20}$/.test(id)).slice(0, MAX_STAFF);
      for (const id of ids) {
        // @everyone verrait tous les tickets ; un rôle d'intégration ne s'attribue pas.
        if (id === interaction.guildId) throw new UserError('Le rôle @everyone ne peut pas être un rôle staff : tout le monde verrait les tickets.');
        const role = interaction.guild.roles?.cache?.get(id);
        if (role?.managed) throw new UserError(`Le rôle ${role.name} est géré par une intégration : choisissez un rôle staff classique.`);
      }
      client.services.config.update(interaction.guildId, { tickets: { supportRoleIds: ids, supportRoleId: ids[0] ?? null } });
      await interaction.update(setupView(client, interaction.guild, `${ICONS.success} ${ids.length} rôle(s) staff.`));
    },
    /** Salon des transcripts (vide : désactivés). */
    async transcripts(interaction, client) {
      guard(interaction);
      const id = interaction.values?.[0] ?? null;
      if (id) {
        if (!/^\d{17,20}$/.test(id)) throw new UserError('Salon invalide.');
        const ch = interaction.guild.channels?.cache?.get(id);
        if (ch && !TEXT_TYPES.includes(ch.type)) throw new UserError('Choisissez un salon textuel.');
      }
      client.services.config.update(interaction.guildId, { tickets: { logChannel: id } });
      await interaction.update(setupView(client, interaction.guild, id ? `${ICONS.success} Transcripts archivés dans <#${id}>.` : `${ICONS.success} Archivage des transcripts désactivé.`));
    },
    /** Limite de tickets ouverts par membre. */
    async limit(interaction, client) {
      guard(interaction);
      const n = Number(interaction.values?.[0]);
      if (!Number.isInteger(n) || n < 1 || n > MAX_LIMIT) throw new UserError(`Choisissez une limite entre 1 et ${MAX_LIMIT}.`);
      client.services.config.update(interaction.guildId, { tickets: { maxPerUser: n } });
      await interaction.update(setupView(client, interaction.guild, `${ICONS.success} Limite : **${n}** ticket(s) ouvert(s) par membre.`));
    },
    /** Salon du panneau. */
    async panelch(interaction, client) {
      guard(interaction);
      const id = interaction.values?.[0];
      if (!/^\d{17,20}$/.test(id ?? '')) throw new UserError('Salon invalide.');
      const ch = interaction.guild.channels?.cache?.get(id);
      if (ch && !TEXT_TYPES.includes(ch.type)) throw new UserError('Choisissez un salon textuel.');
      const cfg = cfgOf(client, interaction.guildId);
      // Changer de salon : le prochain envoi crée un nouveau panneau.
      const patch = { panelChannelId: id, ...(cfg.panelChannelId !== id ? { panelMessageId: null } : {}) };
      client.services.config.update(interaction.guildId, { tickets: patch });
      await interaction.update(panelView(client, interaction.guild, `${ICONS.success} Le panneau sera publié dans <#${id}>.`));
    },
    /** Ouvre le formulaire du message du panneau. */
    async panelmsg(interaction, client) {
      guard(interaction);
      await interaction.showModal(panelModal(cfgOf(client, interaction.guildId)));
    },
    async panelmsgsubmit(interaction, client) {
      guard(interaction);
      const panel = { title: textValue(interaction, 'title'), description: textValue(interaction, 'description'), buttonLabel: textValue(interaction, 'buttonLabel') };
      if (panel.title && panel.title.length > 200) throw new UserError('Titre trop long (200 caractères max).');
      if (panel.buttonLabel && panel.buttonLabel.length > 40) throw new UserError('Texte du bouton trop long (40 caractères max).');
      client.services.config.update(interaction.guildId, { tickets: { panel } });
      await interaction.update(panelView(client, interaction.guild, `${ICONS.success} Message du panneau enregistré. Republiez-le pour l'appliquer.`));
    },
    /** Revient aux textes par défaut du panneau. */
    async panelreset(interaction, client) {
      guard(interaction);
      client.services.config.update(interaction.guildId, { tickets: { panel: { title: null, description: null, buttonLabel: null } } });
      await interaction.update(panelView(client, interaction.guild, `${ICONS.success} Textes par défaut rétablis.`));
    },
    /** Publie (ou met à jour) le panneau dans son salon. */
    async publish(interaction, client) {
      guard(interaction);
      const cfg = cfgOf(client, interaction.guildId);
      if (!cfg.panelChannelId) throw new UserError('Choisissez d\'abord le salon du panneau (section **Panneau**).');
      await interaction.deferUpdate();
      const guild = interaction.guild;
      const channel = guild.channels?.cache?.get(cfg.panelChannelId) ?? (await guild.channels?.fetch?.(cfg.panelChannelId).catch(() => null));
      let notice;
      if (!channel?.send) {
        notice = `${ICONS.error} Le salon du panneau est introuvable : choisissez-en un autre.`;
      } else {
        const payload = client.services.tickets.panel(guild);
        let message = null;
        let updated = false;
        let failure = null;
        const remember = (err) => {
          failure = err;
          return null;
        };
        if (cfg.panelMessageId) {
          const existing = await channel.messages?.fetch?.(cfg.panelMessageId).catch(() => null);
          if (existing?.edit) {
            message = await existing.edit(payload).catch(remember);
            updated = Boolean(message);
          }
        }
        if (!message) message = await channel.send(payload).catch(remember);
        if (message?.id) {
          client.services.config.update(interaction.guildId, { tickets: { panelMessageId: message.id } });
          notice = `${ICONS.success} Panneau ${updated ? 'mis à jour' : 'publié'} dans ${channel}.`;
        } else {
          notice = publishFailure(channel, failure);
        }
      }
      await interaction.editReply(render(client, guild, 'home', notice));
    },
    /** Ouvre le formulaire des motifs. */
    async reasons(interaction, client) {
      guard(interaction);
      await interaction.showModal(reasonsModal(cfgOf(client, interaction.guildId)));
    },
    async reasonssubmit(interaction, client) {
      guard(interaction);
      // Emoji personnalisé inconnu du bot : refusé ici, sinon la publication du panneau échouerait.
      const reasons = parseReasons(textValue(interaction, 'reasons'), { hasEmoji: (id) => Boolean(client.emojis?.cache?.has(id)) });
      // Tableau : ConfigService le remplace en entier.
      client.services.config.update(interaction.guildId, { tickets: { reasons } });
      await interaction.update(reasonsView(client, interaction.guild, `${ICONS.success} ${reasons.length} motif(s) enregistré(s). Republiez le panneau pour l'appliquer.`));
    },
    /** Retire tous les motifs (retour au bouton simple). */
    async reasonsclear(interaction, client) {
      guard(interaction);
      client.services.config.update(interaction.guildId, { tickets: { reasons: [] } });
      await interaction.update(reasonsView(client, interaction.guild, `${ICONS.success} Motifs retirés. Republiez le panneau pour l'appliquer.`));
    },
  },
};
