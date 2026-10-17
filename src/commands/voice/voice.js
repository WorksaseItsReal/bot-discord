'use strict';

const { SlashCommandBuilder, PermissionFlagsBits, ChannelType } = require('discord.js');
const { card, field, ICONS, userLine, actionButton, deleteButton, buttonRows, subtext, ButtonStyle } = require('../../utils/ui');
const { assertCanModerate } = require('../../utils/permissions');
const { assertInvoker } = require('../../utils/buttonGuard');
const { UserError } = require('../../core/errors');

/**
 * /voice : gestion des salons vocaux. Chaque action contrôle les droits de l'auteur DANS le vocal
 * concerné (surcharges comprises) : jamais d'action « par procuration » dans un vocal qui lui est
 * fermé (R94). `rassembler` déplace en série jusqu'à 100 membres vers un vocal ; le bouton
 * « Renvoyer chacun » les ramène dans leur salon d'origine (lots gardés 10 min en mémoire).
 */

/** Déplacements au plus par rassemblement. */
const MAX_MOVES = 100;
/** Durée de vie d'un lot (bouton « Renvoyer chacun »). */
const BATCH_TTL_MS = 10 * 60_000;
/** Lots gardés en mémoire au plus (les plus anciens sont oubliés). */
const MAX_BATCHES = 50;
/** Serveurs où un rassemblement (ou un renvoi) est en cours : un à la fois. */
const gathering = new Set();
/** Lots de rassemblement : lotId → { guildId, ownerId, targetId, moves: [{ memberId, fromId }], at }. */
const batches = new Map();

function requirePermission(interaction, flag, label) {
  if (!interaction.memberPermissions?.has(flag)) throw new UserError(`Il faut la permission **${label}** pour faire cela.`);
}

/** L'auteur doit pouvoir rejoindre le salon cible ET y déplacer des membres (pas de déplacement « par procuration »). */
function assertCanMoveTo(interaction, channel) {
  if (!channel.permissionsFor?.(interaction.member)?.has([PermissionFlagsBits.Connect, PermissionFlagsBits.MoveMembers])) {
    throw new UserError(`Vous ne pouvez pas déplacer de membres vers ${channel}.`);
  }
}

/**
 * L'auteur doit voir le vocal CONCERNÉ (celui du membre, ou le salon vidé) et y avoir la permission
 * (surcharges du salon comprises) : jamais d'action dans un vocal qui lui est fermé.
 */
function assertCanActIn(interaction, channel, flag, label) {
  if (typeof channel?.permissionsFor !== 'function') return; // salon partiel : Discord tranchera
  if (!channel.permissionsFor(interaction.member)?.has([PermissionFlagsBits.ViewChannel, flag])) {
    throw new UserError(`Vous ne pouvez pas ${label} dans ${channel} : il vous faut **Voir le salon** et cette permission dans ce salon.`);
  }
}

/** Même contrôle de hiérarchie que kick/mute (sauf sur soi-même). */
function assertCanActOn(interaction, member, action) {
  if (member.id !== interaction.user.id) assertCanModerate(interaction.member, member, interaction.guild.members.me, { action });
}

/** true si l'auteur peut agir sur ce membre (hiérarchie), sans lever d'erreur. */
function canActOn(interaction, member) {
  try {
    assertCanActOn(interaction, member, 'déconnecter');
    return true;
  } catch {
    return false;
  }
}

/**
 * Déconnexions vocales faites PAR LE BOT pour l'auteur : signées du bot dans le journal d'audit
 * (27), elles échapperaient au module Secur voiceKick. Pré-contrôle AVANT (UserError si `count`
 * déconnexions atteindraient le seuil), puis signalement après coup au nom de l'auteur. Se
 * déconnecter soi-même ne compte pas (aucune entrée d'audit quand on le fait à la main). Les
 * déplacements (move, rassembler) ne sont pas comptés par le module (SECUR_MODULES : audit 27 seul).
 */
