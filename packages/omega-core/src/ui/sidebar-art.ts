export interface GeoPoint {
	readonly lon: number;
	readonly lat: number;
}

export interface ContinentShape {
	readonly id: "AS" | "EU" | "AF" | "NA" | "SA" | "OC";
	readonly name: string;
	readonly label: GeoPoint;
	readonly polygon: readonly GeoPoint[];
}

/** Deliberately simplified offline outlines: readable at terminal resolution, not cartographic data. */
export const SIDEBAR_CONTINENTS: readonly ContinentShape[] = [
	{
		id: "NA",
		name: "North America",
		label: { lon: -105, lat: 45 },
		polygon: [
			{ lon: -168, lat: 70 },
			{ lon: -125, lat: 72 },
			{ lon: -60, lat: 58 },
			{ lon: -52, lat: 42 },
			{ lon: -82, lat: 24 },
			{ lon: -100, lat: 17 },
			{ lon: -118, lat: 28 },
			{ lon: -150, lat: 55 },
		],
	},
	{
		id: "SA",
		name: "South America",
		label: { lon: -60, lat: -18 },
		polygon: [
			{ lon: -82, lat: 12 },
			{ lon: -52, lat: 10 },
			{ lon: -35, lat: -5 },
			{ lon: -48, lat: -28 },
			{ lon: -67, lat: -55 },
			{ lon: -76, lat: -20 },
		],
	},
	{
		id: "EU",
		name: "Europe",
		label: { lon: 16, lat: 53 },
		polygon: [
			{ lon: -11, lat: 36 },
			{ lon: 12, lat: 36 },
			{ lon: 40, lat: 43 },
			{ lon: 60, lat: 58 },
			{ lon: 31, lat: 71 },
			{ lon: -8, lat: 58 },
		],
	},
	{
		id: "AF",
		name: "Africa",
		label: { lon: 20, lat: 5 },
		polygon: [
			{ lon: -18, lat: 35 },
			{ lon: 14, lat: 37 },
			{ lon: 52, lat: 12 },
			{ lon: 42, lat: -20 },
			{ lon: 18, lat: -35 },
			{ lon: -10, lat: 2 },
		],
	},
	{
		id: "AS",
		name: "Asia",
		label: { lon: 92, lat: 45 },
		polygon: [
			{ lon: 34, lat: 36 },
			{ lon: 48, lat: 62 },
			{ lon: 95, lat: 77 },
			{ lon: 169, lat: 66 },
			{ lon: 151, lat: 42 },
			{ lon: 122, lat: 18 },
			{ lon: 102, lat: 5 },
			{ lon: 73, lat: 9 },
			{ lon: 57, lat: 25 },
		],
	},
	{
		id: "OC",
		name: "Oceania",
		label: { lon: 136, lat: -25 },
		polygon: [
			{ lon: 110, lat: -11 },
			{ lon: 154, lat: -10 },
			{ lon: 160, lat: -27 },
			{ lon: 146, lat: -44 },
			{ lon: 113, lat: -35 },
		],
	},
] as const;

const DEG_TO_RAD = Math.PI / 180;
const TAU = Math.PI * 2;
const GLOBE_PERIOD_MS = 30_000;

function normalizeLongitude(lon: number): number {
	let normalized = lon;
	while (normalized > 180) normalized -= 360;
	while (normalized < -180) normalized += 360;
	return normalized;
}

function pointInPolygon(lon: number, lat: number, polygon: readonly GeoPoint[]): boolean {
	let inside = false;
	for (let current = 0, previous = polygon.length - 1; current < polygon.length; previous = current++) {
		const a = polygon[current]!;
		const b = polygon[previous]!;
		const crosses = a.lat > lat !== b.lat > lat;
		if (crosses && lon < ((b.lon - a.lon) * (lat - a.lat)) / (b.lat - a.lat) + a.lon) inside = !inside;
	}
	return inside;
}

function continentAt(lon: number, lat: number): ContinentShape | undefined {
	return SIDEBAR_CONTINENTS.find((continent) => pointInPolygon(lon, lat, continent.polygon));
}

function createGrid(width: number, height: number, fill = " "): string[][] {
	return Array.from({ length: height }, () => Array.from({ length: width }, () => fill));
}

function gridLines(grid: string[][]): string[] {
	return grid.map((row) => row.join(""));
}

