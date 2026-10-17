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

  route('PATCH', '/users/@me', function (p, call) {
    const body = call.body ?? {};
    const problems = problemsOf(body, { user: true });
    if (problems.length) refuse(call, problems);
    fake.profileEdits.push({ scope: 'user', body });
    const user = this.botUser;
    if (body.username != null) user.username = body.username;
    for (const key of ['avatar', 'banner']) if (key in body && body[key] !== undefined) user[key] = body[key] ? hash(body[key]) : null;
    return user;
  }, { prepend: true });

  route('PATCH', '/guilds/:guild/members/@me', function (p, call) {
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
  }, { prepend: true });
};
