// Mini Space Crafts -- a walk-up-and-play minigame at the same kiosk as
// the board games, but a different shape entirely: it's not a
// two-seat turn-based match against another player. Instead, each
// signed-in player has their own persistent "craft profile" (scrap
// collected + weapons unlocked + currently equipped weapon), stored in
// the craft_profiles table, and can play solo -- or side-by-side with
// a friend in the same room, each on their own profile at the same
// time -- by traveling to planets, fighting monsters for scrap, and
// spending scrap to unlock stronger weapons.
//
// Kept free of any DOM/Supabase code, same as the rest of games.js, so
// it's easy to unit-test and extend.

export const PLANETS = [
  {
    id: 'rustbelt',
    name: 'Rustbelt Moon',
    emoji: '🌑',
    scrapType: 'rusty_bolts',
    scrapLabel: 'Rusty Bolts',
    scrapEmoji: '🔩',
    blurb: 'A junkyard moon piled high with old machine parts.',
    monsters: [
      {
        id: 'scrap_crawler', name: 'Scrap Crawler', emoji: '🕷️',
        hp: 12, dmg: [1, 3], scrapReward: [2, 4],
        blurb: 'A skittering pile of loose bolts and wire.',
      },
      {
        id: 'junk_golem', name: 'Junk Golem', emoji: '🤖',
        hp: 20, dmg: [2, 5], scrapReward: [4, 7],
        blurb: 'A lumbering heap of scrap metal held together by rust and spite.',
      },
    ],
  },
  {
    id: 'crystal',
    name: 'Crystal Reach',
    emoji: '💎',
    scrapType: 'star_crystals',
    scrapLabel: 'Star Crystals',
    scrapEmoji: '💠',
    blurb: 'Towering glowing crystal spires hum with strange energy.',
    monsters: [
      {
        id: 'crystal_bat', name: 'Crystal Bat', emoji: '🦇',
        hp: 14, dmg: [1, 4], scrapReward: [2, 4],
        blurb: 'It flits between the spires, chiming like broken glass.',
      },
      {
        id: 'geode_guardian', name: 'Geode Guardian', emoji: '🪨',
        hp: 22, dmg: [2, 6], scrapReward: [4, 7],
        blurb: 'A cracked-open boulder with a crystal core -- and a bad attitude.',
      },
    ],
  },
  {
    id: 'jolly',
    name: 'Jolly Land',
    emoji: '🎪',
    scrapType: 'candy_shards',
    scrapLabel: 'Candy Shards',
    scrapEmoji: '🍬',
    blurb: "Everything here looks fun and delicious -- which is exactly the problem. The creatures would love nothing more than to turn you into candy and eat you.",
    monsters: [
      {
        id: 'gummy_grinner', name: 'Gummy Grinner', emoji: '😁',
        hp: 14, dmg: [1, 4], scrapReward: [2, 4],
        blurb: 'Its smile never stops. Neither does its appetite.',
      },
      {
        id: 'lolli_beast', name: 'Lolli-Beast', emoji: '🍭',
        hp: 20, dmg: [2, 5], scrapReward: [4, 7],
        blurb: "Looks like a giant lollipop. Definitely isn't.",
      },
    ],
  },
];

