'use strict';

const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChannelType,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
} = require('discord.js');
const { truncate, progressBar } = require('../../utils/embeds');
const { card, field, wide, ICONS, code, status, actionButton, buttonRows, ButtonStyle, subtext } = require('../../utils/ui');
const { parseDuration } = require('../../utils/time');
const { fitList } = require('../../services/LoggingService');
const { requirePermission } = require('../../services/ModerationService');
const { variants } = require('../../utils/automod/normalize');
const { phishingScore } = require('../../utils/automod/phishing');
const { PRESETS } = require('../../utils/automod/presets');
const native = require('../../services/NativeAutoMod');
const { UserError } = require('../../core/errors');

/** Filtres et libellés français, regroupés pour l'affichage. */
const FILTER_LABELS = {
  antiSpam: 'Anti-spam',
  antiFlood: 'Anti-flood',
  antiLink: 'Anti-liens',
  antiInvite: 'Anti-invitations',
  antiMassMention: 'Mentions de masse',
  antiCaps: 'Majuscules',
  badWords: 'Mots interdits',
  antiRepeat: 'Répétitions',
  antiEmojiSpam: 'Spam d\'emojis',
  antiDuplicate: 'Doublons',
  antiPhishing: 'Anti-arnaques',
  antiCrossChannel: 'Spam multi-salons',
  antiWall: 'Pavés de texte',
  antiZalgo: 'Texte zalgo',
};
const FILTERS = Object.keys(FILTER_LABELS);
const GROUPS = [
  ['🛡️ Sécurité', ['antiPhishing', 'antiCrossChannel', 'antiInvite', 'antiLink']],
  ['💬 Spam', ['antiSpam', 'antiFlood', 'antiDuplicate', 'antiRepeat', 'antiMassMention']],
  ['✍️ Contenu', ['badWords', 'antiCaps', 'antiEmojiSpam', 'antiWall', 'antiZalgo']],
];
/** Seuil réglable par filtre : [clé de config, libellé, min, max]. */
const THRESHOLDS = {
  antiSpam: ['limit', 'messages', 2, 30],
  antiFlood: ['limit', 'messages', 2, 50],
  antiMassMention: ['limit', 'mentions', 2, 50],
  antiCaps: ['percent', '% de majuscules', 30, 100],
  antiEmojiSpam: ['limit', 'emojis', 2, 100],
  antiPhishing: ['threshold', 'points de suspicion', 1, 6],
  antiCrossChannel: ['channels', 'salons', 2, 10],
  antiWall: ['maxLines', 'lignes', 3, 100],
};
const ACTION_LABELS = { delete: 'Suppression', warn: 'Avertissement', timeout: 'Timeout', kick: 'Expulsion' };
const NOTIFY_LABELS = { channel: 'Dans le salon (8 s)', dm: 'En message privé', none: 'Aucune' };

/** « 🟢 **Anti-spam** · Timeout (5m) ». Pur. */
function filterLine(name, fc = {}) {
  const action = ACTION_LABELS[fc.action] ?? fc.action ?? ACTION_LABELS.delete;
  return `${fc.enabled ? '🟢' : '🔴'} **${FILTER_LABELS[name] ?? name}** · ${action}${fc.action === 'timeout' && fc.duration ? ` (${fc.duration})` : ''}`;
}

function escalationText(esc) {
  if (!esc?.enabled) return '🔴 Désactivées';
  const steps = (esc.steps ?? []).map((s) => `${s.count}× → ${ACTION_LABELS[s.action] ?? s.action}${s.duration ? ` ${s.duration}` : ''}`);
  return `🟢 Sur ${esc.windowMinutes ?? 30} min\n${steps.join('\n')}`;
}

function newMembersText(nm) {
  if (!nm?.enabled) return '🔴 Désactivée';
  const blocked = [nm.blockLinks && 'liens', nm.blockInvites && 'invitations', nm.blockMedia && 'fichiers'].filter(Boolean);
  return `🟢 Compte < ${nm.accountAgeDays} j ou arrivé < ${nm.joinedMinutes} min\nBloque : ${blocked.join(', ') || 'rien'}`;
}

