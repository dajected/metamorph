export const MODULE_NAME = 'metamorph';
export const SCHEMA_VERSION = 3;

export const DEFAULT_SETUP = Object.freeze({
    id: 'current-chat-transformation',
    name: 'Current Chat Transformation',
    version: '1.0.0',
    schema_version: SCHEMA_VERSION,
    description: 'Track irreversible transformation progress through one ordered tier hierarchy.',
    stats: [],
    tiers: [
        {
            id: 'tier_1',
            label: 'Tier 1',
            description: 'The starting transformation tier.',
            world_info_key: 'METAMORPH_TIER_1',
            requires: [],
        },
    ],
    judge: {
        prompt_guidance: 'Count only concrete transformation changes first established in the latest assistant message.',
    },
});

export function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
}

export function clamp(value, min, max) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return Number(min);
    return Math.min(Number(max), Math.max(Number(min), numeric));
}

function tierKey(id, index) {
    const normalized = String(id || `tier_${index + 1}`)
        .trim()
        .replace(/[^a-zA-Z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .toUpperCase();
    return `METAMORPH_TIER_${normalized || index + 1}`;
}

export function migrateSetup(input) {
    const setup = clone(input || DEFAULT_SETUP);
    const fromVersion = Number(setup.schema_version) || 1;
    const obsoleteKeys = ['time', 'decision', 'beats', 'tier_lore', 'options'];
    const migrated = fromVersion !== SCHEMA_VERSION || obsoleteKeys.some((key) => Object.hasOwn(setup, key));

    for (const key of obsoleteKeys) delete setup[key];
    setup.schema_version = SCHEMA_VERSION;
    setup.id = String(setup.id || DEFAULT_SETUP.id);
    setup.name = String(setup.name || DEFAULT_SETUP.name);
    setup.version = String(setup.version || '1.0.0');
    setup.description = String(setup.description || '');
    setup.stats = Array.isArray(setup.stats) ? setup.stats : [];
    setup.tiers = Array.isArray(setup.tiers) ? setup.tiers : [];
    setup.judge = {
        prompt_guidance: String(setup.judge?.prompt_guidance || DEFAULT_SETUP.judge.prompt_guidance),
    };

    setup.stats = setup.stats.map((stat) => ({
        ...stat,
        key: String(stat?.key || ''),
        label: String(stat?.label || stat?.key || ''),
        min: Number.isFinite(Number(stat?.min)) ? Number(stat.min) : 0,
        max: Number.isFinite(Number(stat?.max)) ? Number(stat.max) : 100,
        default: Number.isFinite(Number(stat?.default)) ? Number(stat.default) : 0,
        description: String(stat?.description || ''),
        judge_guidance: String(stat?.judge_guidance || ''),
    }));

    setup.tiers = setup.tiers.map((tier, index) => ({
        id: String(tier?.id || `tier_${index + 1}`),
        label: String(tier?.label || tier?.id || `Tier ${index + 1}`),
        description: String(tier?.description || ''),
        world_info_key: String(tier?.world_info_key || tier?.activation_key || tierKey(tier?.id, index)),
        requires: Array.isArray(tier?.requires) ? tier.requires.map((condition) => ({
            stat: String(condition?.stat || ''),
            op: String(condition?.op || '>='),
            value: Number(condition?.value),
        })).filter((condition) => fromVersion >= SCHEMA_VERSION || ['>', '>='].includes(condition.op)) : [],
    }));

    return { setup, migrated, fromVersion, toVersion: SCHEMA_VERSION };
}

export function validateSetup(input) {
    const errors = [];
    const warnings = [];
    const addError = (path, message, suggestedFix = '') => errors.push({ severity: 'error', path, message, suggestedFix });
    const addWarning = (path, message, suggestedFix = '') => warnings.push({ severity: 'warning', path, message, suggestedFix });

    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        addError('$', 'Transformation setup must be a JSON object.');
        return { valid: false, errors, warnings };
    }

    for (const key of ['time', 'decision', 'beats', 'tier_lore', 'options']) {
        if (Object.hasOwn(input, key)) addWarning(`$.${key}`, `${key} is obsolete and will be removed on import.`);
    }

    const { setup } = migrateSetup(input);
    for (const key of ['id', 'name', 'version']) {
        if (!setup[key]) addError(`$.${key}`, `${key} is required.`);
    }

    if (!setup.stats.length) addWarning('$.stats', 'No stats are defined yet.');
    if (!setup.tiers.length) addError('$.tiers', 'At least one hierarchy tier is required.');

    const statKeys = new Set();
    setup.stats.forEach((stat, index) => {
        const path = `$.stats[${index}]`;
        if (!stat.key) addError(`${path}.key`, 'Stat key is required.');
        if (statKeys.has(stat.key)) addError(`${path}.key`, `Duplicate stat key: ${stat.key}`);
        if (stat.key) statKeys.add(stat.key);
        if (!Number.isFinite(stat.min) || !Number.isFinite(stat.max)) addError(path, 'Stat min and max must be numeric.');
        else if (stat.min >= stat.max) addError(path, 'Stat min must be lower than max.');
        if (!Number.isFinite(stat.default) || stat.default < stat.min || stat.default > stat.max) {
            addError(`${path}.default`, 'Stat default must be within min/max.');
        }
    });

    const tierIds = new Set();
    const tierKeys = new Set();
    setup.tiers.forEach((tier, index) => {
        const path = `$.tiers[${index}]`;
        if (!tier.id) addError(`${path}.id`, 'Tier id is required.');
        if (tierIds.has(tier.id)) addError(`${path}.id`, `Duplicate tier id: ${tier.id}`);
        if (tier.id) tierIds.add(tier.id);
        if (!tier.world_info_key) addError(`${path}.world_info_key`, 'World Info key is required.');
        if (tierKeys.has(tier.world_info_key)) addError(`${path}.world_info_key`, `Duplicate World Info key: ${tier.world_info_key}`);
        if (tier.world_info_key) tierKeys.add(tier.world_info_key);
        validateConditions(tier.requires, `${path}.requires`, statKeys, addError);
        if (index === 0 && tier.requires.length) addWarning(`${path}.requires`, 'The first tier normally has no conditions so the hierarchy always has an active tier.');
        if (index > 0 && !tier.requires.length) addWarning(`${path}.requires`, 'A later tier with no conditions will always override every earlier tier.');
    });

    return { valid: errors.length === 0, errors, warnings, setup };
}

function validateConditions(conditions, path, statKeys, addError) {
    if (!Array.isArray(conditions)) {
        addError(path, 'Conditions must be an array.');
        return;
    }
    const operators = new Set(['>', '>=']);
    conditions.forEach((condition, index) => {
        const conditionPath = `${path}[${index}]`;
        if (!statKeys.has(condition.stat)) addError(`${conditionPath}.stat`, `Unknown stat: ${condition.stat}`);
        if (!operators.has(condition.op)) addError(`${conditionPath}.op`, 'Tier conditions must use > or >= because stats never decrease.');
        if (!Number.isFinite(Number(condition.value))) addError(`${conditionPath}.value`, 'Condition value must be numeric.');
    });
}

export const validateScenario = validateSetup;
export const DEFAULT_SCENARIO = DEFAULT_SETUP;

export function evaluateCondition(condition, stats) {
    const actual = Number(stats?.[condition.stat]);
    const expected = Number(condition.value);
    if (condition.op === '>') return actual > expected;
    if (condition.op === '>=') return actual >= expected;
    return false;
}

export function passesConditions(conditions, stats) {
    return (conditions || []).every((condition) => evaluateCondition(condition, stats));
}

export function activeTier(state, setupInput) {
    const { setup } = migrateSetup(setupInput);
    let current = null;
    for (const tier of setup.tiers) {
        if (!passesConditions(tier.requires, state?.stats || {})) break;
        current = tier;
    }
    return current;
}

export function nextTier(state, setupInput) {
    const { setup } = migrateSetup(setupInput);
    const current = activeTier(state, setup);
    const index = current ? setup.tiers.findIndex((tier) => tier.id === current.id) : -1;
    return setup.tiers[index + 1] || null;
}

function evaluateHierarchy(state, setupInput) {
    const { setup } = migrateSetup(setupInput);
    const next = clone(state);
    const current = activeTier(next, setup);
    const currentIndex = current ? setup.tiers.findIndex((tier) => tier.id === current.id) : -1;
    next.activeTierId = current?.id || null;
    next.reachedTierIds = currentIndex >= 0 ? setup.tiers.slice(0, currentIndex + 1).map((tier) => tier.id) : [];
    return next;
}

export function initialState(input) {
    const { setup } = migrateSetup(input);
    const stats = {};
    for (const stat of setup.stats) stats[stat.key] = clamp(stat.default, stat.min, stat.max);
    return evaluateHierarchy({
        scenarioId: setup.id,
        scenarioVersion: setup.version,
        schemaVersion: SCHEMA_VERSION,
        stats,
        activeTierId: null,
        reachedTierIds: [],
        countedChanges: [],
        processedAssistantFingerprints: [],
        exchangeCounter: 0,
        lastJudgeResult: null,
        lastError: null,
        lastProcessedAssistantFingerprint: '',
        stale: null,
    }, setup);
}

export function normalizeState(input, setupInput) {
    const { setup } = migrateSetup(setupInput);
    if (!input || input.scenarioId !== setup.id) return initialState(setup);
    const next = clone(input);
    next.scenarioId = setup.id;
    next.scenarioVersion = setup.version;
    next.schemaVersion = SCHEMA_VERSION;
    next.stats = next.stats && typeof next.stats === 'object' ? next.stats : {};
    for (const stat of setup.stats) next.stats[stat.key] = clamp(next.stats[stat.key] ?? stat.default, stat.min, stat.max);
    for (const key of Object.keys(next.stats)) {
        if (!setup.stats.some((stat) => stat.key === key)) delete next.stats[key];
    }
    next.countedChanges = Array.isArray(next.countedChanges) ? next.countedChanges.map((entry) => ({
        description: String(entry?.description || ''),
        normalized: normalizeChange(entry?.normalized || entry?.description),
        stats: Array.isArray(entry?.stats) ? entry.stats.map(String) : [],
        messageFingerprint: String(entry?.messageFingerprint || ''),
    })).filter((entry) => entry.description && entry.normalized) : [];
    next.processedAssistantFingerprints = Array.isArray(next.processedAssistantFingerprints)
        ? next.processedAssistantFingerprints.map(String).slice(-200)
        : next.lastProcessedAssistantFingerprint ? [String(next.lastProcessedAssistantFingerprint)] : [];
    next.exchangeCounter = Math.max(0, Number(next.exchangeCounter) || 0);
    next.lastJudgeResult ||= null;
    next.lastError ||= null;
    next.lastProcessedAssistantFingerprint = String(next.lastProcessedAssistantFingerprint || '');
    next.stale ||= null;

    for (const obsolete of [
        'dayNumber', 'dateLabel', 'dayPartIndex', 'beatFlags', 'lastDecisionResult',
        'unlockedTierIds', 'activeLoreIds', 'availableOptionIds', 'takenOptions',
        'promptLayers', 'appearanceLayers', 'lastDeltas', 'lastUndo', 'eventLog',
    ]) delete next[obsolete];
    return evaluateHierarchy(next, setup);
}

export function setStat(state, statKey, value, setupInput) {
    const { setup } = migrateSetup(setupInput);
    const stat = setup.stats.find((candidate) => candidate.key === statKey);
    if (!stat) return { state, error: `Unknown stat: ${statKey}` };
    const before = Number(state.stats?.[statKey] ?? stat.default);
    const requested = clamp(value, stat.min, stat.max);
    if (requested < before) return { state, error: `${stat.label || stat.key} cannot decrease.` };
    const next = clone(state);
    next.stats[statKey] = requested;
    next.lastError = null;
    return { state: evaluateHierarchy(next, setup), error: null };
}

export function normalizeChange(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function judgeResults(payload) {
    if (!payload || typeof payload !== 'object') return [];
    return Array.isArray(payload.results) ? payload.results : [];
}

export function applyJudgeResult(state, payload, setupInput, messageFingerprint) {
    const { setup } = migrateSetup(setupInput);
    const fingerprint = String(messageFingerprint || '');
    const priorFingerprints = new Set(state.processedAssistantFingerprints || []);
    if (!fingerprint) return { state, error: 'The assistant message has no fingerprint.' };
    if (priorFingerprints.has(fingerprint)) return { state, error: null, duplicate: true, increments: {} };
    if (!payload || !Array.isArray(payload.results)) return { state, error: 'Judge result must contain a results array.' };

    const knownStats = new Set(setup.stats.map((stat) => stat.key));
    const previouslyCounted = new Set((state.countedChanges || []).map((entry) => normalizeChange(entry.normalized || entry.description)));
    const batchChanges = new Map();
    for (const result of judgeResults(payload)) {
        const statKey = String(result?.stat || '');
        if (!knownStats.has(statKey)) continue;
        const changes = Array.isArray(result?.new_changes) ? result.new_changes : [];
        for (const value of changes) {
            const description = String(value || '').trim();
            const normalized = normalizeChange(description);
            if (!normalized || previouslyCounted.has(normalized)) continue;
            const entry = batchChanges.get(normalized) || { description, normalized, stats: new Set() };
            entry.stats.add(statKey);
            batchChanges.set(normalized, entry);
        }
    }

    const next = clone(state);
    const increments = {};
    for (const stat of setup.stats) {
        const hasNewChange = [...batchChanges.values()].some((entry) => entry.stats.has(stat.key));
        if (!hasNewChange) continue;
        const before = Number(next.stats[stat.key] ?? stat.default);
        const after = clamp(before + 1, stat.min, stat.max);
        if (after > before) {
            next.stats[stat.key] = after;
            increments[stat.key] = 1;
        }
    }

    const newChanges = [...batchChanges.values()].map((entry) => ({
        description: entry.description,
        normalized: entry.normalized,
        stats: [...entry.stats],
        messageFingerprint: fingerprint,
    }));
    next.countedChanges = [...(next.countedChanges || []), ...newChanges];
    next.processedAssistantFingerprints = [...priorFingerprints, fingerprint].slice(-200);
    next.lastProcessedAssistantFingerprint = fingerprint;
    next.exchangeCounter = (Number(next.exchangeCounter) || 0) + 1;
    next.lastJudgeResult = { fingerprint, increments, newChanges };
    next.lastError = null;
    next.stale = null;
    return { state: evaluateHierarchy(next, setup), error: null, duplicate: false, increments, newChanges };
}

export function markStateStale(state, reason = 'The latest assistant message changed.') {
    const next = clone(state);
    next.stale = { reason, at: new Date().toISOString() };
    return next;
}

export function clearStateStale(state) {
    const next = clone(state);
    next.stale = null;
    return next;
}

export function buildStateBlock(state, setupInput, settings = {}) {
    if (!state || !setupInput || settings.promptInjectionMode === 'off') return '';
    const { setup } = migrateSetup(setupInput);
    const tier = activeTier(state, setup);
    const stats = setup.stats.map((stat) => `${stat.label || stat.key}: ${state.stats?.[stat.key] ?? stat.default}`).join(', ');
    return [
        '[Metamorph]',
        tier ? `World Info key: ${tier.world_info_key}` : 'World Info key: none',
        tier ? `Active transformation tier: ${tier.label}` : 'Active transformation tier: none',
        `Transformation stats: ${stats || 'none'}`,
        '[/Metamorph]',
    ].join('\n');
}

export function buildJudgePrompt(state, setupInput, latestAssistantMessage) {
    const { setup } = migrateSetup(setupInput);
    const statLines = setup.stats.map((stat) => (
        `- ${stat.key} (${stat.label || stat.key}), current ${state.stats[stat.key]}/${stat.max}: ${stat.description || ''} ${stat.judge_guidance || ''}`.trim()
    )).join('\n');
    const memory = (state.countedChanges || []).map((entry) => (
        `- ${entry.description} [${(entry.stats || []).join(', ')}]`
    )).join('\n');
    return [
        'You are the Metamorph new-change judge.',
        'Examine only the latest assistant message below. Identify concrete transformation changes first established in that message.',
        'Do not count a repeated description, continuation, existing trait, intention, hypothetical possibility, or another character merely mentioning an existing change.',
        'Compare semantically against the already-counted changes even when wording differs.',
        'A new change may apply to multiple stats. Include that same change under every appropriate stat.',
        'List every genuinely new change, even if several affect one stat. Metamorph itself applies at most +1 per stat per message.',
        'Output strict JSON only with this shape: {"results":[{"stat":"stat_key","new_changes":["short canonical description"]}]}',
        'Omit stats with no genuinely new changes. Do not output increments, negative values, prose, or markdown.',
        '',
        'Tracked stats:',
        statLines || '- none',
        setup.judge.prompt_guidance ? `Setup guidance: ${setup.judge.prompt_guidance}` : '',
        '',
        'Already-counted changes:',
        memory || '- none',
        '',
        'Latest assistant message:',
        latestAssistantMessage || '',
    ].filter(Boolean).join('\n');
}

export function parseJsonObject(text) {
    if (!text || typeof text !== 'string') return null;
    const trimmed = text.trim();
    try {
        const parsed = JSON.parse(trimmed);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch {
        const start = trimmed.indexOf('{');
        const end = trimmed.lastIndexOf('}');
        if (start < 0 || end <= start) return null;
        try {
            const parsed = JSON.parse(trimmed.slice(start, end + 1));
            return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
        } catch {
            return null;
        }
    }
}