export const WEAPONS = {
  zap_stick: {
    id: 'zap_stick', name: 'Zap Stick', emoji: '⚡',
    dmg: [1, 3], missChance: 0,
    cost: 0, scrapType: null, planetId: null, // starter -- always owned, never bought
  },
  junk_hammer: {
    id: 'junk_hammer', name: 'Junk Hammer', emoji: '🔨',
    dmg: [3, 6], missChance: 0.15,
    cost: 5, scrapType: 'rusty_bolts', planetId: 'rustbelt',
  },
  ray_gun: {
    id: 'ray_gun', name: 'Ray Gun', emoji: '🔫',
    dmg: [2, 5], missChance: 0,
    cost: 8, scrapType: 'rusty_bolts', planetId: 'rustbelt',
    ranged: true, // fires a travelling projectile instead of an instant swing -- see PROJECTILE_* below
  },
  laser_dagger: {
    id: 'laser_dagger', name: 'Laser Dagger', emoji: '🗡️',
    dmg: [2, 4], missChance: 0,
    cost: 10, scrapType: 'rusty_bolts', planetId: 'rustbelt',
    speedMultiplier: 1.35, // light blade -- lets you move faster
  },
  laser_sword: {
    id: 'laser_sword', name: 'Laser Sword', emoji: '⚔️',
    dmg: [4, 7], missChance: 0.05,
    cost: 12, scrapType: 'rusty_bolts', planetId: 'rustbelt',
  },
  laser_tomahawk: {
    id: 'laser_tomahawk', name: 'Laser Tomahawk', emoji: '🪃',
    dmg: [2, 5], missChance: 0.05,
    cost: 14, scrapType: 'rusty_bolts', planetId: 'rustbelt',
    speedMultiplier: 1.3, // lighter than a sword or axe -- moves faster too
    grantsDash: true, // "double jump" reinterpreted as a rechargeable dash burst -- see DASH_* below
  },
  laser_axe: {
    id: 'laser_axe', name: 'Laser Axe', emoji: '🪓',
    dmg: [4, 8], missChance: 0.1,
    cost: 14, scrapType: 'rusty_bolts', planetId: 'rustbelt',
    speedMultiplier: 0.9,
    contactDamageReduction: 0.5, // "stops fall damage" reinterpreted as cutting incoming contact damage in half
  },
  laser_hammer: {
    id: 'laser_hammer', name: 'Laser Hammer', emoji: '⚒️',
    dmg: [9999, 9999], missChance: 0.2,
    cost: 20, scrapType: 'rusty_bolts', planetId: 'rustbelt',
    speedMultiplier: 0.55, // very heavy -- moves slowly
    instaKill: true,
    // The "big hammer" for smashing player-built barriers (see
    // BARRIER_TIERS below) -- a flat amount per swing rather than
    // instaKill, since a barrier isn't a living thing to one-shot.
    // 20 per hit means 2 hits flattens the cheapest (40 hp) barrier
    // tier and proportionally more for the tougher ones.
    structureDamage: 20,
  },
  light_laser_hammer: {
    id: 'light_laser_hammer', name: 'Light Laser Hammer', emoji: '🔨',
    dmg: [3, 6], missChance: 0.05,
    cost: 12, scrapType: 'rusty_bolts', planetId: 'rustbelt',
    speedMultiplier: 1.1, // lighter than the big hammer -- still fairly nimble
    // Wears out with use -- once maxDurability's worth of swings have
    // been thrown, it goes "rusty" (see rollWeaponDamage below) until
    // repaired at a Fixing Table (see repairWeapon / the Fixing Table
    // UI in room.js).
    maxDurability: 12,
  },
  build_laser: {
    id: 'build_laser', name: 'Build Laser', emoji: '🔧',
    dmg: [0, 0], missChance: 0,
    cost: 5, scrapType: 'rusty_bolts', planetId: 'rustbelt',
    // Not a combat weapon at all -- equipping it swaps the attack
    // button/key over to opening the Build menu instead (see
    // craftRoamAttack in room.js), for placing barriers from whatever
    // scrap you're carrying. Armor is crafted from the Ship screen's
    // Armory instead, since it isn't tied to any one planet's material.
    isBuildTool: true,
  },
  crystal_lance: {
    id: 'crystal_lance', name: 'Crystal Lance', emoji: '🔱',
    dmg: [2, 6], missChance: 0,
    cost: 5, scrapType: 'star_crystals', planetId: 'crystal',
  },
  blaster: {
    id: 'blaster', name: 'Blaster', emoji: '💥',
    dmg: [3, 7], missChance: 0.1,
    cost: 8, scrapType: 'star_crystals', planetId: 'crystal',
  },
  sticky_slingshot: {
    id: 'sticky_slingshot', name: 'Sticky Slingshot', emoji: '🎯',
    dmg: [2, 5], missChance: 0.05,
    cost: 5, scrapType: 'candy_shards', planetId: 'jolly',
  },
  candy_cannon: {
    id: 'candy_cannon', name: 'Candy Cannon', emoji: '🍭',
    dmg: [3, 7], missChance: 0.1,
    cost: 8, scrapType: 'candy_shards', planetId: 'jolly',
  },
};

export const STARTER_WEAPON = 'zap_stick';
export const STARTER_HP = 20;

// Crafted with the Build Laser (see WEAPONS.build_laser) from the Ship
// screen's Armory, not tied to any one planet -- there's one armor
// tier per material you can gather, each a bit tougher (and pricier)
// than the last. Only one can be worn at a time (see equipArmor).
export const ARMORS = {
  scrap_plating: {
    id: 'scrap_plating', name: 'Scrap Plating', emoji: '🔩',
    contactDamageReduction: 0.15,
    cost: 15, scrapType: 'rusty_bolts',
  },
  crystal_plating: {
    id: 'crystal_plating', name: 'Crystal Plating', emoji: '💠',
    contactDamageReduction: 0.25,
    cost: 15, scrapType: 'star_crystals',
  },
  candy_plating: {
    id: 'candy_plating', name: 'Candy Plating', emoji: '🍬',
    contactDamageReduction: 0.35, // a surprisingly hard candy shell
    cost: 15, scrapType: 'candy_shards',
  },
};

// Barrier tiers buildable with the Build Laser -- one per material,
// each tougher (and pricier) than the last, matching the "wood, scrap,
// candy" materials mentioned when this was requested. There's no
// literal "wood" resource in the game, so the cheapest/rusty-bolts
// tier stands in for it (also why it's what "2 hits for wood" -- see
// WEAPONS.laser_hammer's structureDamage -- refers to).
export const BARRIER_TIERS = {
  scrap_barrier: {
    id: 'scrap_barrier', name: 'Scrap Barrier', emoji: '🧱',
    hp: 40, cost: 10, scrapType: 'rusty_bolts',
  },
  crystal_barrier: {
    id: 'crystal_barrier', name: 'Crystal Barrier', emoji: '🔷',
    hp: 80, cost: 10, scrapType: 'star_crystals',
  },
  candy_barrier: {
    id: 'candy_barrier', name: 'Candy Barrier', emoji: '🍡',
    hp: 120, cost: 10, scrapType: 'candy_shards',
  },
};