/** Panneau AutoMod (éphémère) : état, filtres groupés, réglages, raccourcis. */
function renderPanel(client, guildId, notice) {
  const cfg = client.services.config.get(guildId).automod;
  const active = FILTERS.filter((f) => cfg.filters?.[f]?.enabled).length;
  const lines = GROUPS.flatMap(([title, keys]) => ['', `**${title}**`, ...keys.map((k) => filterLine(k, cfg.filters?.[k]))]);
  return {
    embeds: [
      card({
        tone: cfg.enabled ? 'success' : 'neutral',
        section: 'automod',
        icon: ICONS.automod,
        title: 'AutoMod',
        description: [
          notice ? `${ICONS.success} ${notice}` : null,
          cfg.enabled ? '🟢 Le filtrage automatique est **actif**.' : '🔴 Le filtrage automatique est **désactivé**.',
          `\`${progressBar(active / FILTERS.length, 14)}\` **${active}** / ${FILTERS.length} filtres`,
          ...lines,
        ],
        fields: [
          field('📈', 'Sanctions progressives', escalationText(cfg.escalation)),
          field('🐣', 'Nouveaux venus', newMembersText(cfg.newMembers)),
          field('🔔', 'Prévenir le membre', NOTIFY_LABELS[cfg.notify] ?? NOTIFY_LABELS.none),
          field(ICONS.channel, 'Salons ignorés', fitList((cfg.ignoredChannels ?? []).map((c) => `<#${c}>`), 1000) ?? '*Aucun*'),
          field(ICONS.role, 'Rôles ignorés', fitList((cfg.ignoredRoles ?? []).map((r) => `<@&${r}>`), 1000) ?? '*Aucun*'),
          field('✅', 'Liste blanche', `${cfg.filters?.antiLink?.allowedDomains?.length ?? 0} domaine(s) · ${cfg.filters?.antiInvite?.allowedCodes?.length ?? 0} invitation(s)`),
        ],
        footer: 'Les membres avec « Gérer les messages » ne sont jamais filtrés.',
      }),
    ],
    components: buttonRows(
      cfg.enabled
        ? actionButton({ command: 'automod', action: 'toggle', args: ['off'], label: 'Désactiver', emoji: '🔴', style: ButtonStyle.Danger })
        : actionButton({ command: 'automod', action: 'toggle', args: ['on'], label: 'Activer', emoji: '🟢', style: ButtonStyle.Success }),
      actionButton({ command: 'automod', action: 'test', label: 'Tester un message', emoji: '🧪' }),
      actionButton({ command: 'automod', action: 'stats', args: ['7'], label: 'Statistiques', emoji: ICONS.stats }),
    ),
  };
}

/** Analyse « à blanc » d'un texte (sans sanction, sans compter le spam). */
function analyse(client, guild, text) {
  const cfg = client.services.config.get(guild.id).automod;
  // Tous les filtres de contenu sont testés, même désactivés, pour montrer ce qu'ils feraient.
  const allOn = Object.fromEntries(Object.entries(cfg.filters ?? {}).map(([k, v]) => [k, { ...v, enabled: true }]));
  const fake = { guild, author: { id: '0', createdTimestamp: 0 }, content: text, mentions: null, channel: null };
  const results = [];
  for (const key of FILTERS) {
    if (['antiSpam', 'antiFlood', 'antiDuplicate', 'antiRepeat', 'antiCrossChannel'].includes(key)) continue;
    const hit = client.services.automod.inspect(fake, { [key]: allOn[key] }, { temporal: false });
    if (hit) results.push({ key, hit, enabled: Boolean(cfg.filters?.[key]?.enabled) });
  }
  const scan = phishingScore(text);
  return { results, scan, normalized: variants(text).at(-1), cfg };
}

function analysisCard(client, guild, text) {
  const { results, scan, normalized, cfg } = analyse(client, guild, text);
  const blocked = results.filter((r) => r.enabled);
  return card({
    tone: blocked.length ? 'danger' : results.length ? 'warning' : 'success',
    section: 'automod',
    icon: '🧪',
    title: 'Test de l\'AutoMod',
    description: [
      blocked.length
        ? `${ICONS.error} Ce message serait **bloqué**${cfg.enabled ? '' : ' (une fois l\'AutoMod activé)'}.`
        : results.length
          ? `${ICONS.warning} Ce message passerait, mais des filtres **désactivés** le bloqueraient.`
          : `${ICONS.success} Ce message **passerait** tous les filtres.`,
      '',
      ...results.map((r) => `${r.enabled ? '🔴' : '⚪'} **${FILTER_LABELS[r.key]}** · ${r.hit.reason}${r.hit.detail ? ` — ${truncate(r.hit.detail, 120)}` : ''}`),
    ],
    fields: [
      wide('✉️', 'Message testé', `\`\`\`\n${truncate(text.replace(/`/g, 'ˋ'), 900)}\n\`\`\``),
      wide('🔤', 'Forme analysée (anti-contournement)', `\`\`\`\n${truncate(normalized.replace(/`/g, 'ˋ'), 900)}\n\`\`\``),
      scan.links.length ? field('🎣', 'Score d\'arnaque', `**${scan.score}** / seuil ${cfg.filters?.antiPhishing?.threshold ?? 3}`) : null,
      scan.reasons.length ? wide(ICONS.search, 'Indices', truncate(scan.reasons.join('\n'), 1024)) : null,
    ],
    footer: 'Test à blanc : aucune sanction, le spam et les doublons ne sont pas évalués.',
  });
}