function writeLabel(grid: string[][], x: number, y: number, label: string): void {
	const row = grid[Math.round(y)];
	if (!row) return;
	const start = Math.round(x - label.length / 2);
	for (let index = 0; index < label.length; index++) {
		const column = start + index;
		if (column >= 0 && column < row.length) row[column] = label[index]!;
	}
}

export function globeRotation(timeMs: number): number {
	return ((timeMs % GLOBE_PERIOD_MS) / GLOBE_PERIOD_MS) * TAU;
}

export function visibleGlobeLabels(rotation: number): string[] {
	return SIDEBAR_CONTINENTS.filter((continent) => {
		const relativeLongitude = normalizeLongitude(continent.label.lon - rotation / DEG_TO_RAD) * DEG_TO_RAD;
		return Math.cos(continent.label.lat * DEG_TO_RAD) * Math.cos(relativeLongitude) > 0.12;
	}).map((continent) => continent.id);
}

export type GlobeRenderer = "ascii" | "braille";

/** Font coverage cannot be queried reliably; allow an explicit override. */
export function resolveGlobeRenderer(
	env: Readonly<Record<string, string | undefined>> = process.env,
	platform: string = process.platform,
): GlobeRenderer {
	const override = env.OMEGA_GLOBE_RENDERER?.toLowerCase();
	if (override === "ascii" || override === "braille") return override;
	if (/^(dumb|linux|cons25|vt100|ansi)$/i.test(env.TERM ?? "")) return "ascii";
	const locale = env.LC_ALL || env.LC_CTYPE || env.LANG;
	if (platform !== "win32" && locale && !/utf-?8/i.test(locale)) return "ascii";
	if (env.WT_SESSION || env.TERM_PROGRAM || env.KITTY_WINDOW_ID || env.WEZTERM_PANE) return "braille";
	if (locale && /utf-?8/i.test(locale)) return "braille";
	return "ascii";
}

const AXIS_TILT = 23.4 * DEG_TO_RAD;
const TILT_COS = Math.cos(AXIS_TILT);
const TILT_SIN = Math.sin(AXIS_TILT);
const BRAILLE_BITS = [
	[1, 8],
	[2, 16],
	[4, 32],
	[64, 128],
] as const;
// Screen-anchored ordered dithering keeps shading stable while the surface rotates.
const DITHER = [
	[0, 8, 2, 10],
	[12, 4, 14, 6],
	[3, 11, 1, 9],
	[15, 7, 13, 5],
] as const;

function globeBrightness(nx: number, ny: number, rotation: number): number {
	const radiusSquared = nx * nx + ny * ny;
	if (radiusSquared > 1) return 0;
	const nz = Math.sqrt(1 - radiusSquared);
	const sphereX = nx * TILT_COS + ny * TILT_SIN;
	const sphereY = -nx * TILT_SIN + ny * TILT_COS;
	const lat = Math.asin(Math.max(-1, Math.min(1, sphereY))) / DEG_TO_RAD;
	const lon = normalizeLongitude((Math.atan2(sphereX, nz) + rotation) / DEG_TO_RAD);
	const land = continentAt(lon, lat) !== undefined;
	const diffuse = Math.max(0, -nx * 0.55 + ny * 0.45 + nz * 0.7);
	const surface = land ? 0.2 + diffuse * 0.72 : 0.05 + diffuse * 0.28;
	const atmosphere = 0.18 * (1 - nz) ** 8;
	return Math.min(0.999, surface + atmosphere);
}

