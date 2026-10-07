'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { memoryDb } = require('./db.helper');
const { ProjectRepository } = require('../src/database/repositories/ProjectRepository');
const { GuildConfigRepository } = require('../src/database/repositories/GuildConfigRepository');
const { ConfigService } = require('../src/services/ConfigService');
const { ProjectService } = require('../src/services/ProjectService');
const f = require('../src/utils/projectFormat');

const GUILD = 'g1';

/** Faux membre Discord (permissions + rôles). */
function member(id, { manager = false, roles = [] } = {}) {
  return {
    id,
    guild: { id: GUILD },
    permissions: { has: () => manager },
    roles: { cache: new Map(roles.map((r) => [r, true])) },
  };
}

function setup() {
  const { db } = memoryDb();
  const projects = new ProjectRepository(db);
  const config = new ConfigService(new GuildConfigRepository(db));
  const service = new ProjectService({ client: { channels: { fetch: async () => null } }, projects, config });
  service.scheduleRefresh = () => {}; // pas de timers pendant les tests
  return { service, projects, config };
}

test('parseDeadline : formats FR/ISO, relatif, dates impossibles', () => {
  const now = Date.UTC(2026, 0, 1);
  assert.strictEqual(f.parseDeadline('25/12/2026', now).value, Date.UTC(2026, 11, 25, 12));
  assert.strictEqual(f.parseDeadline('2026-03-01', now).value, Date.UTC(2026, 2, 1, 12));
  assert.strictEqual(f.parseDeadline('2w', now).value, now + 14 * 86400000);
  assert.ok(f.parseDeadline('31/02/2026', now).error);
  assert.ok(f.parseDeadline('demain', now).error);
  assert.strictEqual(f.parseDeadline('aucune', now).clear, true);
  assert.ok(f.parseDeadline('01/01/2099', now).error, '> 10 ans');
});

test('parseColor, normalizeUrl, parseTags', () => {
  assert.strictEqual(f.parseColor('#5865F2'), 0x5865f2);
  assert.strictEqual(f.parseColor('0f0'), 0x00ff00);
  assert.strictEqual(f.parseColor('rouge'), null);
  assert.strictEqual(f.normalizeUrl('javascript:alert(1)'), null);
  assert.strictEqual(f.normalizeUrl('https://example.com/a'), 'https://example.com/a');
  assert.deepStrictEqual(f.parseTags(' Web, bot ;#API, web'), ['web', 'bot', 'api']);
});

test('computeProgress : tâches > manuel, terminé = 100', () => {
  assert.strictEqual(f.computeProgress({ status: 'en_cours', progress: 40 }, { total: 0, done: 0 }), 40);
  assert.strictEqual(f.computeProgress({ status: 'en_cours', progress: 40 }, { total: 4, done: 1 }), 25);
  assert.strictEqual(f.computeProgress({ status: 'termine', progress: 10 }, { total: 4, done: 1 }), 100);
  assert.strictEqual(f.computeProgress({ status: 'idee', progress: null }, null), 0);
});

test('buildProjectEmbed respecte les limites Discord même avec un contenu maximal', () => {
  const tasks = Array.from({ length: 25 }, (_, i) => ({ id: i, title: 'x'.repeat(100), done: i % 2 === 0 }));
  const members = Array.from({ length: 25 }, (_, i) => ({ userId: String(1e17 + i), role: 'r'.repeat(40) }));
  const project = {
    id: 1, number: 1, name: 'N'.repeat(80), description: 'd'.repeat(2000), status: 'en_cours', progress: null,
    ownerId: '1', color: null, imageUrl: 'https://e.com/i.png', thumbnailUrl: null, deadline: Date.now() - 5 * 86400000,
    tags: Array.from({ length: 10 }, (_, i) => `tag${i}`.padEnd(24, 'z')),
    links: Array.from({ length: 5 }, (_, i) => ({ label: 'L'.repeat(60), url: `https://example.com/${i}` })),
    createdAt: Date.now(), updatedAt: Date.now(),
  };
  const json = f.buildProjectEmbed(project, { tasks, members, guild: { name: 'Serveur', iconURL: () => null } }).toJSON();
  for (const field of json.fields) assert.ok(field.value.length <= 1024, field.name);
  const total = json.title.length + json.description.length + json.footer.text.length + json.author.name.length + json.fields.reduce((n, x) => n + x.name.length + x.value.length, 0);
  assert.ok(total <= 6000, `total ${total}`);
  assert.ok(json.fields.find((x) => x.name.startsWith('⏰')).value.includes('En retard'));
  const rows = f.buildProjectComponents(project, { hasTasks: true }).map((r) => r.toJSON());
  assert.ok(rows.every((r) => r.components.length <= 5));
});

