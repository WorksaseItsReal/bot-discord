'use strict';

const crypto = require('node:crypto');

/**
 * Profil du bot (ADM3) : PATCH /users/@me (nom, avatar, bannière globaux) et
 * PATCH /guilds/:guild/members/@me (pseudo, avatar, bannière, bio sur un serveur).
 * Comme Discord : une image doit être une URI `data:image/…;base64,…` (jamais une URL ni un
 * chemin), le nom fait 2 à 32 caractères, la bio 190 au plus ; l'image enregistrée devient un
 * « hash ». Les corps reçus sont conservés dans `fake.profileEdits` pour les tests.
 */
const DATA_URI = /^data:image\/[a-z]+;base64,[A-Za-z0-9+/]+=*$/;

module.exports = (fake, route, helpers) => {
  fake.profileEdits = [];
  // /embed texte : notifier des rôles ou @everyone est le BUT de l'option quand l'auteur l'a
  // demandé explicitement (mentionner_roles / notifier_tous) ; le bot vérifie lui-même ses
  // permissions natives (comme /annonce dans lib/chaos.js). Sans ces options, toute mention de
  // masse reste une violation relevée par le harnais.
  fake.intendedPingLabels.push(/^\/embed texte\b.*\b(mentionner_roles|notifier_tous)[=:]true\b/);
  const hash = (data) => crypto.createHash('md5').update(String(data)).digest('hex');

  /** Problèmes d'un corps de profil (images, longueurs). */
  const problemsOf = (body, { user = false } = {}) => {
    const out = [];
    for (const key of ['avatar', 'banner']) {
      if (!(key in body) || body[key] === null) continue;
      if (typeof body[key] !== 'string' || !DATA_URI.test(body[key])) out.push(`${key} : image attendue en data:image/…;base64 (reçu ${String(body[key]).slice(0, 40)})`);
    }
    if (user && 'username' in body && body.username != null && ([...body.username].length < 2 || [...body.username].length > 32)) out.push(`username : ${[...body.username].length} caractères (2 à 32)`);
    if ('bio' in body && body.bio != null && [...String(body.bio)].length > 190) out.push(`bio : ${[...String(body.bio)].length} > 190`);
    return out;
  };
  const refuse = (call, problems) => {
    fake.violations.push({ method: call.method, route: call.route, problems, label: call.label });
    throw helpers.error(call, 400, 50035, `Invalid Form Body\n${problems.join('\n')}`);
  };

  // discord.js encode parfois « @me » (%40me) dans le chemin : les deux formes sont servies.
  const userMe = function (p, call) {
    const body = call.body ?? {};
    const problems = problemsOf(body, { user: true });
    if (problems.length) refuse(call, problems);
    fake.profileEdits.push({ scope: 'user', body });
    const user = this.botUser;
    if (body.username != null) user.username = body.username;
    for (const key of ['avatar', 'banner']) if (key in body && body[key] !== undefined) user[key] = body[key] ? hash(body[key]) : null;
    return user;
  };
  route('PATCH', '/users/@me', userMe, { prepend: true });
  route('PATCH', '/users/%40me', userMe, { prepend: true });

  const memberMe = function (p, call) {
    const body = call.body ?? {};
    const problems = problemsOf(body);
    if (problems.length) refuse(call, problems);
    fake.profileEdits.push({ scope: 'member', guildId: p.guild, body });
    const member = this.members.get(this.botUser.id);
    if (member) {
      for (const key of ['avatar', 'banner']) if (key in body && body[key] !== undefined) member[key] = body[key] ? hash(body[key]) : null;
      if ('bio' in body) member.bio = body.bio ?? null;
    }
    // Pseudo et événement GUILD_MEMBER_UPDATE : route de base.
    const base = this.routes.filter((r) => r.method === 'PATCH' && r.re.test(call.route))[1];
    return base.handler({ ...p, user: '@me' }, call);
  };
  route('PATCH', '/guilds/:guild/members/@me', memberMe, { prepend: true });
  route('PATCH', '/guilds/:guild/members/%40me', memberMe, { prepend: true });
};
