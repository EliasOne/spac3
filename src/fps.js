// SPAC3 -- first-person prototype (Rustbelt Moon / Crystal Reach / Jolly Land)
// ================================================================
// A standalone tech test for turning the existing top-down Mini Space
// Crafts world into a real first-person 3D game (the long-term "make
// it like Roblox" direction). Deliberately kept separate from room.js/
// craft.js's game logic for now -- this page proves out the rendering
// approach (Three.js, loaded as flat local files so it still fits the
// site's plain-static-file/no-build-step deploy) and movement feel
// before any of it touches the real, working multiplayer game.
//
// Which planet loads is picked via ?planet=<id> on the URL (see
// PLANET_ID below) -- all three planets reuse the exact same map
// layout as the 2D game's roam mode (via craft.js's PLANET_MAPS/
// getPlanetMap, straight from craft.js, so the two versions never
// drift apart). Every planet gets: walk-around first-person
// movement with wall collision, mouse-look, a weapon model matching
// your real equipped weapon, and real-time combat against that
// planet's own two monsters (via craft.js's PLANETS data) -- see
// "Monsters / combat" below. Only the map layout and the ground/wall
// look (moon rock / crystal facets / candy) actually differ per
// planet; everything else is shared engine code.
//
// Combat here is deliberately self-contained rather than synced with
// the 2D game's shared multiplayer monsters (craft_world_enemies in
// Supabase): this page spawns and simulates its own local monster
// population at the same fixed spawn points the 2D game uses. That
// means killing a monster here doesn't affect what someone playing
// the 2D game right now sees, and vice versa -- unifying the two into
// one shared world is a bigger multiplayer-sync project for later.
// Scrap earned here DOES save for real to your craft_profiles row,
// same as a 2D kill.
//
// What this still deliberately does NOT have yet: other players
// visible in this view, armor/build-laser barriers interacting with
// combat, or true travelling projectiles for ranged weapons (they hit
// instantly along your aim instead -- see FPS_RANGED_REACH below).
// ================================================================

import * as THREE from 'three';
import { PointerLockControls } from './PointerLockControls.js';
import {
  RUSTBELT_COLS, RUSTBELT_ROWS, RUSTBELT_TILE_SIZE,
  getPlanetMap,
  PLAYER_HIT_COOLDOWN_MS, MONSTER_RESPAWN_SECONDS, STARTER_HP,
  ATTACK_REACH, ATTACK_WIDTH, MONSTER_HALF_SIZE, CONTACT_DAMAGE_RANGE,
  getWeapon, STARTER_WEAPON, getPlanet, getArmor, createStarterProfile, normalizeProfile,
  rollWeaponDamage, rollMonsterContactDamage, rollKillLoot, applyWeaponWear, getWeaponDurability,
  addScrap, pointInAttackHitbox,
  weaponsForPlanet, canUnlockWeapon, unlockWeapon, equipWeapon,
} from './craft.js';
import { supabase } from './supabaseClient.js';
import { getSession } from './auth.js';
import { escapeHtml } from './utils.js';

// ---------------------------------------------------------------
// Planet selection -- which planet this first-person view loads is
// picked via ?planet=<id> on the URL (see the "Try first-person view"
// links in room.js), defaulting to Rustbelt Moon so an old link/bookmark
// with no query string at all still works exactly as before. Crystal
// Reach and Jolly Land reuse every bit of shared engine code below
// (movement, combat, shadows, the deep sky) -- the only things that
// actually vary per planet are the map layout (CRYSTAL_*/JOLLY_*
// below) and the ground/wall look (see buildThemeMaterials near the
// Ground/Walls section).
// ---------------------------------------------------------------
const VALID_PLANET_IDS = ['rustbelt', 'crystal', 'jolly'];
const requestedPlanetId = new URLSearchParams(window.location.search).get('planet');
const PLANET_ID = VALID_PLANET_IDS.includes(requestedPlanetId) ? requestedPlanetId : 'rustbelt';

// All three planets' map layouts (obstacles, player spawn, monster
// spawns) now live in one place, craft.js's PLANET_MAPS, shared with
// the 2D game's roam world -- see getPlanetMap there for details. That
// keeps this first-person view and the 2D top-down game showing
// exactly the same Crystal Reach/Jolly Land arenas, the same way they
// already shared Rustbelt Moon's layout.
const MAP = getPlanetMap(PLANET_ID);

// The page's title/badge/heading are written for Rustbelt Moon in the
// static HTML (so a plain, no-JS view of the file still shows
// something sensible) -- patch them to the actual selected planet's
// name/emoji as soon as we know it, before anything else runs.
{
  const planetMeta = getPlanet(PLANET_ID);
  if (planetMeta) {
    document.title = `SPAC3 — ${planetMeta.name} (first-person prototype)`;
    document.querySelectorAll('#fpsBadge, .fpsPlanetHeading').forEach((el) => {
      el.textContent = `${planetMeta.emoji} ${planetMeta.name} — first-person prototype`;
    });
    const introEl = document.getElementById('fpsIntroText');
    if (introEl && planetMeta.monsters.length >= 2) {
      const [m1, m2] = planetMeta.monsters;
      introEl.textContent = `This is an early tech test for turning SPAC3's minigame worlds into first-person 3D -- walkable in first person with your weapon on screen. Fight the same ${m1.name}s and ${m2.name}s as the 2D game for real ${planetMeta.scrapLabel}, using whatever weapon you have equipped. Still single-player here -- no other players visible yet.`;
    }
    const scrapTypeLabelEl = document.getElementById('fpsScrapTypeLabel');
    if (scrapTypeLabelEl) scrapTypeLabelEl.textContent = `${planetMeta.scrapEmoji} ${planetMeta.scrapLabel}`;
  }
}

// One 2D "tile" (RUSTBELT_TILE_SIZE px in the top-down game) becomes
// this many 3D world units -- chosen purely for a comfortable human
// walking scale, unrelated to the 2D game's pixel sizing. All three
// planet layouts above share the same 32x24-tile/40px-tile convention
// (RUSTBELT_COLS/ROWS/TILE_SIZE), so this scale applies to all of them.
const TILE = 4;
const WALL_HEIGHT = 3.2;
const EYE_HEIGHT = 1.7;
const PLAYER_RADIUS = 0.4;
const MOVE_SPEED = 6.5; // world units/sec

const WORLD_W = RUSTBELT_COLS * TILE;
const WORLD_D = RUSTBELT_ROWS * TILE;

const canvas = document.getElementById('fpsCanvas');
const overlay = document.getElementById('fpsOverlay');
const crosshair = document.getElementById('fpsCrosshair');
const damageFlash = document.getElementById('fpsDamageFlash');
const pauseHint = document.getElementById('fpsPauseHint');
const controlsHint = document.getElementById('fpsControlsHint');
const settingsPanel = document.getElementById('fpsSettings');
const sensitivitySlider = document.getElementById('fpsSensitivity');
const sensitivityValue = document.getElementById('fpsSensitivityValue');
const weaponLabel = document.getElementById('fpsWeaponLabel');
const schemeArrowsMoveRadio = document.getElementById('fpsSchemeArrowsMove');
const schemeWasdMoveRadio = document.getElementById('fpsSchemeWasdMove');
const scrapCountEl = document.getElementById('fpsScrapCount');
const weaponShopEl = document.getElementById('fpsWeaponShop');
const healthHud = document.getElementById('fpsHealthHud');
const combatMsgEl = document.getElementById('fpsCombatMsg');
const knockoutOverlay = document.getElementById('fpsKnockoutOverlay');
const touchLookZone = document.getElementById('fpsTouchLookZone');
const joystickZone = document.getElementById('fpsJoystickZone');
const joystickBase = joystickZone.querySelector('.joystick-base');
const joystickKnob = joystickZone.querySelector('.joystick-knob');
const attackBtn = document.getElementById('fpsAttackBtn');
const mobileMenuBtn = document.getElementById('fpsMobileMenuBtn');

// Mobile / touch support -- Roblox-style virtual controls (a floating
// joystick to move, drag-anywhere-else to look, a dedicated attack
// button) for any device whose PRIMARY pointer is touch, not just
// anything that happens to have a touchscreen. `pointer: coarse`
// reflects the primary pointer per the media-queries spec, so a laptop
// with both a trackpad and a touchscreen still gets the normal
// mouse+keyboard experience -- only a phone/tablet (no fine pointer at
// all) switches over to the on-screen controls below.
const isTouchDevice = window.matchMedia('(pointer: coarse)').matches;
if (isTouchDevice) {
  document.body.classList.add('touch');
}

// Look sensitivity -- a single multiplier applied to both mouse-look
// (controls.pointerSpeed, below) and keyboard-look (KEY_LOOK_SPEED,
// further down), so "sensitivity" means one consistent thing rather
// than two separate settings to tune. Remembered across visits via
// localStorage since this is a real deployed page, not a sandboxed
// preview -- there's no server-side profile for a prototype this
// early, so a per-browser preference is the right amount of "remembers
// your settings" for now.
const SENSITIVITY_STORAGE_KEY = 'spac3_fps_look_sensitivity';
let lookSensitivity = 1;
try {
  const stored = parseFloat(localStorage.getItem(SENSITIVITY_STORAGE_KEY));
  if (!Number.isNaN(stored) && stored > 0) lookSensitivity = stored;
} catch (err) {
  // Private browsing / blocked storage -- fall back to the default
  // silently, same as everywhere else this pattern is used.
}
sensitivitySlider.value = String(lookSensitivity);
sensitivityValue.textContent = `${lookSensitivity.toFixed(1)}x`;

// Control scheme -- lets a player swap which key set walks the player
// around and which one turns the camera/crosshair, for anyone used to
// WASD-to-move shooters instead of this prototype's default (arrow
// keys move, WASD looks). Both directions are just two named sets of
// the same shape, swapped as a unit, and persisted the same way as
// look sensitivity since there's no server-side profile here yet.
const CONTROL_SCHEME_STORAGE_KEY = 'spac3_fps_control_scheme';
const CONTROL_SCHEMES = {
  'arrows-move': {
    move: { ArrowUp: 'forward', ArrowDown: 'back', ArrowLeft: 'left', ArrowRight: 'right' },
    look: { KeyW: 'up', KeyS: 'down', KeyA: 'left', KeyD: 'right' },
    hint: 'Click anywhere to start. Arrow keys to move, mouse or WASD to look around, left-click or Space to attack, Esc to release the mouse.',
  },
  'wasd-move': {
    move: { KeyW: 'forward', KeyS: 'back', KeyA: 'left', KeyD: 'right' },
    look: { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' },
    hint: 'Click anywhere to start. WASD to move, mouse or arrow keys to look around, left-click or Space to attack, Esc to release the mouse.',
  },
};
let controlScheme = 'arrows-move';
try {
  const storedScheme = localStorage.getItem(CONTROL_SCHEME_STORAGE_KEY);
  if (storedScheme && CONTROL_SCHEMES[storedScheme]) controlScheme = storedScheme;
} catch (err) {
  // Private browsing / blocked storage -- fall back to the default.
}
schemeArrowsMoveRadio.checked = controlScheme === 'arrows-move';
schemeWasdMoveRadio.checked = controlScheme === 'wasd-move';

// The keyboard control-scheme hint doesn't apply on a touch-primary
// device -- there's no keyboard to speak of -- so this one function is
// the single place that decides which hint text is actually shown,
// called both here and whenever the keyboard scheme changes (a touch
// device with a keyboard case can still change that setting; it just
// keeps seeing the touch instructions instead of the keyboard ones,
// since those keyboard settings aren't what's driving play there).
const TOUCH_HINT = 'Tap anywhere to start. Drag the joystick to move, drag anywhere else to look around, tap ⚔️ to attack, ☰ to pause.';
function updateControlsHint() {
  controlsHint.textContent = isTouchDevice ? TOUCH_HINT : CONTROL_SCHEMES[controlScheme].hint;
}
updateControlsHint();

// ---------------------------------------------------------------
// Scene / renderer / camera
// ---------------------------------------------------------------
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x05060f);
scene.fog = new THREE.FogExp2(0x05060f, 0.018);

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
// PCFSoftShadowMap trades a bit of extra cost for softer shadow edges --
// worth it here since the whole point of turning shadows on is the
// crater terrain below actually reading as 3D relief rather than a
// painted-on bump texture.
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 500);
// PointerLockControls (0.160+) rotates `camera` directly rather than a
// separate wrapper object -- the camera itself must be in the scene
// graph for its children (the weapon viewmodel added below) to render.
scene.add(camera);

const controls = new PointerLockControls(camera, document.body);
controls.pointerSpeed = lookSensitivity;

// The settings panel lives inside the overlay (so it's reachable both
// before the first click-to-start and any time Esc brings the overlay
// back), but the overlay itself locks the pointer on ANY click -- stop
// that click from reaching the overlay so dragging the slider (or
// clicking its label) doesn't immediately re-lock the mouse out from
// under you.
settingsPanel.addEventListener('click', (e) => e.stopPropagation());
sensitivitySlider.addEventListener('input', () => {
  lookSensitivity = parseFloat(sensitivitySlider.value);
  sensitivityValue.textContent = `${lookSensitivity.toFixed(1)}x`;
  controls.pointerSpeed = lookSensitivity;
  try { localStorage.setItem(SENSITIVITY_STORAGE_KEY, String(lookSensitivity)); } catch (err) { /* ignore */ }
});

// Whether the game is actually "playing" right now -- true either from
// real pointer lock (desktop/mouse) or from the mobile "tap to start"
// flow below, since a touch device never acquires real pointer lock at
// all (see isTouchDevice above). Everything that used to gate purely on
// controls.isLocked (movement, looking, attacking, contact damage in
// the main loop) checks this instead, so the same gameplay code runs
// either way -- only how you START and how you LOOK/MOVE differ between
// the two input modes.
let mobileActive = false;
function isPlaying() {
  return controls.isLocked || mobileActive;
}

function enterPlayMode() {
  overlay.style.display = 'none';
  crosshair.style.display = 'block';
  pauseHint.style.display = 'block';
  healthHud.style.display = 'block';
}
function exitPlayMode() {
  overlay.style.display = 'flex';
  crosshair.style.display = 'none';
  pauseHint.style.display = 'none';
  healthHud.style.display = 'none';
  resetJoystick();
  resetTouchLook();
  stopAttackRepeat();
  attackAimPointerId = null;
}

overlay.addEventListener('click', () => {
  if (isTouchDevice) {
    // No real pointer lock on a touch device -- just start play
    // directly. See the touch input section further down for the
    // joystick/look/attack handling that takes over from here.
    mobileActive = true;
    enterPlayMode();
  } else {
    controls.lock();
  }
});
controls.addEventListener('lock', enterPlayMode);
controls.addEventListener('unlock', () => {
  mobileActive = false;
  exitPlayMode();
});

mobileMenuBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  mobileActive = false;
  exitPlayMode();
});

