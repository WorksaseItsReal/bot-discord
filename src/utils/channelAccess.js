'use strict';

const { PermissionFlagsBits, ChannelType } = require('discord.js');

/** Permissions minimales pour lire un salon (et son historique). */
const READ_PERMS = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory];

/**
 * Le membre peut-il lire ce salon (d'après le cache) ? Les fils héritent des permissions de
 * leur salon parent ; un fil PRIVÉ n'est en plus lisible que par ses membres et par
 * « Gérer les fils ». `extra` : permissions supplémentaires exigées (ex. « Gérer les messages »).
 * @returns {boolean}
 */
function canReadCached(channel, member, extra = []) {
  const perms = member ? channel?.permissionsFor?.(member) : null;
  if (!perms?.has([...READ_PERMS, ...extra])) return false;
  if (channel.type !== ChannelType.PrivateThread) return true;
  return Boolean(channel.members?.cache?.has?.(member.id)) || perms.has(PermissionFlagsBits.ManageThreads);
}

/** Un fil privé dont l'appartenance du membre ne peut être tranchée que par Discord ? */
function needsThreadCheck(channel, member, extra = []) {
  const perms = member ? channel?.permissionsFor?.(member) : null;
  return Boolean(
    channel?.type === ChannelType.PrivateThread
      && perms?.has([...READ_PERMS, ...extra])
      && !perms.has(PermissionFlagsBits.ManageThreads)
      && !channel.members?.cache?.has?.(member.id),
  );
}

/**
 * Comme `canReadCached`, mais un fil privé absent du cache des membres du fil (redémarrage,
 * fil ancien) est vérifié auprès de Discord : le cache seul donnerait un faux refus.
 * @returns {Promise<boolean>}
 */
async function canRead(channel, member, extra = []) {
  if (canReadCached(channel, member, extra)) return true;
  if (!needsThreadCheck(channel, member, extra)) return false;
  const joined = await Promise.resolve(channel.members?.fetch?.(member.id)).catch(() => null);
  return Boolean(joined);
}

module.exports = { READ_PERMS, canReadCached, needsThreadCheck, canRead };
