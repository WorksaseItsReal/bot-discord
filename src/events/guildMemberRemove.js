'use strict';

const { discordTimestamp } = require('../utils/time');
const { field, wide, ICONS, userLine } = require('../utils/ui');
const { logCard, fitList } = require('../services/LoggingService');

module.exports = {
  name: 'guildMemberRemove',
  /** @param {import('../core/GadgetClient').GadgetClient} client */
  async execute(client, member) {
    const user = member.user;
    const roles = member.roles?.cache
      ?.filter((r) => r.id !== member.guild.id)
      .sort((a, b) => b.position - a.position)
      .map((r) => r.toString()) ?? [];
    const joined = member.joinedTimestamp;
    const embed = logCard({
      category: 'members',
      tone: 'neutral',
      icon: '📤',
      title: 'Départ d\'un membre',
      description: `${user} a quitté le serveur.`,
      user,
      fields: [
        field(ICONS.user, 'Membre', userLine(user)),
        field(ICONS.date, 'Arrivée', joined ? `${discordTimestamp(joined, 'D')}\n${discordTimestamp(joined, 'R')}` : '*Inconnue*'),
        field(ICONS.members, 'Membres', `**${member.guild.memberCount}**`),
        wide(ICONS.role, `Rôles (${roles.length})`, fitList(roles) ?? '*Aucun*'),
      ],
    });
    await client.services.logging.send(member.guild.id, 'members', embed);
  },
};