export function getPlanet(planetId) {
  return PLANETS.find((p) => p.id === planetId) || null;
}

export function getWeapon(weaponId) {
  return WEAPONS[weaponId] || null;
}

export function weaponsForPlanet(planetId) {
  return Object.values(WEAPONS).filter((w) => w.planetId === planetId);
}

export function getArmor(armorId) {
  return ARMORS[armorId] || null;
}

export function allArmors() {
  return Object.values(ARMORS);
}

export function getBarrierTier(tierId) {
  return BARRIER_TIERS[tierId] || null;
}

export function allBarrierTiers() {
  return Object.values(BARRIER_TIERS);
}

// A brand-new player's profile: no scrap yet, only the free starter
// weapon, and it's equipped by default.
export function createStarterProfile() {
  return {
    scrap: { rusty_bolts: 0, star_crystals: 0, candy_shards: 0 },
    weapons: [STARTER_WEAPON],
    equipped: STARTER_WEAPON,
    armors: [],
    equippedArmor: null,
    // Per-weapon wear, keyed by weapon id -- only weapons with a
    // maxDurability field (currently just the Light Laser Hammer) ever
    // get an entry here. Absent = "as good as new" (see
    // getWeaponDurability), so ordinary weapons never need one at all.
    durability: {},
  };
}

// Defends against a profile loaded from the database missing fields
// (e.g. an older shape, or a partially-written row) by filling in
// anything absent from a fresh starter profile.
export function normalizeProfile(raw) {
  const base = createStarterProfile();
  if (!raw || typeof raw !== 'object') return base;
  const scrap = { ...base.scrap, ...(raw.scrap || {}) };
  const weapons = Array.isArray(raw.weapons) && raw.weapons.length ? raw.weapons.filter((w) => WEAPONS[w]) : base.weapons;
  const safeWeapons = weapons.includes(STARTER_WEAPON) ? weapons : [STARTER_WEAPON, ...weapons];
  const equipped = raw.equipped && safeWeapons.includes(raw.equipped) ? raw.equipped : safeWeapons[0];
  const armors = Array.isArray(raw.armors) ? raw.armors.filter((a) => ARMORS[a]) : base.armors;
  const equippedArmor = raw.equippedArmor && armors.includes(raw.equippedArmor) ? raw.equippedArmor : null;
  const durability = raw.durability && typeof raw.durability === 'object' && !Array.isArray(raw.durability)
    ? { ...raw.durability }
    : base.durability;
  return { scrap, weapons: safeWeapons, equipped, armors, equippedArmor, durability };
}

export function canUnlockArmor(profile, armorId) {
  const armor = ARMORS[armorId];
  if (!armor) return false;
  if (profile.armors.includes(armorId)) return false;
  return (profile.scrap[armor.scrapType] || 0) >= armor.cost;
}

// Immutable, same shape as unlockWeapon.
export function unlockArmor(profile, armorId) {
  if (!canUnlockArmor(profile, armorId)) return profile;
  const armor = ARMORS[armorId];
  return {
    ...profile,
    scrap: { ...profile.scrap, [armor.scrapType]: profile.scrap[armor.scrapType] - armor.cost },
    armors: [...profile.armors, armorId],
  };
}

// armorId may be null to take your armor off.
export function equipArmor(profile, armorId) {
  if (armorId !== null && !profile.armors.includes(armorId)) return profile;
  return { ...profile, equippedArmor: armorId };
}

// A weapon with no maxDurability (almost all of them) is always
// treated as fully intact -- only weapons that actually track wear
// (currently the Light Laser Hammer) can ever come back anything less
// than that.
export function getWeaponDurability(profile, weaponId) {
  const weapon = WEAPONS[weaponId];
  if (!weapon || !weapon.maxDurability) return Infinity;
  const stored = profile.durability?.[weaponId];
  return typeof stored === 'number' ? stored : weapon.maxDurability;
}

// Immutable: wears the weapon down by one use, floored at 0 (fully
// rusty) rather than going negative.
export function applyWeaponWear(profile, weaponId) {
  const weapon = WEAPONS[weaponId];
  if (!weapon || !weapon.maxDurability) return profile;
  const current = getWeaponDurability(profile, weaponId);
  const next = Math.max(0, current - 1);
  return { ...profile, durability: { ...profile.durability, [weaponId]: next } };
}

// What a trip to the Fixing Table does -- back to brand new.
export function repairWeapon(profile, weaponId) {
  const weapon = WEAPONS[weaponId];
  if (!weapon || !weapon.maxDurability) return profile;
  return { ...profile, durability: { ...profile.durability, [weaponId]: weapon.maxDurability } };
}

