// What a block's channel guide shows (see guideConfig.js for the why).
//
// Rule (operator + GLC direction, 2026-11-10): the guide that closes a block
// lists what is STILL TO COME in the current bracket (06–12, 12–18, 18–24,
// 00–06), counted from the moment the block's window ends. The last block of a
// bracket therefore shows the next bracket — and when a channel is off air for
// a whole bracket, the first bracket that has something.
//
// Times are the playlist's: each block's clips run back to back from its
// shifted window start (what a push sends), fillers left out of the list.
// Consecutive airings of one show fold into one row ("S02E23–E24"); every lesson is
// its own row with its topic and subject (operator 2026-11-12), and a
// bracket never lists more than 10 rows. Pure apart from the SQL reads, so the
// grouping can be tested on its own (groupRows).

import { db } from '../db.js';
import { channelDayBlocks, linkShifts } from './scheduling.js';
import { statedEpisode } from './episodeParse.js';
import { addDays } from '../dates.js';
import { BRACKETS, bracketAt, channelStyle, guideConfig } from './guideConfig.js';

const DAY = 86400;
const dayNumber = (date) => Math.round(Date.parse(`${date}T00:00:00Z`) / 86400000);
const dateOf = (dayNo) => new Date(dayNo * 86400000).toISOString().slice(0, 10);
const hhmm = (t) => { const [h, m] = String(t).split(':').map(Number); return (h || 0) * 3600 + (m || 0) * 60; };
const MAX_ROWS = 10;
const MOVIE_MIN_SECONDS = 2400; // a "movie" shorter than this is a short (Agri Talk clips are filed as Movies)

