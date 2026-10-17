# fakeRoutes

Un fichier par fonctionnalité : `module.exports = (fake, route, helpers) => { route('GET', '/guilds/:guild/…', function (params, call) { … }); }`.
Chargés par ordre alphabétique après les routes de base de `../fakeDiscord.js` (`{ prepend: true }` pour passer avant).