// ---------------------------------------------------------------
// Lighting -- soft ambient fill plus one raking "earthshine" light,
// since a moon's own sky has no sun of its own to speak of.
// ---------------------------------------------------------------
scene.add(new THREE.AmbientLight(0x9aa2d0, 0.65));
const keyLight = new THREE.DirectionalLight(0xcfd8ff, 1.9);
keyLight.position.set(WORLD_W * 0.3, 40, WORLD_D * 0.2);
// Real shadows (rather than flat ambient-only fill) are the whole point
// of the crater terrain below -- a shadow-casting light needs its own
// shadow-map camera frustum, generously sized to comfortably cover the
// walkable map regardless of the light's exact aim (it has no explicit
// target, so it implicitly aims at the world origin, same as before
// this change -- retargeting it would shift the existing lighting
// mood/angle, which wasn't asked for).
keyLight.castShadow = true;
const shadowMapSize = isTouchDevice ? 1024 : 2048;
keyLight.shadow.mapSize.set(shadowMapSize, shadowMapSize);
keyLight.shadow.camera.left = -WORLD_W * 0.75;
keyLight.shadow.camera.right = WORLD_W * 0.75;
keyLight.shadow.camera.top = WORLD_D * 0.75;
keyLight.shadow.camera.bottom = -WORLD_D * 0.75;
keyLight.shadow.camera.near = 1;
keyLight.shadow.camera.far = 220;
keyLight.shadow.bias = -0.0015;
scene.add(keyLight);
// A small light that always travels with the camera, so nearby
// geometry (the weapon especially) doesn't read as a flat silhouette
// no matter which way the moonlight above happens to be facing.
const headLight = new THREE.PointLight(0xffffff, 0.9, 16);
camera.add(headLight);

// A scattering of distant points standing in for stars -- purely
// decorative, fixed far outside the walkable area. Two layers (lots
// of tiny dim background stars + fewer, bigger, brighter ones) plus
// real-ish per-star color variation (blue-white dominant, with warm
// gold/orange/red stars mixed in) so it reads as an actual night sky
// rather than a flat dot pattern.
function buildStarfieldLayer(count, size) {
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const radius = 150 + Math.random() * 250;
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(Math.random() * 2 - 1);
    positions[i * 3] = radius * Math.sin(phi) * Math.cos(theta) + WORLD_W / 2;
    positions[i * 3 + 1] = Math.abs(radius * Math.cos(phi)) + 20;
    positions[i * 3 + 2] = radius * Math.sin(phi) * Math.sin(theta) + WORLD_D / 2;

    const tint = Math.random();
    let r, g, b;
    if (tint < 0.6) { r = 0.85; g = 0.9; b = 1.0; } // blue-white (most common)
    else if (tint < 0.82) { r = 1.0; g = 0.95; b = 0.8; } // warm white/gold
    else if (tint < 0.94) { r = 1.0; g = 0.75; b = 0.55; } // orange
    else { r = 1.0; g = 0.55; b = 0.5; } // red
    const brightness = 0.55 + Math.random() * 0.45;
    colors[i * 3] = r * brightness;
    colors[i * 3 + 1] = g * brightness;
    colors[i * 3 + 2] = b * brightness;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const mat = new THREE.PointsMaterial({
    size, sizeAttenuation: false, vertexColors: true,
    transparent: true, fog: false, depthWrite: false,
  });
  scene.add(new THREE.Points(geo, mat));
}
buildStarfieldLayer(1600, 1.1); // dense dim background dust
buildStarfieldLayer(220, 2.4); // fewer, brighter foreground stars

// ---------------------------------------------------------------
// Earth -- a distant sky globe, built entirely from procedural canvas
// textures (no network texture fetch, matching this file's existing
// offline-friendly canvas-texture pattern used for the ground/monster
// sprites/health bars below). A "day" texture (ocean + continents +
// clouds) drives material.map; a second, same-UV-layout "emissive"
// texture holds city lights confined to land only, biased toward a
// few dense hub points per continent. MeshStandardMaterial's
// emissiveMap glows independently of incident light, so the day/night
// terminator falls out for free from however the scene's existing
// keyLight happens to be facing -- no bespoke day/night logic needed.
// ---------------------------------------------------------------
function seededRandom(seed) {
  let s = seed >>> 0;
  return function () {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildEarthTextures() {
  const W = 1024, H = 512;
  const rand = seededRandom(20260923); // fixed seed -- same planet every load, not re-rolled

  const dayCv = document.createElement('canvas');
  dayCv.width = W; dayCv.height = H;
  const dayCtx = dayCv.getContext('2d');
  dayCtx.fillStyle = '#0b2447';
  dayCtx.fillRect(0, 0, W, H);

  const cityCv = document.createElement('canvas');
  cityCv.width = W; cityCv.height = H;
  const cityCtx = cityCv.getContext('2d');
  cityCtx.fillStyle = '#000000';
  cityCtx.fillRect(0, 0, W, H);

  // Fixed continent seed points (positions chosen, not randomized) so
  // land spreads across the sphere's UV space; each is drawn as a
  // cluster of overlapping circles so the outline reads as an organic
  // landmass rather than a perfect blob.
  const continents = [
    { cx: 180, cy: 150, spread: 90 },
    { cx: 150, cy: 300, spread: 70 },
    { cx: 430, cy: 120, spread: 100 },
    { cx: 480, cy: 320, spread: 80 },
    { cx: 700, cy: 160, spread: 120 },
    { cx: 780, cy: 340, spread: 70 },
    { cx: 900, cy: 220, spread: 60 },
  ];

  dayCtx.fillStyle = '#2f4a2e';
  const continentBlobs = [];
  continents.forEach((c) => {
    const blobCircles = [];
    const clusters = 10 + Math.floor(rand() * 8);
    for (let i = 0; i < clusters; i++) {
      const angle = rand() * Math.PI * 2;
      const dist = rand() * c.spread;
      const x = c.cx + Math.cos(angle) * dist;
      const y = c.cy + Math.sin(angle) * dist * 0.6;
      const r = c.spread * (0.25 + rand() * 0.35);
      dayCtx.beginPath();
      dayCtx.arc(x, y, r, 0, Math.PI * 2);
      dayCtx.fill();
      blobCircles.push({ x, y, r });
    }
    continentBlobs.push(blobCircles);
  });

  // Cosmetic cloud speckle over the whole planet.
  dayCtx.fillStyle = 'rgba(255,255,255,0.18)';
  for (let i = 0; i < 260; i++) {
    const x = rand() * W, y = rand() * H;
    const r = 2 + rand() * 5;
    dayCtx.beginPath();
    dayCtx.arc(x, y, r, 0, Math.PI * 2);
    dayCtx.fill();
  }

  // City lights -- ONLY inside the land blobs just drawn (never over
  // open ocean), biased toward a few dense hub points per continent via
  // squared-random-radius sampling, so it reads as dense metro cores
  // surrounded by sparser rural glow rather than an even scattering.
  continentBlobs.forEach((blobCircles) => {
    const hubCount = 2 + Math.floor(rand() * 2);
    for (let h = 0; h < hubCount; h++) {
      const hub = blobCircles[Math.floor(rand() * blobCircles.length)];
      const lightCount = 40 + Math.floor(rand() * 50);
      for (let i = 0; i < lightCount; i++) {
        const angle = rand() * Math.PI * 2;
        const dist = rand() * rand() * hub.r * 1.4; // squared -> hub-biased density
        const x = hub.x + Math.cos(angle) * dist;
        const y = hub.y + Math.sin(angle) * dist;
        // Only keep it if it actually lands inside SOME land circle
        // (not just its own hub's radius), so lights never spill past
        // a blob's true, irregular edge onto open ocean.
        const inLand = blobCircles.some((b) => {
          const dx = x - b.x, dy = y - b.y;
          return dx * dx + dy * dy <= b.r * b.r;
        });
        if (!inLand) continue;
        const warm = rand() > 0.18;
        cityCtx.fillStyle = warm ? '#ffd97a' : '#bfe3ff';
        cityCtx.beginPath();
        cityCtx.arc(x, y, warm ? 1.4 : 1.1, 0, Math.PI * 2);
        cityCtx.fill();
      }
    }
  });

  return { dayTex: new THREE.CanvasTexture(dayCv), cityTex: new THREE.CanvasTexture(cityCv) };
}

const { dayTex: earthDayTex, cityTex: earthCityTex } = buildEarthTextures();
const earth = new THREE.Mesh(
  new THREE.SphereGeometry(34, 48, 32),
  new THREE.MeshStandardMaterial({
    map: earthDayTex,
    emissiveMap: earthCityTex,
    emissive: 0xffffff,
    emissiveIntensity: 1.6,
    roughness: 0.9,
  })
);
earth.position.set(WORLD_W / 2 + 160, 130, WORLD_D / 2 - 90);
// A distant sky object: explicitly excluded from the scene's fog (the
// existing FogExp2 below would otherwise all but erase anything at
// Earth's ~200+ unit distance) and left out of the ground shadow
// system entirely -- it's not part of the walkable surface, so it
// neither casts nor receives shadows.
earth.material.fog = false;
scene.add(earth);

// ---------------------------------------------------------------
// Deep sky -- nebulas, spiral galaxies, and black holes scattered
// across the starfield well beyond Earth, all built from the same
// procedural-canvas, no-network-texture approach as buildEarthTextures
// above. Every object here explicitly opts out of scene fog and the
// ground shadow system for the same reason Earth does: they're far
// outside the fog's effective range and aren't part of the walkable
// surface. `deepSkySpinners` collects everything that should slowly
// rotate in animate() below (galaxies spinning in-plane, black hole
// accretion disks churning) for a bit of life instead of a frozen
// backdrop.
// ---------------------------------------------------------------
const deepSkyRand = seededRandom(133742069); // fixed seed -- same sky every load
const deepSkySpinners = []; // { sprite, speed }

function randomDeepSkyPosition(minRadius, maxRadius) {
  const radius = minRadius + deepSkyRand() * (maxRadius - minRadius);
  const theta = deepSkyRand() * Math.PI * 2;
  const phi = Math.acos(deepSkyRand() * 1.5 - 0.75); // biased toward the upper sky
  return new THREE.Vector3(
    radius * Math.sin(phi) * Math.cos(theta) + WORLD_W / 2,
    Math.abs(radius * Math.cos(phi)) + 70,
    radius * Math.sin(phi) * Math.sin(theta) + WORLD_D / 2
  );
}

function addSkySprite(texture, position, scale, { rotation = 0, opacity = 1, spinSpeed = 0 } = {}) {
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: texture, transparent: true, opacity, rotation,
    blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
  }));
  sprite.position.copy(position);
  sprite.scale.set(scale, scale, 1);
  scene.add(sprite);
  if (spinSpeed) deepSkySpinners.push({ sprite, speed: spinSpeed });
  return sprite;
}

// --- Nebulas -- soft overlapping color-blob clouds, several palettes
// so the sky reads as genuinely psychedelic rather than one repeated
// tint. ---
const NEBULA_PALETTES = [
  [{ core: 'rgba(255,110,220,0.95)', mid: 'rgba(170,50,200,0.5)' }, { core: 'rgba(130,90,255,0.9)', mid: 'rgba(70,40,180,0.45)' }],
  [{ core: 'rgba(110,230,255,0.95)', mid: 'rgba(50,120,220,0.5)' }, { core: 'rgba(140,255,200,0.85)', mid: 'rgba(40,180,140,0.4)' }],
  [{ core: 'rgba(255,210,110,0.95)', mid: 'rgba(255,120,60,0.5)' }, { core: 'rgba(255,90,140,0.85)', mid: 'rgba(200,40,90,0.4)' }],
  [{ core: 'rgba(160,255,140,0.9)', mid: 'rgba(60,200,110,0.45)' }, { core: 'rgba(110,255,235,0.85)', mid: 'rgba(40,180,190,0.4)' }],
];

function buildNebulaTexture(seed, palette) {
  const W = 512, H = 512;
  const rand = seededRandom(seed);
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');

  ctx.globalCompositeOperation = 'lighter';
  const blobCount = 7 + Math.floor(rand() * 5);
  for (let i = 0; i < blobCount; i++) {
    const cx = W / 2 + (rand() - 0.5) * W * 0.55;
    const cy = H / 2 + (rand() - 0.5) * H * 0.55;
    const r = W * (0.16 + rand() * 0.26);
    const color = palette[Math.floor(rand() * palette.length)];
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    grad.addColorStop(0, color.core);
    grad.addColorStop(0.45, color.mid);
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalCompositeOperation = 'source-over';

  // Embedded bright pinpoints -- stars caught inside the cloud.
  for (let i = 0; i < 180; i++) {
    const x = rand() * W, y = rand() * H;
    ctx.fillStyle = `rgba(255,255,255,${rand() * 0.7})`;
    ctx.fillRect(x, y, 1.4, 1.4);
  }

  return new THREE.CanvasTexture(cv);
}

NEBULA_PALETTES.forEach((palette, i) => {
  const tex = buildNebulaTexture(5000 + i * 137, palette);
  const scale = 140 + deepSkyRand() * 160;
  addSkySprite(tex, randomDeepSkyPosition(220, 420), scale, {
    rotation: deepSkyRand() * Math.PI * 2,
    opacity: 0.55 + deepSkyRand() * 0.25,
  });
});

// --- Spiral galaxies -- a bright core plus a couple of arms made of
// tiny star-dots along a loose spiral, flattened for a tilted-disc
// look, slowly spinning in animate() below. ---
const GALAXY_TINTS = [
  { core: 'rgba(255,255,255,0.95)', halo: 'rgba(150,190,255,0.35)', rgb: '190,210,255' },
  { core: 'rgba(255,255,255,0.95)', halo: 'rgba(255,170,220,0.35)', rgb: '255,190,235' },
  { core: 'rgba(255,255,255,0.95)', halo: 'rgba(255,225,150,0.35)', rgb: '255,225,180' },
];

function buildGalaxyTexture(seed, tint) {
  const W = 512, H = 512;
  const rand = seededRandom(seed);
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  const cx = W / 2, cy = H / 2;

  let grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, W * 0.5);
  grad.addColorStop(0, tint.core);
  grad.addColorStop(0.35, tint.halo);
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);

  grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, W * 0.1);
  grad.addColorStop(0, 'rgba(255,255,255,0.95)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(cx, cy, W * 0.1, 0, Math.PI * 2);
  ctx.fill();

  const arms = 2 + Math.floor(rand() * 2);
  const pointsPerArm = 850;
  for (let a = 0; a < arms; a++) {
    const armOffset = (Math.PI * 2 / arms) * a;
    for (let i = 0; i < pointsPerArm; i++) {
      const t = i / pointsPerArm;
      const angle = armOffset + t * Math.PI * 4 + (rand() - 0.5) * 0.35;
      const radius = t * W * 0.46 * (0.35 + rand() * 0.65);
      const x = cx + Math.cos(angle) * radius;
      const y = cy + Math.sin(angle) * radius * 0.5; // flatten into a tilted disc
      const alpha = (1 - t) * 0.55 * rand() + 0.05;
      ctx.fillStyle = `rgba(${tint.rgb},${alpha})`;
      ctx.fillRect(x, y, 1.6, 1.6);
    }
  }
  return new THREE.CanvasTexture(cv);
}

GALAXY_TINTS.forEach((tint, i) => {
  const tex = buildGalaxyTexture(7000 + i * 211, tint);
  const scale = 90 + deepSkyRand() * 90;
  addSkySprite(tex, randomDeepSkyPosition(260, 400), scale, {
    rotation: deepSkyRand() * Math.PI * 2,
    opacity: 0.85,
    spinSpeed: 0.01 + deepSkyRand() * 0.02,
  });
});

// --- Black holes -- an opaque soft-edged black disc (the event
// horizon, blocking whatever's behind it) plus a separate, larger,
// additively-blended accretion-disk ring rendered behind it so the
// glow only shows around the disc's rim, not through it. Several
// different sizes/ring colors per the request for "different sizes".
// ---
const BLACK_HOLE_RING_PALETTES = [
  { hot: 'rgba(255,235,180,0.9)', cool: 'rgba(255,120,60,0.6)' }, // classic hot orange/white
  { hot: 'rgba(190,220,255,0.9)', cool: 'rgba(120,80,255,0.6)' }, // exotic blue/violet
  { hot: 'rgba(255,190,255,0.9)', cool: 'rgba(90,255,210,0.6)' }, // psychedelic pink/teal
];

