/**
 * What the pictures mean, when the page itself says.
 *
 * A grid CAPTCHA is a question about meaning -- is this a bus, is this a
 * traffic light -- and arithmetic on colours only ever answers the ones that
 * are really colour questions. The exact, free way to answer the rest is to
 * read what the page says about each square: an <img> has a src, an alt and
 * often a data- name; a CSS tile has a background-image; and the file name at
 * the end of that URL is the picture's own name (".../vegetables/carrot.webp"
 * is a carrot). Matching those names against the words of the question is
 * reading, not guessing, and it needs no model, no key and no network.
 *
 * It is only possible while the page is honest about its pictures. A sprite
 * sheet cropped by CSS -- what reCAPTCHA draws -- names nothing, and there the
 * picture has to be looked at by something that can see: the vision backend,
 * which is asked only when this has nothing to say. A page that names every
 * square "tile.webp" is treated the same as one that names nothing at all.
 */

/** The things a CAPTCHA asks for, and the names that belong to each. */
const CATEGORIES: Record<string, string[]> = {
  vegetable: [
    "artichoke", "asparagus", "bean", "beet", "beetroot", "broccoli", "cabbage", "carrot",
    "cauliflower", "celery", "corn", "courgette", "cucumber", "eggplant", "garlic", "kale",
    "leek", "lettuce", "mushroom", "okra", "onion", "parsnip", "pea", "pepper", "potato",
    "pumpkin", "radish", "rhubarb", "shallot", "spinach", "sprout", "squash", "turnip", "yam",
    "zucchini",
  ],
  fruit: [
    "apple", "apricot", "avocado", "banana", "blackberry", "blueberry", "cherry", "coconut",
    "cranberry", "date", "fig", "grape", "grapefruit", "kiwi", "lemon", "lime", "lychee",
    "mango", "melon", "nectarine", "orange", "papaya", "peach", "pear", "pineapple", "plum",
    "pomegranate", "raspberry", "strawberry", "tangerine", "tomato", "watermelon",
  ],
  animal: [
    "animal", "bear", "bird", "cat", "chicken", "cow", "dog", "duck", "elephant", "fish",
    "fox", "frog", "goat", "horse", "insect", "lion", "monkey", "mouse", "owl", "panda",
    "pig", "rabbit", "sheep", "snake", "spider", "squirrel", "tiger", "turtle", "wolf", "zebra",
  ],
  dog: ["dog", "puppy", "hound"],
  cat: ["cat", "kitten"],
  bird: ["bird", "crow", "duck", "eagle", "owl", "parrot", "penguin", "pigeon", "seagull", "sparrow"],
  car: ["car", "auto", "automobile", "cab", "convertible", "coupe", "hatchback", "limousine", "sedan", "suv", "truck", "van", "wagon"],
  bus: ["bus", "coach", "minibus", "schoolbus", "trolley"],
  bicycle: ["bicycle", "bike", "cycle", "cyclist", "tricycle"],
  motorcycle: ["motorcycle", "motorbike", "moped", "scooter"],
  tractor: ["tractor", "bulldozer", "excavator", "forklift"],
  boat: ["boat", "canoe", "ferry", "kayak", "raft", "sailboat", "ship", "submarine", "yacht"],
  plane: ["plane", "aeroplane", "airplane", "aircraft", "helicopter", "jet", "glider"],
  train: ["train", "locomotive", "railway", "subway", "tram", "trolley", "wagon"],
  traffic: ["traffic", "light", "stoplight", "trafficlight", "signal"],
  crosswalk: ["crosswalk", "crossing", "crossings", "pedestrian", "zebra"],
  hydrant: ["hydrant", "fireplug"],
  stairs: ["stair", "stairs", "staircase", "step", "steps"],
  chimney: ["chimney", "chimneys", "smokestack"],
  mountain: ["mountain", "mountains", "cliff", "hill", "peak", "volcano"],
  tree: ["tree", "trees", "forest", "bush", "leaf", "leaves", "palm", "willow"],
  flower: ["flower", "flowers", "bloom", "daisy", "lily", "rose", "sunflower", "tulip"],
  bridge: ["bridge", "viaduct"],
  building: ["building", "buildings", "house", "tower", "skyscraper", "church", "castle", "barn"],
  road: ["road", "roads", "street", "streets", "highway", "lane", "path", "pavement", "sidewalk"],
  door: ["door", "doors", "doorway", "gate"],
  window: ["window", "windows"],
  food: ["food", "bread", "burger", "cake", "cheese", "cookie", "dish", "donut", "egg", "fries", "meal", "noodle", "pasta", "pizza", "rice", "salad", "sandwich", "soup", "sushi", "toast"],
  drink: ["drink", "beer", "bottle", "coffee", "cup", "glass", "juice", "milk", "mug", "tea", "water", "wine"],
  furniture: ["chair", "furniture", "sofa", "table", "armchair", "bench", "couch", "stool"],
  instrument: ["instrument", "drum", "flute", "guitar", "piano", "trumpet", "violin"],
  bag: ["bag", "backpack", "briefcase", "handbag", "luggage", "purse", "suitcase"],
  clock: ["clock", "clocks", "watch", "timer"],
  sign: ["sign", "signs", "signpost", "billboard", "poster"],
  pole: ["pole", "poles", "post", "lamp", "lampost", "lamppost", "utility", "wire"],
};

