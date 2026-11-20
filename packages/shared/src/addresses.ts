/**
 * Street addresses for the Measure page's search: the State of Oklahoma's 911 address points (kept locally for
 * the counties a company works in) are matched by a "key": house number, street name, street type and any
 * direction after the name, all in USPS abbreviations, without a direction before the name.
 *   "1601 Deskin Drive"      → "1601 DESKIN DR"
 *   "201 W. Gray St"         → "201 GRAY ST"
 *   "12488 160th Street"     → "12488 160TH ST"
 */

/** The 77 counties of Oklahoma, as the 911 data names them (without "COUNTY"). */
export const OK_COUNTIES = [
  "ADAIR", "ALFALFA", "ATOKA", "BEAVER", "BECKHAM", "BLAINE", "BRYAN", "CADDO", "CANADIAN", "CARTER", "CHEROKEE", "CHOCTAW", "CIMARRON",
  "CLEVELAND", "COAL", "COMANCHE", "COTTON", "CRAIG", "CREEK", "CUSTER", "DELAWARE", "DEWEY", "ELLIS", "GARFIELD", "GARVIN", "GRADY",
  "GRANT", "GREER", "HARMON", "HARPER", "HASKELL", "HUGHES", "JACKSON", "JEFFERSON", "JOHNSTON", "KAY", "KINGFISHER", "KIOWA", "LATIMER",
  "LE FLORE", "LINCOLN", "LOGAN", "LOVE", "MAJOR", "MARSHALL", "MAYES", "MCCLAIN", "MCCURTAIN", "MCINTOSH", "MURRAY", "MUSKOGEE", "NOBLE",
  "NOWATA", "OKFUSKEE", "OKLAHOMA", "OKMULGEE", "OSAGE", "OTTAWA", "PAWNEE", "PAYNE", "PITTSBURG", "PONTOTOC", "POTTAWATOMIE",
  "PUSHMATAHA", "ROGER MILLS", "ROGERS", "SEMINOLE", "SEQUOYAH", "STEPHENS", "TEXAS", "TILLMAN", "TULSA", "WAGONER", "WASHINGTON",
  "WASHITA", "WOODS", "WOODWARD",
] as const;
export const DEFAULT_ADDRESS_COUNTIES = ["CLEVELAND", "OKLAHOMA", "MCCLAIN"];

export const countyLabel = (c: string) => `${c.split(" ").map((w) => (w.startsWith("MC") ? `Mc${w.slice(2, 3)}${w.slice(3).toLowerCase()}` : w[0] + w.slice(1).toLowerCase())).join(" ")} County`;

const STREET_TYPES: Record<string, string> = {
  ALLEY: "ALY", AVENUE: "AVE", AV: "AVE", BOULEVARD: "BLVD", BEND: "BND", CIRCLE: "CIR", CIRCL: "CIR", COURT: "CT", COVE: "CV",
  CROSSING: "XING", DRIVE: "DR", DRV: "DR", EXPRESSWAY: "EXPY", FREEWAY: "FWY", HIGHWAY: "HWY", HOLLOW: "HOLW", LANE: "LN", LOOP: "LOOP",
  PARKWAY: "PKWY", PASS: "PASS", PATH: "PATH", PIKE: "PIKE", PLACE: "PL", PLAZA: "PLZ", POINT: "PT", RIDGE: "RDG", ROAD: "RD", ROW: "ROW",
  RUN: "RUN", SQUARE: "SQ", STREET: "ST", STR: "ST", TERRACE: "TER", TRACE: "TRCE", TRAIL: "TRL", TURNPIKE: "TPKE", VIEW: "VW", VISTA: "VIS",
  WAY: "WAY", CREEK: "CRK", CROSSROAD: "XRD", ESTATES: "ESTS", GLEN: "GLN", GROVE: "GRV", HEIGHTS: "HTS", HILL: "HL", HILLS: "HLS",
  KNOLL: "KNL", LANDING: "LNDG", MEADOW: "MDW", MEADOWS: "MDWS", PARK: "PARK", PRAIRIE: "PR", SPRINGS: "SPGS", VALLEY: "VLY", WALK: "WALK",
};
const DIRECTIONS: Record<string, string> = {
  NORTH: "N", SOUTH: "S", EAST: "E", WEST: "W", NORTHEAST: "NE", NORTHWEST: "NW", SOUTHEAST: "SE", SOUTHWEST: "SW",
  N: "N", S: "S", E: "E", W: "W", NE: "NE", NW: "NW", SE: "SE", SW: "SW",
};

