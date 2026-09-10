export const INSPECT_PROJECT_WORKFLOW = `export const meta = {
  name: 'inspect_project',
  description: 'Inspect a repository and independently verify the module summary',
  phases: [
    { title: 'Scan' },
    { title: 'Analyze' },
    { title: 'Verify' },
  ],
  permissions: {
    network: false,
    write: false,
    destructive: false,
  },
}

phase('Scan')
const inventory = await agent('Inspect the repository structure and identify security-relevant entry points.', {
  label: 'repo inventory',
  agentType: 'security-worker',
})

phase('Analyze')
const summary = await agent(
  'Summarize the main modules, trust boundaries, and exposed attack surfaces from this inventory:\\n' + inventory,
  {
    label: 'module summary',
    agentType: 'security-worker',
  },
)

phase('Verify')
const verification = await verify(summary, {
  label: 'verify summary',
  agentType: 'sec-advisor',
  task: 'Check that the module summary follows from repository evidence and does not omit major trust boundaries.',
  rubric: ['repository evidence', 'module coverage', 'trust boundaries', 'unsupported claims'],
})

return {
  ok: verification.verdict === 'confirmed',
  inventory,
  summary,
  verification,
}`;

export const VERIFIED_SECURITY_TEST_WORKFLOW = `export const meta = {
  name: 'verified_security_test',
  description: 'Execute an authorized security test and independently verify the result',
  phases: [
    { title: 'Execute' },
    { title: 'Verify' },
  ],
  permissions: {
    network: true,
    write: false,
    destructive: false,
  },
}

const findingSchema = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['confirmed', 'suspected', 'not_found'] },
    title: { type: 'string' },
    target: { type: 'string' },
    evidence: { type: 'array', items: { type: 'string' } },
    reproduction: { type: 'array', items: { type: 'string' } },
    impact: { type: 'string' },
  },
  required: ['status', 'title', 'target', 'evidence', 'reproduction', 'impact'],
  additionalProperties: false,
}

const request = args && typeof args === 'object' && typeof args.request === 'string'
  ? args.request
  : 'Perform the authorized security test described by the parent request.'

phase('Execute')
const result = await executeAndVerify(request, {
  executor: {
    label: 'execute test',
    agentType: 'websec-tester',
    schema: findingSchema,
    timeoutMs: 600000,
  },
  verifier: {
    label: 'verify finding',
    agentType: 'sec-advisor',
    task: 'Independently verify the finding, its evidence, reproduction, scope, and claimed impact.',
    rubric: [
      'reproducibility',
      'evidence sufficiency',
      'false-positive resistance',
      'scope compliance',
      'impact correctness',
    ],
  },
  executePhase: 'Execute',
  verifyPhase: 'Verify',
  maxAttempts: 2,
  onUncertain: 'retry',
  onRejected: 'return',
})

return result`;