/** Words in a question that are about the question, not about the picture. */
const NOISE = new Set([
  "select", "click", "choose", "pick", "tap", "find", "then", "submit", "verify", "please",
  "all", "any", "each", "every", "one", "two", "three", "four", "five", "square", "squares",
  "image", "images", "tile", "tiles", "picture", "pictures", "cell", "cells", "box", "boxes",
  "with", "the", "a", "an", "and", "or", "of", "in", "on", "at", "to", "that", "which",
  "containing", "contains", "contain", "showing", "shows", "are", "is", "have", "has", "not",
  "no", "you", "your", "below", "above", "left", "right", "from", "this", "these", "it",
  "them", "there", "where", "photo", "photos", "part", "parts", "some", "most", "few",
]);

/** Bits of a CSS background that are about the drawing, not the picture. */
const CSS = new Set([
  "cover", "contain", "center", "centre", "top", "bottom", "left", "right", "auto", "repeat",
  "scroll", "fixed", "local", "none", "url", "data", "image", "base64", "px", "em", "rem",
]);

/** Every word in a question, lowercased. */
function words(prompt: string): string[] {
  return String(prompt || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * The names hidden in whatever the page said about one square.
 *
 * The page may have said a whole URL ("/not-a-robot/vegetables/carrot.webp"),
 * a CSS background ("url("carrot.webp") center/cover"), an alt text, or a
 * data attribute. What is kept is the words at the end of whatever file-ish
 * thing it said, split on punctuation: "carrot", "traffic", "light".
 */
export function pictureNames(raw: string): string[] {
  const text = String(raw || "").toLowerCase();
  const names: string[] = [];
  for (const part of text.replace(/url\(|\)|["']/g, " ").split(/[\s,;]+/)) {
    if (!part || part.length > 200) continue;
    const tail = part.split("/").pop() ?? "";
    const stem = tail.split("?")[0].split("#")[0].replace(/\.(webp|png|jpe?g|gif|svg|avif|bmp)$/, "");
    for (const bit of stem.split(/[^a-z0-9]+/)) {
      // One and two letter stems are "1x", "a", "x2": noise, not names.
      if (bit.length >= 3 && !/^\d+$/.test(bit) && !CSS.has(bit)) names.push(bit);
    }
  }
  return [...new Set(names)];
}

/** Which squares the question is asking about, and the names that decided it. */
export interface NamedTiles {
  indexes: number[];
  names: string[];
}

/**
 * The squares the question names, read off the squares themselves.
 *
 * null means this said nothing usable -- a page that named no square, a
 * question with no object in it, a set that came out as every square or none
 * of them -- and the caller's next backend gets the picture instead. Saying
 * nothing is the whole point: a set of clicks that is only a guess lands on a
 * real page.
 */
export function identifyTiles(
  prompt: string,
  tiles: { index: number; label?: string }[],
): NamedTiles | null {
  const read = tiles.map((tile) => ({ index: tile.index, names: pictureNames(tile.label ?? "") }));
  if (!read.some((tile) => tile.names.length)) return null;

  const wanted = new Set<string>();
  for (const word of words(prompt)) {
    if (NOISE.has(word) || word.length < 3) continue;
    const category = CATEGORIES[word] ?? CATEGORIES[word.replace(/s$/, "")];
    if (category) for (const member of category) wanted.add(member);
    else wanted.add(word);
  }
  if (!wanted.size) return null;

  const hit = (names: string[], want: string) =>
    names.includes(want) ||
    names.includes(`${want}s`) ||
    (want.endsWith("s") && names.includes(want.slice(0, -1)));
  const picked = read.filter((tile) => tile.names.some((name) => [...wanted].some((want) => hit([name], want))));
  if (!picked.length || picked.length === read.length) return null;

  const deciding = new Set<string>();
  for (const tile of picked) for (const name of tile.names) if ([...wanted].some((want) => hit([name], want))) deciding.add(name);
  return { indexes: picked.map((tile) => tile.index), names: [...deciding] };
}