function statsCard(client, guild, days) {
  const repo = client.repositories?.automodEvents;
  if (!repo) return status.note('Les statistiques ne sont pas disponibles.');
  const s = repo.stats(guild.id, Date.now() - days * 86_400_000);
  if (!s.total) return status.note(`Aucune infraction ces **${days}** derniers jours. ✨`, 'Statistiques AutoMod');
  const max = s.byFilter[0]?.n ?? 1;
  return card({
    tone: 'info',
    section: 'automod',
    icon: ICONS.stats,
    title: `AutoMod · ${days} derniers jours`,
    description: s.byFilter.slice(0, 10).map((r) => `\`${progressBar(r.n / max, 10)}\` **${r.n}** · ${FILTER_LABELS[r.filter] ?? (r.filter === 'newMembers' ? 'Nouveaux venus' : r.filter)}`),
    fields: [
      field(ICONS.count, 'Infractions', `**${s.total}**`),
      field(ICONS.members, 'Membres concernés', `**${s.users}**`),
      field(ICONS.shield, 'Actions', s.byAction.map((a) => `${ACTION_LABELS[a.action] ?? a.action} : **${a.n}**`).join('\n')),
      wide('🏴', 'Membres les plus filtrés', s.topUsers.map((u, i) => `${i + 1}. <@${u.user_id}> — **${u.n}**`).join('\n')),
    ],
  });
}

function listCard(cfg, notice) {
  const words = cfg.filters?.badWords?.words ?? [];
  const domains = cfg.filters?.antiLink?.allowedDomains ?? [];
  const codes = cfg.filters?.antiInvite?.allowedCodes ?? [];
  return card({
    tone: 'info',
    section: 'automod',
    icon: ICONS.list,
    title: 'Listes de l\'AutoMod',
    description: notice ? `${ICONS.success} ${notice}` : null,
    fields: [
      wide('🚫', `Mots interdits (${words.length})`, words.length ? truncate(words.map(code).join(' · '), 1024) : '*Aucun*'),
      wide('🌐', `Domaines autorisés (${domains.length})`, domains.length ? truncate(domains.map(code).join(' · '), 1024) : '*Aucun : tous les liens sont bloqués quand l\'anti-liens est actif.*'),
      wide('✉️', `Invitations autorisées (${codes.length})`, codes.length ? truncate(codes.map((c) => code(`discord.gg/${c}`)).join(' · '), 1024) : '*Aucune* (l\'invitation personnalisée du serveur reste autorisée)'),
    ],
    footer: 'Astuce : « mot* » bloque aussi les mots qui commencent par « mot ».',
  });
}

function testModal() {
  return new ModalBuilder()
    .setCustomId('cmd:automod:testsubmit')
    .setTitle('Tester l\'AutoMod')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('text').setLabel('Message à tester').setStyle(TextInputStyle.Paragraph).setMaxLength(1500).setRequired(true),
      ),
    );
}