function rollDamage([min, max]) {
  return min + Math.floor(Math.random() * (max - min + 1));
}

// Exported alias -- the real-time Rustbelt Moon roaming world (below)
// needs the same "roll a number in this [min,max] range" primitive for
// weapon swings, monster contact damage, and loot amounts, but doesn't
// go through the turn-based resolveAttack() flow at all.
export const rollInRange = rollDamage;

// A weapon swing in the roaming world: same miss-chance/damage-range
// rules as resolveAttack() above, just returned directly rather than
// folded into a turn-based encounter object. A miss is represented as
// 0 damage.
// `durability` is the weapon's current wear (from getWeaponDurability),
// or omitted/Infinity for a weapon that doesn't track it at all. Once a
// durability-tracking weapon (the Light Laser Hammer) hits 0, it's
// "rusty": much more likely to miss, and half as strong on the hits
// that do land, until a Fixing Table repairs it.
export function rollWeaponDamage(weapon, durability = Infinity) {
  const rusty = weapon.maxDurability && durability <= 0;
  const missChance = (weapon.missChance || 0) + (rusty ? RUSTY_WEAPON_MISS_PENALTY : 0);
  if (Math.random() < missChance) return 0;
  if (weapon.instaKill) return INSTA_KILL_DAMAGE;
  const dmg = rollInRange(weapon.dmg);
  return rusty ? Math.max(1, Math.round(dmg * RUSTY_WEAPON_DAMAGE_MULTIPLIER)) : dmg;
}

export function rollMonsterContactDamage(monster) {
  return rollInRange(monster.dmg);
}

// Loot for a kill in the roaming world -- same reward range as a
// turn-based win, just without needing a full `encounter` object.
export function rollKillLoot(planet, monster) {
  return { scrapType: planet.scrapType, amount: rollInRange(monster.scrapReward) };
}

// Picks a monster from a planet, weighted toward the first (easier)
// one so new visitors aren't immediately thrown at the toughest fight.
export function pickRandomMonster(planet) {
  const monsters = planet.monsters;
  if (monsters.length === 1) return monsters[0];
  return Math.random() < 0.6 ? monsters[0] : monsters[1];
}

// Starts a fresh encounter. Player HP always resets to full for a new
// fight -- there's no permanent-death penalty in this first version,
// so losing just means "try again," not "lose your whole collection."
export function startEncounter(planet, monster) {
  const m = monster || pickRandomMonster(planet);
  return {
    planetId: planet.id,
    monsterId: m.id,
    monsterHp: m.hp,
    monsterMaxHp: m.hp,
    playerHp: STARTER_HP,
    playerMaxHp: STARTER_HP,
    log: [`A wild ${m.name} appears!`],
  };
}

// Resolves one click-to-attack exchange: the player swings with their
// equipped weapon (which can miss), and if the monster survives it
// swings back. Returns the updated encounter plus a result flag:
// 'ongoing' | 'won' | 'lost'. On a win, `loot` carries the scrap earned.
export function resolveAttack(encounter, planet, monster, weapon) {
  const log = [];
  let { monsterHp, playerHp } = encounter;

  const playerMissed = Math.random() < (weapon.missChance || 0);
  if (playerMissed) {
    log.push(`Your ${weapon.name} misses!`);
  } else {
    const dmg = rollDamage(weapon.dmg);
    monsterHp = Math.max(0, monsterHp - dmg);
    log.push(`You hit the ${monster.name} with your ${weapon.name} for ${dmg} damage.`);
  }

  if (monsterHp <= 0) {
    const scrapWon = rollDamage(monster.scrapReward);
    log.push(`You defeated the ${monster.name}! +${scrapWon} ${planet.scrapLabel}.`);
    return {
      encounter: { ...encounter, monsterHp: 0, playerHp, log: [...encounter.log, ...log] },
      result: 'won',
      loot: { scrapType: planet.scrapType, amount: scrapWon },
    };
  }

  const monsterDmg = rollDamage(monster.dmg);
  playerHp = Math.max(0, playerHp - monsterDmg);
  log.push(`The ${monster.name} hits you back for ${monsterDmg} damage.`);

  if (playerHp <= 0) {
    log.push(`You were knocked out! Better luck next time.`);
    return {
      encounter: { ...encounter, monsterHp, playerHp: 0, log: [...encounter.log, ...log] },
      result: 'lost',
    };
  }

  return {
    encounter: { ...encounter, monsterHp, playerHp, log: [...encounter.log, ...log] },
    result: 'ongoing',
  };
}

export function canUnlockWeapon(profile, weaponId) {
  const weapon = WEAPONS[weaponId];
  if (!weapon) return false;
  if (profile.weapons.includes(weaponId)) return false;
  return (profile.scrap[weapon.scrapType] || 0) >= weapon.cost;
}