// Names as the catalogue has them → how the guide prints them. config.guide.titles adds to it.
const TITLE_FIX = {
  edpal: 'EDPAL+ Gala', 'Agri talk new videos': 'Agri Talk', 'Different Strokes': "Diff'rent Strokes",
  HarryPotter4GobletOfFire: 'Harry Potter and the Goblet of Fire', 'Across The Spider Verse': 'Across the Spider-Verse',
  'Raya Last Dragon': 'Raya and the Last Dragon', 'W & G Vengeance Most Fowl': 'Wallace & Gromit: Vengeance Most Fowl',
  'W&G Vengeance Most Fowl': 'Wallace & Gromit: Vengeance Most Fowl',
  'Beauty & Beast Enchanted Cmas': 'Beauty and the Beast: Enchanted Christmas',
  'Pirates! Band Of Misfits': 'The Pirates! Band of Misfits', 'Shaun The Sheep Farmageddon': 'Shaun the Sheep: Farmageddon',
  'The B F G': 'The BFG',
  HarryPotter1PhilosopStone: "Harry Potter and the Philosopher's Stone", HarryPotter2ChamberSecrets: 'Harry Potter and the Chamber of Secrets',
  HarryPotter3PrisonerAzkaban: 'Harry Potter and the Prisoner of Azkaban', HarryPotter5OrderOfPhoenix: 'Harry Potter and the Order of the Phoenix',
  HarryPotter6HalfBloodPrince: 'Harry Potter and the Half-Blood Prince', HarryPotter7DeathHallows1: 'Harry Potter and the Deathly Hallows – Part 1',
  HarryPotter8DeathHallows2: 'Harry Potter and the Deathly Hallows – Part 2',
  ChroniclesOfNarnia1_TLTWATW: 'The Chronicles of Narnia: The Lion, the Witch and the Wardrobe',
  ChroniclesOfNarnia2_PC: 'The Chronicles of Narnia: Prince Caspian', 'ChroniclesOfNarnia3._TVOTDT': 'The Chronicles of Narnia: The Voyage of the Dawn Treader',
  CloudyWAChanceOfMeatballs2: 'Cloudy with a Chance of Meatballs 2', LandB4TimeJourneyOfTheHeart: 'The Land Before Time: Journey of the Heart',
  Madagascar_2_Escape2Africa: 'Madagascar: Escape 2 Africa', The_Lego_Movie_2_The2ndPart: 'The Lego Movie 2: The Second Part',
  // operator 2026-11-17: film titles as the public knows them (the stories went out with 'Fred Clause', 'Cloudy WAChance…')
  "AliceThruTheLookingGlass": "Alice Through the Looking Glass",
  "Alice_In_Wonderland": "Alice in Wonderland",
  "Alice_In_Wonderland_2010": "Alice in Wonderland (2010)",
  "Atlantis_Milo’s_Return": "Atlantis: Milo's Return",
  "Back_To_The_Future_1": "Back to the Future",
  "BahHumduck!LooneyTunesCmas": "Bah, Humduck! A Looney Tunes Christmas",
  "Beauty_And_The_Beast_2017": "Beauty and the Beast",
  "Charlie&TheChocolateFactory": "Charlie and the Chocolate Factory",
  "Charlotte’s_Web": "Charlotte's Web",
  "ET_The_Extra_Terrestrial": "E.T. the Extra-Terrestrial",
  "Fantastic_Mr_Fox": "Fantastic Mr. Fox",
  "Fred_Clause": "Fred Claus",
  "Into_The_Spider_Verse": "Spider-Man: Into the Spider-Verse",
  "Jingle_All_The_Way": "Jingle All the Way",
  "Kronk’s_New_Groove": "Kronk's New Groove",
  "Mary_Poppins_1": "Mary Poppins",
  "MickeyTwiceUponAChristmas": "Mickey's Twice Upon a Christmas",
  "OctonautsCavesOfSacActun": "Octonauts & the Caves of Sac Actun",
  "OctonautsGreatBarrier_Reef": "Octonauts: The Great Barrier Reef",
  "Octonauts_The_Ring_Of_Fire": "Octonauts & the Ring of Fire",
  "OneHundred&OneDalmatians": "One Hundred and One Dalmatians",
  "Open_Season_4_Scared_Silly": "Open Season: Scared Silly",
  "Over_The_Hedge": "Over the Hedge",
  "Oz_The_Great_And_Powerful": "Oz the Great and Powerful",
  "Polar_Express": "The Polar Express",
  "Ralph_Breaks_The_Internet": "Ralph Breaks the Internet",
  "RudolphTheRedNoseReindeer": "Rudolph the Red-Nosed Reindeer",
  "SeriesOfUnfortunateEvents": "A Series of Unfortunate Events",
  "Shaun_The_Sheep_Movie": "Shaun the Sheep Movie",
  "Son_Of_The_Mask": "Son of the Mask",
  "Stuart_Little_1": "Stuart Little",
  "Tarzan_1": "Tarzan",
  "The_Emperor’s_New_Groove": "The Emperor's New Groove",
  "The_Incredibles_1": "The Incredibles",
  "The_Incredibles_2": "Incredibles 2",
  "The_Princess_And_The_Frog": "The Princess and the Frog",
  "The_Secret_Life_Of_Pets_1": "The Secret Life of Pets",
  "The_Secret_Life_Of_Pets_2": "The Secret Life of Pets 2",
  "TheMitchellsVsTheMachines": "The Mitchells vs. the Machines",
  "The_Super_Mario_Bros_Movie": "The Super Mario Bros. Movie",
  "Wall_E": "WALL-E",
  "Wreck_It_Ralph": "Wreck-It Ralph",
  "Zathura_A_Space_Adventure": "Zathura: A Space Adventure",
  "Beauty&BeastEnchantedCmas": "Beauty and the Beast: Enchanted Christmas",
  "Muppets_Haunted_Mansion": "Muppets Haunted Mansion",
  Cars1: 'Cars', Cars2: 'Cars 2', Cars3: 'Cars 3', 'The_Jungle_Book_3_(2016)': 'The Jungle Book (2016)',
};