/** Normalise un domaine saisi (« https://www.Site.com/x » → « site.com »). */
function cleanDomain(input) {
  const d = String(input ?? '').trim().toLowerCase().replace(/^(https?:\/\/)?(www\.)?/, '').replace(/[/?#].*$/, '');
  if (!/^[a-z0-9.-]+\.[a-z]{2,24}$/.test(d)) throw new UserError('Domaine invalide. Exemple : `youtube.com`.');
  return d;
}

function cleanInvite(input) {
  const c = String(input ?? '').trim().replace(/^(https?:\/\/)?(www\.)?(discord\.gg|discord(app)?\.com\/invite)\//i, '').toLowerCase();
  if (!/^[a-z0-9-]{2,32}$/.test(c)) throw new UserError('Code d\'invitation invalide. Exemple : `discord.gg/monserveur` ou `monserveur`.');
  return c;
}

const filterChoices = FILTERS.map((f) => ({ name: FILTER_LABELS[f], value: f }));

module.exports = {
  category: 'automod',
  filterLine,
  analyse,
  data: new SlashCommandBuilder()
    .setName('automod')
    .setDescription('Configuration de l\'AutoMod.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((s) => s.setName('status').setDescription('Affiche le panneau de l\'AutoMod.'))
    .addSubcommand((s) => s.setName('enable').setDescription('Active l\'AutoMod.'))
    .addSubcommand((s) => s.setName('disable').setDescription('Désactive l\'AutoMod.'))
    .addSubcommand((s) =>
      s.setName('preset').setDescription('Applique un préréglage complet (conserve vos listes).')
        .addStringOption((o) => o.setName('niveau').setDescription('Niveau de protection').setRequired(true).addChoices(
          ...Object.entries(PRESETS).map(([value, p]) => ({ name: `${p.emoji} ${p.label} — ${p.description}`.slice(0, 100), value })),
        )))
    .addSubcommand((s) =>
      s.setName('filter').setDescription('Règle un filtre : activation, sanction, seuil.')
        .addStringOption((o) => o.setName('nom').setDescription('Filtre').setRequired(true).addChoices(...filterChoices))
        .addBooleanOption((o) => o.setName('actif').setDescription('Activer ?').setRequired(true))
        .addStringOption((o) => o.setName('action').setDescription('Sanction').addChoices(
          { name: 'Suppression', value: 'delete' }, { name: 'Avertissement (+1 strike)', value: 'warn' }, { name: 'Timeout', value: 'timeout' },
        ))
        .addStringOption((o) => o.setName('duree').setDescription('Durée du timeout (ex : 10m, 1h, 1d)').setMaxLength(10))
        .addIntegerOption((o) => o.setName('seuil').setDescription('Seuil du filtre (messages, mentions, %, salons…)').setMinValue(1).setMaxValue(100)))
    .addSubcommand((s) =>
      s.setName('test').setDescription('Teste un message sans sanction : quels filtres le bloqueraient ?')
        .addStringOption((o) => o.setName('texte').setDescription('Message à tester').setRequired(true).setMaxLength(1500)))
    .addSubcommand((s) =>
      s.setName('stats').setDescription('Statistiques des infractions.')
        .addIntegerOption((o) => o.setName('jours').setDescription('Période (1 à 30 jours, défaut 7)').setMinValue(1).setMaxValue(30)))
    .addSubcommand((s) =>
      s.setName('escalade').setDescription('Sanctions progressives en cas de récidive.')
        .addBooleanOption((o) => o.setName('actif').setDescription('Activer ?').setRequired(true))
        .addIntegerOption((o) => o.setName('fenetre').setDescription('Fenêtre de récidive en minutes (5 à 1440)').setMinValue(5).setMaxValue(1440)))
    .addSubcommand((s) =>
      s.setName('nouveaux').setDescription('Restrictions pour les nouveaux venus.')
        .addBooleanOption((o) => o.setName('actif').setDescription('Activer ?').setRequired(true))
        .addIntegerOption((o) => o.setName('age_compte').setDescription('Âge minimal du compte en jours (0 à 90)').setMinValue(0).setMaxValue(90))
        .addIntegerOption((o) => o.setName('anciennete').setDescription('Présence minimale sur le serveur en minutes (0 à 10080)').setMinValue(0).setMaxValue(10080))
        .addBooleanOption((o) => o.setName('liens').setDescription('Bloquer leurs liens'))
        .addBooleanOption((o) => o.setName('invitations').setDescription('Bloquer leurs invitations'))
        .addBooleanOption((o) => o.setName('fichiers').setDescription('Bloquer leurs fichiers et stickers')))
    .addSubcommand((s) =>
      s.setName('notification').setDescription('Comment prévenir le membre dont le message est retiré.')
        .addStringOption((o) => o.setName('mode').setDescription('Mode').setRequired(true).addChoices(
          { name: 'Dans le salon (supprimé après 8 s)', value: 'channel' }, { name: 'En message privé', value: 'dm' }, { name: 'Aucune', value: 'none' },
        )))
    .addSubcommand((s) =>
      s.setName('ignore').setDescription('Ajoute/retire un salon ou rôle ignoré.')
        .addChannelOption((o) => o.setName('salon').setDescription('Salon à (dé)ignorer').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum, ChannelType.GuildVoice))
        .addRoleOption((o) => o.setName('role').setDescription('Rôle à (dé)ignorer')))
    .addSubcommand((s) =>
      s.setName('discord').setDescription('Synchronise l\'AutoMod natif de Discord (actif même bot hors ligne).')
        .addStringOption((o) => o.setName('action').setDescription('Action').setRequired(true).addChoices(
          { name: 'Activer / mettre à jour', value: 'sync' }, { name: 'Retirer les règles', value: 'remove' }, { name: 'État', value: 'status' },
        )))
    .addSubcommandGroup((g) =>
      g.setName('badword').setDescription('Mots interdits')
        .addSubcommand((s) => s.setName('add').setDescription('Ajoute des mots interdits (séparés par des virgules ; « mot* » = préfixe).').addStringOption((o) => o.setName('mot').setDescription('Mot(s)').setRequired(true).setMaxLength(500)))
        .addSubcommand((s) => s.setName('remove').setDescription('Retire un mot interdit.').addStringOption((o) => o.setName('mot').setDescription('Mot').setRequired(true).setMaxLength(100)))
        .addSubcommand((s) => s.setName('list').setDescription('Affiche les listes de l\'AutoMod.')))
    .addSubcommandGroup((g) =>
      g.setName('autoriser').setDescription('Liste blanche des liens et invitations')
        .addSubcommand((s) => s.setName('domaine').setDescription('Autorise/retire un domaine (ex : youtube.com).').addStringOption((o) => o.setName('domaine').setDescription('Domaine').setRequired(true).setMaxLength(200)))
        .addSubcommand((s) => s.setName('invitation').setDescription('Autorise/retire une invitation Discord.').addStringOption((o) => o.setName('code').setDescription('Code ou lien d\'invitation').setRequired(true).setMaxLength(100)))),

  async execute(interaction, client) {
    const group = interaction.options.getSubcommandGroup(false);
    const sub = interaction.options.getSubcommand();
    const { config } = client.services;
    const guildId = interaction.guild.id;
    const cfg = () => config.get(guildId).automod;
    const panel = (notice) => interaction.reply({ ...renderPanel(client, guildId, notice), ephemeral: true });

    if (group === 'badword') {
      const words = new Set(cfg().filters.badWords.words || []);
      if (sub === 'list') return interaction.reply({ embeds: [listCard(cfg())], ephemeral: true });
      if (sub === 'add') {
        const added = interaction.options.getString('mot').split(',').map((w) => w.trim().toLowerCase()).filter((w) => w && w.length <= 60);
        if (!added.length) throw new UserError('Aucun mot valide (60 caractères maximum par mot).');
        if (words.size + added.length > 1000) throw new UserError('La liste est limitée à 1000 mots.');
        added.forEach((w) => words.add(w));
        // Seul l'ajout active le filtre : retirer un mot ne doit pas réactiver un filtre désactivé.
        config.update(guildId, { automod: { filters: { badWords: { words: [...words], enabled: true } } } });
        return interaction.reply({ embeds: [listCard(cfg(), `${added.length} mot(s) ajouté(s) : ${added.map(code).join(', ')}.`)], ephemeral: true });
      }
      const word = interaction.options.getString('mot').trim().toLowerCase();
      if (!words.delete(word)) throw new UserError(`${code(word)} n'est pas dans la liste.`);
      config.update(guildId, { automod: { filters: { badWords: { words: [...words] } } } });
      return interaction.reply({ embeds: [listCard(cfg(), `Mot ${code(word)} retiré.`)], ephemeral: true });
    }

    if (group === 'autoriser') {
      if (sub === 'domaine') {
        const d = cleanDomain(interaction.options.getString('domaine'));
        const set = new Set(cfg().filters.antiLink.allowedDomains ?? []);
        const added = !set.has(d);
        added ? set.add(d) : set.delete(d);
        config.update(guildId, { automod: { filters: { antiLink: { allowedDomains: [...set] } } } });
        return interaction.reply({ embeds: [listCard(cfg(), `Domaine ${code(d)} ${added ? 'autorisé' : 'retiré de la liste blanche'}.`)], ephemeral: true });
      }
      const c = cleanInvite(interaction.options.getString('code'));
      const set = new Set(cfg().filters.antiInvite.allowedCodes ?? []);
      const added = !set.has(c);
      added ? set.add(c) : set.delete(c);
      config.update(guildId, { automod: { filters: { antiInvite: { allowedCodes: [...set] } } } });
      return interaction.reply({ embeds: [listCard(cfg(), `Invitation ${code(`discord.gg/${c}`)} ${added ? 'autorisée' : 'retirée de la liste blanche'}.`)], ephemeral: true });
    }

    switch (sub) {
      case 'status':
        return panel();
      case 'enable':
      case 'disable':
        config.update(guildId, { automod: { enabled: sub === 'enable' } });
        return panel(`AutoMod **${sub === 'enable' ? 'activé' : 'désactivé'}**.`);
      case 'preset': {
        const key = interaction.options.getString('niveau');
        const preset = PRESETS[key];
        if (!preset) throw new UserError('Préréglage inconnu.');
        config.update(guildId, { automod: preset.patch });
        return panel(`Préréglage ${preset.emoji} **${preset.label}** appliqué. Vos listes (mots, domaines) sont conservées.`);
      }
      case 'filter': {
        const name = interaction.options.getString('nom');
        const enabled = interaction.options.getBoolean('actif');
        const action = interaction.options.getString('action');
        const duration = interaction.options.getString('duree');
        const threshold = interaction.options.getInteger('seuil');
        const patch = { enabled };
        if (action) patch.action = action;
        if (duration) {
          const ms = parseDuration(duration);
          if (!ms || ms > 28 * 86_400_000) throw new UserError('Durée invalide (ex : `10m`, `1h`, `1d`, 28 jours maximum).');
          patch.duration = duration;
        }
        if (threshold != null) {
          const spec = THRESHOLDS[name];
          if (!spec) throw new UserError(`Le filtre **${FILTER_LABELS[name]}** n'a pas de seuil réglable.`);
          const [key, label, min, max] = spec;
          if (threshold < min || threshold > max) throw new UserError(`Seuil hors limites : entre ${min} et ${max} ${label}.`);
          patch[key] = threshold;
        }
        config.update(guildId, { automod: { filters: { [name]: patch } } });
        return panel(`Filtre **${FILTER_LABELS[name] ?? name}** ${enabled ? 'activé' : 'désactivé'}.`);
      }
      case 'test':
        return interaction.reply({ embeds: [analysisCard(client, interaction.guild, interaction.options.getString('texte'))], ephemeral: true });
      case 'stats':
        return interaction.reply({ embeds: [statsCard(client, interaction.guild, interaction.options.getInteger('jours') ?? 7)], ephemeral: true });
      case 'escalade': {
        const patch = { enabled: interaction.options.getBoolean('actif') };
        const win = interaction.options.getInteger('fenetre');
        if (win != null) patch.windowMinutes = win;
        config.update(guildId, { automod: { escalation: patch } });
        return panel(`Sanctions progressives ${patch.enabled ? 'activées' : 'désactivées'}.`);
      }
      case 'nouveaux': {
        const o = interaction.options;
        const patch = { enabled: o.getBoolean('actif') };
        for (const [opt, key, getter] of [
          ['age_compte', 'accountAgeDays', 'getInteger'],
          ['anciennete', 'joinedMinutes', 'getInteger'],
          ['liens', 'blockLinks', 'getBoolean'],
          ['invitations', 'blockInvites', 'getBoolean'],
          ['fichiers', 'blockMedia', 'getBoolean'],
        ]) {
          const v = o[getter](opt);
          if (v != null) patch[key] = v;
        }
        config.update(guildId, { automod: { newMembers: patch } });
        return panel(`Protection des nouveaux venus ${patch.enabled ? 'activée' : 'désactivée'}.`);
      }
      case 'notification': {
        const mode = interaction.options.getString('mode');
        config.update(guildId, { automod: { notify: mode } });
        return panel(`Notification : **${NOTIFY_LABELS[mode]}**.`);
      }
      case 'ignore': {
        const channel = interaction.options.getChannel('salon');
        const role = interaction.options.getRole('role');
        if (!channel && !role) throw new UserError('Indiquez un salon ou un rôle.');
        const msgs = [];
        if (channel) {
          const set = new Set(cfg().ignoredChannels);
          set.has(channel.id) ? set.delete(channel.id) : set.add(channel.id);
          config.update(guildId, { automod: { ignoredChannels: [...set] } });
          msgs.push(`${channel} ${set.has(channel.id) ? 'est désormais ignoré' : 'n\'est plus ignoré'}.`);
        }
        if (role) {
          const set = new Set(cfg().ignoredRoles);
          set.has(role.id) ? set.delete(role.id) : set.add(role.id);
          config.update(guildId, { automod: { ignoredRoles: [...set] } });
          msgs.push(`${role} ${set.has(role.id) ? 'est désormais ignoré' : 'n\'est plus ignoré'}.`);
        }
        return panel(msgs.join(' '));
      }
      case 'discord':
        return handleNative(interaction, client);
      default:
        throw new UserError('Sous-commande inconnue.');
    }
  },

  buttons: {
    /** cmd:automod:toggle:<on|off> — « Gérer le serveur » revérifiée. */
    async toggle(interaction, client, [state]) {
      requirePermission(interaction, 'ManageGuild');
      const enabled = state === 'on';
      client.services.config.update(interaction.guildId, { automod: { enabled } });
      await interaction.update(renderPanel(client, interaction.guildId, `AutoMod **${enabled ? 'activé' : 'désactivé'}**.`));
    },
    /** cmd:automod:test — ouvre le formulaire de test. */
    async test(interaction) {
      requirePermission(interaction, 'ManageGuild');
      await interaction.showModal(testModal());
    },
    /** cmd:automod:testsubmit — soumission du formulaire de test. */
    async testsubmit(interaction, client) {
      requirePermission(interaction, 'ManageGuild');
      const text = interaction.fields.getTextInputValue('text');
      await interaction.reply({ embeds: [analysisCard(client, interaction.guild, text)], ephemeral: true });
    },
    /** cmd:automod:stats:<jours> */
    async stats(interaction, client, [days]) {
      requirePermission(interaction, 'ManageGuild');
      const n = Math.min(30, Math.max(1, Number.parseInt(days, 10) || 7));
      await interaction.reply({ embeds: [statsCard(client, interaction.guild, n)], ephemeral: true });
    },
  },
};

async function handleNative(interaction, client) {
  const action = interaction.options.getString('action');
  const guild = interaction.guild;
  await interaction.deferReply({ ephemeral: true });
  if (action === 'status') {
    const rules = await native.ownRules(guild).catch(() => null);
    if (!rules) throw new UserError('Impossible de lire les règles AutoMod de Discord (permission **Gérer le serveur** requise).');
    return interaction.editReply({
      embeds: [
        card({
          tone: rules.length ? 'success' : 'neutral',
          section: 'automod',
          icon: '🛡️',
          title: 'AutoMod natif de Discord',
          description: [
            rules.length ? `${rules.length} règle(s) gérée(s) par le bot :` : 'Aucune règle native gérée par le bot.',
            ...rules.map((r) => `${r.enabled ? '🟢' : '🔴'} **${r.name}**`),
            '',
            subtext('Ces règles bloquent les messages avant leur envoi, même quand le bot est hors ligne.'),
          ],
        }),
      ],
    });
  }
  if (action === 'remove') {
    const n = await native.remove(guild);
    return interaction.editReply({ embeds: [status.ok(`${n} règle(s) native(s) retirée(s).`, 'AutoMod natif')] });
  }
  const cfg = client.services.config.get(guild.id);
  const result = await native.sync(guild, cfg.automod, cfg.logChannels?.automod);
  const ok = result.created.length + result.updated.length;
  return interaction.editReply({
    embeds: [
      card({
        tone: result.failed.length ? (ok ? 'warning' : 'danger') : ok ? 'success' : 'neutral',
        section: 'automod',
        icon: '🛡️',
        title: 'AutoMod natif synchronisé',
        description: [
          ...result.created.map((n) => `🆕 ${n}`),
          ...result.updated.map((n) => `🔄 ${n}`),
          ...(result.removed ?? []).map((n) => `🗑️ ${n} (filtre désactivé)`),
          ...result.failed.map((f) => `${ICONS.error} ${f.name} — ${f.reason}`),
          '',
          ok ? null : 'Aucun filtre compatible n\'est actif (mots interdits, anti-spam, mentions de masse).',
          subtext('Bloque avant l\'envoi, même bot hors ligne. Discord exempte d\'office « Gérer le serveur » et les administrateurs. Relancez après avoir modifié vos filtres.'),
        ],
      }),
    ],
  });
}
