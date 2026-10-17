# Modules Secur

Un fichier `.js` par module, chargé automatiquement (ordre alphabétique) par
`src/services/secur/registry.js`. Le registre livré par SEC1 est VIDE : les modules arrivent
avec SEC4 (salons, rôles, webhooks, serveur, expressions) et SEC5 (membres, bots, messages).

Interface (voir `registry.js`) :

```js
module.exports = {
  key: 'channelDelete',           // clé de SECUR_MODULES (src/utils/secur.js)
  auditTypes: [12],               // types d'audit déclarés pour cette clé
  priority: 3,                    // 1 rôles · 2 catégories · 3 salons · 4 surcharges · 5 membres et références
  classify(entry, guild, ctx) {}, // null si bénin, sinon { weight, record }
  async undo(guild, record, ctx) {}, // → { ok, note } ; relit l'état et s'abstient s'il a changé
  describe(record) {},            // texte court (carte d'incident)
  targetKey(record) {},           // objet visé (disjoncteur : 3 annulations en 60 s → module suspendu 5 min)
};
```

`ctx` : `{ client, service, cfg, moduleCfg, at, idMap, incidentId }`. Hors journal d'audit
(message @everyone…) : `client.services.secur.signal(guild, executorId, key, record, { at, weight })`.
