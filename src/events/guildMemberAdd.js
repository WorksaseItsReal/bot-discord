'use strict';

const { discordTimestamp } = require('../utils/time');
const { field, wide, ICONS, userLine, code } = require('../utils/ui');
const { logCard } = require('../services/LoggingService');
const { createLogger } = require('../core/logger');

const logger = createLogger('guildMemberAdd');

const DAY_MS = 24 * 60 * 60 * 1000;
/** En dessous de cet âge, un compte est signalé comme récent. */
const NEW_ACCOUNT_DAYS = 7;

/**
 * Réapplique le rôle Muted à un membre qui revient avec un mute encore actif
 * (sans échéance ou échéance future) : quitter/rejoindre ne doit pas lever un mute.
 * N'en crée jamais : utilise le rôle configuré (ou « Muted ») s'il existe.
 * @returns {Promise<object|null>} la sanction réappliquée, ou null
 */
async function reapplyMute(client, member) {
  const sanction = client.repositories?.sanctions?.activeMute?.(member.guild.id, member.id);
  if (!sanction) return null;
  const role = client.services?.moderation?.mutedRole?.(member.guild);
  if (!role) {
    logger.debug(`Mute actif #${sanction.id} mais aucun rôle Muted sur ${member.guild.id}`);
    return null;
  }
  if (member.roles.cache.has(role.id)) return null;
  try {
    await member.roles.add(role, `Mute #${sanction.id} toujours actif (retour sur le serveur)`);
  } catch (e) {
    logger.debug('reapplyMute', e?.message);
    return null;
  }
  const embed = logCard({
    category: 'moderation',
    tone: 'caution',
    icon: ICONS.mute,
    title: 'Mute réappliqué',
    description: `${member.user} est revenu sur le serveur avec un mute encore actif : le rôle ${role} lui a été remis.`,
    user: member.user,
    fields: [
      field(ICONS.user, 'Membre', userLine(member.user)),
      field(ICONS.id, 'Sanction', code(`#${sanction.id}`)),
      field(ICONS.expires, 'Fin', sanction.expires_at ? discordTimestamp(sanction.expires_at, 'R') : 'Indéterminée'),
    ],
  });
  await client.services.logging.send(member.guild.id, 'moderation', embed, undefined, { event: 'sanction' }).catch(() => {});
  return sanction;
}

module.exports = {
  name: 'guildMemberAdd',
  reapplyMute,
  /** @param {import('../core/GadgetClient').GadgetClient} client */
  async execute(client, member) {
    const raid = await client.services.antiraid.handleJoin(member).catch(() => null);
    const user = member.user;
    const created = user.createdTimestamp;
    const recent = Date.now() - created < NEW_ACCOUNT_DAYS * DAY_MS;
    const embed = logCard({
      category: 'members',
      tone: 'success',
      icon: '📥',
      title: user.bot ? 'Bot ajouté' : 'Nouveau membre',
      description: `${user} a rejoint le serveur.`,
      user,
      fields: [
        field(ICONS.user, 'Membre', userLine(user)),
        field(ICONS.date, 'Compte créé', `${discordTimestamp(created, 'D')}\n${discordTimestamp(created, 'R')}`),
        field(ICONS.members, 'Membres', `**${member.guild.memberCount}**`),
        recent ? wide(ICONS.warning, 'Compte récent', `Ce compte a moins de ${NEW_ACCOUNT_DAYS} jours.`) : null,
      ],
    });
    await client.services.logging.send(member.guild.id, 'members', embed, undefined, { event: 'memberJoin' });
    // Membre expulsé/banni par l'AntiRaid : il n'est plus là, rien à réappliquer.
    if (!raid?.punished) await reapplyMute(client, member).catch((e) => logger.debug('reapplyMute', e?.message));
  },
};
