#!/usr/bin/env node
import { bedrockProviderModule } from "@earendil-works/pi-ai/bedrock-provider";
import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";
import { setBedrockProviderModule } from "@earendil-works/pi-ai/compat";
import { restoreSandboxEnv } from "@earendil-works/pi-coding-agent";
import { runOmegaCli } from "../cli-runner.ts";

restoreSandboxEnv();
setBedrockProviderModule(bedrockProviderModule);
registerBunOAuthFlows();

await runOmegaCli(process.argv.slice(2));