/** A file name made readable: "Peter_Pan_(2003)" → "Peter Pan (2003)". */
export function prettyName(name) {
  let s = String(name || '').replace(/\.(mp4|mov|mpg|mxf|avi|mkv)$/i, '');
  s = s.replace(/_/g, ' ').replace(/&/g, ' & ');
  s = s.replace(/(?<=[a-z])(?=[A-Z0-9])/g, ' ');
  s = s.replace(/(?<=[0-9])(?=[A-Z][a-z])/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  return s.replace(/ ((?:19|20)\d\d)$/, ' ($1)'); // "Scrooged 1988" → "Scrooged (1988)"
}
// The NAS organize of 2026-11-18 renamed the files ('_' -> ' ', 'S8E09' -> 'S08E09'), so known titles are
// also looked up by a normalised key ('Over The Hedge' finds 'Over_The_Hedge').
const normKey = (t) => String(t || '').replace(/\.(mp4|mov|mpg|mxf)$/i, '').toLowerCase().replace(/[^a-z0-9]/g, '');
let normMap = null;
const EXTRA_TITLES = {
  'Beauty And The Beast 2017': 'Beauty and the Beast', 'Peter Pan (2003)': 'Peter Pan', 'Over The Hedge': 'Over the Hedge',
  'ET The Extra Terrestrial': 'E.T. the Extra-Terrestrial', 'Ralph Breaks The Internet': 'Ralph Breaks the Internet',
  'The Super Mario Bros Movie': 'The Super Mario Bros. Movie', 'Into The Spider Verse': 'Spider-Man: Into the Spider-Verse',
  // shows and documentaries as the public knows them (operator 2026-11-17/18: no misspelt names on the panels)
  'Blues Clues': "Blue's Clues", 'Mythbusters': 'MythBusters', 'Brain Child': 'Brainchild', 'YGAY': 'Your Government & You',
  'Cosmos A Space Time Odyssey': 'Cosmos: A Spacetime Odyssey', 'Human the World Within': 'Human: The World Within',
  'Our Planet Frozen Worlds': 'Our Planet: Frozen Worlds', 'Live Shows': 'Launch of the TVET EMIS Platform',
  'Aladdin (2019)': 'Aladdin', 'Aladdin 2019': 'Aladdin', 'Mr Rogers': "Mister Rogers' Neighborhood", 'StillWater': 'Stillwater',
  'Little Einstein': 'Little Einsteins', 'Octonauts Above and Beyond': 'Octonauts: Above & Beyond', 'Seven Worlds One Planet': 'Seven Worlds, One Planet',
  'Escape Planet Earth': 'Escape from Planet Earth',
};
function fixTitle(t) {
  const extra = guideConfig().titles || {};
  const hit = extra[t] ?? TITLE_FIX[t] ?? EXTRA_TITLES[t];
  if (hit) return hit;
  normMap ??= new Map(Object.entries({ ...TITLE_FIX, ...EXTRA_TITLES }).map(([k, v]) => [normKey(k), v]));
  return normMap.get(normKey(t)) ?? spell(t);
}
// Whole titles and words the DB carries misspelt (same list as the stories, guia-render/day.py).
const SPELL_TITLES = {
  'Life Process of Animal': 'Life Processes of Animals', 'Identify Living and Non-living Things in the Environment': 'Living and Non-Living Things in the Environment',
  'The Plant Kingdom: Flowering and Non: Flowering Plants': 'The Plant Kingdom: Flowering and Non-Flowering Plants', 'Bar Graph': 'Bar Graphs',
  'Subtraction of Mixed Numbers with Regrouping & Without Regrouping': 'Subtracting Mixed Numbers With & Without Regrouping',
  'Naming 2 Dimensional and 3 Dimensional Shapes in the Environment': 'Naming 2D and 3D Shapes in the Environment',
  'What is a Sentence': 'What Is a Sentence?', 'Verb': 'Verbs', 'Non Biodegradable': 'Non-Biodegradable Materials',
  'Grade 2 Consonants and Vowels Sounds': 'Consonant and Vowel Sounds', 'Consonants & Vowels Sounds': 'Consonant and Vowel Sounds',
  'Relationship Among Organisms in the Eco System': 'Relationships Among Organisms in the Ecosystem',
  'Animals Sounds': 'Animal Sounds', 'People Around us': 'People Around Us', 'The Life Cycle of A Frog': 'The Life Cycle of a Frog',
};
const SPELL_WORDS = [[/\bSahding\b/g, 'Shading'], [/\bMonocotlyedons\b/g, 'Monocotyledons'], [/\bEco ?Systems\b/g, 'Ecosystems'], [/\bEco System\b/g, 'Ecosystem'],
  [/Unlike Denominator\b(?!s)/g, 'Unlike Denominators'], [/\bUNLIKE\b/g, 'Unlike'], [/\bPart (\d)\b/g, 'Pt. $1'], [/\bPt\.?\s*(\d)/g, 'Pt. $1'],
  [/\bDecimlas\b/g, 'Decimals'], [/\bEquivelant\b/g, 'Equivalent'], [/\bParagrah\b/g, 'Paragraph'], [/\bDiagraphs\b/g, 'Digraphs'], [/\bClimactic\b/g, 'Climatic'],
  [/^YGAY\b/, 'Your Government & You'], [/^Your Government & You E(\d+)\b.*$/, 'Your Government & You · Ep $1'],
  [/^(Junior (?:English|Mathematics|Social Studies|Science))\s*E(\d+)$/, '$1 · Ep $2'],
  [/^(?:English Language|Literacy)\s*–\s*/, '']];
function spell(t) {
  let s = SPELL_TITLES[t] ?? t;
  if (s.length > 12 && s === s.toUpperCase() && /[A-Z]{6}/.test(s)) {
    s = s.split(' ').map((w, i) => (i && SMALL_WORDS.has(w.toLowerCase()) ? w.toLowerCase() : w.length > 5 ? w.charAt(0) + w.slice(1).toLowerCase() : w)).join(' ');
  }
  for (const [a, b] of SPELL_WORDS) s = s.replace(a, b);
  return SPELL_TITLES[s] ?? s;
}


// Lesson file names carry scaffolding the DEU/IDB editors type ("lesson 25 Topic-…", "Lesson 4 - Topic X Subtopic - Y",
// "TABLES 4 5 6") and a few recurring typos. Operator 2026-11-17: the guide and the stories must read clean.
const TOPIC_TYPOS = { Decimlas: 'Decimals', Equivelant: 'Equivalent', Paragrah: 'Paragraph', Diagraphs: 'Digraphs', Langauge: 'Language', Survivial: 'Survival', Climactic: 'Climatic', Ingles: 'Inglés', Espanol: 'Español' };
const SMALL_WORDS = new Set(['a', 'an', 'and', 'of', 'the', 'to', 'in', 'on', 'with', 'for', 'or', 'at', 'by', 'from', 'vs']);
export function tidyTopic(t) {
  t = String(t || '').replace(/\s+/g, ' ').trim();
  t = t.replace(/^\d+\.\s*/, '');
  t = t.replace(/^(?:[A-Za-z-]+_)?(?:lesson\s*)?\d+\s*_\s*|^[A-Za-z-]+_lesson\s*\d+\s*[-–:]\s*/i, '');  // 'Science_Lesson 1_X', 'Maths_16_X' (DEU 2026)
  t = t.replace(/\s*_+\s*/g, ' ').trim();
  t = t.replace(/\s*[-–:]\s*E\d+$/, '');   // OCR rename 2026-11-18: 'Grade 2 - English Language - Nouns - E26'
  t = t.replace(/\s+re$/, '');                // 'Celebration in our Community re' (re-edit marker)
  t = t.replace(/^[-–\s]+/, '').replace(/^(?:English Language|Literacy|Maths)\s*[-–]\s*/, '').replace(/^Maths\s+\d+\s+/, '');
  t = t.replace(/^(?:social[- ]studies|studies|science|english(?: language)?|mathematics|maths)?\s*(?:lesson|lession)\s*\d+\s*[-–:]?\s*/i, '');
  t = t.replace(/^Structure, Function and Information Processing\s*[-–:]\s*/i, '');
  t = t.replace(/^[-–\s]*grade\s*\d+\s*[-–]\s*/i, '');
  t = t.replace(/^grade\s*\d+\s*(english language|english|mathematics|maths|science|social studies)\s*[-–:]?\s*/i, '');
  t = t.replace(/^(?:lesson|lession)\s*\d+\s*[-:]?\s*/i, '');
  t = t.replace(/^grades?\s*\d+\s*[-–]\s*(?:english language|english|mathematics|maths|science|social studies)\s*[-–]\s*/i, '');
  t = t.replace(/^nursery\s*[-–]\s*/i, '').replace(/\s+(?:edited|final|copy|v\d+)$/i, '');
  t = t.replace(/^S(\d+)\s*Ep\s*(\d+)$/i, 'Season $1 · Ep $2');
  t = t.replace(/^topic\s*[-:]?\s*/i, '');
  t = t.replace(/\s*[-:]?\s*sub-?topic\s*[-:]?\s*/i, ': ');
  t = t.replace(/\s+-\s+/g, ' – ').replace(/,(?=\S)/g, ', ');
  const tables = /^tables?((?:\s*\d+)+)$/i.exec(t);
  if (tables) { const n = tables[1].trim().split(/\s+/); t = `Tables of ${n.length > 1 ? `${n.slice(0, -1).join(', ')} and ${n.at(-1)}` : n[0]}`; }
  for (const [a, b] of Object.entries(TOPIC_TYPOS)) t = t.replace(new RegExp(`\\b${a}\\b`, 'g'), b);
  t = t.replace(/^(Junior (?:English|Mathematics|Literacy|Numeracy))\s*E(\d+)$/i, '$1 · Ep $2');
  t = t.replace(/\b(Ep \d+) (\w)/g, (_m, a, b) => `${a} · ${b.toUpperCase()}`);
  if (/^agri talk new$/i.test(t)) t = 'Agri Talk';
  const ws = t.split(' ');
  t = ws.map((w, i) => {
    const start = i === 0 || ws[i - 1].endsWith(':') || ws[i - 1] === '·' || ws[i - 1] === '–';
    if ((w === w.toUpperCase() && w.length > 1) || /\d/.test(w) || (w.replace(/,$/, '').length <= 2 && !start)) return w;
    if (!start && SMALL_WORDS.has(w.toLowerCase())) return w.toLowerCase();
    return w.charAt(0).toUpperCase() + w.slice(1);
  }).join(' ');
  return t.replace(/^[\s:–-]+|[\s:–-]+$/g, '');
}

const SUBJECT_SHORT = { 'english language': 'English', 'mathematics': 'Maths', 'math': 'Maths' };
const FILLER_WORDS = new Set(['program', 'programme', 'read', 'enjoy', 'discover', '&', 'and', 'junior', 'the']);

/**
 * A lesson as the guide must print it (operator 2026-11-12: "always the subject and the topic, and the
 * time — otherwise it serves no purpose"): title = the TOPIC the clip teaches, tag = its subject.
 * "Grade 2- English language- Singular & Plural Nouns" → { title: 'Singular & Plural Nouns', tag: 'Grade 2 · English' };
 * "Math_Intervention_Program_045_Algebra_and_Measurement_Part_1" → { title: 'Algebra and Measurement Part 1', tag: 'Math Intervention' }.
 */
export function lessonParts(c) {
  const base = String(c.display_name || c.name || '').replace(/\.(mp4|mov|mpg|mxf|avi|mkv)$/i, '').trim().replace(/Social-Studies/gi, 'Social Studies');
  const subjectRaw = String(c.subject || '').trim();
  const grade = /^(?:grade|garde)\s*(\d+)/i.exec(base)?.[1] ?? /^grade\s*(\d+)/i.exec(subjectRaw)?.[1] ?? null;
  let subj = subjectRaw.replace(/^grade\s*\d+\s*/i, '').trim();
  subj = SUBJECT_SHORT[subj.toLowerCase()] ?? subj;
  const subjWords = new Set(subjectRaw.toLowerCase().replace(/^grade\s*\d+\s*/, '').split(/\s+/).filter(Boolean));
  let topic = '';
  if (grade && /^(?:grade|garde)\s*\d+\s*-/i.test(base)) {
    const seg = base.split(/\s*-\s*/).map((x) => x.trim()).filter(Boolean).slice(1);
    // drop the subject segment(s): "English language", "Social", "Studies", "English"
    while (seg.length > 1 && seg[0].toLowerCase().split(/\s+/).every((w) => subjWords.has(w) || w === 'english' || w === 'language')) seg.shift();
    topic = seg.join(': ');
  } else {
    const words = prettyName(base).split(' ');
    while (words.length > 1 && (subjWords.has(words[0].toLowerCase()) || FILLER_WORDS.has(words[0].toLowerCase()) || /^\d+$/.test(words[0]))) words.shift();
    topic = words.join(' ');
    const ep = /^(?:ep|e|episode)\s*(\d+)\s*(.*)$/i.exec(topic);
    if (topic.split(' ').every((w) => subjWords.has(w.toLowerCase()) || FILLER_WORDS.has(w.toLowerCase()))) topic = prettyName(base);
    else if (ep && ep[2]) topic = `${ep[2]} · Ep ${Number(ep[1])}`;           // "Ep12 Letter L" → "Letter L · Ep 12"
    else if (ep && subjWords.size && !/^e\d+$/i.test(words.join(''))) topic = `Episode ${Number(ep[1])}`;
    else if (ep) topic = prettyName(base);                                     // "Junior Literacy E39": the name is all there is
  }
  topic = tidyTopic(topic.replace(/\s+/g, ' ').replace(/[:\s]+$/, '').trim()) || prettyName(base);
  let tag = grade ? `Grade ${grade}${subj ? ` · ${subj}` : ''}` : (subj || 'Lesson');
  const fileSubj = /^grade\s*\d+\s*-\s*(science|mathematics|english(?: language)?|social studies)\s*-/i.exec(base)?.[1];
  if (fileSubj && grade) {   // a Science lesson filed under Mathematics: the file name's subject wins
    tag = `Grade ${grade} · ${SUBJECT_SHORT[fileSubj.toLowerCase()] ?? fileSubj.replace(/\b\w/g, (m) => m.toUpperCase())}`;
    topic = topic.replace(/^(?:Science|Maths|Mathematics|English|Social Studies):\s*/, '');
  }
  // 'Local Academic New/Junior' spans grades 1-3 (MoE Central airs it for Grade 3): name the series, never a grade
  const series = /\/Local Academic New\/(Junior|Elementary|Teen)/.exec(String(c.file_path || ''))?.[1];
  if (series) tag = `${series === 'Teen' ? 'TeenEd' : series} · ${subj || 'Lesson'}`;
  if (tag === 'R.E.A.D') tag = 'R.E.A.D.';
  // 'Beatin_Da_Maths_S2Ep1': the show is the title, the episode the tag (operator 2026-11-17)
  if (/^Season \d+ · Ep \d+$/.test(topic) && !tag.startsWith('Grade')) return { title: fixTitle(tag), tag: topic };
  return { title: fixTitle(topic), tag };
}

// A clip filed straight under a production/hand-off folder gets that FOLDER as its subject
// ("TRANSMISSION FOLDER 2026", operator 2026-11-17: it aired in the stories as a programme name).
// Such a subject names where the file sits, not what it is: print the clip's own name instead.
export function isFolderSubject(s) {
  return /\b(?:folder|completed projects|transmission|new folder|untitled|final renders?|live shows)\b/i.test(String(s || ''));
}
/** A one-off clip's file name made printable: "TVET EMIS.jpg.mp4" → "TVET EMIS", "WHIZ KIDS AD FINAL 2" → "Whiz Kids Ad". */
export function cleanFileTitle(name) {
  let t = String(name || '').replace(/(\.(?:mp4|mov|mpg|mxf|avi|mkv|jpe?g|png))+$/i, '');
  t = t.replace(/\((?:deu|hd|final[^)]*)\)/gi, ' ').replace(/\b(?:final(?: render)?|hd|edited|v\d+)\b(?:\s*\d+)?/gi, ' ');
  t = prettyName(t).replace(/\s+/g, ' ').trim();
  if (t === t.toUpperCase() && t.length > 12) t = t.toLowerCase().replace(/\b\w/g, (m) => m.toUpperCase());
  return t;
}

