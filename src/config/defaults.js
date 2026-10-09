'use strict';

/**
 * Configuration par défaut d'un serveur (guild).
 * Toute donnée est spécifique à un guildId ; ceci sert de base lors du
 * premier accès à la configuration d'un serveur.
 */
const defaultGuildConfig = Object.freeze({
  locale: 'fr',
  logChannels: {
    moderation: null,
    messages: null,
    members: null,
    roles: null,
    channels: null,
    voice: null,
    security: null,
    automod: null,
    server: null,
  },
  // Réglages des logs (/logs). Les salons par catégorie sont dans logChannels.
  logs: {
    enabled: true,
    disabledEvents: [],      // événements désactivés (clés de utils/logCatalog.js)
    disabledCategories: [],  // catégories en pause (le salon est conservé)
    ignoredChannels: [],     // messages de ces salons (et de leurs fils) non journalisés
    ignoreBots: true,        // messages des bots non journalisés
    staffRoleId: null,       // rôle qui peut lire les salons de logs créés automatiquement
    categoryId: null,        // catégorie « Logs » créée automatiquement
    createdChannels: [],     // salons créés par le bot (pour le nettoyage)
    setup: { layout: 'perCategory', categories: ['moderation', 'messages', 'members', 'roles', 'channels', 'voice', 'security', 'automod', 'server'] },
  },
  moderation: {
    dmOnSanction: true,
    requireReason: false,
    confirmDangerous: true,
    mutedRoleId: null,
  },
  strikes: {
    enabled: true,
    // Décroissance : les strikes de plus de N jours ne comptent plus dans le palier
    // (0 = jamais). Ils restent enregistrés (filtre par date, cf. StrikeService).
    decayDays: 0,
    // Paliers configurables: nombre de strikes -> sanction
    thresholds: [
      { strikes: 3, action: 'mute', duration: '1h' },
      { strikes: 5, action: 'kick', duration: null },
      { strikes: 7, action: 'ban', duration: null },
    ],
  },
  automod: {
    enabled: false,
    ignoredChannels: [],
    ignoredRoles: [],
    // Prévenir le membre : 'channel' (message éphémère dans le salon, supprimé après quelques
    // secondes), 'dm' (message privé) ou 'none'.
    notify: 'channel',
    // Sanctions progressives : au-delà de N infractions dans la fenêtre, la sanction monte.
    escalation: {
      enabled: true,
      windowMinutes: 30,
      steps: [
        { count: 3, action: 'timeout', duration: '10m' },
        { count: 5, action: 'timeout', duration: '1h' },
        { count: 8, action: 'kick', duration: null },
      ],
    },
    // Restrictions des nouveaux venus (comptes récents ou arrivés depuis peu).
    newMembers: {
      enabled: false,
      accountAgeDays: 7,
      joinedMinutes: 30,
      blockLinks: true,
      blockInvites: true,
      blockMedia: false,
    },
    // Chaque filtre : { enabled, action, ...seuils }. action : delete | warn | timeout | kick (antiHacked : quarantine)
    filters: {
      antiSpam: { enabled: false, limit: 5, windowSeconds: 5, action: 'timeout', duration: '5m' },
      antiFlood: { enabled: false, limit: 7, windowSeconds: 10, action: 'delete' },
      antiLink: { enabled: false, action: 'delete', allowedDomains: [] },
      antiInvite: { enabled: false, action: 'delete', allowedCodes: [], allowOwnServer: true },
      antiPhishing: { enabled: false, threshold: 3, action: 'timeout', duration: '1d' },
      antiCrossChannel: { enabled: false, channels: 3, windowSeconds: 60, minLength: 20, action: 'timeout', duration: '1h' },
      antiMassMention: { enabled: false, limit: 5, action: 'timeout', duration: '10m' },
      antiCaps: { enabled: false, percent: 70, minLength: 10, action: 'delete' },
      badWords: { enabled: false, words: [], action: 'delete' },
      antiRepeat: { enabled: false, action: 'delete' },
      antiEmojiSpam: { enabled: false, limit: 8, action: 'delete' },
      antiDuplicate: { enabled: false, action: 'delete' },
      antiWall: { enabled: false, maxLines: 15, maxLength: 1500, action: 'delete' },
      antiZalgo: { enabled: false, action: 'delete' },
      // Compte piraté : même lot de pièces jointes ou même message dans `channels` salons en
      // `windowSeconds` s, ou lien d'arnaque d'un score ≥ `scamScore`. Action « quarantine » :
      // timeout (`duration`) + suppression de ses messages des `purgeMinutes` dernières minutes
      // (+ retrait des rôles si `removeRoles`, rendus à la levée).
      antiHacked: { enabled: false, channels: 3, windowSeconds: 60, minLength: 20, scamScore: 5, action: 'quarantine', duration: '1d', purgeMinutes: 10, removeRoles: false },
      // Pseudos (groupe Sécurité) : vérifiés à l'arrivée et à chaque changement de nom. Vérifications :
      // dehoist (symbole/invisible en tête), words (liste des mots interdits), impersonation (« admin »,
      // « discord »… ou nom du staff imité), unreadable (zalgo, invisibles). Action unique : renommer
      // selon `template` ({id} = 4 derniers chiffres de l'identifiant). Exemptions : exemptRoles.
      badNames: { enabled: false, dehoist: true, words: true, impersonation: true, unreadable: true, template: 'Membre {id}' },
    },
    // Exemptions propres à un filtre (en plus des exemptions globales) : chaque filtre accepte
    // `exemptChannels: []` et `exemptRoles: []` (réglables dans la vue du filtre).
  },
  antiraid: {
    enabled: false,
    joinThreshold: 10,
    joinWindowSeconds: 10,
    minAccountAgeDays: 0,
    antiBot: false,
    action: 'kick', // kick | ban | lockdown
    newAccountAction: null, // kick | ban — comptes récents / bots (null : ban si action = ban, sinon kick)
    alertChannel: null,
    // Seuils de destruction (via audit log)
    channelDeleteThreshold: 3,
    roleDeleteThreshold: 3,
    banThreshold: 5,
    kickThreshold: 0, // expulsions massives (0 = désactivé : rien ne change pour les serveurs existants)
    destructiveWindowSeconds: 10,
    punishExecutor: 'strip', // strip (retire les rôles) | ban | none
  },
  whitelist: {
    users: [],
    roles: [],
  },
  tickets: {
    categoryId: null,
    supportRoleId: null, // premier rôle staff (compatibilité)
    supportRoleIds: [], // rôles staff (tableau de bord /tickets)
    logChannel: null, // salon des transcripts
    maxPerUser: 1,
    reasons: [], // motifs proposés à l'ouverture : { value, label, emoji?, description? }
    panel: { title: null, description: null, buttonLabel: null }, // textes du panneau (null : texte par défaut)
    panelChannelId: null,
    panelMessageId: null,
    stats: { opened: 0, closed: 0 },
    // Archive des transcripts (tickets ET ModMail) : pièces jointes ≤ 8 Mo (24 Mo au total)
    // re-téléversées avec le .txt. false : seuls leurs liens figurent (comportement historique).
    archiveAttachments: false,
  },
  modmail: {
    enabled: false,
    categoryId: null,
    staffRoleId: null,
    logChannel: null,
  },
  suggestions: {
    channelId: null,
  },
  giveaways: {
    // rien de configurable au niveau serveur pour l'instant (tout au niveau du giveaway)
  },
  tempVoice: {
    enabled: false,
    hubChannelId: null,   // salon "Créer un vocal"
    categoryId: null,     // null : catégorie du salon créateur
    nameTemplate: 'Vocal de {pseudo}', // variables : {pseudo} (ou {user}), {username}, {n}
    defaultLimit: 0,      // places par défaut (0 = illimité)
    rememberPrefs: true,  // nom, limite et verrou du propriétaire réappliqués à ses prochains vocaux
    panel: true,          // panneau de contrôle posté dans le chat du vocal
  },
  projects: {
    openCreation: true,     // tout le monde peut créer un projet (sinon : gestionnaires uniquement)
    managerRoleId: null,    // rôle pouvant gérer TOUS les projets (en plus de « Gérer le serveur »)
    channelId: null,        // salon de publication par défaut
    maxPerUser: 10,         // projets actifs max par membre (hors gestionnaires)
  },
  // Accueil des nouveaux membres (/bienvenue). Variables : {membre} {pseudo} {serveur} {nombre} {compte}.
  welcome: {
    join: {
      enabled: false,
      channelId: null,
      title: 'Bienvenue sur {serveur} !',
      description: 'Bienvenue {membre} ! Vous êtes notre **{nombre}ᵉ** membre. Installez-vous confortablement.',
      color: null,   // couleur personnalisée (nombre) ; null : couleur du bot
      image: null,   // bannière (URL https)
      mention: true, // mentionne (notifie) le membre au-dessus du message
      dm: false,     // envoie aussi le message en MP
    },
    leave: {
      enabled: false,
      channelId: null,
      title: 'Au revoir {pseudo}',
      description: '**{pseudo}** a quitté le serveur. Nous sommes désormais **{nombre}** membres.',
      color: null,
      image: null,
    },
    // Rôles donnés à l'arrivée (10 max chacun). Avec la vérification, les rôles humains attendent la vérification.
    autoRoles: { humans: [], bots: [] },
    verification: {
      enabled: false,
      mode: 'add',            // add : donne le rôle « vérifié » · remove : retire le rôle « non vérifié » (donné à l'arrivée)
      roleId: null,
      channelId: null,        // salon du panneau de vérification
      captcha: false,         // question anti-robot (calcul ou mot à recopier)
      minAccountAgeDays: 0,   // âge minimal du compte pour se vérifier (0 : aucun)
      panelChannelId: null,
      panelMessageId: null,
    },
  },
  autobackup: {
    enabled: false,
    intervalHours: 24,
    lastRun: 0,
  },
  // Niveaux / XP (/niveaux, /rang, /classement). Désactivé par défaut.
  levels: {
    enabled: false,
    xpMin: 15,              // XP par message : tirage aléatoire entre xpMin et xpMax
    xpMax: 25,
    cooldownSeconds: 60,    // délai minimal entre deux gains d'XP d'un même membre
    minLength: 3,           // messages plus courts ignorés
    voice: { enabled: false, xpPerMinute: 10 }, // par minute en vocal (non muet, pas seul, hors AFK)
    announce: {
      mode: 'same',         // off | same (salon du message) | channel (salon dédié) | dm
      channelId: null,
      message: null,        // null = message par défaut ; variables {membre}, {niveau}
    },
    rewards: [],            // [{ level, roleId }]
    stackRewards: true,     // true : rôles cumulés ; false : seulement le plus haut
    ignoredChannels: [],    // salons (et leurs fils) sans XP
    ignoredRoles: [],       // rôles sans XP
    multipliers: [],        // [{ roleId, multiplier }] : le plus élevé du membre s'applique
  },
  // Suivi des invitations (/invitations). Lecture des invitations : permission « Gérer le serveur ».
  invites: {
    fakeAccountDays: 7,     // compte plus jeune à l'arrivée → invitation « fausse » (0 : jamais)
  },
  // Compteurs de statistiques (/compteurs) : salons vocaux verrouillés dont le nom affiche une valeur.
  // template null = modèle par défaut ; renamedAt : dernier renommage (limite Discord : 2 / 10 min).
  statsCounters: {
    categoryId: null,       // catégorie « 📊 Statistiques » créée par le bot
    counters: {
      members: { enabled: false, channelId: null, template: null, renamedAt: 0 },
      humans: { enabled: false, channelId: null, template: null, renamedAt: 0 },
      bots: { enabled: false, channelId: null, template: null, renamedAt: 0 },
      online: { enabled: false, channelId: null, template: null, renamedAt: 0 },
      boosts: { enabled: false, channelId: null, template: null, renamedAt: 0 },
      channels: { enabled: false, channelId: null, template: null, renamedAt: 0 },
      roles: { enabled: false, channelId: null, template: null, renamedAt: 0 },
    },
  },
  // Signalements de messages (clic droit → Applications → « Signaler le message », /signalements).
  reports: {
    enabled: true,
    channelId: null,        // salon des signalements (null : salon de logs Modération)
    pingRoleId: null,       // rôle pingué à chaque signalement (facultatif)
    showReporter: true,     // false : le signaleur est masqué sur la carte du staff
  },
  // Communauté (/communaute) : starboard et réponses automatiques. Les messages
  // épinglés automatiquement (/sticky) sont en base (table sticky_messages).
  community: {
    starboard: {
      enabled: false,
      channelId: null,        // salon où les messages populaires sont repostés
      emoji: '⭐',            // emoji Unicode ou personnalisé (<:nom:id>)
      threshold: 3,           // réactions nécessaires (auteur et bots exclus)
      excludedChannels: [],   // salons (et leurs fils) jamais repostés
      removeBelow: true,      // retirer la carte si le compte repasse sous le seuil
    },
    autoResponses: {
      enabled: false,
      // [{ id, pattern, mode: word|contains|starts|exact, response, reaction,
      //    cooldownSeconds, channels: [], excludedChannels: [], enabled }]
      triggers: [],
    },
  },
  // Anniversaires (/anniversaire config). Variables du message : {membre} {pseudo} {serveur} {age}
  // (la ligne contenant {age} n'est affichée que si le membre a accepté de montrer son âge).
  birthdays: {
    enabled: false,
    channelId: null,          // salon des messages d'anniversaire (null : aucun message)
    message: null,            // null = message par défaut (services/BirthdayService.js)
    roleId: null,             // rôle « anniversaire » porté 24 h
    timeZone: 'Europe/Paris', // fuseau IANA du serveur (date du jour)
    hour: 9,                  // heure locale d'envoi (0-23)
  },
  // Outils des membres, activables par serveur (/alertes config) : absences (/afk),
  // alertes de mots-clés en MP (/alertes) et derniers messages supprimés / modifiés (/snipe).
  memberTools: {
    afk: {
      enabled: true,
      nickname: true,         // préfixe « [AFK] » sur le pseudo (si la hiérarchie le permet)
    },
    highlights: { enabled: true },
    snipe: { enabled: true }, // « Gérer les messages » ; salons ignorés des logs respectés
  },
  // Économie (/eco, /economie) : monnaie virtuelle SANS valeur réelle. Désactivée par défaut.
  // Comptes, boutique et historique en base (tables economy_*). Bornes : utils/economy.js.
  economy: {
    enabled: false,
    currency: { name: 'pièces', emoji: '🪙' }, // nom (pluriel) et emoji (Unicode ou <:nom:id> du serveur)
    daily: { amount: 100, streakBonus: 10, streakMax: 7 }, // bonus par jour de série, plafonné à streakMax jours
    weekly: { amount: 500 },
    work: { min: 20, max: 80, cooldownMinutes: 60 },
    transfers: { taxPercent: 0, confirmAbove: 1000 }, // taxe détruite ; confirmation au-delà (0 : jamais)
    limits: { maxBet: 1000, maxBalance: 10_000_000 },
    games: { coinflip: true, slots: true, houseEdgePercent: 5, cooldownSeconds: 10 }, // espérance négative réglable
  },
});

module.exports = { defaultGuildConfig };