export const WORKBENCH_WEB_HUNT_WORKFLOW = `export const meta = {
  name: 'workbench_web_hunt',
  description: 'Run an authorized Web security hunt through scope preflight, function modeling, falsifiable prediction, minimum-impact validation, and independent verification',
  whenToUse: 'Use for an authorized Web application or API assessment where evidence quality and scope control matter more than broad checklist coverage.',
  phases: [
    { title: 'Preflight', detail: 'Confirm authorization, scope, impact ceiling, and stop conditions.' },
    { title: 'Model', detail: 'Build one function-level world model from observed evidence.' },
    { title: 'Predict', detail: 'Choose one falsifiable, high-information prediction.' },
    { title: 'Validate', detail: 'Perform at most one minimum-impact, single-variable validation.' },
    { title: 'Verify', detail: 'Independently assess evidence, alternatives, scope, and impact.' },
  ],
  permissions: {
    network: true,
    write: false,
    destructive: false,
  },
}

const preflightSchema = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['ready', 'offline_only', 'blocked'] },
    authorizationSource: { type: 'string' },
    inScope: { type: 'array', items: { type: 'string' } },
    exclusions: { type: 'array', items: { type: 'string' } },
    allowedActions: { type: 'array', items: { type: 'string' } },
    prohibitedActions: { type: 'array', items: { type: 'string' } },
    maxImpactLevel: { type: 'string' },
    stopConditions: { type: 'array', items: { type: 'string' } },
    missing: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
  },
  required: ['status', 'authorizationSource', 'inScope', 'exclusions', 'allowedActions', 'prohibitedActions', 'maxImpactLevel', 'stopConditions', 'missing', 'summary'],
  additionalProperties: false,
}

const modelSchema = {
  type: 'object',
  properties: {
    function: { type: 'string' },
    actors: { type: 'array', items: { type: 'string' } },
    assets: { type: 'array', items: { type: 'string' } },
    observed: { type: 'array', items: { type: 'string' } },
    inferred: { type: 'array', items: { type: 'string' } },
    unknown: { type: 'array', items: { type: 'string' } },
    trustBoundaries: { type: 'array', items: { type: 'string' } },
    invariants: { type: 'array', items: { type: 'string' } },
    developerAssumptions: { type: 'array', items: { type: 'string' } },
    coverageGaps: { type: 'array', items: { type: 'string' } },
    highestValueUnknown: { type: 'string' },
  },
  required: ['function', 'actors', 'assets', 'observed', 'inferred', 'unknown', 'trustBoundaries', 'invariants', 'developerAssumptions', 'coverageGaps', 'highestValueUnknown'],
  additionalProperties: false,
}

const predictionSchema = {
  type: 'object',
  properties: {
    layer: { type: 'string', enum: ['behavior', 'boundary', 'assumption'] },
    claim: { type: 'string' },
    protectedInvariant: { type: 'string' },
    developerAssumption: { type: 'string' },
    observationBasis: { type: 'array', items: { type: 'string' } },
    expectedIfTrue: { type: 'string' },
    expectedIfFalse: { type: 'string' },
    noDiscrimination: { type: 'string' },
    coreVariable: { type: 'string' },
    frozenConditions: { type: 'array', items: { type: 'string' } },
    minimumValidation: { type: 'string' },
    approvalRequired: { type: 'boolean' },
    impactLevel: { type: 'string' },
    stopCondition: { type: 'string' },
  },
  required: ['layer', 'claim', 'protectedInvariant', 'developerAssumption', 'observationBasis', 'expectedIfTrue', 'expectedIfFalse', 'noDiscrimination', 'coreVariable', 'frozenConditions', 'minimumValidation', 'approvalRequired', 'impactLevel', 'stopCondition'],
  additionalProperties: false,
}

const assessmentSchema = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['confirmed', 'rejected', 'inconclusive', 'blocked'] },
    title: { type: 'string' },
    target: { type: 'string' },
    expected: { type: 'string' },
    observed: { type: 'string' },
    outcome: { type: 'string', enum: ['true', 'false', 'no_discrimination', 'not_executed'] },
    evidence: { type: 'array', items: { type: 'string' } },
    transportDifference: { type: 'string', enum: ['difference', 'no_difference', 'not_applicable'] },
    structuredDataDifference: { type: 'string', enum: ['difference', 'no_difference', 'not_applicable'] },
    persistentStateDifference: { type: 'string', enum: ['difference', 'no_difference', 'not_applicable'] },
    invariantViolation: { type: 'string' },
    unauthorizedCapability: { type: 'string' },
    alternatives: { type: 'array', items: { type: 'string' } },
    missingEvidence: { type: 'array', items: { type: 'string' } },
    unruledOut: { type: 'array', items: { type: 'string' } },
    cleanup: { type: 'string' },
    stopReason: { type: 'string' },
  },
  required: ['status', 'title', 'target', 'expected', 'observed', 'outcome', 'evidence', 'transportDifference', 'structuredDataDifference', 'persistentStateDifference', 'invariantViolation', 'unauthorizedCapability', 'alternatives', 'missingEvidence', 'unruledOut', 'cleanup', 'stopReason'],
  additionalProperties: false,
}

const request = args && typeof args === 'object' && typeof args.request === 'string'
  ? args.request
  : 'Assess the authorized Web target described by the parent request.'

phase('Preflight')
const preflight = await agent(
  'Perform a read-only authorization preflight for this Web security request. Read the project scope and authorization material available in the workspace. Never infer authorization from the target being reachable, from historical projects, or from the request merely calling the environment authorized. Do not make network requests. Return ready only when the concrete target, allowed actions, impact ceiling, and stop conditions are sufficiently recorded. Otherwise return offline_only or blocked. Request:\\n' + request,
  {
    label: 'authorization preflight',
    agentType: 'sec-advisor',
    schema: preflightSchema,
    timeoutMs: 120000,
  },
)

if (preflight.status !== 'ready') {
  return {
    ok: false,
    stage: 'preflight',
    summary: preflight.summary,
    preflight,
  }
}

phase('Model')
const model = await agent(
  'Build a local world model for exactly one highest-value business function within this authorized request. Start from normal user behavior and existing runtime or implementation evidence. Clearly separate observed, inferred, and unknown facts. Describe actors, assets, data flow, trust boundaries, protected invariants, developer assumptions, and coverage gaps. Static routes are clues, not proof that an endpoint exists. Do not run state-changing, destructive, bulk, credential, OOB, or higher-impact actions. Authorization preflight:\\n' + JSON.stringify(preflight) + '\\n\\nRequest:\\n' + request,
  {
    label: 'function world model',
    agentType: 'websec-tester',
    schema: modelSchema,
    timeoutMs: 300000,
  },
)

phase('Predict')
const prediction = await agent(
  'Using the supplied function model, choose exactly one falsifiable prediction with the highest expected information gain per cost. Do not produce a vulnerability checklist. Freeze all conditions except one core variable. State true, false, and no-discrimination interpretations before validation. Prefer existing evidence, passive observation, or one read-only request. Mark approvalRequired when the action changes state, is destructive or hard to reverse, has an external side effect, touches non-test data, or exceeds the recorded impact ceiling. If safe discrimination is impossible, describe the blocked validation and stop condition. Function model:\\n' + JSON.stringify(model) + '\\n\\nAuthorization:\\n' + JSON.stringify(preflight),
  {
    label: 'falsifiable prediction',
    agentType: 'security-worker',
    schema: predictionSchema,
    timeoutMs: 180000,
  },
)

phase('Validate')
const executionPrompt = [
  'Validate exactly the supplied prediction for the authorized Web target.',
  'Change only its declared core variable and preserve every frozen condition.',
  'Use the minimum-impact action and stop after the first sufficient controlled difference.',
  'Do not execute when approvalRequired is true; return blocked/not_executed instead.',
  'Do not expand to new hosts, roles, tenants, accounts, paths guessed from siblings, bulk enumeration, credential attacks, destructive actions, OOB callbacks, or real-user data.',
  'A 2xx response or client success message is not proof. Compare transport/protocol, structured data, and persistent state/external effects separately. A state claim requires a fresh read-back or reload. If controls drift, results do not reproduce, sensitive data appears, or side effects exceed expectation, stop and return inconclusive or blocked.',
  'Record alternative explanations, missing evidence, unruled-out surfaces, cleanup, and the exact stop reason.',
  'Request:\\n' + request,
  'Authorization:\\n' + JSON.stringify(preflight),
  'Function model:\\n' + JSON.stringify(model),
  'Prediction fixed before execution:\\n' + JSON.stringify(prediction),
].join('\\n\\n')

const checked = await executeAndVerify(executionPrompt, {
  executor: {
    label: 'minimum-impact validation',
    agentType: 'websec-tester',
    schema: assessmentSchema,
    timeoutMs: 600000,
  },
  verifier: {
    label: 'independent evidence review',
    agentType: 'sec-advisor',
    task: 'Verify that authorization was established before testing; the original prediction was not rewritten after observation; only one core variable changed; controls and three evidence layers were assessed; any persistent-state claim has fresh read-back; alternatives were excluded; impact is not overstated; and the first-sufficient-evidence stop rule was followed.',
    rubric: [
      'authorization and scope compliance',
      'prediction provenance and single-variable design',
      'control consistency and reproducibility',
      'three-layer differential evidence',
      'invariant violation and unauthorized capability',
      'alternative explanations and missing evidence',
      'impact minimization, cleanup, and stop condition',
    ],
    timeoutMs: 300000,
  },
  executePhase: 'Validate',
  verifyPhase: 'Verify',
  maxAttempts: 1,
  onUncertain: 'return',
  onRejected: 'return',
})

return {
  ok: checked.ok && checked.candidate.status === 'confirmed',
  stage: 'verify',
  summary: checked.verification.summary,
  preflight,
  model,
  prediction,
  assessment: checked.candidate,
  verification: checked.verification,
}`;