/** Orthographic sphere with tilted geography, fixed lighting and 2x4 dot sampling. */
export function renderGlobe(
	width: number,
	height: number,
	timeMs: number,
	renderer: GlobeRenderer = resolveGlobeRenderer(),
	palette?: readonly string[],
): string[] {
	const safeWidth = Math.max(1, Math.floor(width));
	const safeHeight = Math.max(1, Math.floor(height));
	const grid = createGrid(safeWidth, safeHeight);
	const radiusY = Math.max(0.25, Math.min((safeHeight - 0.5) / 2, (safeWidth - 0.5) / 4));
	const radiusX = radiusY * 2;
	const centerX = safeWidth / 2;
	const centerY = safeHeight / 2;
	const rotation = globeRotation(timeMs);
	const ramp = " .:-=+*#%@";

	for (let y = 0; y < safeHeight; y++) {
		for (let x = 0; x < safeWidth; x++) {
			if (renderer === "ascii") {
				const brightness = globeBrightness((x + 0.5 - centerX) / radiusX, (centerY - y - 0.5) / radiusY, rotation);
				grid[y]![x] = ramp[Math.floor(brightness * ramp.length)]!;
				continue;
			}
			let dots = 0;
			for (let dy = 0; dy < 4; dy++) {
				for (let dx = 0; dx < 2; dx++) {
					const nx = (x + (dx + 0.5) / 2 - centerX) / radiusX;
					const ny = (centerY - y - (dy + 0.5) / 4) / radiusY;
					const threshold = (DITHER[dy]![(x * 2 + dx) % 4]! + 0.5) / 16;
					if (globeBrightness(nx, ny, rotation) > threshold) dots |= BRAILLE_BITS[dy]![dx]!;
				}
			}
			grid[y]![x] = dots === 0 ? " " : String.fromCharCode(0x2800 + dots);
		}
	}

	for (const continent of SIDEBAR_CONTINENTS) {
		const latitude = continent.label.lat * DEG_TO_RAD;
		const relativeLongitude = normalizeLongitude(continent.label.lon - rotation / DEG_TO_RAD) * DEG_TO_RAD;
		const visibility = Math.cos(latitude) * Math.cos(relativeLongitude);
		if (visibility <= 0.35 || safeWidth < 12 || safeHeight < 5) continue;
		const sphereX = Math.cos(latitude) * Math.sin(relativeLongitude);
		const sphereY = Math.sin(latitude);
		const x = centerX + radiusX * (sphereX * TILT_COS - sphereY * TILT_SIN) - 0.5;
		const y = centerY - radiusY * (sphereX * TILT_SIN + sphereY * TILT_COS) - 0.5;
		const row = Math.round(y);
		const start = Math.round(x - continent.id.length / 2);
		// Do not stamp a label across the limb or into blank space outside the sphere.
		if (
			Array.from(continent.id).every((_, index) => {
				const nx = (start + index + 0.5 - centerX) / radiusX;
				const ny = (centerY - row - 0.5) / radiusY;
				return nx * nx + ny * ny < 0.9;
			})
		)
			writeLabel(grid, x, y, continent.id);
	}

	if (!palette?.length) return gridLines(grid);
	return grid.map((row, y) => {
		let line = "";
		let previousShade = -1;
		for (let x = 0; x < row.length; x++) {
			const glyph = row[x]!;
			if (glyph !== " ") {
				const nx = (x + 0.5 - centerX) / radiusX;
				const ny = (centerY - y - 0.5) / radiusY;
				const nz = Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny));
				const diffuse = Math.max(0, -nx * 0.55 + ny * 0.45 + nz * 0.7);
				// Blinn highlight: the half-vector of the light and the viewer stays fixed as land rotates.
				const specular = Math.max(0, -nx * 0.299 + ny * 0.244 + nz * 0.922) ** 24;
				const light = Math.min(1, 0.08 + diffuse * 0.7 + specular * 0.35);
				const shade = Math.round(light * (palette.length - 1));
				if (shade !== previousShade) line += palette[shade]!;
				previousShade = shade;
			}
			line += glyph;
		}
		return previousShade < 0 ? line : `${line}\x1b[39m`;
	});
}

export function renderAsciiGlobe(width: number, height: number, timeMs: number): string[] {
	return renderGlobe(width, height, timeMs, "ascii");
}

interface MapNode extends GeoPoint {
	readonly id: string;
}

const MAP_NODES: readonly MapNode[] = [
	{ id: "SEA", lon: -122, lat: 47 },
	{ id: "NYC", lon: -74, lat: 41 },
	{ id: "SAO", lon: -46, lat: -23 },
	{ id: "LON", lon: 0, lat: 51 },
	{ id: "LOS", lon: 3, lat: 7 },
	{ id: "CPT", lon: 18, lat: -34 },
	{ id: "BOM", lon: 73, lat: 19 },
	{ id: "SIN", lon: 104, lat: 1 },
	{ id: "TYO", lon: 140, lat: 36 },
	{ id: "SYD", lon: 151, lat: -34 },
] as const;

const ATTACK_ROUTES: readonly (readonly [number, number])[] = [
	[0, 7],
	[8, 1],
	[3, 2],
	[6, 0],
	[7, 3],
	[1, 5],
	[9, 4],
	[2, 8],
] as const;