function buildBlackHoleDiscTexture() {
  const W = 512, H = 512;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  const cx = W / 2, cy = H / 2, r = W * 0.32;
  const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
  grad.addColorStop(0, 'rgba(0,0,0,1)');
  grad.addColorStop(0.88, 'rgba(0,0,0,1)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
  return new THREE.CanvasTexture(cv);
}

function buildBlackHoleRingTexture(seed, palette) {
  const W = 512, H = 512;
  const rand = seededRandom(seed);
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  const cx = W / 2, cy = H / 2;
  ctx.globalCompositeOperation = 'lighter';
  const steps = 260;
  for (let i = 0; i < steps; i++) {
    const t = i / steps;
    const angle = t * Math.PI * 2;
    const wobble = 1 + Math.sin(angle * 3 + seed) * 0.06;
    const rx = W * 0.4 * wobble;
    const ry = W * 0.15 * wobble; // squashed ellipse -- a disk seen edge-on-ish
    const x = cx + Math.cos(angle) * rx;
    const y = cy + Math.sin(angle) * ry;
    const heat = 0.5 + 0.5 * Math.sin(angle * 2);
    const color = heat > 0.5 ? palette.hot : palette.cool;
    const r = W * (0.035 + rand() * 0.03);
    const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, color);
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalCompositeOperation = 'source-over';
  return new THREE.CanvasTexture(cv);
}

const blackHoleDiscTex = buildBlackHoleDiscTexture(); // shared -- the disc itself is just flat black
BLACK_HOLE_RING_PALETTES.forEach((palette, i) => {
  const ringTex = buildBlackHoleRingTexture(9000 + i * 311, palette);
  const position = randomDeepSkyPosition(200, 380);
  const discScale = 26 + deepSkyRand() * 46; // "different sizes"
  const ringScale = discScale * 1.9;
  const ringRotation = deepSkyRand() * Math.PI * 2;

  const ring = addSkySprite(ringTex, position, ringScale, {
    rotation: ringRotation, opacity: 1, spinSpeed: 0.04 + deepSkyRand() * 0.05,
  });
  ring.renderOrder = 0;

  const disc = new THREE.Sprite(new THREE.SpriteMaterial({
    map: blackHoleDiscTex, transparent: true, depthWrite: false, fog: false,
  }));
  disc.position.copy(position);
  disc.scale.set(discScale, discScale, 1);
  disc.renderOrder = 1;
  scene.add(disc);
});

// ---------------------------------------------------------------
// Wall tile rects -- single source of truth for every wall's
// footprint in TILE-grid coordinates (border ring + MAP.obstacles),
// consumed both by the wall-mesh builder below and by the crater
// generator further down (so craters never get placed overlapping a
// wall's base).
// ---------------------------------------------------------------
const WALL_TILE_RECTS = [
  [0, 0, RUSTBELT_COLS, 1], // north
  [0, RUSTBELT_ROWS - 1, RUSTBELT_COLS, 1], // south
  [0, 0, 1, RUSTBELT_ROWS], // west
  [RUSTBELT_COLS - 1, 0, 1, RUSTBELT_ROWS], // east
  ...MAP.obstacles.map(({ x, y, w, h }) => [x, y, w, h]),
];

// ---------------------------------------------------------------
// Terrain -- crater bowls scattered across the moon's surface via
// rejection sampling (never overlapping a wall footprint, the player
// spawn, a monster spawn, or another crater), each with a smoothstep
// falloff so its rim blends smoothly into the flat surrounding ground
// instead of a hard-edged lip -- this is what makes the craters read
// as "rounded" rather than sharp pits. terrainHeightAt() is the single
// source of truth for ground height at any world (x,z), reused below
// for the ground mesh's own vertex displacement, the player's eye
// height, and every monster's resting height, so nothing floats above
// or clips into the bumpy surface.
// ---------------------------------------------------------------
const CRATER_MARGIN = 1.2;
const CRATER_COUNT_TARGET = 26;
const CRATER_MAX_ATTEMPTS = 400;

function rectsOverlap(ax, az, aw, ad, bx, bz, bw, bd) {
  return ax < bx + bw && ax + aw > bx && az < bz + bd && az + ad > bz;
}

function generateCraters() {
  const craters = [];
  const playerSpawnX = (MAP.playerSpawn.x / RUSTBELT_TILE_SIZE) * TILE;
  const playerSpawnZ = (MAP.playerSpawn.y / RUSTBELT_TILE_SIZE) * TILE;
  const spawnPoints = [
    { x: playerSpawnX, z: playerSpawnZ },
    ...MAP.spawns.map((s) => ({
      x: (s.x / RUSTBELT_TILE_SIZE) * TILE,
      z: (s.y / RUSTBELT_TILE_SIZE) * TILE,
    })),
  ];
  const wallRectsWorld = WALL_TILE_RECTS.map(([tx, ty, tw, th]) => ({
    x: tx * TILE, z: ty * TILE, w: tw * TILE, d: th * TILE,
  }));

  let attempts = 0;
  while (craters.length < CRATER_COUNT_TARGET && attempts < CRATER_MAX_ATTEMPTS) {
    attempts++;
    const radius = 3 + Math.random() * 6; // 3..9 world units
    const depth = radius * (0.12 + Math.random() * 0.10); // ~12-22% of radius
    const margin = radius + CRATER_MARGIN;
    const x = margin + Math.random() * (WORLD_W - margin * 2);
    const z = margin + Math.random() * (WORLD_D - margin * 2);

    const hitsWall = wallRectsWorld.some((r) => rectsOverlap(
      x - radius - CRATER_MARGIN, z - radius - CRATER_MARGIN,
      (radius + CRATER_MARGIN) * 2, (radius + CRATER_MARGIN) * 2,
      r.x, r.z, r.w, r.d
    ));
    if (hitsWall) continue;

    const hitsSpawn = spawnPoints.some((p) => {
      const dx = p.x - x, dz = p.z - z;
      return Math.sqrt(dx * dx + dz * dz) < radius + CRATER_MARGIN + 2;
    });
    if (hitsSpawn) continue;

    const overlapsCrater = craters.some((c) => {
      const dx = c.x - x, dz = c.z - z;
      return Math.sqrt(dx * dx + dz * dz) < radius + c.radius + 1.5;
    });
    if (overlapsCrater) continue;

    craters.push({ x, z, radius, depth });
  }
  return craters;
}

const CRATERS = generateCraters();

function terrainHeightAt(x, z) {
  let height = 0;
  for (const c of CRATERS) {
    const dx = x - c.x, dz = z - c.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    if (dist >= c.radius) continue;
    const t = 1 - dist / c.radius;
    const smooth = t * t * (3 - 2 * t);
    height -= c.depth * smooth;
  }
  return height;
}

// ---------------------------------------------------------------
// Moon rock texture -- a procedural canvas texture standing in for
// real lunar regolith/rock photography (same offline-friendly,
// no-network-fetch convention as buildEarthTextures above). Builds a
// matched PAIR of same-layout canvases: a color
// map (a grayish-tan base speckled with fine dust grain, plus a mix of
// darker recessed "pits" and lighter raised "pebbles") and a bump map
// using the exact same blob positions/radii/pit-or-pebble choice --
// so the fine bump detail lines up with what's actually painted,
// rather than being generic unrelated noise. Ground and walls each
// get their own call (different seed/base tint/blob scale) so they
// don't look like obviously tiled copies of each other.
// ---------------------------------------------------------------
function buildMoonRockTexture({ seed, baseColor, blobCount = 220, speckleCount = 2200 }) {
  const W = 512, H = 512;
  const rand = seededRandom(seed);

  const colorCv = document.createElement('canvas');
  colorCv.width = W; colorCv.height = H;
  const colorCtx = colorCv.getContext('2d');
  const bumpCv = document.createElement('canvas');
  bumpCv.width = W; bumpCv.height = H;
  const bumpCtx = bumpCv.getContext('2d');

  colorCtx.fillStyle = baseColor;
  colorCtx.fillRect(0, 0, W, H);
  bumpCtx.fillStyle = '#808080';
  bumpCtx.fillRect(0, 0, W, H);

  // Fine dust-grain speckle -- lots of tiny, mostly-transparent dabs
  // so the base color isn't perfectly flat even between rock chunks.
  for (let i = 0; i < speckleCount; i++) {
    const x = rand() * W, y = rand() * H;
    const v = Math.floor(90 + rand() * 90);
    colorCtx.fillStyle = `rgba(${v}, ${v - 6}, ${v - 14}, ${0.04 + rand() * 0.08})`;
    colorCtx.fillRect(x, y, 1.5, 1.5);
  }

  // Rock chunks -- a mix of small dark recessed pits (tiny craters/
  // shadowed cracks) and lighter raised pebbles, each drawn with a
  // soft radial falloff so nothing has a hard cutout edge. The SAME
  // x/y/radius/pit-choice feeds both the color blob (tinted) and the
  // bump blob (grayscale height), so the two stay visually locked.
  for (let i = 0; i < blobCount; i++) {
    const x = rand() * W, y = rand() * H;
    const r = 3 + rand() * rand() * 30; // mostly small, occasionally a bigger boulder
    const isPit = rand() > 0.45;

    const cGrad = colorCtx.createRadialGradient(x, y, 0, x, y, r);
    if (isPit) {
      cGrad.addColorStop(0, 'rgba(35, 32, 28, 0.55)');
      cGrad.addColorStop(0.7, 'rgba(60, 55, 50, 0.22)');
      cGrad.addColorStop(1, 'rgba(60, 55, 50, 0)');
    } else {
      cGrad.addColorStop(0, 'rgba(205, 198, 186, 0.4)');
      cGrad.addColorStop(0.7, 'rgba(175, 168, 156, 0.18)');
      cGrad.addColorStop(1, 'rgba(175, 168, 156, 0)');
    }
    colorCtx.fillStyle = cGrad;
    colorCtx.beginPath();
    colorCtx.arc(x, y, r, 0, Math.PI * 2);
    colorCtx.fill();

    const bGrad = bumpCtx.createRadialGradient(x, y, 0, x, y, r);
    if (isPit) {
      bGrad.addColorStop(0, 'rgba(15, 15, 15, 0.85)');
      bGrad.addColorStop(1, 'rgba(15, 15, 15, 0)');
    } else {
      bGrad.addColorStop(0, 'rgba(255, 255, 255, 0.85)');
      bGrad.addColorStop(1, 'rgba(255, 255, 255, 0)');
    }
    bumpCtx.fillStyle = bGrad;
    bumpCtx.beginPath();
    bumpCtx.arc(x, y, r, 0, Math.PI * 2);
    bumpCtx.fill();
  }

  const colorTex = new THREE.CanvasTexture(colorCv);
  colorTex.wrapS = colorTex.wrapT = THREE.RepeatWrapping;
  const bumpTex = new THREE.CanvasTexture(bumpCv);
  bumpTex.wrapS = bumpTex.wrapT = THREE.RepeatWrapping;
  return { colorTex, bumpTex };
}

// ---------------------------------------------------------------
// Crystal texture (Crystal Reach) -- irregular translucent-looking
// facet polygons over a deep gradient base, plus glowing crack/vein
// lines. Returns a matched TRIO of same-layout canvases: a color map
// (facets + tinted veins), a bump map (facet edges stroked dark so
// each polygon reads as a distinct raised/cut face), and an emissive
// map (veins only, bright on black) so the cracks visibly glow even
// on a shadowed face -- same MeshStandardMaterial emissiveMap trick
// as Earth's city lights above.
// ---------------------------------------------------------------
function buildCrystalTexture({ seed, baseA, baseB, veinColor, facetCount = 46 }) {
  const W = 512, H = 512;
  const rand = seededRandom(seed);

  const colorCv = document.createElement('canvas');
  colorCv.width = W; colorCv.height = H;
  const colorCtx = colorCv.getContext('2d');
  const bumpCv = document.createElement('canvas');
  bumpCv.width = W; bumpCv.height = H;
  const bumpCtx = bumpCv.getContext('2d');
  const emissiveCv = document.createElement('canvas');
  emissiveCv.width = W; emissiveCv.height = H;
  const emissiveCtx = emissiveCv.getContext('2d');

  const bgGrad = colorCtx.createLinearGradient(0, 0, W, H);
  bgGrad.addColorStop(0, baseA);
  bgGrad.addColorStop(1, baseB);
  colorCtx.fillStyle = bgGrad;
  colorCtx.fillRect(0, 0, W, H);
  bumpCtx.fillStyle = '#808080';
  bumpCtx.fillRect(0, 0, W, H);
  emissiveCtx.fillStyle = '#000000';
  emissiveCtx.fillRect(0, 0, W, H);

  // Facets -- irregular translucent polygons (3-6 sided) at varying
  // brightness, like light catching different faces of a crystal
  // cluster. Each polygon's outline is also stroked into the bump map
  // (dark) with its fill brightness carried over (light/dark gray) so
  // the facet reads as genuine relief rather than a flat sticker.
  for (let i = 0; i < facetCount; i++) {
    const cx = rand() * W, cy = rand() * H;
    const sides = 3 + Math.floor(rand() * 4);
    const radius = 18 + rand() * 70;
    const rot = rand() * Math.PI * 2;
    const points = [];
    for (let s = 0; s < sides; s++) {
      const angle = rot + (Math.PI * 2 * s) / sides + (rand() - 0.5) * 0.4;
      const rr = radius * (0.7 + rand() * 0.4);
      points.push([cx + Math.cos(angle) * rr, cy + Math.sin(angle) * rr]);
    }
    const brightness = rand();
    const alpha = 0.12 + rand() * 0.22;

    colorCtx.beginPath();
    points.forEach(([px, py], idx) => (idx === 0 ? colorCtx.moveTo(px, py) : colorCtx.lineTo(px, py)));
    colorCtx.closePath();
    colorCtx.fillStyle = brightness > 0.5 ? `rgba(255,255,255,${alpha})` : `rgba(0,0,0,${alpha * 0.8})`;
    colorCtx.fill();

    bumpCtx.beginPath();
    points.forEach(([px, py], idx) => (idx === 0 ? bumpCtx.moveTo(px, py) : bumpCtx.lineTo(px, py)));
    bumpCtx.closePath();
    const bumpV = Math.floor(80 + brightness * 150);
    bumpCtx.fillStyle = `rgb(${bumpV},${bumpV},${bumpV})`;
    bumpCtx.fill();
    bumpCtx.strokeStyle = 'rgba(0,0,0,0.4)';
    bumpCtx.lineWidth = 1.5;
    bumpCtx.stroke();
  }

  // Glowing cracks/veins -- short branching polylines in a bright
  // color, drawn on both the color map (tinted, visible in daylight)
  // and the emissive map (pure glow, visible even in shadow).
  const veinCount = 26;
  for (let i = 0; i < veinCount; i++) {
    let x = rand() * W, y = rand() * H;
    const segments = 4 + Math.floor(rand() * 5);
    colorCtx.strokeStyle = veinColor;
    colorCtx.lineWidth = 1 + rand();
    colorCtx.globalAlpha = 0.5 + rand() * 0.3;
    emissiveCtx.strokeStyle = veinColor;
    emissiveCtx.lineWidth = 1.5 + rand();
    colorCtx.beginPath();
    colorCtx.moveTo(x, y);
    emissiveCtx.beginPath();
    emissiveCtx.moveTo(x, y);
    for (let s = 0; s < segments; s++) {
      x += (rand() - 0.5) * 60;
      y += (rand() - 0.5) * 60;
      colorCtx.lineTo(x, y);
      emissiveCtx.lineTo(x, y);
    }
    colorCtx.stroke();
    emissiveCtx.stroke();
    colorCtx.globalAlpha = 1;
  }

  const colorTex = new THREE.CanvasTexture(colorCv);
  colorTex.wrapS = colorTex.wrapT = THREE.RepeatWrapping;
  const bumpTex = new THREE.CanvasTexture(bumpCv);
  bumpTex.wrapS = bumpTex.wrapT = THREE.RepeatWrapping;
  const emissiveTex = new THREE.CanvasTexture(emissiveCv);
  emissiveTex.wrapS = emissiveTex.wrapT = THREE.RepeatWrapping;
  return { colorTex, bumpTex, emissiveTex };
}

// ---------------------------------------------------------------
// Candy texture (Jolly Land) -- a diagonal peppermint-stripe base
// under a scatter of glossy, multi-colored "gumdrop" blobs (each with
// an offset white highlight so it reads as shiny, not chalky) plus
// tiny rainbow sprinkle dashes on top. Returns a color/bump pair like
// buildMoonRockTexture above -- no emissive map here, candy doesn't
// need to glow, just shine.
// ---------------------------------------------------------------
function buildCandyTexture({ seed, stripeColors, blobColors, blobCount = 30 }) {
  const W = 512, H = 512;
  const rand = seededRandom(seed);

  const colorCv = document.createElement('canvas');
  colorCv.width = W; colorCv.height = H;
  const colorCtx = colorCv.getContext('2d');
  const bumpCv = document.createElement('canvas');
  bumpCv.width = W; bumpCv.height = H;
  const bumpCtx = bumpCv.getContext('2d');
  bumpCtx.fillStyle = '#808080';
  bumpCtx.fillRect(0, 0, W, H);

  // Diagonal peppermint-stripe background, drawn oversized then
  // clipped by the canvas bounds so the 45-degree rotation never
  // leaves a gap at the corners.
  colorCtx.save();
  colorCtx.translate(W / 2, H / 2);
  colorCtx.rotate(Math.PI / 4);
  colorCtx.translate(-W, -H);
  const stripeWidth = 34;
  for (let x = -W; x < W * 3; x += stripeWidth) {
    const idx = Math.floor((x + W) / stripeWidth);
    colorCtx.fillStyle = idx % 2 === 0 ? stripeColors[0] : stripeColors[1];
    colorCtx.fillRect(x, -H, stripeWidth, H * 4);
  }
  colorCtx.restore();

  // Gumdrop blobs -- bright candy-colored circles with a glossy
  // highlight, plus a matching bump blob so they read as raised
  // buttons rather than flat dots.
  for (let i = 0; i < blobCount; i++) {
    const x = rand() * W, y = rand() * H;
    const r = 14 + rand() * 26;
    const color = blobColors[Math.floor(rand() * blobColors.length)];

    const grad = colorCtx.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, color.light);
    grad.addColorStop(0.7, color.base);
    grad.addColorStop(1, color.base);
    colorCtx.fillStyle = grad;
    colorCtx.beginPath();
    colorCtx.arc(x, y, r, 0, Math.PI * 2);
    colorCtx.fill();
    // Glossy highlight, offset toward the upper-left like a light source.
    colorCtx.fillStyle = 'rgba(255,255,255,0.55)';
    colorCtx.beginPath();
    colorCtx.arc(x - r * 0.3, y - r * 0.3, r * 0.28, 0, Math.PI * 2);
    colorCtx.fill();

    const bGrad = bumpCtx.createRadialGradient(x, y, 0, x, y, r);
    bGrad.addColorStop(0, 'rgba(255,255,255,0.9)');
    bGrad.addColorStop(1, 'rgba(255,255,255,0)');
    bumpCtx.fillStyle = bGrad;
    bumpCtx.beginPath();
    bumpCtx.arc(x, y, r, 0, Math.PI * 2);
    bumpCtx.fill();
  }

  // Tiny rainbow sprinkles scattered on top.
  const sprinkleColors = ['#ff4d8d', '#ffd93d', '#4dd2ff', '#7dff4d', '#c56bff', '#ffffff'];
  for (let i = 0; i < 220; i++) {
    const x = rand() * W, y = rand() * H;
    const angle = rand() * Math.PI * 2;
    const len = 4 + rand() * 5;
    colorCtx.strokeStyle = sprinkleColors[Math.floor(rand() * sprinkleColors.length)];
    colorCtx.lineWidth = 1.6;
    colorCtx.beginPath();
    colorCtx.moveTo(x, y);
    colorCtx.lineTo(x + Math.cos(angle) * len, y + Math.sin(angle) * len);
    colorCtx.stroke();
  }

  const colorTex = new THREE.CanvasTexture(colorCv);
  colorTex.wrapS = colorTex.wrapT = THREE.RepeatWrapping;
  const bumpTex = new THREE.CanvasTexture(bumpCv);
  bumpTex.wrapS = bumpTex.wrapT = THREE.RepeatWrapping;
  return { colorTex, bumpTex };
}