// Immutable: returns a new profile with the weapon added and its cost
// deducted, rather than mutating the one passed in.
export function unlockWeapon(profile, weaponId) {
  if (!canUnlockWeapon(profile, weaponId)) return profile;
  const weapon = WEAPONS[weaponId];
  return {
    ...profile,
    scrap: { ...profile.scrap, [weapon.scrapType]: profile.scrap[weapon.scrapType] - weapon.cost },
    weapons: [...profile.weapons, weaponId],
  };
}

export function addScrap(profile, scrapType, amount) {
  return { ...profile, scrap: { ...profile.scrap, [scrapType]: (profile.scrap[scrapType] || 0) + amount } };
}

export function equipWeapon(profile, weaponId) {
  if (!profile.weapons.includes(weaponId)) return profile;
  return { ...profile, equipped: weaponId };
}

// =================================================================
// Rustbelt Moon roaming world (real-time, shared)
// -----------------------------------------------------------------
// The first planet converted from the old menu-based "encounter"
// flow into an actual walk-around Zelda-style world. Everything in
// this section is pure/DOM-free so it can be unit tested the same
// way as the rest of this file -- the canvas rendering and Supabase
// realtime wiring live in room.js, which calls into these functions.
//
// Design notes (so the "why" survives past this one PR):
// - The tile map and monster spawn points are fixed/hand-placed, not
//   randomly generated, so they're stable across reloads and testable.
// - Monster HP/alive state is the ONE thing that's actually synced
//   live between players (via a new craft_world_enemies table) --
//   that's what makes a kill "count" for everyone on the planet.
// - Monster WANDERING motion is deliberately NOT synced -- it's a
//   small cosmetic wobble computed the same way from a spawn id + the
//   current time on every client, so it looks alive without needing
//   a constant stream of position updates over the network.
// - Player positions ARE synced live (via Supabase Realtime presence,
//   the same mechanism the main SPAC3 room already uses for avatars),
//   since those really do need to match what each player is doing.
// =================================================================

export const RUSTBELT_TILE_SIZE = 40;
export const RUSTBELT_COLS = 32;
export const RUSTBELT_ROWS = 24;
export const RUSTBELT_WORLD_W = RUSTBELT_COLS * RUSTBELT_TILE_SIZE;
export const RUSTBELT_WORLD_H = RUSTBELT_ROWS * RUSTBELT_TILE_SIZE;

// Hand-placed junk-pile obstacle rectangles, in TILE coordinates --
// kept well clear of the border, the player's spawn point, and every
// monster spawn point below, so there's always a way through.
// Exported (not just used internally by createRustbeltMap below) so the
// first-person prototype (fps.js) can build the exact same layout in 3D
// without needing its own separate copy of these coordinates.
export const RUSTBELT_OBSTACLES = [
  { x: 4, y: 4, w: 3, h: 2 },
  { x: 13, y: 7, w: 2, h: 3 },
  { x: 21, y: 3, w: 4, h: 2 },
  { x: 26, y: 11, w: 2, h: 2 },
  { x: 7, y: 15, w: 3, h: 3 },
  { x: 16, y: 17, w: 4, h: 2 },
  { x: 23, y: 15, w: 3, h: 2 },
  { x: 3, y: 10, w: 2, h: 2 },
];

// Builds the tile grid fresh each time (cheap, and keeps this function
// pure) -- 1 = blocked (border wall or junk pile), 0 = open ground.
// Generic over which obstacle list is used, so Crystal Reach and Jolly
// Land's own layouts below can share this exact same border-wall/grid
// logic instead of duplicating it.
export function createPlanetMap(obstacles) {
  const grid = [];
  for (let r = 0; r < RUSTBELT_ROWS; r++) {
    const row = [];
    for (let c = 0; c < RUSTBELT_COLS; c++) {
      const isBorder = r === 0 || c === 0 || r === RUSTBELT_ROWS - 1 || c === RUSTBELT_COLS - 1;
      row.push(isBorder ? 1 : 0);
    }
    grid.push(row);
  }
  obstacles.forEach(({ x, y, w, h }) => {
    for (let r = y; r < y + h; r++) {
      for (let c = x; c < x + w; c++) {
        if (r > 0 && r < RUSTBELT_ROWS - 1 && c > 0 && c < RUSTBELT_COLS - 1) grid[r][c] = 1;
      }
    }
  });
  return grid;
}

export function createRustbeltMap() {
  return createPlanetMap(RUSTBELT_OBSTACLES);
}

export function isBlockedTile(grid, col, row) {
  if (row < 0 || row >= grid.length || col < 0 || col >= grid[0].length) return true;
  return grid[row][col] === 1;
}

// Axis-aligned collision check: is a square entity centered at world
// pixel (x, y) with the given half-size touching any blocked tile?
// Checks all four corners of its bounding box.
export function isBlockedAt(grid, x, y, halfSize, tileSize) {
  const corners = [
    [x - halfSize, y - halfSize],
    [x + halfSize, y - halfSize],
    [x - halfSize, y + halfSize],
    [x + halfSize, y + halfSize],
  ];
  return corners.some(([px, py]) => isBlockedTile(grid, Math.floor(px / tileSize), Math.floor(py / tileSize)));
}

