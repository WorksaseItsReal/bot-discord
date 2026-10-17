'use strict';

/**
 * Pendu : logique pure et liste de mots courants (embarquée, sans réseau).
 * Les mots sont affichés avec leurs accents ; la comparaison se fait sans accents
 * (« E » révèle É, È, Ê et E). Chaque caractère d'un mot correspond à une seule
 * lettre de A à Z après normalisation (pas de Œ, de tiret ni d'espace).
 */

const MAX_ERRORS = 6;
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
const FIRST_HALF = LETTERS.slice(0, 13); // A → M
const SECOND_HALF = LETTERS.slice(13); // N → Z

// prettier-ignore
const WORDS = Object.freeze([
  // Animaux
  'chat', 'chien', 'cheval', 'lapin', 'souris', 'oiseau', 'poisson', 'tortue', 'girafe', 'éléphant',
  'lion', 'tigre', 'zèbre', 'singe', 'ours', 'loup', 'renard', 'mouton', 'vache', 'cochon',
  'poule', 'canard', 'dauphin', 'baleine', 'requin', 'papillon', 'abeille', 'fourmi', 'araignée', 'serpent',
  'crocodile', 'grenouille', 'escargot', 'hérisson', 'écureuil', 'kangourou', 'panda', 'chameau', 'hibou', 'pingouin',
  'perroquet', 'aigle', 'corbeau', 'pigeon', 'moustique', 'chenille', 'coccinelle', 'lézard', 'castor', 'taureau',
  // Fruits, légumes et cuisine
  'pomme', 'poire', 'banane', 'orange', 'citron', 'fraise', 'cerise', 'raisin', 'abricot', 'ananas',
  'melon', 'pastèque', 'carotte', 'tomate', 'salade', 'oignon', 'poireau', 'haricot', 'courgette', 'aubergine',
  'fromage', 'beurre', 'yaourt', 'chocolat', 'gâteau', 'biscuit', 'confiture', 'baguette', 'croissant', 'sandwich',
  'omelette', 'crêpe', 'soupe', 'pizza', 'sucre', 'farine', 'poivre', 'moutarde', 'vinaigre', 'jambon',
  'saucisse', 'poulet', 'frites', 'purée', 'café', 'bonbon', 'sucette', 'glace', 'crème', 'citrouille',
  // Maison
  'maison', 'cuisine', 'chambre', 'salon', 'fenêtre', 'porte', 'escalier', 'plafond', 'jardin', 'garage',
  'grenier', 'meuble', 'table', 'chaise', 'armoire', 'canapé', 'fauteuil', 'lampe', 'miroir', 'tapis',
  'rideau', 'coussin', 'oreiller', 'couverture', 'réfrigérateur', 'ordinateur', 'téléphone', 'télévision', 'horloge', 'bougie',
  'étagère', 'tiroir', 'valise', 'parapluie', 'bouteille', 'verre', 'assiette', 'fourchette', 'couteau', 'cuillère',
  'casserole', 'tasse', 'théière', 'plateau', 'clavier', 'écran', 'imprimante', 'robot', 'machine', 'moteur',
  // École et bureau
  'école', 'cahier', 'crayon', 'stylo', 'gomme', 'règle', 'cartable', 'tableau', 'bureau', 'livre',
  'journal', 'lettre', 'enveloppe', 'ciseaux', 'papier', 'classeur', 'dictionnaire', 'professeur', 'élève', 'leçon',
  'devoir', 'examen', 'récréation', 'histoire', 'géographie', 'musique', 'science', 'calcul', 'alphabet', 'question',
  // Nature et météo
  'montagne', 'rivière', 'fleuve', 'océan', 'plage', 'forêt', 'désert', 'volcan', 'colline', 'vallée',
  'prairie', 'cascade', 'glacier', 'nuage', 'soleil', 'étoile', 'planète', 'comète', 'orage', 'tonnerre',
  'éclair', 'neige', 'pluie', 'brouillard', 'tempête', 'saison', 'printemps', 'automne', 'hiver', 'arbre',
  'fleur', 'feuille', 'branche', 'racine', 'herbe', 'rocher', 'caillou', 'sable', 'coquillage', 'lumière',
  // Transports
  'voiture', 'camion', 'bateau', 'avion', 'train', 'vélo', 'moto', 'fusée', 'métro', 'autobus',
  'tracteur', 'hélicoptère', 'trottinette', 'navire', 'ambulance', 'parachute', 'gare', 'aéroport', 'route', 'pont',
  // Corps humain
  'tête', 'cheveux', 'visage', 'oreille', 'bouche', 'épaule', 'genou', 'cheville', 'poignet', 'coude',
  'ventre', 'cerveau', 'squelette', 'muscle', 'estomac', 'poumon', 'sourcil', 'paupière', 'menton', 'orteil',
  'doigt', 'main', 'pied', 'jambe', 'sourire',
  // Métiers
  'médecin', 'pompier', 'policier', 'boulanger', 'boucher', 'cuisinier', 'jardinier', 'facteur', 'pilote', 'infirmier',
  'avocat', 'architecte', 'ingénieur', 'plombier', 'électricien', 'coiffeur', 'peintre', 'musicien', 'chanteur', 'danseur',
  'acteur', 'écrivain', 'journaliste', 'vétérinaire', 'pharmacien', 'agriculteur', 'astronaute', 'marin', 'soldat', 'chevalier',
  // Loisirs, sports et musique
  'guitare', 'piano', 'violon', 'trompette', 'tambour', 'ballon', 'raquette', 'médaille', 'trophée', 'football',
  'tennis', 'natation', 'rugby', 'judo', 'escrime', 'gymnastique', 'équitation', 'cyclisme', 'marathon', 'olympique',
  'arbitre', 'stade', 'champion', 'victoire', 'défaite', 'équipe', 'cinéma', 'théâtre', 'concert', 'puzzle',
  // Lieux
  'château', 'église', 'musée', 'hôpital', 'pharmacie', 'boulangerie', 'marché', 'village', 'quartier', 'capitale',
  'frontière', 'bibliothèque', 'piscine', 'restaurant', 'magasin', 'usine', 'ferme', 'phare', 'port', 'campagne',
  // Aventure et contes
  'voyage', 'vacances', 'aventure', 'trésor', 'pirate', 'sorcière', 'dragon', 'fantôme', 'princesse', 'royaume',
  'couronne', 'épée', 'bouclier', 'armure', 'lanterne', 'boussole', 'carte', 'mystère', 'magicien', 'licorne',
  // Vêtements et objets du quotidien
  'chapeau', 'écharpe', 'manteau', 'chemise', 'pantalon', 'chaussure', 'chaussette', 'ceinture', 'cravate', 'lunettes',
  'montre', 'bague', 'collier', 'bracelet', 'parfum', 'savon', 'brosse', 'peigne', 'serviette', 'dentifrice',
  // Idées et fêtes
  'bonheur', 'amitié', 'courage', 'liberté', 'silence', 'nature', 'couleur', 'anniversaire', 'cadeau', 'fête',
  'surprise', 'vacarme', 'souvenir', 'promesse', 'secret', 'énigme', 'jeudi', 'dimanche', 'janvier', 'décembre',
]);