// ---------------------------------------------------------------
// Theme dispatch -- picks the ground/wall look for whichever planet
// this page loaded with (see PLANET_ID above). Rustbelt Moon keeps
// its existing procedural moon-rock look unchanged; Crystal Reach
// gets the crystal facet/vein texture; Jolly Land gets the candy
// texture. One texture repeat roughly every 6 world units for both
// the ground (regardless of overall map size, so scale reads the same
// no matter how big the level is) and the walls -- walls use the same
// 1/6 repeat value, but note it means something different there: see
// the comment beside the crystal branch's wall repeat.set() below,
// since ExtrudeGeometry's UVs are raw world units, not normalized
// 0..1 like PlaneGeometry's.
// ---------------------------------------------------------------
function buildThemeMaterials() {
  if (PLANET_ID === 'crystal') {
    const ground = buildCrystalTexture({ seed: 51001, baseA: '#160b33', baseB: '#2a1660', veinColor: '#8fe8ff', facetCount: 50 });
    const wall = buildCrystalTexture({ seed: 51002, baseA: '#0d0726', baseB: '#241247', veinColor: '#c9a3ff', facetCount: 34 });
    [ground.colorTex, ground.bumpTex, ground.emissiveTex].forEach((t) => t.repeat.set(WORLD_W / 6, WORLD_D / 6));
    // Walls are built with ExtrudeGeometry (buildRoundedBoxGeometry
    // below), whose default UVGenerator bakes literal world-unit
    // vertex coordinates straight into the UV attribute (unlike
    // PlaneGeometry, which always normalizes UVs to a clean 0..1 range
    // regardless of world size). So a wall's raw UV span already equals
    // its actual size in world units, and a `repeat` value here means
    // "tile repeats per world unit" directly -- 1/6 matches the same
    // "one texture tile spans 6 world units" density used for the
    // ground above, instead of the old repeat.set(2, 1), which -- under
    // this raw-world-unit UV convention -- meant 2 tile-repeats PER
    // WORLD UNIT (a texture tile every 0.5 units), over 10x too fine
    // for every wall regardless of its size, causing the wall texture
    // to alias/mip down into a flat near-gray blur at any normal
    // viewing distance.
    [wall.colorTex, wall.bumpTex, wall.emissiveTex].forEach((t) => t.repeat.set(1 / 6, 1 / 6));
    return {
      groundMaterial: new THREE.MeshStandardMaterial({
        map: ground.colorTex, bumpMap: ground.bumpTex, bumpScale: 0.12,
        emissiveMap: ground.emissiveTex, emissive: 0xffffff, emissiveIntensity: 1.1,
        roughness: 0.32, metalness: 0.15,
      }),
      wallMaterial: new THREE.MeshStandardMaterial({
        map: wall.colorTex, bumpMap: wall.bumpTex, bumpScale: 0.2,
        emissiveMap: wall.emissiveTex, emissive: 0xffffff, emissiveIntensity: 1.3,
        roughness: 0.28, metalness: 0.2,
      }),
    };
  }

  if (PLANET_ID === 'jolly') {
    const pink = { light: '#ffd7ec', base: '#ff5fa8' };
    const yellow = { light: '#fff6c2', base: '#ffcf3d' };
    const blue = { light: '#d6f3ff', base: '#4fc7ff' };
    const green = { light: '#e4ffd6', base: '#6be05a' };
    const purple = { light: '#f0dcff', base: '#b366ff' };
    const candyPalette = [pink, yellow, blue, green, purple];
    const ground = buildCandyTexture({ seed: 61001, stripeColors: ['#fff0f6', '#ffd6e8'], blobColors: candyPalette, blobCount: 30 });
    const wall = buildCandyTexture({ seed: 61002, stripeColors: ['#fff9e0', '#ffe9a8'], blobColors: candyPalette, blobCount: 22 });
    [ground.colorTex, ground.bumpTex].forEach((t) => t.repeat.set(WORLD_W / 6, WORLD_D / 6));
    // See the crystal branch above for why walls use 1/6 (not the old
    // repeat.set(2, 1)) -- ExtrudeGeometry's raw world-unit UVs mean
    // the old value was a texture tile every 0.5 world units on every
    // wall, aliasing the vivid candy pattern down into a flat gray blur.
    [wall.colorTex, wall.bumpTex].forEach((t) => t.repeat.set(1 / 6, 1 / 6));
    return {
      groundMaterial: new THREE.MeshStandardMaterial({ map: ground.colorTex, bumpMap: ground.bumpTex, bumpScale: 0.08, roughness: 0.3, metalness: 0.02 }),
      // bumpScale kept close to the ground's own 0.08 (rather than the
      // original 0.14) so the gumdrops don't dig in deeper false
      // shadows than the ground's do. The candy walls also get a
      // modest self-illumination straight off their own color map
      // (candyPalette colors as emissive, not just a separate vein
      // map like crystal's) -- the raking key light lights the ground
      // almost head-on but hits these vertical wall faces at a much
      // more grazing angle (or not at all on faces angled away from
      // it), so without this boost the walls fall back to the scene's
      // dim, desaturated ambient light and read as flat gray no matter
      // how vividly colored their texture actually is. emissiveIntensity
      // is kept well under 1 so lit faces still pick up extra brightness
      // and specular pop from the key light on top of this floor.
      wallMaterial: new THREE.MeshStandardMaterial({
        map: wall.colorTex, bumpMap: wall.bumpTex, bumpScale: 0.08,
        emissiveMap: wall.colorTex, emissive: 0xffffff, emissiveIntensity: 0.55,
        roughness: 0.25, metalness: 0.02,
      }),
    };
  }

  // Default: Rustbelt Moon's existing procedural moon-rock look.
  const ground = buildMoonRockTexture({ seed: 8675309, baseColor: '#8f887c' });
  const wall = buildMoonRockTexture({ seed: 42017, baseColor: '#726c60', blobCount: 90, speckleCount: 1400 });
  [ground.colorTex, ground.bumpTex].forEach((t) => t.repeat.set(WORLD_W / 6, WORLD_D / 6));
  // Same fix as the crystal/jolly branches above: 1/6, not the old
  // repeat.set(2, 1), given ExtrudeGeometry's raw world-unit wall UVs.
  [wall.colorTex, wall.bumpTex].forEach((t) => t.repeat.set(1 / 6, 1 / 6));
  return {
    groundMaterial: new THREE.MeshStandardMaterial({ map: ground.colorTex, bumpMap: ground.bumpTex, bumpScale: 0.12, roughness: 0.97, metalness: 0 }),
    wallMaterial: new THREE.MeshStandardMaterial({ map: wall.colorTex, bumpMap: wall.bumpTex, bumpScale: 0.18, roughness: 0.95, metalness: 0 }),
  };
}

const THEME_MATERIALS = buildThemeMaterials();

// Segmented (not a single flat quad) so per-vertex height displacement
// below actually has geometry to bend -- density chosen high enough to
// resolve the smallest craters (radius ~3 world units) without being
// needlessly heavy on mobile GPUs.
const GROUND_SEGMENTS_X = 96;
const GROUND_SEGMENTS_Z = 72;
const groundGeo = new THREE.PlaneGeometry(WORLD_W, WORLD_D, GROUND_SEGMENTS_X, GROUND_SEGMENTS_Z);
{
  // PlaneGeometry lies flat in its local XY-plane (local Z=0) before
  // any rotation. After this mesh's `rotation.x = -Math.PI/2` and its
  // position offset below, a local (Lx, Ly, z) vertex ends up at world
  // (Lx + WORLD_W/2, z, -Ly + WORLD_D/2) -- so setting local Z to a
  // height puts it at that world height, and the matching world (x,z)
  // for feeding terrainHeightAt is (Lx + WORLD_W/2, -Ly + WORLD_D/2).
  const posAttr = groundGeo.attributes.position;
  for (let i = 0; i < posAttr.count; i++) {
    const localX = posAttr.getX(i);
    const localY = posAttr.getY(i);
    const worldX = localX + WORLD_W / 2;
    const worldZ = -localY + WORLD_D / 2;
    posAttr.setZ(i, terrainHeightAt(worldX, worldZ));
  }
  groundGeo.computeVertexNormals();
}

const ground = new THREE.Mesh(groundGeo, THEME_MATERIALS.groundMaterial);
ground.rotation.x = -Math.PI / 2;
ground.position.set(WORLD_W / 2, 0, WORLD_D / 2);
ground.receiveShadow = true;
ground.castShadow = true; // lets one crater's rim shadow a neighboring crater's floor
scene.add(ground);

// ---------------------------------------------------------------
// Walls -- the same border + obstacle rectangles as the 2D game's
// createRustbeltMap() (via WALL_TILE_RECTS above), now built as
// rounded-corner extruded shapes instead of plain sharp-edged boxes.
// `collisionBoxes` mirrors every wall's footprint, expanded by
// PLAYER_RADIUS, purely for movement collision (see resolveStep) --
// collision itself stays rectangular even though the visual corners
// are now rounded, which is an imperceptible simplification at this
// wall thickness.
// ---------------------------------------------------------------
const WALL_CORNER_RADIUS = 0.55;

// Builds a rounded-rectangle THREE.Shape (quadratic corner curves)
// and extrudes it into a 3D box, with a small bevel on the extruded
// edges too so the top/bottom edges read as softened, not just the
// four vertical corners. ExtrudeGeometry builds in the XY-plane
// extruded along +Z (range [0, height]); rotating -90 deg about X
// maps that Z range onto world Y, and translating by -height/2
// re-centers it around Y=0 to match BoxGeometry's own centered
// convention, so the existing mesh.position.set(cx, height/2, cz)
// placement below doesn't need to change.
function buildRoundedBoxGeometry(width, depth, height, radius) {
  const r = Math.max(0, Math.min(radius, width / 2 - 0.01, depth / 2 - 0.01));
  const hw = width / 2, hd = depth / 2;
  const shape = new THREE.Shape();
  shape.moveTo(-hw + r, -hd);
  shape.lineTo(hw - r, -hd);
  shape.quadraticCurveTo(hw, -hd, hw, -hd + r);
  shape.lineTo(hw, hd - r);
  shape.quadraticCurveTo(hw, hd, hw - r, hd);
  shape.lineTo(-hw + r, hd);
  shape.quadraticCurveTo(-hw, hd, -hw, hd - r);
  shape.lineTo(-hw, -hd + r);
  shape.quadraticCurveTo(-hw, -hd, -hw + r, -hd);

  const bevelSize = Math.max(0.01, Math.min(r * 0.5, height / 4));
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: height,
    bevelEnabled: true,
    bevelThickness: bevelSize,
    bevelSize,
    bevelSegments: 3,
    curveSegments: 8,
  });
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, -height / 2, 0);
  return geo;
}