export const RUSTBELT_PLAYER_SPAWN = { x: 640, y: 480 };

// Fixed monster spawn points. `id` matches the primary key of the seed
// rows in supabase/schema.sql -- these two lists must stay in sync.
// 15 total spawn points, matching MAX_ALIVE_ENEMIES below -- every point
// here checked clear of walls/obstacles and reasonably spaced out.
export const RUSTBELT_SPAWNS = [
  { id: 'rustbelt-1', monsterId: 'scrap_crawler', x: 380, y: 180 },
  { id: 'rustbelt-2', monsterId: 'scrap_crawler', x: 740, y: 380 },
  { id: 'rustbelt-3', monsterId: 'scrap_crawler', x: 1140, y: 260 },
  { id: 'rustbelt-4', monsterId: 'junk_golem', x: 500, y: 820 },
  { id: 'rustbelt-5', monsterId: 'junk_golem', x: 1100, y: 780 },
  { id: 'rustbelt-6', monsterId: 'junk_golem', x: 220, y: 820 },
  { id: 'rustbelt-7', monsterId: 'scrap_crawler', x: 301, y: 312 },
  { id: 'rustbelt-8', monsterId: 'scrap_crawler', x: 640, y: 240 },
  { id: 'rustbelt-9', monsterId: 'junk_golem', x: 960, y: 240 },
  { id: 'rustbelt-10', monsterId: 'scrap_crawler', x: 320, y: 480 },
  { id: 'rustbelt-11', monsterId: 'junk_golem', x: 960, y: 480 },
  { id: 'rustbelt-12', monsterId: 'scrap_crawler', x: 229, y: 668 },
  { id: 'rustbelt-13', monsterId: 'junk_golem', x: 611, y: 712 },
  { id: 'rustbelt-14', monsterId: 'scrap_crawler', x: 960, y: 720 },
  { id: 'rustbelt-15', monsterId: 'junk_golem', x: 80, y: 80 },
];

// Crystal Reach and Jolly Land's own fixed-layout arenas -- same
// 32x24-tile/40px grid and 8-obstacle/15-spawn shape as Rustbelt
// Moon's above, originally built for the first-person prototype
// (fps.js) but living here now so the 2D roam world can use the exact
// same layouts and the two versions never drift apart. `id` on each
// spawn matches the primary key of the seed rows in
// supabase/schema.sql, same convention as RUSTBELT_SPAWNS above.
export const CRYSTAL_OBSTACLES = [
  { x: 5, y: 5, w: 2, h: 2 },
  { x: 10, y: 9, w: 2, h: 2 },
  { x: 15, y: 4, w: 2, h: 3 },
  { x: 20, y: 8, w: 3, h: 2 },
  { x: 25, y: 13, w: 2, h: 2 },
  { x: 6, y: 16, w: 3, h: 2 },
  { x: 12, y: 19, w: 2, h: 2 },
  { x: 22, y: 18, w: 3, h: 3 },
];
export const CRYSTAL_PLAYER_SPAWN = { x: 640, y: 480 };
export const CRYSTAL_SPAWNS = [
  { id: 'crystal-1', monsterId: 'crystal_bat', x: 140, y: 140 },
  { id: 'crystal-2', monsterId: 'geode_guardian', x: 1140, y: 140 },
  { id: 'crystal-3', monsterId: 'geode_guardian', x: 140, y: 820 },
  { id: 'crystal-4', monsterId: 'crystal_bat', x: 1140, y: 820 },
  { id: 'crystal-5', monsterId: 'crystal_bat', x: 660, y: 140 },
  { id: 'crystal-6', monsterId: 'geode_guardian', x: 660, y: 820 },
  { id: 'crystal-7', monsterId: 'crystal_bat', x: 340, y: 500 },
  { id: 'crystal-8', monsterId: 'geode_guardian', x: 980, y: 500 },
  { id: 'crystal-9', monsterId: 'geode_guardian', x: 140, y: 500 },
  { id: 'crystal-10', monsterId: 'crystal_bat', x: 1140, y: 500 },
  { id: 'crystal-11', monsterId: 'crystal_bat', x: 500, y: 660 },
  { id: 'crystal-12', monsterId: 'geode_guardian', x: 820, y: 660 },
  { id: 'crystal-13', monsterId: 'geode_guardian', x: 500, y: 300 },
  { id: 'crystal-14', monsterId: 'crystal_bat', x: 820, y: 300 },
  { id: 'crystal-15', monsterId: 'crystal_bat', x: 1060, y: 700 },
];

