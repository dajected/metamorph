import assert from 'node:assert/strict';
import {
    MODULE_NAME,
    SCHEMA_VERSION,
    activeTier,
    applyJudgeResult,
    buildJudgePrompt,
    buildStateBlock,
    initialState,
    migrateSetup,
    nextTier,
    normalizeState,
    parseJsonObject,
    setStat,
    validateSetup,
} from '../src/engine.js';

assert.equal(MODULE_NAME, 'metamorph');
assert.equal(SCHEMA_VERSION, 3);

const setup = {
    id: 'test-hierarchy',
    name: 'Test Hierarchy',
    version: '1.0.0',
    schema_version: SCHEMA_VERSION,
    description: 'Test setup',
    stats: [
        { key: 'vanity', label: 'Vanity', min: 0, max: 30, default: 0, description: 'Appearance investment', judge_guidance: 'Count new lasting appearance changes.' },
        { key: 'confidence', label: 'Confidence', min: 0, max: 30, default: 0, description: 'Social confidence', judge_guidance: 'Count new confidence changes.' },
    ],
    tiers: [
        { id: 'tier_1', label: 'Tier 1', description: 'Start', world_info_key: 'METAMORPH_TIER_1', requires: [] },
        { id: 'tier_2', label: 'Tier 2', description: 'Early', world_info_key: 'METAMORPH_TIER_2', requires: [
            { stat: 'vanity', op: '>=', value: 10 },
            { stat: 'confidence', op: '>=', value: 10 },
        ] },
        { id: 'tier_3', label: 'Tier 3', description: 'Established', world_info_key: 'METAMORPH_TIER_3', requires: [
            { stat: 'vanity', op: '>=', value: 20 },
            { stat: 'confidence', op: '>', value: 14 },
        ] },
    ],
    judge: { prompt_guidance: 'Latest assistant message only.' },
};

const validation = validateSetup(setup);
assert.equal(validation.valid, true, JSON.stringify(validation.errors));

let state = initialState(setup);
assert.deepEqual(state.stats, { vanity: 0, confidence: 0 });
assert.equal(activeTier(state, setup).id, 'tier_1');
assert.equal(nextTier(state, setup).id, 'tier_2');
assert.deepEqual(state.reachedTierIds, ['tier_1']);

const cannotSkipState = initialState(setup);
cannotSkipState.stats.confidence = 30;
assert.equal(activeTier(cannotSkipState, setup).id, 'tier_1', 'a failed tier blocks every later hierarchy step');

state = setStat(state, 'vanity', 10, setup).state;
state = setStat(state, 'confidence', 9, setup).state;
assert.equal(activeTier(state, setup).id, 'tier_1', 'all next-tier conditions must pass');
state = setStat(state, 'confidence', 10, setup).state;
assert.equal(activeTier(state, setup).id, 'tier_2');
assert.deepEqual(state.reachedTierIds, ['tier_1', 'tier_2']);
assert.equal(nextTier(state, setup).id, 'tier_3');

const decrease = setStat(state, 'vanity', 5, setup);
assert.match(decrease.error, /cannot decrease/i);
assert.equal(decrease.state.stats.vanity, 10);

const increase = setStat(state, 'vanity', 999, setup);
assert.equal(increase.error, null);
assert.equal(increase.state.stats.vanity, 30, 'manual increases clamp to max');

const assistantMessage = 'She applies red lipstick for the first time and begins wearing decorative jewellery.';
const prompt = buildJudgePrompt(state, setup, assistantMessage);
assert.match(prompt, /latest assistant message/i);
assert.match(prompt, /at most \+1 per stat per message/i);
assert.match(prompt, /red lipstick/);
assert.doesNotMatch(prompt, /Latest user message/);

const judged = applyJudgeResult(state, {
    results: [
        { stat: 'vanity', new_changes: ['began wearing red lipstick', 'started wearing decorative jewellery'] },
        { stat: 'confidence', new_changes: ['began wearing red lipstick'] },
        { stat: 'unknown', new_changes: ['ignored change'] },
    ],
}, setup, 'message-1');
assert.equal(judged.error, null);
assert.deepEqual(judged.increments, { vanity: 1, confidence: 1 });
assert.equal(judged.state.stats.vanity, 11, 'two changes for one stat still add one point');
assert.equal(judged.state.stats.confidence, 11);
assert.equal(judged.state.countedChanges.length, 2, 'all distinct changes are remembered');
assert.deepEqual(judged.state.countedChanges[0].stats.sort(), ['confidence', 'vanity']);