/** One clip → { title, tag, kind } as the guide prints it. */
export function describeClip(c) {
  const type = c.show_type_code;
  const movie = type === 'movies' && Number(c.duration) >= MOVIE_MIN_SECONDS;
  if (movie) {
    const raw = c.display_name || c.name;
    const fixed = fixTitle(raw); // a known raw file name, or the pretty form of it
    const title = fixed !== raw ? fixed : fixTitle(c.display_name || prettyName(c.name));
    return { title, tag: 'MOVIE', kind: 'movie' };
  }
  if (type === 'lessons') return { ...lessonParts(c), kind: 'lesson' };
  const raw = isFolderSubject(c.subject) ? cleanFileTitle(c.display_name || c.name) : (c.subject || c.display_name || prettyName(c.name));
  const title = fixTitle(raw) !== raw ? fixTitle(raw) : fixTitle(tidyTopic(raw)); // same clean-up the social stories get
  const ep = statedEpisode(c.name, c.subject) ?? (Number(c.chapter) > 0 && Number(c.chapter) < 1000 ? Number(c.chapter) : null);
  const pad = (n) => String(n).padStart(2, '0');
  const tag = ep == null ? '' : c.season != null ? `S${pad(c.season)}E${pad(ep)}` : `EP ${ep}`;
  return { title, tag, kind: type === 'documentaries' ? 'doc' : 'show' };
}

