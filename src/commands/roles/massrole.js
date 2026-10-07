'use strict';

const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { progressBar } = require('../../utils/embeds');
const { formatDuration } = require('../../utils/time');
const { card, field, ICONS, subtext } = require('../../utils/ui');
const { UserError } = require('../../core/errors');

const TARGET_LABELS = { all: 'Tous les membres', humans: 'Humains', bots: 'Bots' };
const BATCH = 5;
/** Intervalle minimal entre deux mises à jour de la carte de progression. */
const PROGRESS_EVERY_MS = 3_000;
/** Au-delà, le jeton d'interaction (15 min) est sur le point d'expirer : on édite le message directement. */
const TOKEN_SAFE_MS = 14 * 60 * 1000;
/** Serveurs ayant un /massrole en cours (une seule exécution à la fois par serveur). */
const running = new Set();

/**
 * Éditeur de la réponse : passe par l'interaction tant que son jeton est valide,
 * puis par le message de réponse (récupéré une fois) au-delà de 14 minutes.
 */
function replyEditor(interaction, now = () => Date.now()) {
  const startedAt = interaction.createdTimestamp ?? now();
  let message = null;
  return async (payload) => {
    if (now() - startedAt < TOKEN_SAFE_MS) {
      // Mémorise le message tant que le jeton le permet encore.
      if (!message) message = await interaction.fetchReply().catch(() => null);
      return interaction.editReply(payload);
    }
    if (!message) throw new Error('Message de progression introuvable');
    return message.edit(payload);
  };
}

/** Carte de progression / résultat. Pure. */
function progressCard({ action, role, target, total, done, failed, startedAt, finished }) {
  const processed = done + failed;
  const ratio = total ? processed / total : 1;
  const verb = action === 'add' ? 'Ajout' : 'Retrait';
  return card({
    tone: finished ? (failed ? 'warning' : 'success') : 'info',
    section: 'roles',
    icon: finished ? (failed ? ICONS.warning : ICONS.success) : ICONS.loading,
    title: finished ? `${verb} en masse terminé` : `${verb} en masse en cours…`,
    description: [
      `${action === 'add' ? 'Ajout de' : 'Retrait de'} ${role} · ${TARGET_LABELS[target] ?? target}`,
      `\`${progressBar(ratio, 18)}\` **${Math.round(ratio * 100)} %**`,
      finished ? null : subtext('Traitement par lots pour respecter les limites de Discord.'),
    ],
    fields: [
      field(ICONS.success, 'Mis à jour', `**${done}**`),
      field(ICONS.error, 'Échecs', `**${failed}**`),
      field(ICONS.count, 'Concernés', `**${total}**`),
      field(ICONS.role, 'Rôle', `${role}`),
      field(ICONS.members, 'Cible', TARGET_LABELS[target] ?? target),
      field(ICONS.duration, finished ? 'Durée' : 'Écoulé', formatDuration(Math.max(1000, Date.now() - startedAt))),
    ],
  });
}

/**
 * Ajoute/retire un rôle à TOUS les membres (ou aux humains/bots), par lots pour
 * respecter les rate limits Discord.
 */
module.exports = {
  category: 'roles',
  progressCard,
  replyEditor,
  running,
  data: new SlashCommandBuilder()
    .setName('massrole')
    .setDescription('Ajoute ou retire un rôle en masse.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption((o) => o.setName('action').setDescription('Action').setRequired(true).addChoices({ name: 'add', value: 'add' }, { name: 'remove', value: 'remove' }))
    .addRoleOption((o) => o.setName('role').setDescription('Rôle cible').setRequired(true))
    .addStringOption((o) => o.setName('cible').setDescription('Qui ?').addChoices({ name: 'tous', value: 'all' }, { name: 'humains', value: 'humans' }, { name: 'bots', value: 'bots' })),

  async execute(interaction) {
    const action = interaction.options.getString('action');
    const role = interaction.options.getRole('role');
    const target = interaction.options.getString('cible') || 'all';
    if (role.id === interaction.guild.id) throw new UserError('Le rôle @everyone ne peut pas être attribué ou retiré.');
    if (role.managed) throw new UserError('Ce rôle est géré par une intégration et ne peut pas être attribué manuellement.');
    if (role.position >= interaction.guild.members.me.roles.highest.position) {
      throw new UserError('Ce rôle est trop haut pour que je puisse le gérer.');
    }
    if (interaction.user.id !== interaction.guild.ownerId && role.position >= interaction.member.roles.highest.position) {
      throw new UserError('Ce rôle est au-dessus (ou égal) à votre rôle le plus haut.');
    }

    const guildId = interaction.guild.id;
    if (running.has(guildId)) throw new UserError('Un /massrole est déjà en cours sur ce serveur. Attendez qu\'il se termine.');
    running.add(guildId);
    try {
      await run(interaction, { action, role, target });
    } finally {
      running.delete(guildId);
    }
  },
};

async function run(interaction, { action, role, target }) {
  await interaction.deferReply();
  const edit = replyEditor(interaction);
  const startedAt = Date.now();
  const members = await interaction.guild.members.fetch();
  const filtered = members.filter((m) => {
    if (target === 'humans' && m.user.bot) return false;
    if (target === 'bots' && !m.user.bot) return false;
    return action === 'add' ? !m.roles.cache.has(role.id) : m.roles.cache.has(role.id);
  });

  let done = 0;
  let failed = 0;
  const list = [...filtered.values()];
  const state = () => ({ action, role, target, total: list.length, done, failed, startedAt });
  await edit({ embeds: [progressCard({ ...state(), finished: list.length === 0 })] });
  if (!list.length) return;

  let lastUpdate = Date.now();
  // Traitement par lots pour éviter les rate limits
  for (let i = 0; i < list.length; i += BATCH) {
    const batch = list.slice(i, i + BATCH);
    await Promise.all(
      batch.map((m) =>
        (action === 'add' ? m.roles.add(role) : m.roles.remove(role))
          .then(() => (done += 1))
          .catch(() => (failed += 1)),
      ),
    );
    if (i + BATCH < list.length) {
      if (Date.now() - lastUpdate >= PROGRESS_EVERY_MS) {
        lastUpdate = Date.now();
        await edit({ embeds: [progressCard({ ...state(), finished: false })] }).catch(() => {});
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  await edit({ embeds: [progressCard({ ...state(), finished: true })] });
}