/** US states other than Oklahoma, as written in addresses: a typed one means the 911 list doesn't apply. */
const OTHER_STATES = new Set([
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "DC", "FL", "GA", "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD", "MA", "MI", "MN",
  "MS", "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND", "OH", "OR", "PA", "RI", "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV",
  "WI", "WY", "TEXAS", "KANSAS", "ARKANSAS", "MISSOURI", "COLORADO", "CALIFORNIA", "FLORIDA",
]);

const words = (s: string) => s.toUpperCase().replace(/[.,#]/g, " ").replace(/[^A-Z0-9 &'/-]/g, " ").split(/\s+/).filter(Boolean);
const abbr = (w: string) => STREET_TYPES[w] ?? DIRECTIONS[w] ?? w;

/** The key for a 911 record's parts. */
export function addressKey(p: { number: number | string; street: string; streetType?: string | null; sufDir?: string | null }) {
  return [String(p.number), ...words(p.street), ...words(p.streetType ?? "").map(abbr), ...words(p.sufDir ?? "").map(abbr)].join(" ");
}

/**
 * What someone typed, as keys to try (longest first): with the city, state or ZIP dropped from the end one word
 * at a time, since the key holds only the street address. Null if it doesn't start with a house number.
 */
export function typedAddressKeys(typed: string): { number: number; keys: string[]; extra: string[]; words: string[]; otherState: boolean } | null {
  const head = typed.split(",")[0];
  const w = words(head);
  if (!w.length || !/^\d+[A-Z]?$/.test(w[0])) return null;
  const number = parseInt(w[0], 10);
  let rest = w.slice(1);
  if (rest.length > 1 && DIRECTIONS[rest[0]]) rest = rest.slice(1); // "201 W GRAY" → "201 GRAY"
  rest = rest.map(abbr);
  // Drop a state and ZIP at the end ("NORMAN OK 73069").
  const extra = words(typed.slice(head.length));
  while (rest.length > 1 && (/^\d{5}(-\d{4})?$/.test(rest[rest.length - 1]) || ["OK", "OKLAHOMA"].includes(rest[rest.length - 1]))) extra.unshift(rest.pop()!);
  const keys: string[] = [];
  for (let n = rest.length; n >= 1 && keys.length < 4; n--) keys.push([String(number), ...rest.slice(0, n)].join(" "));
  if (!rest.length) keys.push(String(number));
  const all = [...rest, ...extra];
  return { number, keys, extra: [...rest.slice(1), ...extra], words: all, otherState: all.some((w) => OTHER_STATES.has(w)) };
}

/**
 * A street name typed without a house number ("Deskin", "w gray st", "Deskin Dr Norman"), as the words to look
 * for in address keys (USPS abbreviations, no direction in front, no state or ZIP). Null if it starts with a number.
 */
export function typedStreetWords(typed: string): string[] | null {
  const w = words(typed.split(",")[0]);
  if (!w.length || /^\d/.test(w[0])) return null;
  let rest = w;
  if (rest.length > 1 && DIRECTIONS[rest[0]]) rest = rest.slice(1);
  rest = rest.map(abbr).filter((x) => !["OK", "OKLAHOMA"].includes(x) && !/^\d{5}$/.test(x));
  return rest.length && rest.join("").length >= 3 ? rest : null;
}

/** "1601 DESKIN DR" → "1601 Deskin Dr"; keeps directions upper case and "160th" lower. */
export function titleCaseAddress(s: string) {
  return s
    .toLowerCase()
    .split(/\s+/)
    .map((w) => (/^(n|s|e|w|ne|nw|se|sw)$/.test(w) ? w.toUpperCase() : /^\d/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ")
    .replace(/\bMc(\w)/g, (_, c: string) => `Mc${c.toUpperCase()}`);
}
