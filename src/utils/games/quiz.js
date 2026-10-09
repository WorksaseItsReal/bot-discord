'use strict';

/**
 * Quiz : questions embarquées (sans réseau) et logique pure.
 * Chaque question : `q` (énoncé), `a` (LA bonne réponse), `w` (trois mauvaises réponses).
 * L'ordre des choix est tiré au sort à chaque partie.
 */

const THEMES = Object.freeze({
  culture: { label: 'Culture générale', emoji: '🎭' },
  sciences: { label: 'Sciences', emoji: '🔬' },
  geographie: { label: 'Géographie', emoji: '🌍' },
  histoire: { label: 'Histoire', emoji: '🏛️' },
  jeuxvideo: { label: 'Jeux vidéo', emoji: '🎮' },
});

const MIN_ROUNDS = 1;
const MAX_ROUNDS = 10;
const DEFAULT_ROUNDS = 5;
const CHOICE_EMOJIS = Object.freeze(['🇦', '🇧', '🇨', '🇩']);

const q = (theme) => (text, answer, wrong) => ({ theme, q: text, a: answer, w: wrong });
const culture = q('culture');
const sciences = q('sciences');
const geo = q('geographie');
const histoire = q('histoire');
const jv = q('jeuxvideo');

// prettier-ignore
const QUESTIONS = Object.freeze([
  // ---------------------------------------------------------------- culture générale
  culture('Combien de jours compte une année bissextile ?', '366', ['365', '364', '360']),
  culture('Combien de côtés possède un hexagone ?', '6', ['5', '7', '8']),
  culture('Qui a peint « La Joconde » ?', 'Léonard de Vinci', ['Michel-Ange', 'Raphaël', 'Botticelli']),
  culture('Qui a écrit « Les Misérables » ?', 'Victor Hugo', ['Émile Zola', 'Gustave Flaubert', 'Honoré de Balzac']),
  culture('Combien de joueurs une équipe de football aligne-t-elle sur le terrain ?', '11', ['10', '9', '12']),
  culture('Quelle couleur obtient-on en mélangeant du bleu et du jaune ?', 'Vert', ['Violet', 'Orange', 'Marron']),
  culture('Combien de secondes y a-t-il dans une heure ?', '3 600', ['360', '6 000', '1 000']),
  culture('Combien de touches compte un piano standard ?', '88', ['76', '92', '64']),
  culture('Qui a composé l\'opéra « La Flûte enchantée » ?', 'Mozart', ['Beethoven', 'Bach', 'Verdi']),
  culture('En quelle année la tour Eiffel a-t-elle été inaugurée ?', '1889', ['1900', '1871', '1914']),
  culture('Qui est l\'auteur du « Petit Prince » ?', 'Antoine de Saint-Exupéry', ['Jules Verne', 'Albert Camus', 'Marcel Pagnol']),
  culture('Combien de cartes compte un jeu de tarot ?', '78', ['52', '54', '32']),
  culture('Combien de cases compte un échiquier ?', '64', ['81', '100', '49']),
  culture('Quelle pièce du jeu d\'échecs se déplace en « L » ?', 'Le cavalier', ['Le fou', 'La tour', 'Le roi']),
  culture('Qui a écrit « Roméo et Juliette » ?', 'William Shakespeare', ['Molière', 'Charles Dickens', 'Jean Racine']),
  culture('Quel détective célèbre a été créé par Arthur Conan Doyle ?', 'Sherlock Holmes', ['Hercule Poirot', 'Arsène Lupin', 'Jules Maigret']),
  culture('Quelle romancière a créé le détective Hercule Poirot ?', 'Agatha Christie', ['Mary Shelley', 'Jane Austen', 'George Sand']),
  culture('Dans quel pays sont nés les Jeux olympiques antiques ?', 'La Grèce', ['L\'Italie', 'L\'Égypte', 'La Turquie']),
  culture('Combien d\'anneaux figurent sur le drapeau olympique ?', '5', ['4', '6', '7']),
  culture('Quelle est la langue officielle du Brésil ?', 'Le portugais', ['L\'espagnol', 'Le brésilien', 'L\'anglais']),
  culture('Quelle est la monnaie du Japon ?', 'Le yen', ['Le yuan', 'Le won', 'Le baht']),
  culture('Combien de couleurs compte-t-on traditionnellement dans un arc-en-ciel ?', '7', ['5', '6', '8']),
  culture('Qui a réalisé le film « E.T. l\'extra-terrestre » ?', 'Steven Spielberg', ['George Lucas', 'James Cameron', 'Ridley Scott']),
  culture('Quel héros de bande dessinée a pour fidèle compagnon le chien Milou ?', 'Tintin', ['Astérix', 'Spirou', 'Lucky Luke']),
  culture('Comment s\'appelle le petit chien d\'Obélix ?', 'Idéfix', ['Milou', 'Rantanplan', 'Pif']),
  culture('Combien de notes différentes compte une gamme majeure ?', '7', ['5', '8', '12']),
  culture('Qui a écrit « Vingt mille lieues sous les mers » ?', 'Jules Verne', ['Alexandre Dumas', 'Victor Hugo', 'H. G. Wells']),
  culture('Dans quel musée « La Joconde » est-elle exposée ?', 'Le Louvre', ['Le musée d\'Orsay', 'Le Prado', 'Les Offices']),

  // ---------------------------------------------------------------- sciences
  sciences('Quel est le symbole chimique de l\'or ?', 'Au', ['Or', 'Ag', 'Go']),
  sciences('Quel est le symbole chimique du fer ?', 'Fe', ['Fr', 'Ir', 'F']),
  sciences('Quelle planète est la plus proche du Soleil ?', 'Mercure', ['Vénus', 'Mars', 'La Terre']),
  sciences('Quelle est la plus grande planète du système solaire ?', 'Jupiter', ['Saturne', 'Neptune', 'Uranus']),
  sciences('Combien de planètes compte le système solaire ?', '8', ['9', '7', '10']),
  sciences('Quelle est la formule chimique de l\'eau ?', 'H₂O', ['CO₂', 'O₂', 'H₂O₂']),
  sciences('Quel gaz les plantes absorbent-elles pour réaliser la photosynthèse ?', 'Le dioxyde de carbone', ['L\'oxygène', 'L\'azote', 'L\'hélium']),
  sciences('Quel est le gaz le plus abondant dans l\'atmosphère terrestre ?', 'L\'azote', ['L\'oxygène', 'Le dioxyde de carbone', 'L\'argon']),
  sciences('Combien d\'os compte le squelette d\'un adulte ?', '206', ['186', '226', '312']),
  sciences('Quel organe pompe le sang dans tout le corps ?', 'Le cœur', ['Le foie', 'Les poumons', 'Les reins']),
  sciences('Quelle est la vitesse approximative de la lumière dans le vide ?', '300 000 km/s', ['30 000 km/s', '3 000 km/s', '3 000 000 km/s']),
  sciences('À quelle température l\'eau bout-elle au niveau de la mer ?', '100 °C', ['90 °C', '120 °C', '80 °C']),
  sciences('Quelle est l\'unité de mesure de la résistance électrique ?', 'L\'ohm', ['Le volt', 'L\'ampère', 'Le watt']),
  sciences('Qui a formulé la théorie de la relativité ?', 'Albert Einstein', ['Isaac Newton', 'Niels Bohr', 'Galilée']),
  sciences('Qui a découvert la pénicilline ?', 'Alexander Fleming', ['Louis Pasteur', 'Marie Curie', 'Robert Koch']),
  sciences('Quel savant français a mis au point le vaccin contre la rage ?', 'Louis Pasteur', ['Claude Bernard', 'Pierre Curie', 'Antoine Lavoisier']),
  sciences('Combien de chromosomes compte une cellule humaine (hors cellules sexuelles) ?', '46', ['23', '44', '48']),
  sciences('Quel est le plus grand organe du corps humain ?', 'La peau', ['Le foie', 'Le cerveau', 'Les poumons']),
  sciences('Quelle planète est surnommée « la planète rouge » ?', 'Mars', ['Vénus', 'Jupiter', 'Mercure']),
  sciences('Combien de temps met environ la lumière du Soleil pour atteindre la Terre ?', '8 minutes', ['8 secondes', '1 heure', '1 jour']),
  sciences('Quel élément chimique porte le numéro atomique 1 ?', 'L\'hydrogène', ['L\'hélium', 'L\'oxygène', 'Le carbone']),
  sciences('Quel métal est liquide à température ambiante ?', 'Le mercure', ['Le plomb', 'L\'étain', 'Le zinc']),
  sciences('Quel est le symbole chimique du sodium ?', 'Na', ['So', 'Sd', 'S']),
  sciences('Combien de pattes possède une araignée ?', '8', ['6', '10', '12']),
  sciences('Lequel de ces animaux marins est un mammifère ?', 'La baleine', ['Le requin', 'Le thon', 'Le saumon']),
  sciences('Quelle est la valeur approchée du nombre π (pi) ?', '3,14', ['2,72', '1,62', '3,41']),
  sciences('Que vaut la somme des angles d\'un triangle ?', '180°', ['90°', '360°', '270°']),
  sciences('Dans une cellule animale, où se trouve l\'essentiel de l\'ADN ?', 'Dans le noyau', ['Dans la membrane', 'Dans le cytoplasme', 'Dans les ribosomes']),

  // ---------------------------------------------------------------- géographie
  geo('Quelle est la capitale de l\'Australie ?', 'Canberra', ['Sydney', 'Melbourne', 'Perth']),
  geo('Quelle est la capitale du Canada ?', 'Ottawa', ['Toronto', 'Montréal', 'Vancouver']),
  geo('Quel est le plus long fleuve de France ?', 'La Loire', ['La Seine', 'La Garonne', 'La Dordogne']),
  geo('Quel est le plus haut sommet des Alpes ?', 'Le mont Blanc', ['Le Cervin', 'Le mont Rose', 'La barre des Écrins']),
  geo('Quel est le plus grand océan du monde ?', 'L\'océan Pacifique', ['L\'océan Atlantique', 'L\'océan Indien', 'L\'océan Arctique']),
  geo('Quel est le plus grand désert chaud du monde ?', 'Le Sahara', ['Le désert de Gobi', 'Le Kalahari', 'L\'Atacama']),
  geo('Quelle est la capitale du Japon ?', 'Tokyo', ['Kyoto', 'Osaka', 'Séoul']),
  geo('Dans quel pays se trouve la ville de Marrakech ?', 'Le Maroc', ['L\'Algérie', 'La Tunisie', 'L\'Égypte']),
  geo('Quel est le plus haut sommet du monde ?', 'L\'Everest', ['Le K2', 'Le Kilimandjaro', 'Le mont Blanc']),
  geo('Quelle est la capitale de l\'Espagne ?', 'Madrid', ['Barcelone', 'Séville', 'Valence']),
  geo('Quelle est la capitale de l\'Italie ?', 'Rome', ['Milan', 'Naples', 'Florence']),
  geo('Quelle est la capitale de l\'Allemagne ?', 'Berlin', ['Munich', 'Francfort', 'Hambourg']),
  geo('Quel fleuve traverse Paris ?', 'La Seine', ['La Loire', 'Le Rhône', 'La Garonne']),
  geo('Quel pays a la forme d\'une botte ?', 'L\'Italie', ['La Grèce', 'Le Portugal', 'La Croatie']),
  geo('Quelle est la capitale du Brésil ?', 'Brasília', ['Rio de Janeiro', 'São Paulo', 'Salvador']),
  geo('Dans quel pays se trouve le site du Machu Picchu ?', 'Le Pérou', ['La Bolivie', 'Le Mexique', 'Le Chili']),
  geo('Quel est le plus long fleuve d\'Afrique ?', 'Le Nil', ['Le Congo', 'Le Niger', 'Le Zambèze']),
  geo('Quel est le plus grand pays du monde par sa superficie ?', 'La Russie', ['Le Canada', 'La Chine', 'Les États-Unis']),
  geo('Quelle mer sépare l\'Europe de l\'Afrique ?', 'La Méditerranée', ['La mer Noire', 'La mer Rouge', 'La mer Baltique']),
  geo('Quelle est la capitale de la Belgique ?', 'Bruxelles', ['Anvers', 'Liège', 'Bruges']),
  geo('Quelle ville est le siège des autorités fédérales suisses ?', 'Berne', ['Genève', 'Zurich', 'Lausanne']),
  geo('Quel est le plus petit État du monde ?', 'Le Vatican', ['Monaco', 'Saint-Marin', 'Le Liechtenstein']),
  geo('Dans quelle ville se dresse la statue de la Liberté ?', 'New York', ['Washington', 'Boston', 'Chicago']),
  geo('Quel est le plus grand pays d\'Amérique du Sud ?', 'Le Brésil', ['L\'Argentine', 'Le Pérou', 'La Colombie']),
  geo('Quelle chaîne de montagnes sépare la France de l\'Espagne ?', 'Les Pyrénées', ['Les Alpes', 'Le Jura', 'Les Vosges']),
  geo('Quelle est la capitale du Portugal ?', 'Lisbonne', ['Porto', 'Faro', 'Coimbra']),
  geo('Sur quel continent se trouve l\'essentiel du territoire de l\'Égypte ?', 'L\'Afrique', ['L\'Asie', 'L\'Europe', 'L\'Océanie']),
  geo('Quelle est la capitale du Royaume-Uni ?', 'Londres', ['Manchester', 'Édimbourg', 'Liverpool']),

  // ---------------------------------------------------------------- histoire
  histoire('En quelle année a eu lieu la prise de la Bastille ?', '1789', ['1792', '1776', '1815']),
  histoire('Qui fut le premier empereur des Français ?', 'Napoléon Ier', ['Louis XIV', 'Charlemagne', 'Napoléon III']),
  histoire('En quelle année a commencé la Première Guerre mondiale ?', '1914', ['1918', '1912', '1939']),
  histoire('En quelle année s\'est terminée la Seconde Guerre mondiale ?', '1945', ['1944', '1946', '1939']),
  histoire('Quel roi de France était surnommé le « Roi-Soleil » ?', 'Louis XIV', ['Louis XVI', 'François Ier', 'Henri IV']),
  histoire('Qui fut le premier homme à marcher sur la Lune ?', 'Neil Armstrong', ['Buzz Aldrin', 'Youri Gagarine', 'John Glenn']),
  histoire('En quelle année l\'homme a-t-il marché sur la Lune pour la première fois ?', '1969', ['1965', '1972', '1961']),
  histoire('Quelle héroïne française fut brûlée à Rouen en 1431 ?', 'Jeanne d\'Arc', ['Catherine de Médicis', 'Aliénor d\'Aquitaine', 'Marie-Antoinette']),
  histoire('En quelle année le mur de Berlin est-il tombé ?', '1989', ['1991', '1985', '1961']),
  histoire('Qui fut le premier président des États-Unis ?', 'George Washington', ['Abraham Lincoln', 'Thomas Jefferson', 'John Adams']),
  histoire('Quelle civilisation a bâti les pyramides de Gizeh ?', 'Les Égyptiens', ['Les Romains', 'Les Mayas', 'Les Grecs']),
  histoire('En quelle année Christophe Colomb a-t-il atteint l\'Amérique ?', '1492', ['1515', '1453', '1498']),
  histoire('Quel chef gaulois a affronté Jules César à Alésia ?', 'Vercingétorix', ['Astérix', 'Brennus', 'Ambiorix']),
  histoire('Quel homme d\'État romain fut assassiné aux ides de mars 44 av. J.-C. ?', 'Jules César', ['Néron', 'Auguste', 'Caligula']),
  histoire('Quel roi de France fut guillotiné en 1793 ?', 'Louis XVI', ['Louis XV', 'Louis XVIII', 'Charles X']),
  histoire('En quelle année fut signé l\'armistice de la Première Guerre mondiale ?', '1918', ['1917', '1919', '1920']),
  histoire('Quel paquebot a coulé lors de son voyage inaugural en 1912 ?', 'Le Titanic', ['Le Lusitania', 'Le Britannic', 'Le Queen Mary']),
  histoire('Qui fut couronné empereur d\'Occident en l\'an 800 ?', 'Charlemagne', ['Clovis', 'Pépin le Bref', 'Charles Martel']),
  histoire('Quelle bataille de 1815 marque la défaite finale de Napoléon ?', 'Waterloo', ['Austerlitz', 'Iéna', 'Wagram']),
  histoire('Quel pays a offert la statue de la Liberté aux États-Unis ?', 'La France', ['Le Royaume-Uni', 'L\'Espagne', 'L\'Italie']),
  histoire('En quelle année les Françaises ont-elles voté pour la première fois ?', '1945', ['1936', '1918', '1958']),
  histoire('Qui fut le premier président de la Ve République ?', 'Charles de Gaulle', ['Georges Pompidou', 'René Coty', 'Vincent Auriol']),
  histoire('Qui a mis au point l\'imprimerie à caractères mobiles en Europe ?', 'Gutenberg', ['Galilée', 'Léonard de Vinci', 'Copernic']),
  histoire('Quelle reine d\'Égypte fut l\'alliée de Jules César puis de Marc Antoine ?', 'Cléopâtre', ['Néfertiti', 'Hatchepsout', 'Néfertari']),
  histoire('Quel navigateur a dirigé la première expédition autour du monde, partie en 1519 ?', 'Fernand de Magellan', ['Vasco de Gama', 'Christophe Colomb', 'Jacques Cartier']),
  histoire('En quelle année a eu lieu le débarquement allié en Normandie ?', '1944', ['1943', '1942', '1945']),
  histoire('Qui fut le premier homme à voyager dans l\'espace ?', 'Youri Gagarine', ['Neil Armstrong', 'Alexeï Leonov', 'John Glenn']),
  histoire('Quelle dynastie régnait en France au moment de la Révolution ?', 'Les Bourbons', ['Les Valois', 'Les Mérovingiens', 'Les Carolingiens']),

  // ---------------------------------------------------------------- jeux vidéo
  jv('Comment s\'appelle le frère de Mario ?', 'Luigi', ['Wario', 'Toad', 'Yoshi']),
  jv('Comment s\'appelle le roi des Koopas, ennemi juré de Mario ?', 'Bowser', ['Ganondorf', 'Wario', 'King K. Rool']),
  jv('Dans quelle série de jeux incarne-t-on le héros Link ?', 'The Legend of Zelda', ['Final Fantasy', 'Metroid', 'Kirby']),
  jv('Comment s\'appelle le hérisson bleu, mascotte de Sega ?', 'Sonic', ['Tails', 'Knuckles', 'Shadow']),
  jv('Quel Pokémon est la mascotte de la série ?', 'Pikachu', ['Évoli', 'Rondoudou', 'Salamèche']),
  jv('Dans Pokémon, de quel type est Salamèche ?', 'Feu', ['Eau', 'Plante', 'Dragon']),
  jv('Quel jeu consiste à empiler des pièces appelées tétriminos ?', 'Tetris', ['Pac-Man', 'Columns', 'Puyo Puyo']),
  jv('Quel personnage jaune avale des pac-gommes en fuyant des fantômes ?', 'Pac-Man', ['Kirby', 'Q*bert', 'Bomberman']),
  jv('Dans Minecraft, quelle créature verte explose près du joueur ?', 'Le Creeper', ['L\'Enderman', 'Le Zombie', 'Le Ghast']),
  jv('Quelle entreprise a créé la console PlayStation ?', 'Sony', ['Nintendo', 'Sega', 'Microsoft']),
  jv('Quelle entreprise fabrique les consoles Xbox ?', 'Microsoft', ['Sony', 'Nintendo', 'Sega']),
  jv('Quelle entreprise française édite la série Assassin\'s Creed ?', 'Ubisoft', ['Ankama', 'Quantic Dream', 'Gameloft']),
  jv('Quel soldat est le héros de la série Halo ?', 'Master Chief', ['Marcus Fenix', 'Samus Aran', 'Gordon Freeman']),
  jv('Comment s\'appelle la chasseuse de primes héroïne de Metroid ?', 'Samus Aran', ['Lara Croft', 'Bayonetta', 'Jill Valentine']),
  jv('Quelle aventurière est l\'héroïne de Tomb Raider ?', 'Lara Croft', ['Samus Aran', 'Chun-Li', 'Aloy']),
  jv('Quel dinosaure vert sert souvent de monture à Mario ?', 'Yoshi', ['Rex', 'Birdo', 'Dino']),
  jv('Dans quel jeu de Nintendo s\'installe-t-on sur une île avec l\'aide de Tom Nook ?', 'Animal Crossing', ['Harvest Moon', 'Stardew Valley', 'Pikmin']),
  jv('En quelle année est sortie la console Nintendo Switch ?', '2017', ['2015', '2019', '2013']),
  jv('Quel jeu d\'Epic Games oppose 100 joueurs qui peuvent construire des structures ?', 'Fortnite', ['PUBG', 'Apex Legends', 'Warzone']),
  jv('Quel jeu de Rockstar, sorti en 2013, se déroule à Los Santos ?', 'Grand Theft Auto V', ['Red Dead Redemption 2', 'Mafia III', 'Watch Dogs']),
  jv('Quelle console portable de Nintendo est sortie en 1989 ?', 'La Game Boy', ['La Game Gear', 'La Nintendo DS', 'La PSP']),
  jv('Quel jeu de karts réunit Mario et ses amis ?', 'Mario Kart', ['Crash Team Racing', 'Sonic & All-Stars Racing', 'F-Zero']),
  jv('Quelle langue imaginaire parlent les personnages des Sims ?', 'Le simlish', ['Le sindarin', 'Le klingon', 'L\'espéranto']),
  jv('Quel jeu de construction en blocs a été créé par Markus « Notch » Persson ?', 'Minecraft', ['Roblox', 'Terraria', 'Lego Worlds']),
  jv('Dans Street Fighter, lequel de ces combattants lance le « Hadoken » ?', 'Ryu', ['Guile', 'Blanka', 'Zangief']),
  jv('Dans quelle série d\'Ubisoft les Lapins Crétins sont-ils apparus ?', 'Rayman', ['Prince of Persia', 'Assassin\'s Creed', 'Far Cry']),
  jv('Combien de fantômes poursuivent Pac-Man dans le jeu original ?', '4', ['3', '5', '6']),
  jv('Quel personnage rose de Nintendo aspire ses ennemis pour copier leurs pouvoirs ?', 'Kirby', ['Rondoudou', 'Yoshi', 'Toad']),
]);