const wallMaterial = THEME_MATERIALS.wallMaterial;
const collisionBoxes = []; // { minX, maxX, minZ, maxZ }
// Every wall mesh, kept separately from the scene graph in general so
// a ranged weapon's laser can be raycast against exactly (and only)
// the walls -- see rangedSightDistance further down -- without also
// hitting monsters, the weapon viewmodel, the ground, etc.
const wallMeshes = [];

function addWallBox(tileX, tileY, tileW, tileH) {
  const minX = tileX * TILE, maxX = (tileX + tileW) * TILE;
  const minZ = tileY * TILE, maxZ = (tileY + tileH) * TILE;
  const mesh = new THREE.Mesh(
    buildRoundedBoxGeometry(maxX - minX, maxZ - minZ, WALL_HEIGHT, WALL_CORNER_RADIUS),
    wallMaterial
  );
  mesh.position.set((minX + maxX) / 2, WALL_HEIGHT / 2, (minZ + maxZ) / 2);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  scene.add(mesh);
  wallMeshes.push(mesh);
  collisionBoxes.push({
    minX: minX - PLAYER_RADIUS, maxX: maxX + PLAYER_RADIUS,
    minZ: minZ - PLAYER_RADIUS, maxZ: maxZ + PLAYER_RADIUS,
  });
}

WALL_TILE_RECTS.forEach(([x, y, w, h]) => addWallBox(x, y, w, h));

function isBlockedAtWorld(x, z) {
  for (const box of collisionBoxes) {
    if (x >= box.minX && x <= box.maxX && z >= box.minZ && z <= box.maxZ) return true;
  }
  return false;
}

// ---------------------------------------------------------------
// Weapon viewmodel -- built to match whichever weapon is actually
// equipped on your real saved profile (see resolveEquippedWeapon
// further down), not a fixed placeholder. Still just simple
// primitives (no art assets yet, matching the low-poly look
// everywhere else in this prototype) -- the goal at this stage is
// that each weapon reads as a distinct, roughly-correct silhouette
// and color for its category, with the HUD label (#fpsWeaponLabel)
// there to remove any remaining ambiguity about which one it is.
// Combat, durability/rust visuals, and armor aren't wired up here
// yet -- this is purely "what's in your hand," carried over from the
// real game's Ship screen.
// ---------------------------------------------------------------
const WEAPON_ACCENTS = {
  zap_stick: 0x7dd3fc,
  junk_hammer: 0xb08968,
  ray_gun: 0x7dd3fc,
  laser_dagger: 0xf87171,
  laser_sword: 0xf87171,
  laser_tomahawk: 0xfacc15,
  laser_axe: 0xfacc15,
  laser_hammer: 0xff5c5c,
  light_laser_hammer: 0xffa94d,
  build_laser: 0x4ade80,
  crystal_lance: 0xa78bfa,
  blaster: 0xa78bfa,
  sticky_slingshot: 0xf472b6,
  candy_cannon: 0xf472b6,
};

function metalMat(color, opts = {}) {
  return new THREE.MeshStandardMaterial({ color, metalness: opts.metalness ?? 0.4, roughness: opts.roughness ?? 0.5 });
}
function glowMat(color) {
  return new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 1.4 });
}
// Every builder below sets group.userData.{baseX,baseY} to the
// resting position the animate() loop's weapon-bob reads each frame
// (see "Main loop"), and sets the group's actual position/rotation
// once here -- only x/y ever move after that, same as the original
// fixed placeholder did.
function finishViewmodel(group, baseX, baseY, baseZ) {
  group.position.set(baseX, baseY, baseZ);
  group.userData = { baseX, baseY };
  return group;
}

function buildBlasterModel(accent) {
  const group = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.13, 0.42), metalMat(0x2a2d4a));
  const grip = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.22, 0.1), metalMat(0x1c1e33, { metalness: 0.3, roughness: 0.6 }));
  grip.position.set(0, -0.15, 0.12);
  grip.rotation.x = 0.35;
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.028, 0.28, 12), metalMat(0x4a4e78, { metalness: 0.7, roughness: 0.3 }));
  barrel.rotation.x = Math.PI / 2;
  barrel.position.set(0, 0.02, -0.34);
  const tip = new THREE.Mesh(new THREE.SphereGeometry(0.035, 12, 12), glowMat(accent));
  tip.position.set(0, 0.02, -0.49);
  group.add(body, grip, barrel, tip);
  const tipLight = new THREE.PointLight(accent, 0.6, 2.5);
  tipLight.position.copy(tip.position);
  group.add(tipLight);
  group.rotation.y = -0.05;
  return finishViewmodel(group, 0.26, -0.26, -0.55);
}

function buildStickModel(accent) {
  const group = new THREE.Group();
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.022, 0.62, 10), metalMat(0x3a3d5a, { metalness: 0.3, roughness: 0.6 }));
  shaft.rotation.x = 0.55;
  shaft.position.set(0, -0.05, -0.28);
  const tip = new THREE.Mesh(new THREE.SphereGeometry(0.045, 12, 12), glowMat(accent));
  tip.position.set(0, 0.08, -0.56);
  group.add(shaft, tip);
  const tipLight = new THREE.PointLight(accent, 0.5, 2);
  tipLight.position.copy(tip.position);
  group.add(tipLight);
  return finishViewmodel(group, 0.24, -0.24, -0.5);
}

function buildLauncherModel(accent) {
  const group = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.16, 0.3), metalMat(0x2a2d4a));
  const grip = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.22, 0.1), metalMat(0x1c1e33, { metalness: 0.3, roughness: 0.6 }));
  grip.position.set(0, -0.16, 0.1);
  grip.rotation.x = 0.35;
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.24, 14), metalMat(accent, { metalness: 0.5, roughness: 0.35 }));
  barrel.rotation.x = Math.PI / 2;
  barrel.position.set(0, 0.02, -0.32);
  const tip = new THREE.Mesh(new THREE.RingGeometry(0.02, 0.058, 16), glowMat(accent));
  tip.position.set(0, 0.02, -0.45);
  group.add(body, grip, barrel, tip);
  const tipLight = new THREE.PointLight(accent, 0.6, 2.5);
  tipLight.position.copy(tip.position);
  group.add(tipLight);
  return finishViewmodel(group, 0.27, -0.27, -0.55);
}

function buildBladeModel(accent, { length = 0.5, wide = false } = {}) {
  const group = new THREE.Group();
  const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.022, 0.16, 8), metalMat(0x2a2d4a, { metalness: 0.3, roughness: 0.6 }));
  handle.position.set(0, -0.08, 0);
  const guard = new THREE.Mesh(new THREE.BoxGeometry(wide ? 0.14 : 0.09, 0.02, 0.03), metalMat(0x3a3d5a));
  const blade = new THREE.Mesh(new THREE.BoxGeometry(wide ? 0.1 : 0.045, length, 0.012), glowMat(accent));
  blade.position.set(0, length / 2 + 0.01, 0);
  group.add(handle, guard, blade);
  const glow = new THREE.PointLight(accent, 0.4, 1.6);
  glow.position.set(0, length * 0.6, 0);
  group.add(glow);
  group.rotation.set(1.1, 0, -0.15);
  group.scale.setScalar(0.75);
  return finishViewmodel(group, 0.3, -0.28, -0.58);
}

function buildAxeModel(accent, { small = false } = {}) {
  const group = new THREE.Group();
  const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.02, small ? 0.32 : 0.46, 8), metalMat(0x4a3826, { metalness: 0.1, roughness: 0.8 }));
  const head = new THREE.Mesh(new THREE.ConeGeometry(small ? 0.09 : 0.13, small ? 0.14 : 0.2, 4), glowMat(accent));
  head.rotation.z = Math.PI / 2;
  head.position.set(0, small ? 0.14 : 0.21, 0);
  group.add(handle, head);
  const glow = new THREE.PointLight(accent, 0.4, 1.6);
  glow.position.copy(head.position);
  group.add(glow);
  group.rotation.set(1.0, 0.1, -0.2);
  group.scale.setScalar(0.75);
  return finishViewmodel(group, 0.3, -0.3, -0.58);
}

function buildHammerModel(accent, { headSize = 0.16 } = {}) {
  const group = new THREE.Group();
  const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.026, 0.5, 8), metalMat(0x4a3826, { metalness: 0.1, roughness: 0.8 }));
  const head = new THREE.Mesh(new THREE.BoxGeometry(headSize, headSize * 0.75, headSize * 0.75), glowMat(accent));
  head.position.set(0, 0.27, 0);
  group.add(handle, head);
  const glow = new THREE.PointLight(accent, 0.5, 2);
  glow.position.copy(head.position);
  group.add(glow);
  group.rotation.set(1.0, 0, -0.15);
  group.scale.setScalar(0.75);
  return finishViewmodel(group, 0.3, -0.3, -0.58);
}

function buildToolModel(accent) {
  const group = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.1, 0.32), metalMat(0x2a2d4a));
  const grip = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.18, 0.09), metalMat(0x1c1e33, { metalness: 0.3, roughness: 0.6 }));
  grip.position.set(0, -0.13, 0.1);
  grip.rotation.x = 0.3;
  const dish = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.02, 16), glowMat(accent));
  dish.rotation.x = Math.PI / 2;
  dish.position.set(0, 0.04, -0.2);
  group.add(body, grip, dish);
  const glow = new THREE.PointLight(accent, 0.5, 2);
  glow.position.copy(dish.position);
  group.add(glow);
  return finishViewmodel(group, 0.26, -0.25, -0.5);
}

// Maps every real weapon id (see WEAPONS in craft.js) to the builder
// for its shape family. Anything unrecognized (shouldn't happen, but
// cheap insurance against craft.js gaining a new weapon before this
// map is updated) falls back to the blaster shape in
// buildWeaponViewmodel below.
const WEAPON_MODEL_BUILDERS = {
  zap_stick: (a) => buildStickModel(a),
  ray_gun: (a) => buildBlasterModel(a),
  blaster: (a) => buildBlasterModel(a),
  candy_cannon: (a) => buildLauncherModel(a),
  sticky_slingshot: (a) => buildLauncherModel(a),
  laser_dagger: (a) => buildBladeModel(a, { length: 0.32 }),
  laser_sword: (a) => buildBladeModel(a, { length: 0.52 }),
  crystal_lance: (a) => buildBladeModel(a, { length: 0.62 }),
  laser_tomahawk: (a) => buildAxeModel(a, { small: true }),
  laser_axe: (a) => buildAxeModel(a, { small: false }),
  junk_hammer: (a) => buildHammerModel(a, { headSize: 0.14 }),
  laser_hammer: (a) => buildHammerModel(a, { headSize: 0.22 }),
  light_laser_hammer: (a) => buildHammerModel(a, { headSize: 0.17 }),
  build_laser: (a) => buildToolModel(a),
};

function buildWeaponViewmodel(weaponDef) {
  const accent = WEAPON_ACCENTS[weaponDef.id] ?? 0x7dd3fc;
  const builder = WEAPON_MODEL_BUILDERS[weaponDef.id] || buildBlasterModel;
  return builder(accent);
}

// Start with the starter weapon so there's something in-hand
// immediately without waiting on a network round trip, then swap it
// out below once we know what's actually equipped.
let weapon = buildWeaponViewmodel(getWeapon(STARTER_WEAPON));
camera.add(weapon);
let currentWeaponModelId = STARTER_WEAPON;

// Swaps the in-hand 3D model to match whatever's currently equipped in
// craftProfile -- shared by the initial profile load (initCraftProfile
// below) and by equipping something new from the in-page weapon shop
// (see equipShopWeapon further down), so the two paths can never leave
// the viewmodel out of sync with craftProfile.equipped. A no-op if
// nothing actually changed, so it's always safe to call speculatively.
function syncWeaponViewmodel() {
  const resolved = equippedWeapon();
  if (resolved.id === currentWeaponModelId) return;
  camera.remove(weapon);
  weapon = buildWeaponViewmodel(resolved);
  camera.add(weapon);
  currentWeaponModelId = resolved.id;
}

// ---------------------------------------------------------------
// Real loadout + profile -- reads (and, once combat starts earning
// loot, writes) the same craft_profiles row the real game uses, so
// both what's in your hand and what you earn here matches your Ship
// screen. Session comes from the same Supabase client/localStorage
// session the rest of the site uses -- being logged in on the main
// site is all that's needed, there's no separate login here. If
// you're not logged in (or something goes wrong loading your
// profile), combat still works using a local starter profile that
// simply never gets saved anywhere.
// ---------------------------------------------------------------
let craftProfile = createStarterProfile();
let myUserId = null; // null = not logged in / profile not saved anywhere

function equippedWeapon() {
  return getWeapon(craftProfile.equipped) || getWeapon(STARTER_WEAPON);
}

function updateWeaponLabel(suffix) {
  const w = equippedWeapon();
  weaponLabel.textContent = suffix ? `${w.emoji} ${w.name} (${suffix})` : `${w.emoji} ${w.name}`;
}

async function initCraftProfile() {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      updateWeaponLabel('default -- log in on the main site to use your real weapon');
      return;
    }
    myUserId = session.user.id;
    const { data, error } = await supabase
      .from('craft_profiles').select('*').eq('user_id', myUserId).maybeSingle();
    if (error || !data) {
      myUserId = null; // couldn't confirm a real row -- don't risk writing to the wrong place
      updateWeaponLabel('default');
      return;
    }
    craftProfile = normalizeProfile({ ...data, equippedArmor: data.equipped_armor });
    updateWeaponLabel();
  } catch (err) {
    console.error('fps: could not load your profile', err);
    myUserId = null;
    updateWeaponLabel('default');
  }
}

// Same save shape (and the same schema.sql-not-re-run 42703 fallback)
// as room.js's saveCraftProfile, duplicated here rather than shared
// since this page deliberately stays free-standing -- see the file
// header. A no-op whenever myUserId is null (not logged in, or the
// initial load above couldn't confirm a real row), so local play never
// silently tries to write to nowhere.
let fpsSchemaWarningShown = false;
async function saveCraftProfile() {
  if (!myUserId) return;
  let { error } = await supabase
    .from('craft_profiles')
    .update({
      scrap: craftProfile.scrap,
      weapons: craftProfile.weapons,
      equipped: craftProfile.equipped,
      armors: craftProfile.armors,
      equipped_armor: craftProfile.equippedArmor,
      durability: craftProfile.durability,
      updated_at: new Date().toISOString(),
    })
    .eq('user_id', myUserId);
  if (error && error.code === '42703') {
    if (!fpsSchemaWarningShown) {
      fpsSchemaWarningShown = true;
      showCombatMsg("Loot won't be saved until schema.sql is re-run in Supabase.", '#f87171', 3000);
    }
    ({ error } = await supabase
      .from('craft_profiles')
      .update({
        scrap: craftProfile.scrap,
        weapons: craftProfile.weapons,
        equipped: craftProfile.equipped,
        updated_at: new Date().toISOString(),
      })
      .eq('user_id', myUserId));
  }
  if (error) console.error('fps: craft profile save error', error);
}

// Durability wear (currently just the Light Laser Hammer) is saved
// debounced, same reasoning as room.js's scheduleDurabilitySave: with
// no attack cooldown, a burst of swings shouldn't fire a save per hit.
let durabilitySaveTimer = null;
function scheduleDurabilitySave() {
  clearTimeout(durabilitySaveTimer);
  durabilitySaveTimer = setTimeout(saveCraftProfile, 600);
}