function mapPoint(point: GeoPoint, width: number, height: number): { x: number; y: number } {
	return {
		x: Math.max(0, Math.min(width - 1, Math.round(((point.lon + 180) / 360) * (width - 1)))),
		y: Math.max(0, Math.min(height - 1, Math.round(((80 - point.lat) / 140) * (height - 1)))),
	};
}

function routePoint(
	start: { x: number; y: number },
	end: { x: number; y: number },
	progress: number,
): { x: number; y: number } {
	const controlX = (start.x + end.x) / 2;
	const controlY = Math.max(0, Math.min(start.y, end.y) - Math.max(1, Math.abs(end.x - start.x) * 0.12));
	const inverse = 1 - progress;
	return {
		x: Math.round(inverse * inverse * start.x + 2 * inverse * progress * controlX + progress * progress * end.x),
		y: Math.round(inverse * inverse * start.y + 2 * inverse * progress * controlY + progress * progress * end.y),
	};
}

/** Render a deterministic, offline simulation. It never consumes real network data. */
export function renderAttackMap(width: number, height: number, timeMs: number, seed = 17): string[] {
	const safeWidth = Math.max(1, Math.floor(width));
	const safeHeight = Math.max(1, Math.floor(height));
	const grid = createGrid(safeWidth, safeHeight);

	for (let y = 0; y < safeHeight; y++) {
		const lat = 80 - (y / Math.max(1, safeHeight - 1)) * 140;
		for (let x = 0; x < safeWidth; x++) {
			const lon = -180 + (x / Math.max(1, safeWidth - 1)) * 360;
			if (continentAt(lon, lat)) grid[y]![x] = ".";
		}
	}

	const tick = Math.floor(timeMs / 1_800);
	for (let active = 0; active < 3; active++) {
		const route = ATTACK_ROUTES[(tick + seed + active * 3) % ATTACK_ROUTES.length]!;
		const start = mapPoint(MAP_NODES[route[0]]!, safeWidth, safeHeight);
		const end = mapPoint(MAP_NODES[route[1]]!, safeWidth, safeHeight);
		for (let step = 0; step <= 24; step++) {
			const point = routePoint(start, end, step / 24);
			if (grid[point.y]?.[point.x] !== undefined) grid[point.y]![point.x] = ":";
		}
		const progress = (((timeMs / 1_800 + active * 0.27) % 1) + 1) % 1;
		const particle = routePoint(start, end, progress);
		if (grid[particle.y]?.[particle.x] !== undefined) grid[particle.y]![particle.x] = "*";
		if (grid[end.y]?.[end.x] !== undefined) grid[end.y]![end.x] = Math.floor(timeMs / 250) % 2 === 0 ? "X" : "o";
	}

	for (const node of MAP_NODES) {
		const point = mapPoint(node, safeWidth, safeHeight);
		if (grid[point.y]?.[point.x] === ".") grid[point.y]![point.x] = "+";
	}
	return gridLines(grid);
}

const TERMINAL_SEQUENCE_LENGTH = 27;
const HEX_START = 4;
const HEX_END = 21;
const RESPONSE_GLYPHS = "0123456789ABCDEF@#$%?~^<>/\\";

function nextNoise(seed: number): number {
	let value = seed >>> 0;
	value ^= value << 13;
	value ^= value >>> 17;
	value ^= value << 5;
	return value >>> 0;
}

function responseNoise(ordinal: number, width: number): string {
	let seed = (Math.imul(ordinal + 1024, 0x9e3779b1) ^ 0xa5a5a5a5) >>> 0;
	let value = "[rx] ";
	while (value.length < width) {
		seed = nextNoise(seed);
		value += RESPONSE_GLYPHS[seed % RESPONSE_GLYPHS.length];
	}
	return value;
}

function hexHeader(byteCount: number): string {
	return `Address   ${Array.from({ length: byteCount }, (_, index) => index.toString(16).toUpperCase().padStart(2, "0")).join(" ")}  ASCII`;
}

function hexResponse(row: number, byteCount: number, tick: number): string {
	let seed = (Math.imul(row + 1, 0x45d9f3b) ^ Math.imul(tick + 1, 0x119de1f3)) >>> 0;
	const bytes: number[] = [];
	for (let column = 0; column < byteCount; column++) {
		seed = nextNoise(seed);
		bytes.push(seed % 7 === 0 ? 0 : seed & 0xff);
	}
	const address = (row * byteCount).toString(16).toUpperCase().padStart(8, "0");
	const hex = bytes.map((byte) => byte.toString(16).toUpperCase().padStart(2, "0")).join(" ");
	const ascii = bytes.map((byte) => (byte >= 33 && byte <= 126 ? String.fromCharCode(byte) : ".")).join("");
	return `${address}: ${hex}  |${ascii}|`;
}