function preCheckDisconnects(client, interaction, count) {
  if (count > 0) client?.services?.secur?.assertAllowed?.(interaction, 'voiceKick', { count });
}

async function reportDisconnects(client, interaction, count) {
  if (count > 0) await client?.services?.moderation?.reportDestructiveAction?.(interaction.guild, interaction.user, 'voiceKick', { count });
}

/** Membre connecté en vocal, ou erreur claire. */
async function voiceMember(guild, userId) {
  const member = await guild.members.fetch(userId).catch(() => null);
  if (!member) throw new UserError('Membre introuvable.');
  if (!member.voice.channel) throw new UserError(`${member} n'est pas connecté en vocal.`);
  return member;
}

/** Carte micro coupé / réactivé + bouton inverse. */
function muteView(muted, { member, moderator, ownerId }) {
  return {
    embeds: [
      card({
        tone: muted ? 'caution' : 'success',
        section: 'voice',
        icon: muted ? ICONS.mute : ICONS.unmute,
        title: muted ? 'Micro coupé' : 'Micro réactivé',
        description: muted ? `${member} ne peut plus parler en vocal.` : `${member} peut de nouveau parler en vocal.`,
        fields: [
          field(ICONS.user, 'Membre', userLine(member.user ?? member)),
          field(ICONS.voice, 'Salon', member.voice.channel ? `${member.voice.channel}` : '—'),
          field(ICONS.moderator, 'Par', `${moderator}`),
        ],
      }),
    ],
    components: buttonRows(
      muted
        ? actionButton({ command: 'voice', action: 'unmute', args: [member.id, ownerId], label: 'Réactiver', emoji: ICONS.unmute })
        : actionButton({ command: 'voice', action: 'mute', args: [member.id, ownerId], label: 'Couper', emoji: ICONS.mute }),
      deleteButton(ownerId),
    ),
  };
}

/** Carte « membre déplacé » (+ bouton pour le ramener). */
function moveView({ member, from, to, moderator, ownerId, back = false }) {
  return {
    embeds: [
      card({
        tone: 'info',
        section: 'voice',
        icon: back ? '↩️' : '🔀',
        title: back ? 'Membre ramené' : 'Membre déplacé',
        description: `${member} est maintenant dans ${to}.`,
        fields: [
          field(ICONS.user, 'Membre', userLine(member.user ?? member)),
          field('📤', 'Depuis', from ? `${from}` : '—'),
          field('📥', 'Vers', `${to}`),
          field(ICONS.moderator, 'Par', `${moderator}`),
        ],
      }),
    ],
    components: buttonRows(
      from && !back ? actionButton({ command: 'voice', action: 'moveback', args: [member.id, from.id, ownerId], label: 'Ramener', emoji: '↩️' }) : null,
      deleteButton(ownerId),
    ),
  };
}

/**
 * Plan d'un rassemblement (pur) : qui déplacer, depuis où, et ce qui est ignoré.
 * @param {{ sources: Array<{ id: string, allowed: boolean, members: object[] }>, targetId: string,
 *   includeBots?: boolean, canAct: (member: object) => boolean, max?: number }} input
 * @returns {{ moves: Array<{ member: object, fromId: string }>, skipped: { hierarchy: number, bots: number, inTarget: number },
 *   skippedChannels: number, truncated: number }}
 */
function planMoves({ sources, targetId, includeBots = false, canAct, max = MAX_MOVES }) {
  const moves = [];
  const skipped = { hierarchy: 0, bots: 0, inTarget: 0 };
  let skippedChannels = 0;
  let truncated = 0;
  for (const source of sources) {
    if (source.id === targetId) continue;
    // Salon fermé à l'auteur : ignoré et compté, SANS rien révéler de ses occupants.
    if (!source.allowed) {
      skippedChannels += 1;
      continue;
    }
    for (const member of source.members) {
      if (member.voice?.channelId === targetId) {
        skipped.inTarget += 1;
        continue;
      }
      if (member.user?.bot && !includeBots) {
        skipped.bots += 1;
        continue;
      }
      if (!canAct(member)) {
        skipped.hierarchy += 1;
        continue;
      }
      if (moves.length >= max) {
        truncated += 1;
        continue;
      }
      moves.push({ member, fromId: source.id });
    }
  }
  return { moves, skipped, skippedChannels, truncated };
}