// ---------------------------------------------------------------
// In-page weapon shop -- lives in the settings screen (#fpsSettings)
// so you can unlock/equip a weapon without tabbing back to the main
// site's Ship screen. Mirrors buildWeaponShopList in room.js: same
// unlock rules, same scrap costs, same trait tags -- just rendered
// straight into this page's DOM instead of a modal, and it swaps the
// in-hand 3D model the moment you equip something new (see
// syncWeaponViewmodel above). The starter weapon (Zap Stick) is
// included at the top of the list even though weaponsForPlanet()
// doesn't return it (its planetId is null, same as how the 2D game
// leaves it out of every planet's shop) -- it's always owned, so it
// only ever needs an Equip button, never an Unlock one.
//
// One-line plain-English description of what each weapon/item
// actually does, for anyone deciding what to unlock or equip -- the
// short trait tags below (Faster/Slower/Dash/etc, same as room.js's
// shop) are the at-a-glance version of the same information.
// ---------------------------------------------------------------
const WEAPON_DESCRIPTIONS = {
  zap_stick: "Your starter weapon -- always available, no scrap required. Reliable, unremarkable damage.",
  junk_hammer: "A basic scrap hammer with solid damage, but it misses fairly often.",
  ray_gun: "Fires a bolt from range instead of swinging up close -- hits monsters before they can close the distance.",
  laser_dagger: "A light blade that never misses and lets you move noticeably faster while it's equipped.",
  laser_sword: "A dependable all-around blade -- good damage with only a small chance to miss.",
  laser_tomahawk: "Light and fast-moving, and lets you burst-dash a short distance twice in a row before it needs to recharge.",
  laser_axe: "A heavy axe that cuts incoming contact damage from monsters in half, at the cost of moving slower.",
  laser_hammer: "An enormous hammer that instantly defeats anything it lands on -- but it's very slow, and swings can still miss.",
  light_laser_hammer: "A lighter, faster hammer that wears out the more you swing it. Once it's rusty it needs repairing at a Fixing Table on the main site to hit at full strength again.",
  build_laser: "Not a combat weapon -- equipping it swaps your attack button over to placing barriers instead. Bring something else to fight monsters here.",
};

function weaponTraits(wpn) {
  const traits = [];
  if (wpn.speedMultiplier > 1) traits.push('⚡ Faster');
  if (wpn.speedMultiplier < 1) traits.push('🐢 Slower');
  if (wpn.grantsDash) traits.push('💨 Dash');
  if (wpn.contactDamageReduction) traits.push('🛡️ Damage resist');
  if (wpn.isBuildTool) traits.push('🔧 Builds barriers');
  if (wpn.maxDurability) traits.push('⚠️ Wears out');
  return traits;
}

function renderWeaponShop() {
  const planet = getPlanet(PLANET_ID);
  scrapCountEl.textContent = String(craftProfile.scrap[planet.scrapType] || 0);

  weaponShopEl.innerHTML = '';
  const rows = [getWeapon(STARTER_WEAPON), ...weaponsForPlanet(PLANET_ID)];
  rows.forEach((wpn) => {
    const owned = craftProfile.weapons.includes(wpn.id);
    const equipped = craftProfile.equipped === wpn.id;
    const canUnlock = !owned && canUnlockWeapon(craftProfile, wpn.id);
    const dmgLabel = wpn.isBuildTool ? 'Utility' : wpn.instaKill ? 'Insta-kill' : `${wpn.dmg[0]}–${wpn.dmg[1]} dmg`;
    const traits = weaponTraits(wpn);

    const row = document.createElement('div');
    row.className = 'weapon-shop-row' + (equipped ? ' equipped' : '');
    row.innerHTML = `
      <div class="weapon-shop-top">
        <span class="weapon-shop-icon">${wpn.emoji}</span>
        <span class="weapon-shop-name">${escapeHtml(wpn.name)}</span>
        <span class="weapon-shop-dmg">${dmgLabel}</span>
      </div>
      <div class="weapon-shop-desc">${escapeHtml(WEAPON_DESCRIPTIONS[wpn.id] || '')}</div>
      ${traits.length ? `<div class="weapon-shop-traits">${traits.join(' · ')}</div>` : ''}
    `;

    const actionBtn = document.createElement('button');
    actionBtn.type = 'button';
    actionBtn.className = 'weapon-shop-action';
    if (equipped) {
      actionBtn.textContent = 'Equipped';
      actionBtn.disabled = true;
      actionBtn.classList.add('equipped');
    } else if (owned) {
      actionBtn.textContent = 'Equip';
      actionBtn.onclick = () => equipShopWeapon(wpn.id);
    } else {
      actionBtn.textContent = `Unlock (${wpn.cost} ${planet.scrapEmoji})`;
      actionBtn.disabled = !canUnlock;
      actionBtn.onclick = () => unlockShopWeapon(wpn.id);
    }
    row.appendChild(actionBtn);
    weaponShopEl.appendChild(row);
  });
}

function unlockShopWeapon(weaponId) {
  if (!canUnlockWeapon(craftProfile, weaponId)) return;
  craftProfile = unlockWeapon(craftProfile, weaponId);
  saveCraftProfile();
  renderWeaponShop();
}

function equipShopWeapon(weaponId) {
  if (!craftProfile.weapons.includes(weaponId)) return;
  craftProfile = equipWeapon(craftProfile, weaponId);
  saveCraftProfile();
  updateWeaponLabel();
  syncWeaponViewmodel();
  renderWeaponShop();
}

// Draw the shop right away with the local starter profile so it's
// never empty while initCraftProfile's network round trip is in
// flight, then again once your real profile (or lack of one, if
// you're not logged in) is known.
renderWeaponShop();

initCraftProfile().then(() => {
  syncWeaponViewmodel();
  renderWeaponShop();
});

// ---------------------------------------------------------------
// Player spawn -- converts the current planet's pixel spawn point
// into a tile coordinate (independent of TILE, the 3D scale chosen
// above). MAP.playerSpawn comes straight from craft.js's PLANET_MAPS
// for all three planets, so this always matches the 2D game's own
// spawn point for whichever planet is loaded.
// ---------------------------------------------------------------
const spawnCol = MAP.playerSpawn.x / RUSTBELT_TILE_SIZE;
const spawnRow = MAP.playerSpawn.y / RUSTBELT_TILE_SIZE;
camera.position.set(
  spawnCol * TILE,
  terrainHeightAt(spawnCol * TILE, spawnRow * TILE) + EYE_HEIGHT,
  spawnRow * TILE
);

// ---------------------------------------------------------------
// Monsters / combat -- the same two Rustbelt Moon monsters, fixed
// spawn points, and damage/loot math as the 2D game (see craft.js),
// just simulated locally on this page instead of through the 2D
// game's shared realtime craft_world_enemies table -- see the file
// header for why. Positions convert from the 2D game's pixel spawn
// points the same way the player spawn above does, so both versions
// place monsters in the same spots on the map.
//
// Melee/ranged "reach" and "width" reuse craft.js's exact ATTACK_REACH/
// ATTACK_WIDTH/CONTACT_DAMAGE_RANGE constants, scaled down by the same
// TILE-vs-RUSTBELT_TILE_SIZE ratio used for spawn positions, so combat
// range feels proportionally the same here as in the 2D game rather
// than being re-tuned from scratch. Ranged weapons (Ray Gun, Blaster,
// Sticky Slingshot, Candy Cannon) hit instantly along your aim instead
// of firing a travelling projectile -- a deliberate simplification for
// this first combat pass -- but their actual REACH isn't a fixed
// number: rangedSightDistance (below) raycasts along your aim against
// the walls, so a ranged shot travels exactly as far as you can
// actually see down that line before something solid blocks it,
// rather than fizzling out at an arbitrary short distance the way a
// melee swing does.
// ---------------------------------------------------------------
const FPS_SCALE = TILE / RUSTBELT_TILE_SIZE;
const MELEE_REACH_3D = (ATTACK_REACH + MONSTER_HALF_SIZE) * FPS_SCALE;
const ATTACK_WIDTH_3D = ATTACK_WIDTH * FPS_SCALE;
// Safety fallback only -- the map is fully enclosed by border walls
// (see addWallBox above), so a raycast from anywhere inside it should
// always hit one well before this; this just guarantees a ranged
// attack can never come back with an infinite/undefined reach if that
// ever somehow isn't true. Matches the camera's own far clipping
// plane, i.e. literally as far as the eye (the renderer) can ever see.
const RANGED_MAX_FALLBACK_REACH = 500;
const CONTACT_RANGE_3D = CONTACT_DAMAGE_RANGE * FPS_SCALE;

const CURRENT_PLANET = getPlanet(PLANET_ID);
const MONSTER_DEFS = Object.fromEntries(CURRENT_PLANET.monsters.map((m) => [m.id, m]));

function buildEmojiSprite(emoji, size) {
  const cv = document.createElement('canvas');
  cv.width = 128; cv.height = 128;
  const ctx = cv.getContext('2d');
  ctx.font = '92px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(emoji, 64, 70);
  const tex = new THREE.CanvasTexture(cv);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true }));
  sprite.scale.set(size, size, 1);
  return sprite;
}

function buildHealthBarTexture(fraction) {
  const cv = document.createElement('canvas');
  cv.width = 128; cv.height = 20;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = 'rgba(10,10,20,0.75)';
  ctx.fillRect(0, 0, 128, 20);
  ctx.fillStyle = fraction > 0.4 ? '#4ade80' : '#f87171';
  ctx.fillRect(3, 3, Math.max(0, (128 - 6) * fraction), 14);
  return new THREE.CanvasTexture(cv);
}

// A THREE.Sprite always faces the camera on its own (that's what makes
// it a sprite rather than a mesh), so the monster's emoji "face" and
// its health bar both stay readable from any angle with no manual
// billboarding needed.
function buildMonsterView(def) {
  const group = new THREE.Group();

  const shadow = new THREE.Mesh(
    new THREE.CircleGeometry(0.55, 16),
    new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.35 })
  );
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 0.02;
  group.add(shadow);

  const bodySprite = buildEmojiSprite(def.emoji, 1.15);
  bodySprite.position.y = 0.95;
  group.add(bodySprite);

  const healthSprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: buildHealthBarTexture(1), transparent: true, depthTest: false,
  }));
  healthSprite.scale.set(0.75, 0.12, 1);
  healthSprite.position.y = 1.62;
  group.add(healthSprite);

  return { group, bodySprite, healthSprite };
}

function updateMonsterHealthBar(monster) {
  const fraction = Math.max(0, monster.hp / monster.maxHp);
  const oldMap = monster.healthSprite.material.map;
  monster.healthSprite.material.map = buildHealthBarTexture(fraction);
  monster.healthSprite.material.needsUpdate = true;
  if (oldMap) oldMap.dispose();
}

function createMonster(spawn, idx) {
  const def = MONSTER_DEFS[spawn.monsterId];
  const worldX = (spawn.x / RUSTBELT_TILE_SIZE) * TILE;
  const worldZ = (spawn.y / RUSTBELT_TILE_SIZE) * TILE;
  const view = buildMonsterView(def);
  view.group.position.set(worldX, terrainHeightAt(worldX, worldZ), worldZ);
  scene.add(view.group);
  return { id: spawn.id, def, hp: def.hp, maxHp: def.hp, alive: true, worldX, worldZ, idx, ...view };
}

const monsters = MAP.spawns.map((spawn, idx) => createMonster(spawn, idx));

function reviveMonster(monster) {
  monster.hp = monster.maxHp;
  monster.alive = true;
  monster.group.visible = true;
  updateMonsterHealthBar(monster);
}

function killMonster(monster) {
  monster.alive = false;
  monster.group.visible = false;
  const loot = rollKillLoot(CURRENT_PLANET, monster.def);
  craftProfile = addScrap(craftProfile, loot.scrapType, loot.amount);
  saveCraftProfile();
  showCombatMsg(`Defeated ${monster.def.name}! +${loot.amount} ${CURRENT_PLANET.scrapEmoji}`, '#4ade80', 1800);
  setTimeout(() => reviveMonster(monster), MONSTER_RESPAWN_SECONDS * 1000);
}

// ---------------------------------------------------------------
// Player health / combat HUD
// ---------------------------------------------------------------
let playerHp = STARTER_HP;
const PLAYER_MAX_HP = STARTER_HP;
let playerInvulnerableUntil = 0;
let knockedOut = false;

function updateHealthHud() {
  healthHud.textContent = `❤️ ${Math.max(0, playerHp)}/${PLAYER_MAX_HP}`;
}
updateHealthHud();

let combatMsgTimer = null;
function showCombatMsg(text, color, duration = 1300) {
  combatMsgEl.textContent = text;
  combatMsgEl.style.color = color || '#e8eaf6';
  combatMsgEl.classList.add('show');
  clearTimeout(combatMsgTimer);
  combatMsgTimer = setTimeout(() => combatMsgEl.classList.remove('show'), duration);
}

let crosshairFlashTimer = null;
function flashCrosshair() {
  crosshair.classList.add('hit');
  clearTimeout(crosshairFlashTimer);
  crosshairFlashTimer = setTimeout(() => crosshair.classList.remove('hit'), 120);
}

// Full-screen red flash whenever the player takes damage (see
// #fpsDamageFlash in fps.html for the element/z-index reasoning).
// Snaps opacity to 1 with transitions disabled, forces a reflow so
// the browser "locks in" that starting state, then re-enables a 1s
// transition and drops opacity back to 0 -- the reflow is what makes
// a SECOND hit mid-fade restart cleanly from solid red instead of
// wherever the fade currently was (without it, the browser can coalesce
// the opacity:1 and opacity:0 style writes into a single frame and the
// flash never visibly happens).
function flashDamage() {
  damageFlash.style.transition = 'none';
  damageFlash.style.opacity = '1';
  void damageFlash.offsetWidth; // force reflow
  damageFlash.style.transition = 'opacity 1s ease-out';
  damageFlash.style.opacity = '0';
}

function knockoutPlayer() {
  if (knockedOut) return;
  knockedOut = true;
  knockoutOverlay.style.display = 'flex';
  setTimeout(() => {
    playerHp = PLAYER_MAX_HP;
    camera.position.set(
      spawnCol * TILE,
      terrainHeightAt(spawnCol * TILE, spawnRow * TILE) + EYE_HEIGHT,
      spawnRow * TILE
    );
    playerInvulnerableUntil = Date.now() + PLAYER_HIT_COOLDOWN_MS;
    updateHealthHud();
    knockedOut = false;
    knockoutOverlay.style.display = 'none';
  }, 2000);
}

// ---------------------------------------------------------------
// Ranged-weapon line of sight -- how far a shot can actually travel
// before something solid stops it. Raycasts from the camera along the
// aim direction against every wall mesh (border + obstacles, see
// addWallBox above) and returns the distance to the nearest one, so a
// ranged weapon's reach is "as far as you can see in a straight line,"
// not a fixed short number -- unlike a melee swing, which only ever
// needs to reach a few feet and so never bothers checking walls at
// all. A single reusable Raycaster instance avoids allocating a new
// one on every single shot.
// ---------------------------------------------------------------
const rangedRaycaster = new THREE.Raycaster();
function rangedSightDistance(dir) {
  rangedRaycaster.set(camera.position, dir);
  rangedRaycaster.far = RANGED_MAX_FALLBACK_REACH;
  const hits = rangedRaycaster.intersectObjects(wallMeshes, false);
  return hits.length ? hits[0].distance : RANGED_MAX_FALLBACK_REACH;
}