export const JOLLY_OBSTACLES = [
  { x: 4, y: 6, w: 3, h: 2 },
  { x: 9, y: 3, w: 2, h: 3 },
  { x: 14, y: 8, w: 2, h: 2 },
  { x: 19, y: 4, w: 3, h: 2 },
  { x: 24, y: 9, w: 2, h: 3 },
  { x: 6, y: 14, w: 2, h: 2 },
  { x: 11, y: 18, w: 3, h: 2 },
  { x: 20, y: 16, w: 2, h: 3 },
];
export const JOLLY_PLAYER_SPAWN = { x: 640, y: 480 };
export const JOLLY_SPAWNS = [
  { id: 'jolly-1', monsterId: 'gummy_grinner', x: 140, y: 140 },
  { id: 'jolly-2', monsterId: 'lolli_beast', x: 1140, y: 140 },
  { id: 'jolly-3', monsterId: 'lolli_beast', x: 140, y: 820 },
  { id: 'jolly-4', monsterId: 'gummy_grinner', x: 1140, y: 820 },
  { id: 'jolly-5', monsterId: 'gummy_grinner', x: 660, y: 140 },
  { id: 'jolly-6', monsterId: 'lolli_beast', x: 660, y: 820 },
  { id: 'jolly-7', monsterId: 'gummy_grinner', x: 340, y: 500 },
  { id: 'jolly-8', monsterId: 'lolli_beast', x: 980, y: 500 },
  { id: 'jolly-9', monsterId: 'lolli_beast', x: 140, y: 500 },
  { id: 'jolly-10', monsterId: 'gummy_grinner', x: 1140, y: 500 },
  { id: 'jolly-11', monsterId: 'gummy_grinner', x: 500, y: 660 },
  { id: 'jolly-12', monsterId: 'lolli_beast', x: 900, y: 660 },
  { id: 'jolly-13', monsterId: 'lolli_beast', x: 500, y: 300 },
  { id: 'jolly-14', monsterId: 'gummy_grinner', x: 820, y: 300 },
  { id: 'jolly-15', monsterId: 'lolli_beast', x: 1060, y: 700 },
];

// Single place tying each planet id to its map layout -- the 2D roam
// world below (createPlanetMap(map.obstacles) for collision,
// map.playerSpawn for where you appear/respawn) and the first-person
// prototype (fps.js, which also uses map.spawns for its own local
// monster simulation) both read from this one object, so all three
// planets' layouts live in exactly one place and can't drift apart.
export const PLANET_MAPS = {
  rustbelt: { obstacles: RUSTBELT_OBSTACLES, playerSpawn: RUSTBELT_PLAYER_SPAWN, spawns: RUSTBELT_SPAWNS },
  crystal: { obstacles: CRYSTAL_OBSTACLES, playerSpawn: CRYSTAL_PLAYER_SPAWN, spawns: CRYSTAL_SPAWNS },
  jolly: { obstacles: JOLLY_OBSTACLES, playerSpawn: JOLLY_PLAYER_SPAWN, spawns: JOLLY_SPAWNS },
};

export function getPlanetMap(planetId) {
  return PLANET_MAPS[planetId] || PLANET_MAPS.rustbelt;
}

// The world never has fewer than this many monsters up at once --
// craft_respawn_enemies() in schema.sql tops the planet back up to this
// floor immediately (skipping the normal respawn timer) whenever kills
// have dropped it below that, instead of making everyone wait out the
// full per-monster cooldown. The ceiling is just the total number of
// spawn points that exist on any one planet -- 15, for all three (see
// RUSTBELT_SPAWNS/CRYSTAL_SPAWNS/JOLLY_SPAWNS above).
export const MAX_ALIVE_ENEMIES = RUSTBELT_SPAWNS.length; // 15

export const PLAYER_HALF_SIZE = 14;
export const MONSTER_HALF_SIZE = 16;
export const PLAYER_SPEED = 3.2; // world pixels per animation frame
export const ATTACK_REACH = 34;
export const ATTACK_WIDTH = 30;
// No cooldown at all -- every press of the attack button/key swings
// immediately, exactly as fast as the player presses it.
export const ATTACK_COOLDOWN_MS = 0;
export const PLAYER_HIT_COOLDOWN_MS = 800; // brief invulnerability after taking contact damage
export const CONTACT_DAMAGE_RANGE = PLAYER_HALF_SIZE + MONSTER_HALF_SIZE;
export const MONSTER_RESPAWN_SECONDS = 20;

// The Laser Tomahawk's dash (see weapon.grantsDash below) -- a short
// instant burst of movement in whatever direction the player's
// currently aiming, run through the same wall-collision check as
// ordinary movement so it can't punch through obstacles. Two charges,
// each recharging on its own a few seconds after being spent, is what
// gives it that "double jump" feel of two quick bursts before having
// to wait -- there's no actual jumping or falling in this top-down
// world for a literal double jump to attach to, so this is the closest
// equivalent: a burst of extra mobility you can use twice in a row.
export const DASH_DISTANCE = 130; // world px covered by one dash
export const DASH_MAX_CHARGES = 2;
export const DASH_RECHARGE_MS = 4000; // time for one spent charge to refill

