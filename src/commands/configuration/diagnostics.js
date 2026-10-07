'use strict';

const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { truncate, progressBar } = require('../../utils/embeds');
const { card, wide, subtext, ICONS, actionButton, buttonRows, ButtonStyle } = require('../../utils/ui');
const { UserError } = require('../../core/errors');

const RECOMMENDED_PERMS = [
  ['Voir les salons', PermissionFlagsBits.ViewChannel],
  ['Envoyer des messages', PermissionFlagsBits.SendMessages],
  ['Intégrer des liens', PermissionFlagsBits.EmbedLinks],
  ['Bannir des membres', PermissionFlagsBits.BanMembers],
  ['Expulser des membres', PermissionFlagsBits.KickMembers],
  ['Exclure temporairement', PermissionFlagsBits.ModerateMembers],
  ['Gérer les messages', PermissionFlagsBits.ManageMessages],
  ['Gérer les rôles', PermissionFlagsBits.ManageRoles],
  ['Gérer les salons', PermissionFlagsBits.ManageChannels],
  ['Voir les logs d\'audit', PermissionFlagsBits.ViewAuditLog],
];

/** Niveau d'un contrôle → pastille. Seuls ok / warn / fail comptent dans le score. */
const LEVEL = Object.freeze({ ok: ICONS.success, warn: ICONS.warning, fail: ICONS.error, info: ICONS.info });

const WRITE_PERMS = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks];

/**
 * Analyse la configuration d'un serveur. Pur vis-à-vis de Discord (lit seulement les caches).
 * @returns {Array<{ icon: string, label: string, checks: Array<{ level: keyof LEVEL, text: string, tip?: string }> }>}
 */
function analyze(guild, cfg) {
  const me = guild.members.me;
  const groups = [];

  // 1) Permissions du bot
  const perms = { icon: '🔑', label: 'Permissions du bot', checks: [] };
  if (me?.permissions.has(PermissionFlagsBits.Administrator, false)) {
    perms.checks.push({ level: 'ok', text: '**Administrateur** : toutes les permissions' });
  } else {
    for (const [label, flag] of RECOMMENDED_PERMS) {
      const ok = Boolean(me?.permissions.has(flag));
      perms.checks.push({ level: ok ? 'ok' : 'warn', text: label, tip: ok ? null : `Accordez-moi **${label}** dans les paramètres de mon rôle.` });
    }
  }
  groups.push(perms);

  // 2) Hiérarchie des rôles
  const hierarchy = { icon: ICONS.role, label: 'Hiérarchie des rôles', checks: [] };
  if (me) {
    const above = guild.roles.cache.filter((r) => r.position > me.roles.highest.position).size;
    hierarchy.checks.push(
      above <= 1
        ? { level: 'ok', text: `Mon rôle ${me.roles.highest} est en haut de la liste` }
        : { level: 'warn', text: `**${above}** rôles au-dessus du mien : je ne peux pas modérer leurs membres`, tip: 'Remontez mon rôle dans **Paramètres du serveur › Rôles**.' },
    );
  }
  groups.push(hierarchy);

  // 3) Salons de logs
  const logs = { icon: ICONS.list, label: 'Salons de logs', checks: [] };
  const logEntries = Object.entries(cfg.logChannels || {}).filter(([, id]) => id);
  if (!logEntries.length) {
    logs.checks.push({ level: 'info', text: 'Aucun salon de logs configuré', tip: 'Configurez au moins les logs de modération : `/logs`.' });
  }
  for (const [cat, id] of logEntries) logs.checks.push(channelCheck(guild, me, id, `Logs « ${cat} »`, '/logs'));
  groups.push(logs);

  // 4) Modules : salons configurés encore valides + état
  const modules = { icon: ICONS.settings, label: 'Modules', checks: [] };
  modules.checks.push({ level: 'info', text: `Strikes ${cfg.strikes?.enabled ? 'activés' : 'désactivés'} · AutoMod ${cfg.automod?.enabled ? 'actif' : 'inactif'} · AntiRaid ${cfg.antiraid?.enabled ? 'actif' : 'inactif'}` });
  const refs = [
    [cfg.antiraid?.alertChannel, 'Alertes AntiRaid', '/antiraid'],
    [cfg.tickets?.categoryId, 'Catégorie des tickets', '/ticket'],
    [cfg.tickets?.logChannel, 'Logs des tickets', '/ticket'],
    [cfg.modmail?.categoryId, 'Catégorie du modmail', '/modmail'],
    [cfg.suggestions?.channelId, 'Salon des suggestions', '/suggestion'],
    [cfg.tempVoice?.enabled ? cfg.tempVoice.hubChannelId : null, 'Salon « Créer un vocal »', '/tempvoice'],
    [cfg.projects?.channelId, 'Salon des projets', '/projet config'],
  ];
  for (const [id, label, cmd] of refs) if (id) modules.checks.push(channelCheck(guild, me, id, label, cmd));
  if (cfg.antiraid?.enabled && !cfg.antiraid.alertChannel) {
    modules.checks.push({ level: 'warn', text: 'AntiRaid actif sans salon d\'alerte', tip: 'Définissez un salon d\'alerte AntiRaid pour être prévenu des raids.' });
  }
  groups.push(modules);

  return groups;
}