/** Oubli paresseux des lots expirés (aucun minuteur), puis plafond. */
function pruneBatches(now = Date.now()) {
  for (const [id, lot] of batches) if (now - lot.at > BATCH_TTL_MS) batches.delete(id);
  while (batches.size > MAX_BATCHES) batches.delete(batches.keys().next().value);
}

function rememberBatch(lot, now = Date.now()) {
  pruneBatches(now);
  const id = `${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  batches.set(id, { ...lot, at: now });
  pruneBatches(now);
  return id;
}

const plural = (n, one, many = `${one}s`) => `${n} ${n > 1 ? many : one}`;

/** Carte du bilan d'un rassemblement (+ bouton « Renvoyer chacun »). */
function gatherView({ target, moved, plan, failed, gone, moderator, ownerId, lotId }) {
  const ignored = plan.skipped.hierarchy + plan.skipped.bots + plan.skipped.inTarget + gone;
  const details = [
    plan.skipped.hierarchy ? `${plural(plan.skipped.hierarchy, 'membre')} au rôle supérieur ou égal au vôtre` : null,
    plan.skipped.bots ? `${plural(plan.skipped.bots, 'bot')} (option « bots » pour les inclure)` : null,
    gone ? `${plural(gone, 'membre')} parti(s) entre-temps` : null,
  ].filter(Boolean);
  return {
    embeds: [
      card({
        tone: moved ? 'info' : 'neutral',
        section: 'voice',
        icon: '🧲',
        title: moved ? 'Membres rassemblés' : 'Personne à déplacer',
        description: [
          moved ? `**${plural(moved, 'membre')}** déplacé${moved > 1 ? 's' : ''} vers ${target}.` : `Aucun membre n'a été déplacé vers ${target}.`,
          plan.truncated ? subtext(`${MAX_MOVES} déplacements au plus : ${plural(plan.truncated, 'membre')} restant(s), relancez la commande.`) : null,
          details.length ? subtext(`Ignorés : ${details.join(' · ')}.`) : null,
        ],
        fields: [
          field('📥', 'Vers', `${target}`),
          field(ICONS.success, 'Déplacés', `**${moved}**`),
          field('⏭️', 'Ignorés', `**${ignored}**`),
          field(ICONS.lock, 'Salons ignorés', `**${plan.skippedChannels}**`),
          field(ICONS.error, 'Échecs', `**${failed}**`),
          field(ICONS.moderator, 'Par', `${moderator}`),
        ],
        footer: lotId ? 'Renvoi possible pendant 10 minutes' : undefined,
      }),
    ],
    components: buttonRows(
      lotId ? actionButton({ command: 'voice', action: 'scatter', args: [lotId, ownerId], label: 'Renvoyer chacun', emoji: '↩️', style: ButtonStyle.Primary }) : null,
      deleteButton(ownerId),
    ),
  };
}

