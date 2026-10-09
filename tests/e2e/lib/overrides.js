'use strict';

const { IDS } = require('./fixtures');
const { nextId } = require('./ids');

/**
 * Valeurs d'options choisies pour que chaque commande prenne son chemin « succès »
 * (la génération automatique ne peut pas deviner un format libre). Clé : « commande
 * [sous-commande] ». Une fonction reçoit le harnais ; `null` = option non fournie.
 */
async function latestBackupId(h) {
  if (!h.client.repositories.backups.list(h.guild.id, 1).length) {
    h.client.cooldowns.expiries.clear();
    await h.slash('backup', [{ name: 'create', type: 1, options: [{ name: 'nom', type: 3, value: 'préparation' }] }], { label: 'préparation : /backup create' });
  }
  return String(h.client.repositories.backups.list(h.guild.id, 1)[0]?.id ?? 1);
}

/** Met un membre en vocal (préparation des commandes /voice). */
async function inVoice(h, as = 'member') {
  if (!h.fake.voiceStates.has(IDS.users[as])) await h.voice(as, 'voice', { label: 'préparation : vocal' });
  return IDS.users[as];
}

/** Dernier rappel de l'administrateur (créé au besoin). */
async function latestReminderId(h) {
  h.client.cooldowns.expiries.clear();
  await h.slash('reminder', [{ name: 'create', type: 1, options: [{ name: 'duree', type: 3, value: '2h' }, { name: 'message', type: 3, value: 'à supprimer' }] }], { label: 'préparation : /reminder create' });
  const rows = h.client.repositories.reminders.listByUser(IDS.users.admin);
  return Math.max(1, ...rows.map((r) => r.id));
}

/** Nouveau membre jetable (cible d'une sanction qui l'expulse du serveur). */
async function freshMember(h, name) {
  const user = h.addUser(name, { ageDays: 300 });
  await h.memberJoin(user, { label: `préparation : ${name}` });
  return user.id;
}

/** Salon textuel jetable (cible de /channel supprimer, renommer…), créé par le faux Discord. */
async function throwawayChannel(h, name = 'jetable') {
  const id = nextId();
  const raw = { id, type: 0, guild_id: h.guild.id, name, position: 50, permission_overwrites: [], parent_id: IDS.channels.catGeneral, flags: 0, topic: null, nsfw: false, last_message_id: null, rate_limit_per_user: 0 };
  h.fake.channels.set(id, raw);
  h.fake.dispatchNow('CHANNEL_CREATE', raw, `préparation : salon ${name}`);
  await h.settle();
  return id;
}

