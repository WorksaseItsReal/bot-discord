'use strict';

const { embeds } = require('../utils/embeds');
const { discordTimestamp } = require('../utils/time');

module.exports = {
  name: 'guildMemberRemove',
  /** @param {import('../core/GadgetClient').GadgetClient} client */
  async execute(client, member) {
    const roles = member.roles?.cache?.filter((r) => r.id !== member.guild.id).map((r) => r.toString()).join(', ') || 'Aucun';
    const embed = embeds.neutral('📤 Départ d\'un membre').addFields(
      { name: 'Membre', value: `${member.user} (${member.id})`, inline: false },
      { name: 'A rejoint', value: member.joinedTimestamp ? discordTimestamp(member.joinedTimestamp) : 'Inconnu', inline: true },
      { name: 'Rôles', value: roles.slice(0, 1024), inline: false },
    ).setThumbnail(member.user.displayAvatarURL());
    await client.services.logging.send(member.guild.id, 'members', embed);
  },
};