/** /voice rassembler [vers] [depuis] [bots] */
async function gather(interaction) {
  const guild = interaction.guild;
  const ownerId = interaction.user.id;
  const pickedTarget = interaction.options.getChannel('vers');
  const target = pickedTarget ? guild.channels.cache.get(pickedTarget.id) ?? pickedTarget : interaction.member?.voice?.channel ?? null;
  if (!target) throw new UserError('Rejoignez un salon vocal, ou précisez le salon d\'arrivée avec l\'option « vers ».');
  if (!target.isVoiceBased?.()) throw new UserError('Le salon d\'arrivée doit être un salon vocal.');
  assertCanMoveTo(interaction, target);
  const me = guild.members.me;
  if (me && target.permissionsFor?.(me) && !target.permissionsFor(me).has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.MoveMembers])) {
    throw new UserError(`Il me faut **Voir le salon**, **Se connecter** et **Déplacer des membres** dans ${target}.`);
  }
  const includeBots = interaction.options.getBoolean('bots') ?? false;
  const pickedSource = interaction.options.getChannel('depuis');
  let sourceChannels;
  if (pickedSource) {
    const source = guild.channels.cache.get(pickedSource.id) ?? pickedSource;
    if (source.id === target.id) throw new UserError('Le salon de départ et le salon d\'arrivée sont identiques.');
    // Source choisie explicitement : refus clair plutôt qu'un salon « ignoré ».
    assertCanActIn(interaction, source, PermissionFlagsBits.MoveMembers, 'déplacer des membres');
    sourceChannels = [source];
  } else {
    // Tous les vocaux sauf la cible et l'AFK (les salons de conférence ne sont pas des vocaux ici).
    sourceChannels = [...guild.channels.cache.values()].filter((c) => c.type === ChannelType.GuildVoice && c.id !== target.id && c.id !== guild.afkChannelId);
  }
  if (gathering.has(guild.id)) throw new UserError('Un rassemblement est déjà en cours sur ce serveur : attendez qu\'il se termine.');
  gathering.add(guild.id);
  try {
    // Déplacements en série : l'opération peut durer.
    await interaction.deferReply();
    const sources = sourceChannels.map((c) => ({
      id: c.id,
      allowed: typeof c.permissionsFor !== 'function' || Boolean(c.permissionsFor(interaction.member)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.MoveMembers])),
      members: [...(c.members?.values?.() ?? [])],
    }));
    const plan = planMoves({ sources, targetId: target.id, includeBots, canAct: (m) => canActOn(interaction, m) });
    const done = [];
    let failed = 0;
    let gone = 0;
    for (const { member, fromId } of plan.moves) {
      // Parti ou déplacé entre-temps : on ne le ramène pas de force.
      if (member.voice?.channelId !== fromId) {
        gone += 1;
        continue;
      }
      try {
        await member.voice.setChannel(target, `Rassemblement par ${interaction.user.tag}`);
        done.push({ memberId: member.id, fromId });
      } catch {
        failed += 1;
      }
    }
    const lotId = done.length ? rememberBatch({ guildId: guild.id, ownerId, targetId: target.id, moves: done }) : null;
    return interaction.editReply(gatherView({ target, moved: done.length, plan, failed, gone, moderator: interaction.user, ownerId, lotId }));
  } finally {
    gathering.delete(guild.id);
  }
}