/** A continuous, deterministic command/response stream with simulated hex-editor dumps. */
export function renderTerminalScene(width: number, height: number, timeMs: number): string[] {
	const safeWidth = Math.max(1, Math.floor(width));
	const safeHeight = Math.max(1, Math.floor(height));
	const step = Math.max(0, Math.floor(timeMs / 700));
	const byteCount = Math.max(1, Math.min(16, Math.floor((safeWidth - 12) / 4)));
	const tick = Math.floor(timeMs / 250);
	const reveal = Math.floor(((timeMs % 700) / 700) * safeWidth);
	return Array.from({ length: safeHeight }, (_, row) => {
		const ordinal = step - safeHeight + row + 1;
		const index = ((ordinal % TERMINAL_SEQUENCE_LENGTH) + TERMINAL_SEQUENCE_LENGTH) % TERMINAL_SEQUENCE_LENGTH;
		let value: string;
		if (index === 3) value = hexHeader(byteCount);
		else if (index >= HEX_START && index <= HEX_END) value = hexResponse(index - HEX_START, byteCount, tick);
		else if (index === 0) value = "> INITIALIZING GHOST INTERFACE";
		else if (index === 1) value = "[ok] visual core online // SIMULATION";
		else if (index === 2) value = "> inspect phantom buffer --view hex";
		else if (index === 22) value = responseNoise(ordinal, safeWidth);
		else if (index === 23) value = "> decoding spectral response...";
		else if (index === 24) value = responseNoise(ordinal, safeWidth);
		else if (index === 25) value = "[ok] ghost channel stable";
		else value = "> synchronizing midnight protocol";
		if (row === safeHeight - 1 && (index < HEX_START || index > HEX_END) && index !== 3) {
			value = value.slice(0, reveal) + (timeMs % 500 < 250 ? "_" : " ");
		}
		return value.slice(0, safeWidth).padEnd(safeWidth, " ");
	});
}

// --- Skull ---

const SKULL_RAMP = " .:-=+*#%@";
const SKULL_BOB_PERIOD_MS = 6_400;
const SKULL_JAW_PERIOD_MS = 5_200;
const SKULL_EMBER_PERIOD_MS = 1_100;

/** Signed-ish ellipse field: 1 at the center, 0 on the rim, negative outside. */
function skullEllipseField(x: number, y: number, radiusX: number, radiusY: number): number {
	const dx = x / radiusX;
	const dy = y / radiusY;
	return 1 - Math.sqrt(dx * dx + dy * dy);
}

function skullMottle(cellX: number, cellY: number): number {
	const noise = nextNoise((Math.imul(cellX + 1, 0x27d4eb2d) ^ Math.imul(cellY + 1, 0x165667b1)) >>> 0);
	return ((noise >>> 24) / 255 - 0.5) * 0.12;
}

/**
 * Bone density for one cell: SDF-composed cranium, face and jaw with carved sockets and nasal
 * cavity, lambert shading from the dominant shape's pseudo-normal, and a density ramp standing in
 * for highlight and shadow. Eye embers flicker out of phase and the jaw slowly chatters.
 * Returns 0 for empty space.
 */
