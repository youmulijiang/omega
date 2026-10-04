#!/usr/bin/env node
import { bedrockProviderModule } from "@earendil-works/pi-ai/bedrock-provider";
import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";
import { setBedrockProviderModule } from "@earendil-works/pi-ai/compat";
import * as piCodingAgent from "@earendil-works/pi-coding-agent";
import { runOmegaCli } from "../cli-runner.ts";

// restoreSandboxEnv is an Omega fork addition; stock npm pi builds lack it, and
// ESM named imports of missing exports fail at link time, so access it lazily.
type SandboxEnvRestorer = () => void;
const restoreSandboxEnv = (piCodingAgent as Partial<Record<"restoreSandboxEnv", SandboxEnvRestorer>>).restoreSandboxEnv;
restoreSandboxEnv?.();
setBedrockProviderModule(bedrockProviderModule);
registerBunOAuthFlows();

await runOmegaCli(process.argv.slice(2));