/** cmd:voice:scatter:<lotId>:<ownerId> — renvoie chaque membre dans son salon d'origine (revérifié). */
async function scatter(interaction, client, [lotId, ownerId]) {
  requirePermission(interaction, PermissionFlagsBits.MoveMembers, 'Déplacer des membres');
  assertInvoker(interaction, ownerId);
  const guild = interaction.guild;
  pruneBatches();
  const lot = batches.get(lotId);
  if (!lot || lot.guildId !== guild.id || lot.ownerId !== interaction.user.id) {
    throw new UserError('Ce rassemblement a expiré (10 minutes, ou redémarrage du bot) : renvoyez les membres à la main.');
  }
  const target = guild.channels.cache.get(lot.targetId);
  if (target) assertCanActIn(interaction, target, PermissionFlagsBits.MoveMembers, 'déplacer des membres');
  if (gathering.has(guild.id)) throw new UserError('Un rassemblement est déjà en cours sur ce serveur : attendez qu\'il se termine.');
  // Lot consommé tout de suite : un double clic ne renvoie qu'une fois.
  batches.delete(lotId);
  gathering.add(guild.id);
  try {
    await interaction.deferUpdate();
    let back = 0;
    let skipped = 0;
    let failed = 0;
    for (const { memberId, fromId } of lot.moves) {
      const member = guild.members.cache.get(memberId);
      const from = guild.channels.cache.get(fromId);
      // Chaque retour est revérifié : toujours dans le salon d'arrivée, salon d'origine encore là
      // et ouvert à l'auteur (Voir, Se connecter, Déplacer), hiérarchie respectée.
      const allowed = member && from?.isVoiceBased?.() && member.voice?.channelId === lot.targetId
        && from.permissionsFor?.(interaction.member)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.MoveMembers])
        && canActOn(interaction, member);
      if (!allowed) {
        skipped += 1;
        continue;
      }
      try {
        await member.voice.setChannel(from, `Renvoi après rassemblement par ${interaction.user.tag}`);
        back += 1;
      } catch {
        failed += 1;
      }
    }
    await interaction.editReply({
      embeds: [
        card({
          tone: back ? 'success' : 'neutral',
          section: 'voice',
          icon: '↩️',
          title: back ? 'Membres renvoyés' : 'Personne à renvoyer',
          description: back ? `**${plural(back, 'membre')}** renvoyé${back > 1 ? 's' : ''} dans leur salon d'origine.` : 'Aucun membre n\'a pu être renvoyé.',
          fields: [
            field(ICONS.success, 'Renvoyés', `**${back}**`),
            field('⏭️', 'Ignorés', `**${skipped}**`),
            field(ICONS.error, 'Échecs', `**${failed}**`),
          ],
        }),
      ],
      components: buttonRows(deleteButton(ownerId)),
    });
  } finally {
    gathering.delete(guild.id);
  }
}