export function skullBrightness(nx: number, ny: number, cellX: number, cellY: number, timeMs: number): number {
	const bob = Math.sin((timeMs / SKULL_BOB_PERIOD_MS) * TAU) * 0.03;
	const jawDrop = 0.05 + 0.09 * (0.5 + 0.5 * Math.sin((timeMs / SKULL_JAW_PERIOD_MS) * TAU));
	const y = ny - bob;

	const cranium = skullEllipseField(nx, y - 0.26, 0.94, 0.7);
	const face = skullEllipseField(nx, y + 0.2, 0.7, 0.44);
	const jaw = skullEllipseField(nx, y + 0.68 + jawDrop, 0.46, 0.36);
	const boneField = Math.max(cranium, Math.max(face, jaw));
	if (boneField <= 0) return 0;

	// Eye sockets: mirrored through Math.abs(nx). Deep void with a flickering ember at the bottom.
	const socket = skullEllipseField(Math.abs(nx) - 0.34, y - 0.02, 0.24, 0.2);
	if (socket > 0) {
		const phase = nx < 0 ? 0 : 1.7;
		const flicker = Math.max(0, Math.sin((timeMs / SKULL_EMBER_PERIOD_MS) * TAU + phase)) ** 6;
		const ember = Math.max(0, skullEllipseField(Math.abs(nx) - 0.34, y - 0.11, 0.11, 0.08));
		return Math.min(0.99, 0.03 + ember * flicker * 0.9);
	}

	// Nasal cavity.
	if (skullEllipseField(nx, y + 0.3, 0.09, 0.17) > 0) return 0.04;

	// Teeth: bright enamel columns separated by dark grooves; upper set fixed, lower set rides the jaw.
	const upperTeeth = y > -0.52 && y < -0.3 && Math.abs(nx) < 0.3 && face > 0.15;
	const lowerTeeth = jaw > 0.25 && y < -0.46 + jawDrop && y > -0.7 && Math.abs(nx) < 0.3;
	if (upperTeeth || lowerTeeth) {
		const groove = Math.sin((Math.abs(nx) + (upperTeeth ? 0.22 : 0.36)) * 26) > 0;
		return groove ? 0.16 : 0.96;
	}

	// Lambert shading from the union field's outward gradient; light sits upper-left.
	let normalX = 0;
	let normalY = 0;
	for (const [shapeY, shapeRX, shapeRY] of [
		[0.26, 0.94, 0.7],
		[-0.2, 0.7, 0.44],
		[-0.68 - jawDrop, 0.46, 0.36],
	] as const) {
		normalX -=
			skullEllipseField(nx + 0.02, y - shapeY, shapeRX, shapeRY) -
			skullEllipseField(nx - 0.02, y - shapeY, shapeRX, shapeRY);
		normalY -=
			skullEllipseField(nx, y + 0.02 - shapeY, shapeRX, shapeRY) -
			skullEllipseField(nx, y - 0.02 - shapeY, shapeRX, shapeRY);
	}
	const normalLength = Math.hypot(normalX, normalY) || 1;
	normalX /= normalLength;
	normalY /= normalLength;
	const diffuse = Math.max(0, normalX * -0.48 + normalY * 0.62);

	// The jaw sits in the skull's shadow; scale down its lambert term so it reads darker than the cranium.
	const jawDominant = jaw >= cranium && jaw >= face;
	const lit = jawDominant ? diffuse * 0.55 : diffuse;

	// Brow ridge and cheekbones catch extra light; temples fall into shadow.
	const brow = Math.max(0, skullEllipseField(Math.abs(nx) - 0.34, y + 0.22, 0.28, 0.09));
	const cheekbone = Math.max(0, skullEllipseField(Math.abs(nx) - 0.58, y - 0.14, 0.15, 0.1));
	const temple = Math.max(0, skullEllipseField(Math.abs(nx) - 0.74, y + 0.3, 0.2, 0.25));
	const rim = Math.max(0, 0.5 - boneField);

	const brightness =
		0.14 + 0.62 * lit + brow * 0.28 + cheekbone * 0.22 - temple * 0.18 - rim * 0.8 + skullMottle(cellX, cellY);
	return Math.max(0.08, Math.min(0.99, brightness));
}

/** Dynamic skull: density-ramp bone shading, ember-lit sockets, slow jaw chatter and bob. */
export function renderSkull(width: number, height: number, timeMs: number): string[] {
	const safeWidth = Math.max(1, Math.floor(width));
	const safeHeight = Math.max(1, Math.floor(height));
	const grid = createGrid(safeWidth, safeHeight);
	const radiusY = Math.max(0.25, Math.min((safeHeight - 0.5) / 2.3, (safeWidth - 0.5) / 3.4));
	const radiusX = radiusY * 1.7;
	const centerX = safeWidth / 2;
	const centerY = safeHeight / 2;
	for (let y = 0; y < safeHeight; y++) {
		for (let x = 0; x < safeWidth; x++) {
			const brightness = skullBrightness((x + 0.5 - centerX) / radiusX, (centerY - y - 0.5) / radiusY, x, y, timeMs);
			if (brightness > 0) {
				grid[y]![x] = SKULL_RAMP[Math.min(SKULL_RAMP.length - 1, Math.floor(brightness * SKULL_RAMP.length))]!;
			}
		}
	}
	return gridLines(grid);
}