/** Mélange de Fisher-Yates (copie). Pur avec `rng` injecté. */
function shuffle(list, rng = Math.random) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Nombre de manches borné (1 à 10, 5 par défaut). Pur. */
function clampRounds(value) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return DEFAULT_ROUNDS;
  return Math.min(MAX_ROUNDS, Math.max(MIN_ROUNDS, n));
}

/**
 * Tire `rounds` questions (thème donné ou tous), sans doublon, choix mélangés.
 * @returns {{ theme: string, q: string, choices: string[], answer: number }[]}
 */
function drawQuestions(theme, rounds, rng = Math.random) {
  const pool = theme && Object.hasOwn(THEMES, theme) ? QUESTIONS.filter((x) => x.theme === theme) : QUESTIONS;
  return shuffle(pool, rng).slice(0, clampRounds(rounds)).map((x) => {
    const choices = shuffle([x.a, ...x.w], rng);
    return { theme: x.theme, q: x.q, choices, answer: choices.indexOf(x.a) };
  });
}

/**
 * Classement final : [{ userId, points, outcome }] trié (points décroissants).
 * Seul en tête → victoire ; ex æquo en tête → nul ; les autres → défaite. Pur.
 * @param {Map<string, number>|Record<string, number>} scores points par participant
 */
function finalRanking(scores) {
  const entries = (scores instanceof Map ? [...scores.entries()] : Object.entries(scores ?? {})).filter(([, p]) => Number.isFinite(p));
  entries.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  const top = entries[0]?.[1] ?? 0;
  const leaders = entries.filter(([, p]) => p === top).length;
  return entries.map(([userId, points]) => ({
    userId,
    points,
    outcome: points === top && top > 0 ? (leaders === 1 ? 'win' : 'draw') : 'loss',
  }));
}

module.exports = { THEMES, QUESTIONS, CHOICE_EMOJIS, MIN_ROUNDS, MAX_ROUNDS, DEFAULT_ROUNDS, shuffle, clampRounds, drawQuestions, finalRanking };