/**
 * Fold consecutive airings into rows and cap them. `items` are
 * { at, title, tag, kind, duration, file_path } in air order.
 */
export function groupRows(items, max = MAX_ROWS) {
  const rows = [];
  for (const x of items) {
    const last = rows[rows.length - 1];
    if (last && x.kind !== 'movie' && last.kind === x.kind && last.title === x.title) {
      last.n++; last.lastTag = x.tag; continue;
    }
    rows.push({ ...x, n: 1, lastTag: x.tag, subjects: [x.title], all: [x.title] });
  }
  for (const r of rows) {
    if (r.kind === 'lesson') {
      // every lesson is its own row (topic + subject); only the same lesson twice in a row folds
    } else if (r.n > 1) {
      if (/^S\d+E\d+$/.test(r.tag) && /^S\d+E\d+$/.test(r.lastTag) && r.lastTag !== r.tag) {
        r.tag = r.tag.slice(0, 3) === r.lastTag.slice(0, 3) ? `${r.tag}–${r.lastTag.slice(3)}` : `${r.tag}–${r.lastTag}`;
      } else r.tag = `${r.n} EPS`;
    }
    delete r.subjects; delete r.all; delete r.lastTag;
  }
  if (rows.length > max) {
    const extra = rows.length - (max - 1);
    return [...rows.slice(0, max - 1), { at: rows[max - 1].at, title: `+ ${extra} more programmes`, tag: '', kind: 'more', n: 1 }];
  }
  return rows;
}

