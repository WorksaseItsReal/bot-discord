'use strict';

const { embeds } = require('../utils/embeds');
const { discordTimestamp } = require('../utils/time');

module.exports = {
  name: 'guildMemberAdd',
  /** @param {import('../core/GadgetClient').GadgetClient} client */
  async execute(client, member) {
    const embed = embeds.neutral('📥 Arrivée d\'un membre').addFields(
      { name: 'Membre', value: `${member.user} (${member.id})`, inline: false },
      { name: 'Compte créé', value: discordTimestamp(member.user.createdTimestamp), inline: true },
      { name: 'Membres', value: `${member.guild.memberCount}`, inline: true },
    ).setThumbnail(member.user.displayAvatarURL());
    await client.services.logging.send(member.guild.id, 'members', embed);
  },
};