module.exports = {
  category: 'voice',
  planMoves,
  /** Contrôle des droits de l'auteur DANS un vocal (surcharges comprises), exporté pour les tests. */
  assertVoiceAuthority: assertCanActIn,
  _batches: batches,
  _gathering: gathering,
  data: new SlashCommandBuilder()
    .setName('voice')
    .setDescription('Gestion des salons vocaux.')
    .setDefaultMemberPermissions(PermissionFlagsBits.MoveMembers)
    .addSubcommand((s) =>
      s.setName('move').setDescription('Déplace un membre vers un salon vocal.')
        .addUserOption((o) => o.setName('membre').setDescription('Membre connecté en vocal').setRequired(true))
        .addChannelOption((o) => o.setName('salon').setDescription('Salon vocal').addChannelTypes(ChannelType.GuildVoice).setRequired(true)))
    .addSubcommand((s) =>
      s.setName('kick').setDescription('Déconnecte un membre du vocal.')
        .addUserOption((o) => o.setName('membre').setDescription('Membre connecté en vocal').setRequired(true)))
    .addSubcommand((s) =>
      s.setName('mute').setDescription('Coupe le micro d\'un membre en vocal.')
        .addUserOption((o) => o.setName('membre').setDescription('Membre connecté en vocal').setRequired(true)))
    .addSubcommand((s) =>
      s.setName('unmute').setDescription('Réactive le micro d\'un membre.')
        .addUserOption((o) => o.setName('membre').setDescription('Membre connecté en vocal').setRequired(true)))
    .addSubcommand((s) =>
      s.setName('disconnect').setDescription('Déconnecte un membre (alias de kick).')
        .addUserOption((o) => o.setName('membre').setDescription('Membre connecté en vocal').setRequired(true)))
    .addSubcommand((s) =>
      s.setName('cleanup').setDescription('Déconnecte tous les membres d\'un salon vocal.')
        .addChannelOption((o) => o.setName('salon').setDescription('Salon vocal').addChannelTypes(ChannelType.GuildVoice).setRequired(true)))
    .addSubcommand((s) =>
      s.setName('rassembler').setDescription('Déplace les membres des autres vocaux vers un même salon (100 au plus).')
        .addChannelOption((o) => o.setName('vers').setDescription('Salon d\'arrivée (par défaut : votre salon vocal)').addChannelTypes(ChannelType.GuildVoice))
        .addChannelOption((o) => o.setName('depuis').setDescription('Ne vider que ce salon (par défaut : tous les vocaux)').addChannelTypes(ChannelType.GuildVoice))
        .addBooleanOption((o) => o.setName('bots').setDescription('Déplacer aussi les bots (non par défaut)'))),

  async execute(interaction, client) {
    const sub = interaction.options.getSubcommand();
    const ownerId = interaction.user.id;

    if (sub === 'rassembler') return gather(interaction);

    if (sub === 'cleanup') {
      const channel = interaction.options.getChannel('salon');
      assertCanActIn(interaction, interaction.guild.channels?.cache?.get(channel.id) ?? channel, PermissionFlagsBits.MoveMembers, 'déconnecter des membres');
      // Membres au rôle supérieur ou égal (ou propriétaire, ou le bot) : ignorés.
      const targets = [...channel.members.values()].filter((m) => canActOn(interaction, m));
      const protectedCount = channel.members.size - targets.length;
      const others = (list) => list.filter((m) => m.id !== interaction.user.id).length;
      preCheckDisconnects(client, interaction, others(targets));
      await interaction.deferReply({ ephemeral: true });
      let n = 0;
      let failed = 0;
      const done = [];
      for (const m of targets) {
        await m.voice.disconnect(`Cleanup vocal par ${interaction.user.tag}`).then(() => {
          n += 1;
          done.push(m);
        }).catch(() => (failed += 1));
      }
      await interaction.editReply({
        embeds: [
          card({
            tone: n ? 'caution' : 'neutral',
            section: 'voice',
            icon: '🧹',
            title: n ? 'Salon vocal vidé' : 'Salon déjà vide',
            description: n
              ? `**${n}** membre${n > 1 ? 's' : ''} déconnecté${n > 1 ? 's' : ''} de ${channel}.`
              : protectedCount ? `Aucun membre de ${channel} ne pouvait être déconnecté par vous.` : `Personne n'était connecté à ${channel}.`,
            fields: [
              field(ICONS.voice, 'Salon', `${channel}`),
              field(ICONS.success, 'Déconnectés', `**${n}**`),
              field(ICONS.error, 'Échecs', `**${failed}**`),
              protectedCount ? field(ICONS.shield, 'Ignorés (hiérarchie)', `**${protectedCount}**`) : null,
            ],
          }),
        ],
      });
      return reportDisconnects(client, interaction, others(done));
    }

    const user = interaction.options.getUser('membre');
    const member = await voiceMember(interaction.guild, user.id);
    const me = interaction.guild.members.me;

    if (sub === 'move') {
      const channel = interaction.options.getChannel('salon');
      const from = member.voice.channel;
      if (from?.id === channel.id) throw new UserError(`${user} est déjà dans ${channel}.`);
      assertCanActOn(interaction, member, 'déplacer');
      assertCanActIn(interaction, from, PermissionFlagsBits.MoveMembers, 'déplacer des membres');
      assertCanMoveTo(interaction, channel);
      await member.voice.setChannel(channel, `Par ${interaction.user.tag}`);
      return interaction.reply(moveView({ member, from, to: channel, moderator: interaction.user, ownerId }));
    }
    if (sub === 'kick' || sub === 'disconnect') {
      assertCanActOn(interaction, member, 'déconnecter');
      const from = member.voice.channel;
      assertCanActIn(interaction, from, PermissionFlagsBits.MoveMembers, 'déconnecter des membres');
      const counted = member.id === interaction.user.id ? 0 : 1;
      preCheckDisconnects(client, interaction, counted);
      await member.voice.disconnect(`Par ${interaction.user.tag}`);
      await interaction.reply({
        embeds: [
          card({
            tone: 'caution',
            section: 'voice',
            icon: ICONS.kick,
            title: 'Membre déconnecté',
            description: `${user} a été déconnecté du vocal.`,
            fields: [field(ICONS.user, 'Membre', userLine(user)), field(ICONS.voice, 'Salon', `${from}`), field(ICONS.moderator, 'Par', `${interaction.user}`)],
          }),
        ],
      });
      return reportDisconnects(client, interaction, counted);
    }
    if (sub === 'mute' || sub === 'unmute') {
      requirePermission(interaction, PermissionFlagsBits.MuteMembers, 'Couper le micro des membres');
      if (member.id !== interaction.user.id) assertCanModerate(interaction.member, member, me, { action: sub === 'mute' ? 'rendre muet' : 'réactiver le micro de' });
      assertCanActIn(interaction, member.voice.channel, PermissionFlagsBits.MuteMembers, 'couper ou réactiver le micro');
      const muted = sub === 'mute';
      if (member.voice.serverMute === muted) throw new UserError(muted ? `Le micro de ${user} est déjà coupé.` : `Le micro de ${user} n'est pas coupé.`);
      await member.voice.setMute(muted, `Par ${interaction.user.tag}`);
      return interaction.reply(muteView(muted, { member, moderator: interaction.user, ownerId }));
    }
  },

  buttons: {
    /** cmd:voice:mute:<memberId>:<ownerId> */
    async mute(interaction, client, [memberId, ownerId]) {
      return toggleMute(interaction, memberId, ownerId, true);
    },
    /** cmd:voice:unmute:<memberId>:<ownerId> */
    async unmute(interaction, client, [memberId, ownerId]) {
      return toggleMute(interaction, memberId, ownerId, false);
    },
    /** cmd:voice:moveback:<memberId>:<channelId>:<ownerId> — ramène le membre dans son salon d'origine. */
    async moveback(interaction, client, [memberId, channelId, ownerId]) {
      requirePermission(interaction, PermissionFlagsBits.MoveMembers, 'Déplacer des membres');
      const member = await voiceMember(interaction.guild, memberId);
      assertCanActOn(interaction, member, 'déplacer');
      const target = interaction.guild.channels.cache.get(channelId);
      if (!target?.isVoiceBased?.()) throw new UserError('Le salon d\'origine n\'existe plus.');
      assertCanMoveTo(interaction, target);
      const from = member.voice.channel;
      if (from?.id === target.id) throw new UserError(`${member} est déjà dans ${target}.`);
      assertCanActIn(interaction, from, PermissionFlagsBits.MoveMembers, 'déplacer des membres');
      await member.voice.setChannel(target, `Par ${interaction.user.tag}`);
      await interaction.update(moveView({ member, from, to: target, moderator: interaction.user, ownerId, back: true }));
    },
    /** cmd:voice:scatter:<lotId>:<ownerId> — « Renvoyer chacun » après /voice rassembler. */
    scatter,
  },
};

async function toggleMute(interaction, memberId, ownerId, muted) {
  requirePermission(interaction, PermissionFlagsBits.MuteMembers, 'Couper le micro des membres');
  const member = await voiceMember(interaction.guild, memberId);
  if (member.id !== interaction.user.id) {
    assertCanModerate(interaction.member, member, interaction.guild.members.me, { action: muted ? 'rendre muet' : 'réactiver le micro de' });
  }
  assertCanActIn(interaction, member.voice.channel, PermissionFlagsBits.MuteMembers, 'couper ou réactiver le micro');
  if (member.voice.serverMute === muted) throw new UserError(muted ? `Le micro de ${member} est déjà coupé.` : `Le micro de ${member} n'est pas coupé.`);
  await member.voice.setMute(muted, `Par ${interaction.user.tag}`);
  await interaction.update(muteView(muted, { member, moderator: interaction.user, ownerId }));
}