// The Laser Hammer's insta-kill damage value -- comfortably above any
// monster's max HP so it always finishes the job in one hit (misses
// still apply, via weapon.missChance, so it isn't unconditional).
export const INSTA_KILL_DAMAGE = 9999;

// How much worse a durability-tracking weapon (the Light Laser Hammer)
// gets once it's fully rusty -- noticeably worse, but not useless,
// which is what makes the trip to a Fixing Table feel worthwhile
// without making a rusty weapon completely dead weight mid-fight.
export const RUSTY_WEAPON_MISS_PENALTY = 0.35;
export const RUSTY_WEAPON_DAMAGE_MULTIPLIER = 0.5;

// Ray Gun (and any future weapon.ranged === true weapon) fires one of
// these instead of doing an instant hitbox swing -- see spawnCraftProjectile
// / advanceCraftProjectile in room.js for how it travels each frame.
export const PROJECTILE_SPEED = 11; // world pixels per animation frame
export const PROJECTILE_MAX_DISTANCE = 340; // despawns if it travels this far without hitting anything
export const PROJECTILE_RADIUS = 5; // visual size of the bolt itself
export const PROJECTILE_HIT_RANGE = PROJECTILE_RADIUS + MONSTER_HALF_SIZE;

// Converts a continuous aim angle in radians (0 = pointing right, and
// increasing clockwise on screen since +y is down -- i.e. plain
// Math.atan2(dy, dx) convention) into a unit vector. This is what lets a
// ranged shot or a melee swing aim at the *exact* angle the player is
// currently moving -- including diagonals and every angle in between --
// instead of snapping to one of 4 cardinal directions.
export function angleToVector(angle) {
  return { dx: Math.cos(angle), dy: Math.sin(angle) };
}

// The nearest 4-way cardinal direction to a continuous aim angle --
// still useful for things that only make sense as one of 4 states, like
// mirroring the player's sprite left/right.
export function angleToFacing(angle) {
  const deg = (angle * 180) / Math.PI;
  if (deg >= -45 && deg < 45) return 'right';
  if (deg >= 45 && deg < 135) return 'down';
  if (deg >= -135 && deg < -45) return 'up';
  return 'left';
}

export function distance(x1, y1, x2, y2) {
  return Math.hypot(x2 - x1, y2 - y1);
}

// True once a travelling projectile's center comes within hitting
// distance of an enemy's current (wandering) position.
export function projectileHitsPoint(proj, targetX, targetY) {
  return distance(proj.x, proj.y, targetX, targetY) <= PROJECTILE_HIT_RANGE;
}

// The area a melee swing covers, in world pixels, aimed along a
// continuous angle (radians, same convention as angleToVector) rather
// than one of 4 cardinal directions -- described as a "reach" forward
// from (x, y) along that angle, and a "width" on either side of it, so
// it can be hit-tested/drawn as a rotated rectangle at any angle.
export function attackHitbox(x, y, angle) {
  return { x, y, angle, reach: ATTACK_REACH + MONSTER_HALF_SIZE, width: ATTACK_WIDTH };
}

// True if (px, py) falls inside an attackHitbox's rotated rectangle.
// Works by rotating the point into the hitbox's own local axes (forward
// = along its aim angle, side = perpendicular to it), which reduces to
// exactly the old 4-way axis-aligned rect check for angle = 0/90/180/270
// but also works correctly for every angle in between.
export function pointInAttackHitbox(px, py, hitbox) {
  const dx = px - hitbox.x;
  const dy = py - hitbox.y;
  const cosA = Math.cos(hitbox.angle);
  const sinA = Math.sin(hitbox.angle);
  const forward = dx * cosA + dy * sinA;
  const side = -dx * sinA + dy * cosA;
  return forward >= 0 && forward <= hitbox.reach && Math.abs(side) <= hitbox.width;
}

// Purely cosmetic idle wobble for a monster around its spawn point --
// the same spawnId + timestamp always produces the same offset, so
// every client draws it in the same place without any network sync.
export function monsterWanderOffset(spawnId, now) {
  let seed = 0;
  for (let i = 0; i < spawnId.length; i++) seed = (seed * 31 + spawnId.charCodeAt(i)) >>> 0;
  const phase = (seed % 1000) / 1000 * Math.PI * 2;
  const t = now / 1400;
  return { dx: Math.sin(t + phase) * 22, dy: Math.cos(t * 0.8 + phase) * 22 };
}

// Given a proposed next position, slides the player along whichever
// axis is still free rather than stopping dead the instant either
// axis hits a wall -- this is what makes walking diagonally into a
// wall's edge feel smooth instead of snagging.
export function resolveMove(grid, x, y, dx, dy, halfSize, tileSize) {
  let nx = x, ny = y;
  if (dx !== 0 && !isBlockedAt(grid, x + dx, y, halfSize, tileSize)) nx = x + dx;
  if (dy !== 0 && !isBlockedAt(grid, nx, y + dy, halfSize, tileSize)) ny = y + dy;
  return { x: nx, y: ny };
}