const OVERRIDES = {
  'backup create': { nom: 'Sauvegarde e2e' },
  'backup info': { id: latestBackupId },
  'backup delete': { id: latestBackupId },
  'backup restore': { id: latestBackupId },
  'backup auto': { intervalle_h: 24 },
  'custom create': { nom: 'regles', contenu: 'Soyez gentils.' },
  'custom delete': {
    nom: async (h) => {
      h.client.cooldowns.expiries.clear();
      await h.slash('custom', [{ name: 'create', type: 1, options: [{ name: 'nom', type: 3, value: 'jetable' }, { name: 'contenu', type: 3, value: 'x' }] }], { label: 'préparation : /custom create jetable' });
      return 'jetable';
    },
  },
  'settings moderation': { paliers: '3=mute 1h, 5=kick, 7=ban', role_muet: IDS.roles.muted },
  choisir: { options: 'pizza | sushi | tacos' },
  de: { lancer: '2d6+1' },
  sondage: { choix: 'Oui | Non | Peut-être', duree: 24 },
  'giveaway create': { duree: '1h', role_requis: IDS.roles.member, role_interdit: IDS.roles.muted },
  'giveaway end': { id: 1 },
  'giveaway reroll': { id: 1 },
  emoji: { emoji: `<:gadget:${IDS.emoji}>` },
  'emoji info': { emoji: `<:gadget:${IDS.emoji}>` },
  // Pas de pièce jointe générée : son téléchargement serait refusé (réseau coupé) ; voir tests/e2e/admin-tools.e2e.test.js.
  'emoji ajouter': { nom: 'emoji_e2e', image: null, url: 'https://example.com/emoji.png' },
  'emoji supprimer': { emoji: 'introuvable_e2e' },
  'emoji renommer': { emoji: 'introuvable_e2e', nom: 'nouveau_nom' },
  'channel creer': { nom: 'salon-e2e', sujet: 'Sujet de test e2e' },
  'channel supprimer': { salon: (h) => throwawayChannel(h, 'a-supprimer') },
  'channel cloner': { salon: (h) => throwawayChannel(h, 'a-cloner'), nom: 'copie-e2e' },
  'channel renommer': { salon: (h) => throwawayChannel(h, 'a-renommer'), nom: 'renomme-e2e' },
  'channel sujet': { salon: (h) => throwawayChannel(h, 'a-sujet'), texte: 'Nouveau sujet e2e' },
  'channel nsfw': { salon: (h) => throwawayChannel(h, 'a-nsfw') },
  'role modifier': { role: IDS.roles.notif, nom: 'Notifications', couleur: '#ff8800', affiche_separement: null, mentionnable: null },
  'lockdown enable': { duree: '2h' },
  softban: { membre: (h) => freshMember(h, 'ASoftbannir'), jours_messages: 1 },
  modstats: { periode: 30, moderateur: null },
  help: { commande: 'ban' },
  inrole: { role: IDS.roles.member },
  roleinfo: { role: IDS.roles.mod },
  ban: { membre: (h) => freshMember(h, 'ABannir'), duree: null },
  tempban: { membre: (h) => freshMember(h, 'ATempBannir'), duree: '1d' },
  kick: { membre: (h) => freshMember(h, 'AExpulser') },
  derank: { membre: IDS.users.mod },
  clear: {
    nombre: async (h) => {
      for (let i = 0; i < 5; i += 1) await h.userMessage({ as: 'member', content: `message à nettoyer ${i}`, label: 'préparation : /clear' });
      return 10;
    },
    membre: null,
  },
  pseudo: { pseudo: 'Pseudo e2e' },
  mute: { duree: '1h' },
  timeout: { duree: '10m' },
  slowmode: { duree: '10s', pendant: '1h' },
  lock: { duree: '30m' },
  'sanctions raison': { raison: 'Nouvelle raison e2e' },
  'sanctions remove': { id: 2 },
  unban: {
    user_id: async (h) => {
      const user = h.addUser('Banni', { ageDays: 300 });
      h.fake.bans.set(user.id, { user, reason: 'test' });
      return user.id;
    },
  },
  'projet creer': { nom: 'Projet e2e', echeance: '2030-12-31', couleur: '#ff8800', lien: 'https://example.com', image: 'https://example.com/a.png', tags: 'bot, test' },
  'projet echeance': { date: '2031-01-15' },
  'projet lien-ajouter': { nom: 'Dépôt', url: 'https://github.com/exemple/projet' },
  'projet membre-ajouter': { membre: IDS.users.member, role: 'Développeur' },
  'projet membre-retirer': { membre: IDS.users.member },
  'projet transferer': { membre: IDS.users.admin },
  'projet config': { reinitialiser: false },
  massrole: { action: 'add', role: IDS.roles.notif, cible: 'humans' },
  'role add': { membre: IDS.users.target, role: IDS.roles.gamer },
  'role remove': { membre: IDS.users.target, role: IDS.roles.gamer },
  'role create': { nom: 'Rôle e2e', couleur: '#00ff88' },
  'role delete': { role: IDS.roles.temp },
  'role temporaire': { membre: IDS.users.target, role: IDS.roles.gamer, duree: '7d' },
  'annonce programmer': { date: '+2h', role: IDS.roles.notif, fuseau: 'Europe/Paris', repetition: 'weekly' },
  'anniversaire definir': { jour: 14, mois: 7, annee: 1995, afficher_age: true },
  rolemenu: { role1: IDS.roles.notif, role2: IDS.roles.gamer, role3: null, role4: null, role5: null, details: 'Annonces | Jeux' },
  'whitelist add': { utilisateur: IDS.users.mod, role: null },
  'whitelist remove': { utilisateur: IDS.users.mod, role: null },
  'suggestion setup': { salon: IDS.channels.general },
  'suggestion create': { contenu: 'Ajouter un salon musique' },
  'suggestion approve': { id: 1, raison: 'Bonne idée' },
  'suggestion deny': {
    id: async (h) => {
      h.client.cooldowns.expiries.clear();
      await h.slash('suggestion', [{ name: 'create', type: 1, options: [{ name: 'contenu', type: 3, value: 'Supprimer les règles' }] }], { as: 'member', label: 'préparation : /suggestion create' });
      return 2;
    },
  },
  'modmail setup': { categorie: IDS.channels.catTickets, role_staff: IDS.roles.mod, salon_logs: IDS.channels.logs },
  calcul: { expression: 'sqrt(16) + 2^3' },
  couleur: { hex: '#5865F2' },
  'embed send': { titre: 'Annonce', description: 'Bienvenue à tous', couleur: '#ff8800', image: 'https://example.com/a.png', thumbnail: 'https://example.com/b.png', footer: 'Pied' },
  'reminder create': { duree: '10m', message: 'Penser au test' },
  'reminder delete': { id: latestReminderId },
  tag: { nom: 'regles' },
  timestamp: { quand: '2030-06-01 14:30', fuseau: 'Europe/Paris' },
  'tempvoice setup': { hub: IDS.channels.hub, categorie: IDS.channels.catVoice },
  'voice move': {
    membre: async (h) => {
      await h.voice('member', 'voice', { label: 'préparation : vocal' });
      return IDS.users.member;
    },
    salon: IDS.channels.hub,
  },
  'voice kick': { membre: (h) => inVoice(h) },
  'voice mute': { membre: (h) => inVoice(h) },
  'voice unmute': { membre: (h) => inVoice(h) },
  'voice disconnect': { membre: (h) => inVoice(h) },
  'voice cleanup': { salon: IDS.channels.voice },
};

module.exports = { OVERRIDES, freshMember, throwawayChannel };
