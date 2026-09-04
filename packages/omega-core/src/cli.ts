#!/usr/bin/env node
import { runOmegaCli } from "./cli-runner.ts";

await runOmegaCli(process.argv.slice(2));
