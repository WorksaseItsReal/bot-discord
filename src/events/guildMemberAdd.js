'use strict';

const { discordTimestamp } = require('../utils/time');
const { field, wide, ICONS, userLine } = require('../utils/ui');
const { logCard } = require('../services/LoggingService');

const DAY_MS = 24 * 60 * 60 * 1000;
/** En dessous de cet âge, un compte est signalé comme récent. */
const NEW_ACCOUNT_DAYS = 7;

module.exports = {
  name: 'guildMemberAdd',
  /** @param {import('../core/GadgetClient').GadgetClient} client */
  async execute(client, member) {
    await client.services.antiraid.handleJoin(member).catch(() => {});
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
    await client.services.logging.send(member.guild.id, 'members', embed);
  },
};