// ---------------------------------------------------------------
// Ranged-weapon laser bolts -- purely cosmetic. Damage is still
// resolved instantly the moment attack() below is called (see the
// "Ranged weapons ... hit instantly along your aim" note further up
// -- this file still doesn't have true travel-time hit detection),
// but firing the Ray Gun with nothing visibly leaving the barrel
// never read as a "laser," so this layers a fast glowing bolt on top
// that flies from the gun's muzzle out to wherever the beam actually
// reached (the nearest monster it hit, or the wall/border that
// stopped it if nothing was in the way) and disappears once it
// arrives.
// ---------------------------------------------------------------
// world units/sec -- fast enough that even a shot down the map's
// longest possible sightline (~160 units, corner to corner) arrives
// in well under half a second. Damage is still applied the instant
// you fire (see attack() below), so the bolt's travel time is purely
// visual -- keeping it fast is what stops a long-range shot from
// looking laggy/desynced from the health bar it already changed.
const LASER_BOLT_SPEED = 700;
const LASER_BOLT_LENGTH = 0.5;
const LASER_BOLT_RADIUS = 0.035;
const activeLaserBolts = [];

// Approximates buildBlasterModel's muzzle tip (local (0, 0.02, -0.49),
// see WEAPON_MODEL_BUILDERS above) -- close enough for every ranged
// weapon here since buildBlasterModel is both what the Ray Gun
// actually uses AND this file's fallback shape for any weapon id it
// doesn't otherwise recognize.
const LASER_MUZZLE_LOCAL = new THREE.Vector3(0, 0.02, -0.5);

function spawnLaserBolt(dir, travelDistance, color) {
  camera.updateMatrixWorld(); // weapon is a child of camera -- make sure its world transform is current before reading from it
  const origin = weapon.localToWorld(LASER_MUZZLE_LOCAL.clone());

  // Pivoted at its trailing end (not its center) so that moving
  // mesh.position along `dir` each frame sweeps the whole cylinder
  // forward as a fixed-length streak, rather than stretching/shrinking
  // it -- see updateLaserBolts below.
  const geo = new THREE.CylinderGeometry(LASER_BOLT_RADIUS, LASER_BOLT_RADIUS, LASER_BOLT_LENGTH, 6, 1, true);
  geo.translate(0, LASER_BOLT_LENGTH / 2, 0);
  const mat = new THREE.MeshBasicMaterial({
    color, transparent: true, opacity: 0.9,
    blending: THREE.AdditiveBlending, depthWrite: false, // additive + unlit so it reads as a bright glowing beam rather than a flat-shaded rod
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
  mesh.position.copy(origin);
  scene.add(mesh);

  activeLaserBolts.push({
    mesh, origin: origin.clone(), dir: dir.clone(), traveled: 0,
    maxDistance: Math.max(travelDistance, LASER_BOLT_LENGTH),
  });
}

// Advances every in-flight bolt by this frame's delta and removes any
// that have reached their target -- called from animate() below every
// frame regardless of isPlaying(), same as the monster idle bob, so a
// bolt already in the air finishes its flight smoothly even if Esc is
// hit the instant after firing.
function updateLaserBolts(delta) {
  for (let i = activeLaserBolts.length - 1; i >= 0; i--) {
    const bolt = activeLaserBolts[i];
    bolt.traveled += LASER_BOLT_SPEED * delta;
    if (bolt.traveled >= bolt.maxDistance) {
      scene.remove(bolt.mesh);
      bolt.mesh.geometry.dispose();
      bolt.mesh.material.dispose();
      activeLaserBolts.splice(i, 1);
      continue;
    }
    bolt.mesh.position.copy(bolt.origin).addScaledVector(bolt.dir, bolt.traveled);
  }
}

// A melee swing: reuses craft.js's pointInAttackHitbox (a plain
// rotated-rectangle test, dimensionless, so it works fine at this
// page's 3D scale even though craft.js itself only ever calls it in
// 2D-pixel space) aimed along the camera's current look direction, at
// the short fixed MELEE_REACH_3D. Same as the 2D game's melee swing,
// a single attack can hit every monster within the cone at once, not
// just the closest one -- walls are never checked since the reach is
// only a few feet, far too short to realistically be swinging through
// one anyway.
function meleeAttack(weaponDef, aimAngle, durability) {
  const hitbox = {
    x: camera.position.x, y: camera.position.z, angle: aimAngle,
    reach: MELEE_REACH_3D, width: ATTACK_WIDTH_3D,
  };
  monsters.forEach((monster) => {
    if (!monster.alive) return;
    if (!pointInAttackHitbox(monster.worldX, monster.worldZ, hitbox)) return;
    const dmg = rollWeaponDamage(weaponDef, durability);
    if (dmg <= 0) {
      showCombatMsg('Miss!', '#8b8fb3');
      return;
    }
    flashCrosshair();
    monster.hp = Math.max(0, monster.hp - dmg);
    updateMonsterHealthBar(monster);
    if (monster.hp <= 0) {
      killMonster(monster);
    } else {
      showCombatMsg(`Hit ${monster.def.name} for ${dmg}`, '#facc15');
    }
  });
}

// A ranged shot: a true single-target hitscan, unlike the melee
// cone's "hit everything in range" -- it travels in a straight line
// as far as rangedSightDistance says the wall behind everything lets
// it (see that function above), and stops at whichever comes first:
// that wall, or the NEAREST living monster still inside the aim cone
// before it. Only that one monster takes damage, same as a real laser
// beam would stop at the first solid thing it touches rather than
// punching through it to hit something farther away.
function rangedAttack(weaponDef, dir, aimAngle, durability) {
  const sightDistance = rangedSightDistance(dir);
  const hitbox = {
    x: camera.position.x, y: camera.position.z, angle: aimAngle,
    reach: sightDistance, width: ATTACK_WIDTH_3D,
  };

  let nearestMonster = null;
  let nearestDist = null;
  monsters.forEach((monster) => {
    if (!monster.alive) return;
    if (!pointInAttackHitbox(monster.worldX, monster.worldZ, hitbox)) return;
    const distToMonster = Math.hypot(monster.worldX - camera.position.x, monster.worldZ - camera.position.z);
    if (nearestDist === null || distToMonster < nearestDist) {
      nearestDist = distToMonster;
      nearestMonster = monster;
    }
  });

  if (nearestMonster) {
    const dmg = rollWeaponDamage(weaponDef, durability);
    if (dmg <= 0) {
      showCombatMsg('Miss!', '#8b8fb3');
    } else {
      flashCrosshair();
      nearestMonster.hp = Math.max(0, nearestMonster.hp - dmg);
      updateMonsterHealthBar(nearestMonster);
      if (nearestMonster.hp <= 0) {
        killMonster(nearestMonster);
      } else {
        showCombatMsg(`Hit ${nearestMonster.def.name} for ${dmg}`, '#facc15');
      }
    }
  }

  const accent = WEAPON_ACCENTS[weaponDef.id] ?? 0x7dd3fc;
  spawnLaserBolt(dir, nearestMonster ? nearestDist : sightDistance, accent);
}

// One attack with whatever's currently equipped -- dispatches to
// meleeAttack or rangedAttack above depending on the weapon.
let attackCallCount = 0; // test-only instrumentation, harmless in real play -- see window.__fpsDebug.getAttackCallCount below
function attack() {
  attackCallCount++;
  if (knockedOut) return;
  const weaponDef = equippedWeapon();
  if (weaponDef.isBuildTool) {
    showCombatMsg("The Build Laser can't fight here -- equip a weapon on your Ship screen.", '#facc15');
    return;
  }

  const dir = new THREE.Vector3();
  camera.getWorldDirection(dir);
  const aimAngle = Math.atan2(dir.z, dir.x);
  const durability = getWeaponDurability(craftProfile, weaponDef.id);

  if (weaponDef.ranged) {
    rangedAttack(weaponDef, dir, aimAngle, durability);
  } else {
    meleeAttack(weaponDef, aimAngle, durability);
  }

  // Wear happens once per swing regardless of what it hit (or missed
  // entirely), same as the 2D game -- a no-op for every weapon except
  // the Light Laser Hammer.
  if (weaponDef.maxDurability) {
    craftProfile = applyWeaponWear(craftProfile, weaponDef.id);
    scheduleDurabilitySave();
  }
}

document.addEventListener('mousedown', (e) => {
  if (e.button !== 0 || !isPlaying()) return;
  attack();
});

// A monster within CONTACT_RANGE_3D of the player deals contact
// damage, same rule as the 2D game -- checked every frame from
// animate() below while unlocked/knocked-out isn't in effect.
// PLAYER_HIT_COOLDOWN_MS of invulnerability after a hit stops a
// single stationary monster from melting the player in one frame's
// worth of overlap.
function applyContactDamage(now) {
  if (now < playerInvulnerableUntil) return;
  const weapon = equippedWeapon();
  const equippedArmor = craftProfile.equippedArmor ? getArmor(craftProfile.equippedArmor) : null;
  for (const monster of monsters) {
    if (!monster.alive) continue;
    const dx = camera.position.x - monster.worldX;
    const dz = camera.position.z - monster.worldZ;
    if (Math.hypot(dx, dz) > CONTACT_RANGE_3D) continue;
    let dmg = rollMonsterContactDamage(monster.def);
    if (weapon.contactDamageReduction) dmg *= (1 - weapon.contactDamageReduction);
    if (equippedArmor?.contactDamageReduction) dmg *= (1 - equippedArmor.contactDamageReduction);
    dmg = Math.max(1, Math.round(dmg));
    playerHp = Math.max(0, playerHp - dmg);
    playerInvulnerableUntil = now + PLAYER_HIT_COOLDOWN_MS;
    updateHealthHud();
    flashDamage();
    showCombatMsg(`-${dmg} from ${monster.def.name}`, '#fb7185');
    if (playerHp <= 0) knockoutPlayer();
    break; // at most one contact hit per frame, same as the 2D game
  }
}

// ---------------------------------------------------------------
// Input -- split on purpose, per how this desktop control scheme was
// requested: the ARROW KEYS are the only thing that walks the player
// from place to place; WASD instead turns the camera/crosshair (the
// same way the mouse does, and both work at the same time), rather
// than WASD being movement like a typical FPS. Mobile isn't handled
// in this prototype yet, so this split is desktop-only for now.
// ---------------------------------------------------------------
const moveKeys = { forward: false, back: false, left: false, right: false };
const lookKeys = { up: false, down: false, left: false, right: false };
// `let`, not `const` -- swapped as a whole object when the control
// scheme changes (see applyControlScheme below), rather than mutated
// in place, so there's never a half-old/half-new mapping mid-swap.
let MOVE_KEY_MAP = CONTROL_SCHEMES[controlScheme].move;
let LOOK_KEY_MAP = CONTROL_SCHEMES[controlScheme].look;
// Radians/sec while a look key is held -- roughly comparable to a
// brisk mouse turn, so WASD-look and mouse-look feel like two ways of
// doing the same thing rather than one being a poor substitute.
const KEY_LOOK_SPEED = 2.2;
// Same pitch limits PointerLockControls itself defaults to (0..PI),
// expressed the way its internal Euler stores pitch, so keyboard-look
// can't crank the camera past straight up/down any more than the
// mouse can.
const LOOK_PITCH_LIMIT = Math.PI / 2 - 0.01;

// Swaps which key set moves vs. looks. Resets every key's held state
// to false on switch -- otherwise a key held down at the moment of the
// swap (e.g. holding W to look, then switching schemes) would get
// "stuck" pressed under its new meaning since keydown/keyup only fire
// on actual key transitions, not on scheme changes.
function applyControlScheme(scheme) {
  controlScheme = scheme;
  MOVE_KEY_MAP = CONTROL_SCHEMES[scheme].move;
  LOOK_KEY_MAP = CONTROL_SCHEMES[scheme].look;
  moveKeys.forward = moveKeys.back = moveKeys.left = moveKeys.right = false;
  lookKeys.up = lookKeys.down = lookKeys.left = lookKeys.right = false;
  updateControlsHint();
  try { localStorage.setItem(CONTROL_SCHEME_STORAGE_KEY, scheme); } catch (err) { /* ignore */ }
}
schemeArrowsMoveRadio.addEventListener('change', () => {
  if (schemeArrowsMoveRadio.checked) applyControlScheme('arrows-move');
});
schemeWasdMoveRadio.addEventListener('change', () => {
  if (schemeWasdMoveRadio.checked) applyControlScheme('wasd-move');
});

window.addEventListener('keydown', (e) => {
  if (MOVE_KEY_MAP[e.code]) moveKeys[MOVE_KEY_MAP[e.code]] = true;
  if (LOOK_KEY_MAP[e.code]) lookKeys[LOOK_KEY_MAP[e.code]] = true;
  // Space attacks alongside left-click, same as the 2D game's Space
  // key -- no repeat-guard, so holding it down auto-repeats into a
  // rapid-fire swing exactly like holding it does in the 2D roam world.
  if (e.code === 'Space' && isPlaying()) {
    e.preventDefault();
    attack();
  }
});
window.addEventListener('keyup', (e) => {
  if (MOVE_KEY_MAP[e.code]) moveKeys[MOVE_KEY_MAP[e.code]] = false;
  if (LOOK_KEY_MAP[e.code]) lookKeys[LOOK_KEY_MAP[e.code]] = false;
});

// Rotates the camera the same way PointerLockControls' own mouse
// handler does (a YXZ Euler, so yaw/pitch stay well-defined regardless
// of how mouse-look and key-look interleave frame to frame) -- this is
// what lets WASD and the mouse both drive looking without fighting
// each other or accumulating drift.
const _lookEuler = new THREE.Euler(0, 0, 0, 'YXZ');
function applyKeyboardLook(delta) {
  if (!lookKeys.up && !lookKeys.down && !lookKeys.left && !lookKeys.right) return;
  _lookEuler.setFromQuaternion(camera.quaternion);
  const turn = KEY_LOOK_SPEED * lookSensitivity * delta;
  if (lookKeys.left) _lookEuler.y += turn;
  if (lookKeys.right) _lookEuler.y -= turn;
  if (lookKeys.up) _lookEuler.x += turn;
  if (lookKeys.down) _lookEuler.x -= turn;
  _lookEuler.x = Math.max(-LOOK_PITCH_LIMIT, Math.min(LOOK_PITCH_LIMIT, _lookEuler.x));
  camera.quaternion.setFromEuler(_lookEuler);
}

// Moves along one axis at a time and reverts that single move if it
// would end up inside a wall -- simple, and (since forward/back and
// left/right are handled as separate calls) already gives a "slide
// along the wall" feel for the common case of walking into a wall
// at an angle, without needing full swept/vector collision yet.
function resolveStep(moveFn, distance) {
  const before = camera.position.x, beforeZ = camera.position.z;
  moveFn(distance);
  if (isBlockedAtWorld(camera.position.x, camera.position.z)) {
    camera.position.x = before;
    camera.position.z = beforeZ;
  }
}

// ---------------------------------------------------------------
// Touch input -- Roblox-mobile-style: a floating joystick to walk, drag
// anywhere else on screen to look around, and a dedicated button to
// attack. Three separate screen zones (see fps.html/CSS) share the
// touch surface without stealing each other's fingers: #fpsJoystickZone
// and #fpsAttackBtn sit ABOVE #fpsTouchLookZone in z-index but only
// cover their own corner of the screen, so a touch that starts on
// either of them hits that element first (normal DOM hit-testing --
// whichever element is topmost at that pixel), while everything else
// falls through to the full-screen look zone underneath. Each zone
// tracks its own pointerId, so a thumb on the joystick and a second
// finger dragging to look work at the same time, same as a real mobile
// shooter.
//
// This reuses the exact same underlying movement/look machinery as
// keyboard+mouse (controls.moveForward/moveRight for movement, the same
// YXZ Euler as applyKeyboardLook for looking) rather than a parallel
// implementation -- PointerLockControls' move methods don't care
// whether pointer lock is actually active (see their source), so
// there's nothing mobile-specific about how movement/looking are
// actually applied, only about what drives them.
// ---------------------------------------------------------------
const JOYSTICK_MAX_RADIUS = 54; // px -- matches .joystick-base's visual radius in fps.html
let joystickPointerId = null;
let joystickCenter = { x: 0, y: 0 };
// x = strafe (-1..1, right positive), y = forward (-1..1, forward
// positive) -- analog, so a light push moves slower than a full push,
// unlike the keyboard's all-or-nothing keys.
const joystickVec = { x: 0, y: 0 };

function resetJoystick() {
  joystickPointerId = null;
  joystickVec.x = 0;
  joystickVec.y = 0;
  joystickZone.classList.remove('active');
}

function updateJoystickKnob(dx, dy) {
  joystickKnob.style.left = `${joystickCenter.x + dx}px`;
  joystickKnob.style.top = `${joystickCenter.y + dy}px`;
}

joystickZone.addEventListener('pointerdown', (e) => {
  // Only one thumb drives the joystick at a time -- a second touch
  // starting inside the same zone while it's already active is ignored
  // rather than stealing control from the first.
  if (!isPlaying() || joystickPointerId !== null) return;
  joystickPointerId = e.pointerId;
  joystickCenter = { x: e.clientX, y: e.clientY };
  joystickBase.style.left = `${joystickCenter.x}px`;
  joystickBase.style.top = `${joystickCenter.y}px`;
  updateJoystickKnob(0, 0);
  joystickZone.classList.add('active');
  // setPointerCapture keeps this same pointer's move/up events routed
  // here even if a thumb slides outside the zone's bounds mid-drag.
  // Wrapped defensively -- in principle the pointer that just fired
  // this pointerdown is always "active" and this can't fail, but
  // there's no upside to letting a capture edge case throw and skip
  // the rest of this handler.
  try { joystickZone.setPointerCapture(e.pointerId); } catch {}
});
joystickZone.addEventListener('pointermove', (e) => {
  if (e.pointerId !== joystickPointerId) return;
  let dx = e.clientX - joystickCenter.x;
  let dy = e.clientY - joystickCenter.y;
  const dist = Math.hypot(dx, dy);
  if (dist > JOYSTICK_MAX_RADIUS) {
    dx = (dx / dist) * JOYSTICK_MAX_RADIUS;
    dy = (dy / dist) * JOYSTICK_MAX_RADIUS;
  }
  updateJoystickKnob(dx, dy);
  joystickVec.x = dx / JOYSTICK_MAX_RADIUS;
  joystickVec.y = -dy / JOYSTICK_MAX_RADIUS; // screen up (negative dy) = forward
});
function endJoystickTouch(e) {
  if (e.pointerId !== joystickPointerId) return;
  resetJoystick();
}
joystickZone.addEventListener('pointerup', endJoystickTouch);
joystickZone.addEventListener('pointercancel', endJoystickTouch);

// Drag-to-look -- same YXZ Euler approach as applyKeyboardLook (see
// there for why YXZ specifically), driven by the finger's frame-to-frame
// movement instead of a held key's fixed turn speed. TOUCH_LOOK_SPEED is
// tuned so the default sensitivity (1.0x) feels similarly brisk to a
// typical mouse-look, not a literal unit conversion of anything.
// Pulled out into its own function (rather than inlined in
// touchLookZone's pointermove below) because the attack button's own
// touch handling further down reuses this exact same math -- see the
// comment there for why.
let lastLookX = 0, lastLookY = 0;
const TOUCH_LOOK_SPEED = 0.0026;

function applyTouchLookDelta(dx, dy) {
  _lookEuler.setFromQuaternion(camera.quaternion);
  _lookEuler.y -= dx * TOUCH_LOOK_SPEED * lookSensitivity;
  _lookEuler.x -= dy * TOUCH_LOOK_SPEED * lookSensitivity;
  _lookEuler.x = Math.max(-LOOK_PITCH_LIMIT, Math.min(LOOK_PITCH_LIMIT, _lookEuler.x));
  camera.quaternion.setFromEuler(_lookEuler);
}

let lookPointerId = null;

function resetTouchLook() {
  lookPointerId = null;
}

touchLookZone.addEventListener('pointerdown', (e) => {
  if (!isPlaying() || lookPointerId !== null) return;
  lookPointerId = e.pointerId;
  lastLookX = e.clientX;
  lastLookY = e.clientY;
  try { touchLookZone.setPointerCapture(e.pointerId); } catch {}
});
touchLookZone.addEventListener('pointermove', (e) => {
  if (e.pointerId !== lookPointerId) return;
  const dx = e.clientX - lastLookX;
  const dy = e.clientY - lastLookY;
  lastLookX = e.clientX;
  lastLookY = e.clientY;
  applyTouchLookDelta(dx, dy);
});
function endLookTouch(e) {
  if (e.pointerId !== lookPointerId) return;
  resetTouchLook();
}
touchLookZone.addEventListener('pointerup', endLookTouch);
touchLookZone.addEventListener('pointercancel', endLookTouch);

// Attack button -- fires once immediately on tap, then keeps firing on
// an interval while held, mirroring how holding the desktop Space key
// auto-repeats into a rapid-fire swing (see the keydown handler above).
//
// It ALSO doubles as a look-drag surface while held, using the exact
// same applyTouchLookDelta math as touchLookZone above: the same
// finger that's holding the button down to keep attacking can slide
// anywhere on screen to adjust aim, instead of being stuck attacking
// in a fixed direction until it lifts off. setPointerCapture is what
// makes this actually work -- once set on pointerdown, every later
// event for that exact touch (move/up/cancel) keeps targeting
// attackBtn no matter where the finger physically drags to next,
// rather than the browser handing move events over to whatever
// element happens to be underneath it at the new position (which,
// without capture, would just be touchLookZone -- but one that never
// saw a pointerdown of its own, so its own drag-to-look handler above
// would never activate for this touch at all).
//
// This also means the button no longer stops firing just because the
// finger slides outside its visual circle (there's deliberately no
// pointerleave listener here anymore) -- same "keep going until you
// actually lift off" behavior as holding the desktop Space key.
let attackAimPointerId = null;
let lastAttackAimX = 0, lastAttackAimY = 0;
let attackRepeatTimer = null;
function stopAttackRepeat() {
  clearInterval(attackRepeatTimer);
  attackRepeatTimer = null;
}
attackBtn.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  if (!isPlaying()) return;
  attack();
  stopAttackRepeat();
  attackRepeatTimer = setInterval(attack, 350);
  attackAimPointerId = e.pointerId;
  lastAttackAimX = e.clientX;
  lastAttackAimY = e.clientY;
  try { attackBtn.setPointerCapture(e.pointerId); } catch {}
});
attackBtn.addEventListener('pointermove', (e) => {
  if (e.pointerId !== attackAimPointerId) return;
  const dx = e.clientX - lastAttackAimX;
  const dy = e.clientY - lastAttackAimY;
  lastAttackAimX = e.clientX;
  lastAttackAimY = e.clientY;
  applyTouchLookDelta(dx, dy);
});
function endAttackHold(e) {
  if (e.pointerId !== attackAimPointerId) return;
  attackAimPointerId = null;
  stopAttackRepeat();
}
attackBtn.addEventListener('pointerup', endAttackHold);
attackBtn.addEventListener('pointercancel', endAttackHold);