const invalidJudgeShape = applyJudgeResult(judged.state, { vanity: 1 }, setup, 'invalid-message');
assert.match(invalidJudgeShape.error, /results array/);
assert.equal(invalidJudgeShape.state.processedAssistantFingerprints.includes('invalid-message'), false);

const duplicateMessage = applyJudgeResult(judged.state, {
    results: [{ stat: 'vanity', new_changes: ['another change'] }],
}, setup, 'message-1');
assert.equal(duplicateMessage.duplicate, true);
assert.equal(duplicateMessage.state.stats.vanity, 11);

const repeatedChange = applyJudgeResult(judged.state, {
    results: [{ stat: 'vanity', new_changes: ['Began wearing red lipstick!'] }],
}, setup, 'message-2');
assert.deepEqual(repeatedChange.increments, {});
assert.equal(repeatedChange.state.stats.vanity, 11);
assert.equal(repeatedChange.state.countedChanges.length, 2);

const memoryPrompt = buildJudgePrompt(judged.state, setup, 'She wears her red lipstick again.');
assert.match(memoryPrompt, /Already-counted changes/);
assert.match(memoryPrompt, /began wearing red lipstick/);

const tierTwoBlock = buildStateBlock(judged.state, setup, { promptInjectionMode: 'compact' });
assert.match(tierTwoBlock, /METAMORPH_TIER_2/);
assert.match(tierTwoBlock, /Active transformation tier: Tier 2/);
assert.doesNotMatch(tierTwoBlock, /METAMORPH_TIER_1/);
assert.doesNotMatch(tierTwoBlock, /METAMORPH_TIER_3/);
assert.doesNotMatch(tierTwoBlock, /Available changes|Recent history|Active transformation lore/i);
assert.equal(buildStateBlock(judged.state, setup, { promptInjectionMode: 'off' }), '');

const legacySetup = {
    ...setup,
    schema_version: 2,
    tier_lore: [{ id: 'old', text: 'obsolete' }],
    options: [{ id: 'old-change' }],
    time: { enabled: true },
    tiers: setup.tiers.map(({ world_info_key, ...tier }) => tier),
};
const migrated = migrateSetup(legacySetup);
assert.equal(migrated.migrated, true);
assert.equal(migrated.setup.schema_version, 3);
assert.equal(Object.hasOwn(migrated.setup, 'tier_lore'), false);
assert.equal(Object.hasOwn(migrated.setup, 'options'), false);
assert.ok(migrated.setup.tiers.every((tier) => tier.world_info_key.startsWith('METAMORPH_TIER_')));

const legacyRanges = structuredClone(legacySetup);
legacyRanges.tiers[0].requires = [{ stat: 'vanity', op: '<', value: 10 }];
legacyRanges.tiers[1].requires.push({ stat: 'vanity', op: '<', value: 20 });
const migratedRanges = migrateSetup(legacyRanges).setup;
assert.deepEqual(migratedRanges.tiers[0].requires, []);
assert.equal(migratedRanges.tiers[1].requires.some((condition) => condition.op === '<'), false);

const legacyState = {
    scenarioId: setup.id,
    scenarioVersion: '0.9.0',
    schemaVersion: 2,
    stats: { vanity: 12, confidence: 10 },
    eventLog: [{ type: 'old' }],
    availableOptionIds: ['old-change'],
    activeLoreIds: ['old'],
};
const normalized = normalizeState(legacyState, setup);
assert.deepEqual(normalized.stats, { vanity: 12, confidence: 10 });
assert.equal(normalized.activeTierId, 'tier_2');
assert.equal(Object.hasOwn(normalized, 'eventLog'), false);
assert.equal(Object.hasOwn(normalized, 'availableOptionIds'), false);

const invalidOperator = structuredClone(setup);
invalidOperator.tiers[1].requires[0].op = '<=';
const invalidValidation = validateSetup(invalidOperator);
assert.equal(invalidValidation.valid, false);
assert.match(invalidValidation.errors.map((entry) => entry.message).join(' '), /must use > or >=/);

assert.deepEqual(parseJsonObject('```json\n{"results":[]}\n```'), { results: [] });
assert.equal(parseJsonObject('not json'), null);

console.log('engine tests passed');
