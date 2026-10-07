'use strict';

/**
 * Préréglages AutoMod (« /automod preset »). Ne touchent qu'aux interrupteurs,
 * actions et seuils : les listes (mots interdits, domaines autorisés…) sont conservées.
 */
const off = (extra = {}) => ({ enabled: false, ...extra });
const on = (extra = {}) => ({ enabled: true, ...extra });

const PRESETS = {
  faible: {
    label: 'Faible',
    emoji: '🟢',
    description: 'Arnaques, invitations et spam massif uniquement. Idéal pour une petite communauté.',
    patch: {
      enabled: true,
      escalation: { enabled: false },
      newMembers: { enabled: false },
      filters: {
        antiSpam: on({ limit: 8, windowSeconds: 5, action: 'timeout', duration: '5m' }),
        antiFlood: off(),
        antiLink: off(),
        antiInvite: on({ action: 'delete' }),
        antiPhishing: on({ threshold: 3, action: 'timeout', duration: '1d' }),
        antiCrossChannel: on({ channels: 4, windowSeconds: 60, minLength: 20, action: 'timeout', duration: '1h' }),
        antiMassMention: on({ limit: 8, action: 'timeout', duration: '10m' }),
        antiCaps: off(),
        badWords: off(),
        antiRepeat: off(),
        antiEmojiSpam: off(),
        antiDuplicate: off(),
        antiWall: off(),
        antiZalgo: on({ action: 'delete' }),
      },
    },
  },
  equilibre: {
    label: 'Équilibré',
    emoji: '🟡',
    description: 'Recommandé : protège efficacement sans gêner les discussions normales.',
    patch: {
      enabled: true,
      escalation: { enabled: true, windowMinutes: 30 },
      newMembers: { enabled: true, accountAgeDays: 3, joinedMinutes: 10, blockLinks: true, blockInvites: true, blockMedia: false },
      filters: {
        antiSpam: on({ limit: 5, windowSeconds: 5, action: 'timeout', duration: '5m' }),
        antiFlood: on({ limit: 8, windowSeconds: 10, action: 'delete' }),
        antiLink: off(),
        antiInvite: on({ action: 'delete' }),
        antiPhishing: on({ threshold: 3, action: 'timeout', duration: '1d' }),
        antiCrossChannel: on({ channels: 3, windowSeconds: 60, minLength: 20, action: 'timeout', duration: '1h' }),
        antiMassMention: on({ limit: 5, action: 'timeout', duration: '10m' }),
        antiCaps: on({ percent: 75, minLength: 15, action: 'delete' }),
        badWords: on({ action: 'delete' }),
        antiRepeat: on({ action: 'delete' }),
        antiEmojiSpam: on({ limit: 12, action: 'delete' }),
        antiDuplicate: off(),
        antiWall: on({ maxLines: 20, maxLength: 1800, action: 'delete' }),
        antiZalgo: on({ action: 'delete' }),
      },
    },
  },
  strict: {
    label: 'Strict',
    emoji: '🔴',
    description: 'Tolérance minimale : liens bloqués, seuils bas, sanctions rapides.',
    patch: {
      enabled: true,
      escalation: { enabled: true, windowMinutes: 60 },
      newMembers: { enabled: true, accountAgeDays: 7, joinedMinutes: 60, blockLinks: true, blockInvites: true, blockMedia: true },
      filters: {
        antiSpam: on({ limit: 4, windowSeconds: 5, action: 'timeout', duration: '15m' }),
        antiFlood: on({ limit: 6, windowSeconds: 10, action: 'timeout', duration: '5m' }),
        antiLink: on({ action: 'delete' }),
        antiInvite: on({ action: 'warn' }),
        antiPhishing: on({ threshold: 2, action: 'timeout', duration: '7d' }),
        antiCrossChannel: on({ channels: 3, windowSeconds: 90, minLength: 20, action: 'timeout', duration: '1d' }),
        antiMassMention: on({ limit: 4, action: 'timeout', duration: '1h' }),
        antiCaps: on({ percent: 70, minLength: 10, action: 'delete' }),
        badWords: on({ action: 'warn' }),
        antiRepeat: on({ action: 'delete' }),
        antiEmojiSpam: on({ limit: 8, action: 'delete' }),
        antiDuplicate: on({ action: 'delete' }),
        antiWall: on({ maxLines: 12, maxLength: 1200, action: 'delete' }),
        antiZalgo: on({ action: 'delete' }),
      },
    },
  },
};

module.exports = { PRESETS };
