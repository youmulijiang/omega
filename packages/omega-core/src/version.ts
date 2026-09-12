import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const moduleManifest = new URL("../package.json", import.meta.url);
const manifestPath = existsSync(moduleManifest) ? moduleManifest : join(dirname(process.execPath), "package.json");

/** Version of the Omega application, independent of the Pi kernel version. */
export const OMEGA_VERSION: string = (JSON.parse(readFileSync(manifestPath, "utf8")) as { version: string }).version;