/** Lettres de A à Z sans accents, en majuscules (« Éléphant » → « ELEPHANT »). Pur. */
function normalizeWord(text) {
  return String(text ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase();
}

/** Mot affichable (majuscules accentuées) et sa forme de comparaison. */
function prepareWord(raw) {
  const display = String(raw).toLocaleUpperCase('fr-FR');
  return { display, plain: normalizeWord(raw) };
}

/** Tire un mot de la liste. */
function randomWord(rng = Math.random) {
  return prepareWord(WORDS[Math.floor(rng() * WORDS.length)]);
}

/** Lettre proposée valide (A à Z) ? */
const isLetter = (value) => typeof value === 'string' && /^[A-Z]$/.test(value);

/** Mot masqué : lettres trouvées (avec accents), « _ » sinon, séparées par des espaces. Pur. */
function maskWord(word, guessed) {
  const set = guessed instanceof Set ? guessed : new Set(guessed);
  return [...word.display].map((ch, i) => (set.has(word.plain[i]) ? ch : '_')).join(' ');
}

/** Toutes les lettres du mot sont-elles trouvées ? Pur. */
function isSolved(word, guessed) {
  const set = guessed instanceof Set ? guessed : new Set(guessed);
  return [...word.plain].every((l) => set.has(l));
}

/** Nombre d'erreurs : lettres proposées absentes du mot. Pur. */
function errorCount(word, guessed) {
  return [...guessed].filter((l) => !word.plain.includes(l)).length;
}

/** Dessin du pendu après `errors` erreurs (0 à 6). */
const DRAWINGS = Object.freeze([
  ['  +---+', '  |   |', '      |', '      |', '      |', '      |', '========='],
  ['  +---+', '  |   |', '  O   |', '      |', '      |', '      |', '========='],
  ['  +---+', '  |   |', '  O   |', '  |   |', '      |', '      |', '========='],
  ['  +---+', '  |   |', '  O   |', ' /|   |', '      |', '      |', '========='],
  ['  +---+', '  |   |', '  O   |', ' /|\\  |', '      |', '      |', '========='],
  ['  +---+', '  |   |', '  O   |', ' /|\\  |', ' /    |', '      |', '========='],
  ['  +---+', '  |   |', '  O   |', ' /|\\  |', ' / \\  |', '      |', '========='],
].map((lines) => lines.join('\n')));

const drawing = (errors) => DRAWINGS[Math.min(MAX_ERRORS, Math.max(0, errors))];

/** Points d'une victoire : 1 + vies restantes (1 à 7). Pur. */
const winPoints = (errors) => 1 + Math.max(0, MAX_ERRORS - errors);

module.exports = { MAX_ERRORS, LETTERS, FIRST_HALF, SECOND_HALF, WORDS, normalizeWord, prepareWord, randomWord, isLetter, maskWord, isSolved, errorCount, drawing, winPoints, DRAWINGS };