// ---------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------
const clock = new THREE.Clock();

function animate() {
  requestAnimationFrame(animate);
  const delta = Math.min(clock.getDelta(), 0.1);
  const time = clock.getElapsedTime();

  let moving = false;
  // Frozen entirely (no look, no movement, no contact damage) during
  // the brief knockout pause -- knockoutPlayer() below already
  // teleports the player back to spawn and clears knockedOut once it
  // ends, so there's nothing to advance here in the meantime.
  if (isPlaying() && !knockedOut) {
    applyKeyboardLook(delta);
    const step = MOVE_SPEED * delta;
    if (moveKeys.forward) { resolveStep((d) => controls.moveForward(d), step); moving = true; }
    if (moveKeys.back) { resolveStep((d) => controls.moveForward(d), -step); moving = true; }
    if (moveKeys.right) { resolveStep((d) => controls.moveRight(d), step); moving = true; }
    if (moveKeys.left) { resolveStep((d) => controls.moveRight(d), -step); moving = true; }
    // Roblox-style mobile joystick: joystickVec.y is forward/back
    // (screen-up drag = positive = forward), joystickVec.x is
    // strafe left/right, both already normalized to [-1, 1] by
    // pointermove above. Scaled by the same per-frame `step` as the
    // keyboard so joystick and keyboard movement feel identical.
    if (joystickVec.x || joystickVec.y) {
      resolveStep((d) => controls.moveForward(d), joystickVec.y * step);
      resolveStep((d) => controls.moveRight(d), joystickVec.x * step);
      moving = true;
    }
    // Keep the eye height fixed -- there's no jumping or falling in
    // this prototype yet, same as the 2D roam world it's modeled on.
    camera.position.y = terrainHeightAt(camera.position.x, camera.position.z) + EYE_HEIGHT;
    applyContactDamage(Date.now());
  }

  // Slow cosmetic rotation for the Earth globe hanging in the sky.
  earth.rotation.y += delta * 0.01;

  // Slow in-plane spin for galaxies and black-hole accretion disks --
  // a Sprite always faces the camera, but its material.rotation still
  // rotates the flat texture within that facing plane, so this reads
  // as the galaxy/disk itself turning rather than the camera moving.
  deepSkySpinners.forEach(({ sprite, speed }) => {
    sprite.material.rotation += delta * speed;
  });

  // Idle bob for every living monster, purely cosmetic -- each one
  // offset by its spawn index so a cluster of them doesn't bob in
  // lockstep.
  monsters.forEach((monster) => {
    if (!monster.alive) return;
    monster.bodySprite.position.y = 0.95 + Math.sin(time * 2 + monster.idx) * 0.05;
  });

  // Weapon bob -- quicker/larger while walking, a slow idle sway at rest.
  // Reads the current viewmodel's own resting position (see
  // finishViewmodel above) rather than a fixed offset, since swapping
  // to a real equipped weapon can swap in a differently-shaped/sized
  // model at any time.
  const bobSpeed = moving ? 9 : 1.4;
  const bobAmount = moving ? 0.018 : 0.005;
  const baseX = weapon.userData.baseX ?? 0.26;
  const baseY = weapon.userData.baseY ?? -0.26;
  weapon.position.y = baseY + Math.sin(time * bobSpeed) * bobAmount;
  weapon.position.x = baseX + Math.cos(time * bobSpeed * 0.5) * bobAmount * 0.6;

  updateLaserBolts(delta);

  renderer.render(scene, camera);
}
animate();

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// Test-only debug hook -- entirely inert unless a test harness sets
// window.__FPS_TEST__ = true before this module loads. Never touched
// by normal play, but lets automated tests reach otherwise-private
// module state (camera position, monster/player HP) without needing
// to simulate minutes of real walking.
if (window.__FPS_TEST__) {
  window.__fpsDebug = {
    teleport(x, z) { camera.position.set(x, terrainHeightAt(x, z) + EYE_HEIGHT, z); },
    attack,
    monsters,
    // x/z/rotY added for the mobile touch-controls tests -- lets a test
    // confirm joystick drags actually move the camera and look-zone
    // drags actually rotate it, without needing to read Three.js
    // internals directly from the test script.
    getPlayerState: () => ({
      hp: playerHp,
      knockedOut,
      x: camera.position.x,
      z: camera.position.z,
      rotY: camera.rotation.y,
    }),
    getProfile: () => craftProfile,
    // Added for the ray-gun laser-bolt test -- lets a test equip a
    // weapon directly (bypassing the shop's scrap/ownership checks,
    // which aren't what that test is about) and inspect the bolt
    // system's live state without reaching into Three.js internals
    // from the test script itself.
    forceEquip(weaponId) {
      if (!craftProfile.weapons.includes(weaponId)) craftProfile = { ...craftProfile, weapons: [...craftProfile.weapons, weaponId] };
      craftProfile = equipWeapon(craftProfile, weaponId);
      updateWeaponLabel();
      syncWeaponViewmodel();
    },
    getActiveBoltCount: () => activeLaserBolts.length,
    getBoltPositions: () => activeLaserBolts.map((b) => ({ x: b.mesh.position.x, y: b.mesh.position.y, z: b.mesh.position.z, traveled: b.traveled, maxDistance: b.maxDistance })),
    // Sets the camera's horizontal facing directly (radians, same
    // convention as Math.atan2(dz, dx)) -- lets a test aim a ranged
    // shot down a specific, known-clear line without needing to drive
    // real mouse-look input first.
    setYaw(angle) { camera.rotation.set(0, angle, 0, 'YXZ'); },
    lookAt(x, y, z) { camera.lookAt(x, y, z); },
    rangedSightDistance,
    getAttackCallCount: () => attackCallCount,
    // Added for the terrain/lighting/Earth overhaul -- lets tests
    // confirm craters exist with real height variance, that walls are
    // genuinely rounded/extruded geometry (not plain BoxGeometry), and
    // that Earth exists in the scene with the expected setup, without
    // reaching into Three.js internals directly from the test script.
    getCraters: () => CRATERS.map((c) => ({ x: c.x, z: c.z, radius: c.radius, depth: c.depth })),
    getGroundHeightAt: (x, z) => terrainHeightAt(x, z),
    getWallGeometryType: () => wallMeshes[0]?.geometry?.type ?? null,
    getEarthInfo: () => ({
      position: { x: earth.position.x, y: earth.position.y, z: earth.position.z },
      radius: earth.geometry.parameters.radius,
      fogExcluded: earth.material.fog === false,
      hasEmissiveMap: !!earth.material.emissiveMap,
      emissiveIntensity: earth.material.emissiveIntensity,
    }),
    shadowsEnabled: () => renderer.shadowMap.enabled && keyLight.castShadow,
    // Diagnostic only -- swaps the checkerboard texture for a flat
    // color so a screenshot can isolate real shadow contrast from the
    // checker pattern's own light/dark tiles when visually verifying
    // the shadow setup above.
    debugFlattenGroundColor(hex) {
      ground.material.map = null;
      ground.material.color.set(hex);
      ground.material.needsUpdate = true;
    },
    // Added for the multi-planet (Rustbelt/Crystal/Jolly) FPS support --
    // lets a test confirm the right planet/map/theme actually loaded
    // from ?planet=<id> without reaching into Three.js internals.
    getPlanetId: () => PLANET_ID,
    getMonsterDefs: () => Object.keys(MONSTER_DEFS),
    getGroundMaterialInfo: () => ({
      hasEmissiveMap: !!ground.material.emissiveMap,
      roughness: ground.material.roughness,
      metalness: ground.material.metalness,
    }),
    getWallMaterialInfo: () => ({
      hasEmissiveMap: !!wallMaterial.emissiveMap,
      roughness: wallMaterial.roughness,
      metalness: wallMaterial.metalness,
      sameAsGround: wallMaterial === ground.material,
    }),
    getWallMapDataUrl: () => wallMaterial.map.image.toDataURL(),
    getGroundMapDataUrl: () => ground.material.map.image.toDataURL(),
    getObstacleCount: () => MAP.obstacles.length,
  };
}