let itemsStmt = null;
const itemsOf = { all: (id) => (itemsStmt ??= db.prepare(`
  SELECT r.name, r.subject, r.season, r.chapter, r.duration, r.is_filler, r.file_path,
         st.code AS show_type_code, ov.display_name
  FROM ScheduleItem si
  JOIN Resource r ON r.id = si.resource_id
  LEFT JOIN ShowType st ON st.id = r.show_type_id
  LEFT JOIN ResourceOverride ov ON ov.resource_id = r.id
  WHERE si.block_id = ? ORDER BY si.play_order`)).all(id) };

/** Every clip of a channel-day with its absolute air time (seconds since day 0). */
function dayAir(channelId, date) {
  const rows = linkShifts(channelDayBlocks(channelId, date));
  const blocks = [];
  for (const r of rows) {
    const start = dayNumber(r.target_date) * DAY + hhmm(r.start_time) + (r.start_shift || 0);
    let t = start;
    const clips = [];
    for (const c of itemsOf.all(r.id)) {
      // Fillers that open a block are not what the viewer waits for: the block's first
      // programme is announced at the block's own start (9:00, not 9:04).
      if (!c.is_filler) clips.push({ ...c, at: guideTime(clips.length ? t : start) });
      t += Number(c.duration) || 0;
    }
    blocks.push({ ...r, absStart: start, absEnd: start + r.blockSeconds + (r.guide_seconds || 0), clips });
  }
  return blocks;
}