test('pages de liste : 6 projets par page', () => {
  const entries = Array.from({ length: 13 }, (_, i) => ({
    project: { id: i, number: i + 1, name: `P${i}`, status: 'en_cours', ownerId: '1', tags: [], progress: 50, createdAt: 0, updatedAt: 0 },
    counts: { total: 0, done: 0 },
  }));
  const pages = f.buildProjectListPages(entries, { guildName: 'S' });
  assert.strictEqual(pages.length, 3);
  assert.strictEqual(pages[2].toJSON().fields.length, 1);
});

test('ProjectService : création, numéros par serveur, noms uniques', () => {
  const { service } = setup();
  const alice = member('alice');
  const p1 = service.create(alice, { name: 'Site web', tags: ['web'] });
  const p2 = service.create(alice, { name: 'Bot Discord' });
  assert.strictEqual(p1.number, 1);
  assert.strictEqual(p2.number, 2);
  assert.throws(() => service.create(alice, { name: 'site WEB' }), /existe déjà/);
  assert.throws(() => service.create(alice, { name: '42' }), /nombre/);
  assert.throws(() => service.create(alice, { name: 'X', link: 'ftp://x' }), /invalide/);
  assert.strictEqual(service.resolve(GUILD, '#2').id, p2.id);
  assert.strictEqual(service.resolve(GUILD, 'bot discord').id, p2.id);
  assert.throws(() => service.resolve(GUILD, '99'), /introuvable/);
  assert.throws(() => service.resolve('autre-serveur', '1'), /introuvable/, 'isolation entre serveurs');
});

test('ProjectService : droits d\'édition et de gestion', () => {
  const { service } = setup();
  const owner = member('owner');
  const p = service.create(owner, { name: 'Projet' });
  const bob = member('bob');
  assert.throws(() => service.assertCanEdit(p, bob), /Seuls/);
  service.addMember(p, 'bob', 'Dev');
  assert.doesNotThrow(() => service.assertCanEdit(p, bob));
  assert.throws(() => service.assertCanManage(p, bob), /Seuls/);
  assert.doesNotThrow(() => service.assertCanManage(p, member('admin', { manager: true })));
});

test('ProjectService : tâches, progression auto et statut auto', () => {
  const { service } = setup();
  const owner = member('o');
  let p = service.create(owner, { name: 'Tâches' });
  service.addTask(p, 'A');
  p = service.addTask(p, 'B');
  assert.throws(() => service.setProgress(p, 50), /calculée automatiquement/);
  const [a, b] = service.repo.tasks(p.id);
  let r = service.toggleTask(p, String(a.id), 'o');
  assert.strictEqual(r.project.status, 'en_cours');
  r = service.toggleTask(r.project, String(b.id), 'o');
  assert.strictEqual(r.project.status, 'termine', 'toutes les tâches cochées → terminé');
  r = service.toggleTask(r.project, String(b.id), 'o');
  assert.strictEqual(r.project.status, 'en_cours', 'décocher rouvre le projet');
});

test('ProjectService : limites (membres, liens, projets par membre)', () => {
  const { service, config } = setup();
  config.update(GUILD, { projects: { maxPerUser: 2 } });
  const o = member('o');
  const p = service.create(o, { name: 'A' });
  service.create(o, { name: 'B' });
  assert.throws(() => service.create(o, { name: 'C' }), /projets actifs/);
  assert.doesNotThrow(() => service.create(member('admin', { manager: true }), { name: 'C' }));
  let cur = p;
  for (let i = 0; i < 5; i++) cur = service.addLink(cur, `L${i}`, `https://e.com/${i}`);
  assert.throws(() => service.addLink(cur, 'L9', 'https://e.com/9'), /maximum/);
  cur = service.addLink(cur, 'l0', 'https://e.com/new');
  assert.strictEqual(cur.links.length, 5, 'même nom = remplacement');
  config.update(GUILD, { projects: { openCreation: false } });
  assert.throws(() => service.create(member('x'), { name: 'D' }), /réservée/);
});

test('ProjectService : transfert et suppression en cascade', async () => {
  const { service, projects } = setup();
  const p = service.create(member('o'), { name: 'T' });
  service.addTask(p, 'x');
  const t = service.transfer(p, 'n');
  assert.strictEqual(t.ownerId, 'n');
  assert.ok(projects.isMember(p.id, 'o'), 'ancien responsable gardé dans l\'équipe');
  await service.delete(t);
  assert.strictEqual(projects.get(p.id), null);
  assert.strictEqual(projects.tasks(p.id).length, 0);
});