/** Vérifie qu'un salon configuré existe encore et que je peux y écrire. */
function channelCheck(guild, me, id, label, command) {
  const channel = guild.channels.cache.get(id);
  if (!channel) return { level: 'fail', text: `${label} : salon introuvable (supprimé ?)`, tip: `Reconfigurez **${label}** avec \`${command}\`.` };
  if (channel.isTextBased?.() && me) {
    const perms = channel.permissionsFor(me);
    if (perms && !perms.has(WRITE_PERMS)) {
      return { level: 'warn', text: `${label} : ${channel} · accès refusé`, tip: `Autorisez-moi à écrire et intégrer des liens dans ${channel}.` };
    }
  }
  return { level: 'ok', text: `${label} : ${channel}` };
}

/** Score (0-100) : un avertissement compte pour moitié, une erreur pour zéro. */
function score(groups) {
  const all = groups.flatMap((g) => g.checks);
  const ok = all.filter((c) => c.level === 'ok').length;
  const warn = all.filter((c) => c.level === 'warn').length;
  const fail = all.filter((c) => c.level === 'fail').length;
  const total = ok + warn + fail;
  return { ok, warn, fail, percent: total ? Math.round(((ok + warn * 0.5) / total) * 100) : 100 };
}

function grade(s) {
  if (s.fail) return ['🔴', 'Problèmes détectés', 'danger'];
  if (s.warn) return ['🟡', 'Quelques points d\'attention', 'warning'];
  return ['🟢', 'Tout est en ordre', 'success'];
}

function render(guild, cfg) {
  const groups = analyze(guild, cfg);
  const s = score(groups);
  const [dot, label, tone] = grade(s);
  const tips = groups.flatMap((g) => g.checks).filter((c) => c.tip && c.level !== 'ok').map((c) => `› ${c.tip}`);
  const plural = (n, w) => `${n} ${w}${n > 1 ? 's' : ''}`;
  return {
    embeds: [
      card({
        tone,
        section: 'configuration',
        icon: ICONS.search,
        title: 'Diagnostic du serveur',
        description: [
          `${dot} **${label}** · score **${s.percent} %**`,
          `\`${progressBar(s.percent / 100, 18)}\``,
          subtext(`${plural(s.ok, 'contrôle')} OK · ${plural(s.warn, 'avertissement')} · ${plural(s.fail, 'erreur')}`),
        ],
        thumbnail: guild.iconURL?.({ size: 128 }) ?? null,
        fields: [
          ...groups.filter((g) => g.checks.length).map((g) => {
            const bad = g.checks.filter((c) => c.level === 'warn' || c.level === 'fail').length;
            const name = `${g.label}${bad ? ` · ${bad} à corriger` : ''}`;
            return wide(g.icon, name, truncate(g.checks.map((c) => `${LEVEL[c.level]} ${c.text}`).join('\n'), 1024));
          }),
          tips.length ? wide(ICONS.idea, 'À faire', truncate([...tips.slice(0, 6), tips.length > 6 ? subtext(`… et ${tips.length - 6} autre(s)`) : null].filter(Boolean).join('\n'), 1024)) : null,
        ],
        footer: 'Analyse en direct',
      }),
    ],
    components: buttonRows(actionButton({ command: 'diagnostics', action: 'rerun', label: 'Relancer l\'analyse', emoji: ICONS.refresh, style: ButtonStyle.Primary })),
  };
}

module.exports = {
  category: 'configuration',
  analyze,
  score,
  data: new SlashCommandBuilder()
    .setName('diagnostics')
    .setDescription('Analyse la configuration du serveur et détecte les problèmes.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  /** @param {import('discord.js').ChatInputCommandInteraction} interaction */
  async execute(interaction, client) {
    const { guild } = interaction;
    await interaction.reply({ ...render(guild, client.services.config.get(guild.id)), ephemeral: true });
  },
  buttons: {
    /** cmd:diagnostics:rerun — relance l'analyse (Gérer le serveur requis). */
    async rerun(interaction, client) {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
        throw new UserError('Il faut la permission **Gérer le serveur** pour relancer le diagnostic.');
      }
      await interaction.update(render(interaction.guild, client.services.config.get(interaction.guildId)));
    },
  },
};