/**
 * Air time as the guide states it: to the minute, and on the quarter hour when
 * within 90 s of one. Auto-balanced boundaries move blocks by up to a minute,
 * so a programme due at 8:00 really starts 7:59:20 — a guide reads 8:00.
 */
export function guideTime(t) {
  const q = Math.round(t / 900) * 900;
  return Math.abs(t - q) <= 90 ? q : Math.round(t / 60) * 60;
}

function clock12(abs) {
  const s = ((abs % DAY) + DAY) % DAY;
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return `${(h % 12) || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

/**
 * The guide of one block, or null when the block is gone, its channel has no
 * guide look, or nothing at all airs in the next 24 hours. Returns
 * { blockId, channelId, style, date, bracket, rows, hero, next, airsAt }.
 */
export function guidePlan(blockId) {
  const b = db.prepare('SELECT id, channel_id, target_date FROM ScheduledBlock WHERE id = ?').get(blockId);
  if (!b || b.channel_id == null) return null;
  const style = channelStyle(b.channel_id);
  if (!style) return null;
  const days = [addDays(b.target_date, -1), b.target_date, addDays(b.target_date, 1), addDays(b.target_date, 2)];
  const blocks = days.flatMap((d) => dayAir(b.channel_id, d));
  const me = blocks.find((x) => x.id === blockId);
  if (!me) return null;
  const clips = blocks.flatMap((x) => x.clips).sort((p, q) => p.at - q.at);
  const from = guideTime(me.absEnd);            // what airs after the guide

  const windowOf = (abs) => {
    const day = Math.floor(abs / DAY);
    const br = bracketAt(abs - day * DAY);
    return { br, start: day * DAY + br.from * 3600, end: day * DAY + br.to * 3600, day };
  };
  let w = windowOf(from);
  let lo = from - 30;                           // a clip starting a few seconds early still counts
  let picked = [];
  for (let k = 0; k < 4; k++) {
    picked = clips.filter((c) => c.at >= lo && c.at < w.end);
    if (picked.length) break;
    w = windowOf(w.end); lo = w.start;          // nothing left: the next bracket
  }
  if (!picked.length) return null;
  const described = picked.map((c) => ({ ...describeClip(c), at: c.at, time: clock12(c.at), duration: Number(c.duration) || 0, file_path: c.file_path }));
  const rows = groupRows(described).map((r) => ({ ...r, time: clock12(r.at) }));
  const heroClip = described.find((x) => x.kind === 'movie')
    ?? described.find((x) => x.kind === 'show' || x.kind === 'doc') ?? described[0];
  const nw = windowOf(w.end);
  const next = groupRows(clips.filter((c) => c.at >= nw.start && c.at < nw.end)
    .map((c) => ({ ...describeClip(c), at: c.at, duration: Number(c.duration) || 0 })), 6)
    .slice(0, 5).map((r) => ({ title: r.title, time: clock12(r.at) }));
  return {
    blockId, channelId: b.channel_id, style,
    date: dateOf(w.day), bracket: w.br.key, bracketName: w.br.name,
    airsAt: me.absEnd - (me.guide_seconds || guideConfig().seconds),
    rows, hero: heroClip ? { ...heroClip, time: clock12(heroClip.at) } : null,
    next: { bracket: nw.br.key, bracketName: nw.br.name, date: dateOf(nw.day), rows: next },
  };
}

export { BRACKETS };
