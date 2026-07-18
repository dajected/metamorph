const EXTENSION_NAME = 'Metamorph';
const MODULE_NAME = 'metamorph';
const LEGACY_MODULE_NAME = 'transformationDirector';
const PROMPT_KEY = `${MODULE_NAME}.stateBlock`;
const LEGACY_PROMPT_KEY = `${LEGACY_MODULE_NAME}.stateBlock`;
const BOOT_RETRY_MS = 500;
const BOOT_RETRY_LIMIT = 40;

let SCHEMA_VERSION;
let DEFAULT_SETUP;
let activeTier;
let nextTier;
let applyJudgeResult;
let buildJudgePrompt;
let buildStateBlock;
let clearStateStale;
let clone;
let initialState;
let markStateStale;
let migrateSetup;
let normalizeState;
let parseJsonObject;
let passesConditions;
let setStat;
let validateSetup;

const defaultSettings = Object.freeze({
    enabled: true,
    helperConnectionProfile: 'current',
    connectionProfiles: [],
    savedSetups: [],
    judgeEnabledByDefault: true,
    promptInjectionMode: 'compact',
    debugMode: false,
});

let initialized = false;
let initializing = false;
let eventsRegistered = false;
let bootAttempts = 0;
let reparentAttempts = 0;
let panelEl = null;
let launcherEl = null;
let settingsEl = null;
let panelOpen = false;
let postReplyBusy = false;
let lastFocusedBeforePanel = null;
let legacySettingsMigrated = false;
let legacyChatMigrated = false;
let setupDraft = null;
let setupDraftRoot = null;

function cloneValue(value) {
    if (typeof structuredClone === 'function') return structuredClone(value);
    return value == null ? value : JSON.parse(JSON.stringify(value));
}

async function loadEngine() {
    if (DEFAULT_SETUP) return;
    const engine = await import('./src/engine.js?v=0.5.0');
    ({
        SCHEMA_VERSION,
        DEFAULT_SETUP,
        activeTier,
        nextTier,
        applyJudgeResult,
        buildJudgePrompt,
        buildStateBlock,
        clearStateStale,
        clone,
        initialState,
        markStateStale,
        migrateSetup,
        normalizeState,
        parseJsonObject,
        passesConditions,
        setStat,
        validateSetup,
    } = engine);
}

function ctx() {
    return globalThis.SillyTavern?.getContext?.() || {};
}

function getSettings() {
    const context = ctx();
    context.extensionSettings ||= {};
    if (!context.extensionSettings[MODULE_NAME] && context.extensionSettings[LEGACY_MODULE_NAME]) {
        context.extensionSettings[MODULE_NAME] = cloneValue(context.extensionSettings[LEGACY_MODULE_NAME]);
        delete context.extensionSettings[LEGACY_MODULE_NAME];
        legacySettingsMigrated = true;
    }
    context.extensionSettings[MODULE_NAME] ||= cloneValue(defaultSettings);
    const settings = context.extensionSettings[MODULE_NAME];
    for (const [key, value] of Object.entries(defaultSettings)) {
        if (!Object.hasOwn(settings, key)) settings[key] = cloneValue(value);
    }
    for (const obsolete of [
        'autonomyEnabledByDefault', 'defaultLingerRecheckEveryTurns', 'timeEnabled',
        'showImagePreview', 'useCurrentPresetFallback', 'defaultStatCap', 'showLockedTierRequirements',
    ]) delete settings[obsolete];
    if (!['off', 'compact'].includes(settings.promptInjectionMode)) settings.promptInjectionMode = 'compact';
    return settings;
}

function saveSettings() {
    ctx().saveSettingsDebounced?.();
}

function getRoot(create = true) {
    const context = ctx();
    if (!context.chatMetadata) return null;
    if (!context.chatMetadata[MODULE_NAME] && context.chatMetadata[LEGACY_MODULE_NAME]) {
        context.chatMetadata[MODULE_NAME] = context.chatMetadata[LEGACY_MODULE_NAME];
        delete context.chatMetadata[LEGACY_MODULE_NAME];
        legacyChatMigrated = true;
    }
    if (create) context.chatMetadata[MODULE_NAME] ||= {};
    return context.chatMetadata[MODULE_NAME] || null;
}

async function saveMetadata() {
    await ctx().saveMetadata?.();
}

async function persistLegacyStorageMigration() {
    if (legacySettingsMigrated) {
        saveSettings();
        legacySettingsMigrated = false;
    }
    if (legacyChatMigrated) {
        await saveMetadata();
        legacyChatMigrated = false;
    }
}

function getCurrentCharacter() {
    const context = ctx();
    return typeof context.characterId === 'number' ? context.characters?.[context.characterId] || null : null;
}

function getCharacterName() {
    return getCurrentCharacter()?.name || ctx().name2 || getRoot(false)?.binding?.subject?.name || 'Current character';
}

function getSetup() {
    return getRoot(false)?.setup || null;
}

function getState() {
    const root = getRoot(false);
    if (!root?.setup) return null;
    root.state = normalizeState(root.state, root.setup);
    return root.state;
}

function isGroupChat() {
    const context = ctx();
    return context.groupId != null || context.selected_group != null;
}

async function migrateCurrentChatData() {
    const root = getRoot(false);
    if (!root?.setup) return false;
    const original = cloneValue(root);
    const validation = validateSetup(root.setup);
    if (!validation.valid) {
        console.error(`[${EXTENSION_NAME}] Existing setup could not be migrated`, validation.errors);
        return false;
    }
    try {
        root.setup = migrateSetup(root.setup).setup;
        root.state = normalizeState(root.state, root.setup);
        root.binding ||= {};
        if (!Object.hasOwn(root.binding, 'judgeEnabled')) root.binding.judgeEnabled = getSettings().judgeEnabledByDefault;
        if (!Object.hasOwn(root.binding, 'promptInjectionEnabled')) root.binding.promptInjectionEnabled = true;
        for (const obsolete of ['statCapOverride', 'autonomyEnabled', 'autoAdvanceEnabled', 'lingerRecheckEveryTurnsOverride']) delete root.binding[obsolete];
        if (JSON.stringify(original) !== JSON.stringify(root)) await saveMetadata();
        return true;
    } catch (error) {
        ctx().chatMetadata[MODULE_NAME] = original;
        notify(`Could not migrate this chat's transformation data: ${error.message}`, 'error');
        return false;
    }
}

async function startTracker(input = DEFAULT_SETUP, { confirmReplace = false } = {}) {
    const root = getRoot();
    if (!root) throw new Error('No active chat metadata is available.');
    if (confirmReplace && root.setup && !confirm('Replace the active Metamorph setup? Progress is preserved only when the setup ID stays the same.')) return false;
    const validation = validateSetup(input);
    if (!validation.valid) throw new Error(formatValidation(validation));
    const setup = migrateSetup(input).setup;
    const character = getCurrentCharacter();
    const sameScenario = root.setup?.id === setup.id;
    root.setup = clone(setup);
    root.binding = {
        subject: {
            type: 'character',
            name: character?.name || ctx().name2 || 'Current character',
            avatar: character?.avatar || '',
        },
        judgeEnabled: sameScenario ? root.binding?.judgeEnabled ?? getSettings().judgeEnabledByDefault : getSettings().judgeEnabledByDefault,
        promptInjectionEnabled: sameScenario ? root.binding?.promptInjectionEnabled ?? true : true,
    };
    root.state = sameScenario ? normalizeState(root.state, setup) : initialState(setup);
    setupDraft = clone(setup);
    setupDraftRoot = root;
    await saveMetadata();
    await refreshPromptInjection();
    await renderAll();
    notify(`Tracker active: ${setup.name}`);
    return true;
}

async function stopTracker() {
    if (!confirm('Stop Metamorph for this chat? Its setup and progress will be removed from this chat.')) return;
    const root = getRoot(false);
    if (!root) return;
    delete root.setup;
    delete root.binding;
    delete root.state;
    setupDraft = null;
    setupDraftRoot = root;
    await saveMetadata();
    await refreshPromptInjection();
    await renderAll();
}

function formatValidation(validation) {
    return (validation.errors || []).map((error) => `${error.path}: ${error.message}`).join('\n');
}

function validationHtml(validation) {
    const entries = [...(validation.errors || []), ...(validation.warnings || [])];
    if (!entries.length) return '<div class="mm-success">Setup is valid.</div>';
    return `<div class="mm-validation">${entries.map((entry) => `
        <div class="${entry.severity === 'error' ? 'mm-error' : 'mm-warning'}">
            <strong>${sanitizeHtml(entry.severity.toUpperCase())}: ${sanitizeHtml(entry.path)}</strong>
            <div>${sanitizeHtml(entry.message)}</div>
        </div>`).join('')}</div>`;
}

function sanitizeHtml(value) {
    const div = document.createElement('div');
    div.textContent = value ?? '';
    return div.innerHTML;
}

function escapeSelector(value) {
    return globalThis.CSS?.escape ? CSS.escape(String(value)) : String(value).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
}

function slugify(value, fallback = 'item') {
    const slug = String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    return slug || fallback;
}

function latestAssistantMessage() {
    const chat = ctx().chat || [];
    for (let index = chat.length - 1; index >= 0; index -= 1) {
        const message = chat[index];
        if (message?.is_user || message?.is_system) continue;
        return { index, message, text: String(message?.mes || '') };
    }
    return null;
}

function assistantFingerprint(entry = latestAssistantMessage()) {
    if (!entry) return '';
    const { index, message, text } = entry;
    return [index, message?.mesid ?? message?.id ?? '', message?.send_date ?? message?.gen_started ?? '', text].join('|');
}

function getSettingsContainer() {
    return document.querySelector('#extensions_settings2')
        || document.querySelector('#extensions_settings')
        || document.querySelector('#rm_extensions_block')
        || document.body;
}

function mountSettings() {
    if (!document.body) return false;
    settingsEl = document.getElementById('mm-settings') || settingsEl || document.createElement('div');
    settingsEl.id = 'mm-settings';
    const container = getSettingsContainer();
    if (container && settingsEl.parentElement !== container) container.appendChild(settingsEl);
    return Boolean(settingsEl.parentElement);
}

function normalizeConnectionProfiles(profiles) {
    if (!Array.isArray(profiles)) return [];
    return profiles.map((profile) => ({
        value: String(profile.value || `cm:${profile.id}`),
        label: String(profile.label || profile.name || profile.id),
        id: String(profile.id || String(profile.value || '').replace(/^cm:/, '')),
    })).filter((profile) => profile.id && profile.label);
}

function profileOptionsHtml() {
    const settings = getSettings();
    const options = [{ value: 'current', label: 'Current chat connection' }, ...normalizeConnectionProfiles(settings.connectionProfiles)];
    return options.map((option) => `<option value="${sanitizeHtml(option.value)}" ${settings.helperConnectionProfile === option.value ? 'selected' : ''}>${sanitizeHtml(option.label)}</option>`).join('');
}

function savedSetupOptionsHtml() {
    return (getSettings().savedSetups || []).map((entry) => `<option value="${sanitizeHtml(entry.id)}">${sanitizeHtml(entry.name)} · ${sanitizeHtml(entry.setup?.version || '')}</option>`).join('');
}

function ensureSetupDraft(setup = getSetup()) {
    const root = getRoot(false);
    if (!setup) {
        setupDraft = null;
        setupDraftRoot = root;
        return null;
    }
    if (!setupDraft || setupDraftRoot !== root) {
        setupDraft = clone(setup);
        setupDraftRoot = root;
    }
    return setupDraft;
}

function newStat() {
    const number = (setupDraft?.stats?.length || 0) + 1;
    return {
        key: `stat_${number}`,
        label: `Stat ${number}`,
        min: 0,
        max: 30,
        default: 0,
        description: '',
        judge_guidance: '',
    };
}

function newTier() {
    const number = (setupDraft?.tiers?.length || 0) + 1;
    const previous = setupDraft?.tiers?.at(-1);
    const previousThresholds = new Map((previous?.requires || []).map((condition) => [condition.stat, Number(condition.value)]));
    return {
        id: `tier_${number}`,
        label: `Tier ${number}`,
        description: '',
        world_info_key: `METAMORPH_TIER_${number}`,
        requires: (setupDraft?.stats || []).map((stat) => ({
            stat: stat.key,
            op: '>=',
            value: (previousThresholds.get(stat.key) ?? Number(stat.default) ?? 0) + 10,
        })),
    };
}

function renderSettings(validation = null) {
    if (!settingsEl) return;
    const settings = getSettings();
    const setup = getSetup();
    ensureSetupDraft(setup);
    const savedOptions = savedSetupOptionsHtml();
    settingsEl.innerHTML = `
        <div class="mm-settings inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header"><b>${EXTENSION_NAME}</b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div>
            <div class="inline-drawer-content">
                <details class="mm-settings-section mm-settings-collapsible">
                    <summary>Judge and extension settings</summary>
                    <label class="mm-check"><input id="mm-enabled" type="checkbox" ${settings.enabled ? 'checked' : ''}><span>Enabled</span></label>
                    <label>Helper judge connection profile<select id="mm-helper-profile">${profileOptionsHtml()}</select></label>
                    <button id="mm-refresh-profiles" type="button">Refresh connection profiles</button>
                    <label class="mm-check"><input id="mm-judge-default" type="checkbox" ${settings.judgeEnabledByDefault ? 'checked' : ''}><span>Judge enabled by default</span></label>
                    <label>Context injection<select id="mm-prompt-mode"><option value="compact" ${settings.promptInjectionMode === 'compact' ? 'selected' : ''}>on</option><option value="off" ${settings.promptInjectionMode === 'off' ? 'selected' : ''}>off</option></select></label>
                    <label class="mm-check"><input id="mm-debug" type="checkbox" ${settings.debugMode ? 'checked' : ''}><span>Debug mode</span></label>
                    <button id="mm-reset-settings" class="mm-danger" type="button">Reset extension settings</button>
                </details>
                <section class="mm-settings-section">
                    <h4>Setup library</h4>
                    <div class="mm-library-row"><select id="mm-library-select" aria-label="Saved setup">${savedOptions || '<option value="">No saved setups</option>'}</select><button id="mm-library-load" type="button" ${savedOptions ? '' : 'disabled'}>Load</button><button id="mm-library-delete" class="mm-danger" type="button" ${savedOptions ? '' : 'disabled'}>Delete</button></div>
                    <div class="mm-row"><button id="mm-start-blank" type="button">New blank setup</button><button id="mm-import-setup" type="button">Import JSON</button>${setup ? '<button id="mm-export-setup" type="button">Export current</button>' : ''}</div>
                </section>
                ${setupEditorHtml(setup, validation)}
            </div>
        </div>`;
    bindSettingsActions();
}

function setupEditorHtml(setup, validation) {
    if (!setup || !setupDraft) return '<section class="mm-settings-section"><h4>Tracker setup</h4><div class="mm-muted">Create a blank setup, load one from the library, or import JSON.</div></section>';
    return `
        <section class="mm-settings-section" id="mm-scenario-editor">
            <h4>Tracker setup</h4>
            <div class="mm-muted">Add stats and arrange the tier hierarchy without editing JSON.</div>
            <label>Setup name<input data-setup-field="name" value="${sanitizeHtml(setupDraft.name)}"></label>
            <label>Description<textarea data-setup-field="description">${sanitizeHtml(setupDraft.description || '')}</textarea></label>
            <details class="mm-card mm-edit-card"><summary>Advanced identity and judge guidance</summary>
                <div class="mm-field-grid"><label>Setup ID<input data-setup-field="id" value="${sanitizeHtml(setupDraft.id)}"></label><label>Version<input data-setup-field="version" value="${sanitizeHtml(setupDraft.version)}"></label></div>
                <label>Judge guidance<textarea data-judge-field="prompt_guidance">${sanitizeHtml(setupDraft.judge?.prompt_guidance || '')}</textarea></label>
            </details>
            <div class="mm-builder-section"><div class="mm-builder-title"><div><h4>Stats</h4><div class="mm-muted">Every confirmed new change adds one point.</div></div><button id="mm-add-stat" type="button">Add stat</button></div>${statsBuilderHtml()}</div>
            <div class="mm-builder-section"><div class="mm-builder-title"><div><h4>Tier hierarchy</h4><div class="mm-muted">The first tier is the starting tier. Later tiers require every listed condition.</div></div><button id="mm-add-tier" type="button">Add tier</button></div>${tiersBuilderHtml()}</div>
            <div class="mm-row"><button id="mm-save-setup" type="button">Save changes</button><button id="mm-save-library" type="button">Save to library</button></div>
            <div id="mm-validation-result">${validation ? validationHtml(validation) : ''}</div>
        </section>`;
}

function statsBuilderHtml() {
    if (!setupDraft.stats?.length) return '<div class="mm-empty-builder">No stats yet. Add the first stat to begin.</div>';
    return setupDraft.stats.map((stat, index) => `
        <div class="mm-builder-card" data-stat-index="${index}">
            <div class="mm-builder-head"><strong>${sanitizeHtml(stat.label || `Stat ${index + 1}`)}</strong><button class="mm-danger" data-remove-stat="${index}" type="button">Remove</button></div>
            <div class="mm-field-grid"><label>Label<input data-stat-field="label" value="${sanitizeHtml(stat.label || '')}"></label><label>Key<input data-stat-field="key" value="${sanitizeHtml(stat.key || '')}"></label><label>Maximum<input data-stat-field="max" type="number" min="1" value="${sanitizeHtml(stat.max ?? 30)}"></label><label>Starting value<input data-stat-field="default" type="number" min="0" max="${sanitizeHtml(stat.max ?? 30)}" value="${sanitizeHtml(stat.default ?? 0)}"></label></div>
            <label>Description<textarea data-stat-field="description">${sanitizeHtml(stat.description || '')}</textarea></label>
            <label>What should count?<textarea data-stat-field="judge_guidance">${sanitizeHtml(stat.judge_guidance || '')}</textarea></label>
        </div>`).join('');
}

function statOptions(selected) {
    return (setupDraft.stats || []).map((stat) => `<option value="${sanitizeHtml(stat.key)}" ${stat.key === selected ? 'selected' : ''}>${sanitizeHtml(stat.label || stat.key)}</option>`).join('');
}

function conditionsBuilderHtml(tier, tierIndex) {
    if (tierIndex === 0) return '<div class="mm-muted">Starting tier — always active until Tier 2 is reached.</div>';
    if (!tier.requires?.length) return '<div class="mm-empty-builder">No conditions yet.</div>';
    return `<div class="mm-condition-list">${tier.requires.map((condition, conditionIndex) => `
        <div class="mm-condition-row" data-tier-index="${tierIndex}" data-condition-index="${conditionIndex}">
            <select data-condition-field="stat" aria-label="Condition stat">${statOptions(condition.stat)}</select><span>reaches</span><input data-condition-field="value" aria-label="Condition threshold" type="number" min="0" value="${sanitizeHtml(condition.value)}"><button class="mm-danger" data-remove-condition="${conditionIndex}" type="button">Remove</button>
        </div>`).join('')}</div>`;
}

function tiersBuilderHtml() {
    return (setupDraft.tiers || []).map((tier, index) => `
        <div class="mm-builder-card" data-tier-index="${index}">
            <div class="mm-builder-head"><strong>${sanitizeHtml(tier.label || `Tier ${index + 1}`)}</strong><div class="mm-builder-actions">${index > 1 ? `<button data-move-tier-up="${index}" type="button" aria-label="Move ${sanitizeHtml(tier.label)} up">↑</button>` : ''}${index > 0 && index < setupDraft.tiers.length - 1 ? `<button data-move-tier-down="${index}" type="button" aria-label="Move ${sanitizeHtml(tier.label)} down">↓</button>` : ''}${index > 0 ? `<button class="mm-danger" data-remove-tier="${index}" type="button">Remove</button>` : ''}</div></div>
            <div class="mm-field-grid"><label>Label<input data-tier-field="label" value="${sanitizeHtml(tier.label || '')}"></label><label>World Info key<input data-tier-field="world_info_key" value="${sanitizeHtml(tier.world_info_key || '')}"></label></div>
            <label>Description<textarea data-tier-field="description">${sanitizeHtml(tier.description || '')}</textarea></label>
            <details class="mm-card mm-condition-editor" ${index === 0 ? '' : 'open'}><summary>${index === 0 ? 'Starting tier' : `Conditions (${tier.requires?.length || 0})`}</summary>${conditionsBuilderHtml(tier, index)}${index > 0 ? '<button data-add-condition type="button">Add condition</button>' : ''}</details>
        </div>`).join('');
}

function bindChange(selector, handler) {
    settingsEl.querySelector(selector)?.addEventListener('change', handler);
}

function bindSettingsActions() {
    bindChange('#mm-enabled', async (event) => { getSettings().enabled = event.target.checked; saveSettings(); await refreshPromptInjection(); await renderPanel(); });
    bindChange('#mm-helper-profile', (event) => { getSettings().helperConnectionProfile = event.target.value; saveSettings(); });
    bindChange('#mm-judge-default', (event) => { getSettings().judgeEnabledByDefault = event.target.checked; saveSettings(); });
    bindChange('#mm-prompt-mode', async (event) => { getSettings().promptInjectionMode = event.target.value; saveSettings(); await refreshPromptInjection(); await renderPanel(); });
    bindChange('#mm-debug', async (event) => { getSettings().debugMode = event.target.checked; saveSettings(); await renderPanel(); });
    settingsEl.querySelector('#mm-refresh-profiles')?.addEventListener('click', refreshConnectionProfiles);
    settingsEl.querySelector('#mm-start-blank')?.addEventListener('click', () => startTracker(DEFAULT_SETUP, { confirmReplace: true }).catch(showError));
    settingsEl.querySelector('#mm-import-setup')?.addEventListener('click', importSetupFile);
    settingsEl.querySelector('#mm-reset-settings')?.addEventListener('click', resetExtensionSettings);
    settingsEl.querySelector('#mm-library-load')?.addEventListener('click', loadSelectedLibrarySetup);
    settingsEl.querySelector('#mm-library-delete')?.addEventListener('click', deleteSelectedLibrarySetup);
    settingsEl.querySelector('#mm-save-setup')?.addEventListener('click', saveSetupDraft);
    settingsEl.querySelector('#mm-save-library')?.addEventListener('click', saveDraftToLibrary);
    settingsEl.querySelector('#mm-export-setup')?.addEventListener('click', () => setupDraft && downloadJson(`${slugify(setupDraft.name, 'metamorph-setup')}.json`, migrateSetup(setupDraft).setup));
    settingsEl.querySelector('#mm-add-stat')?.addEventListener('click', () => { setupDraft.stats.push(newStat()); renderSettings(); });
    settingsEl.querySelector('#mm-add-tier')?.addEventListener('click', () => { setupDraft.tiers.push(newTier()); renderSettings(); });
    bindSetupBuilderActions();
}

function bindSetupBuilderActions() {
    settingsEl.querySelectorAll('[data-setup-field]').forEach((input) => input.addEventListener('input', () => { setupDraft[input.dataset.setupField] = input.value; }));
    settingsEl.querySelectorAll('[data-judge-field]').forEach((input) => input.addEventListener('input', () => { setupDraft.judge ||= {}; setupDraft.judge[input.dataset.judgeField] = input.value; }));
    settingsEl.querySelectorAll('[data-stat-index]').forEach((card) => {
        const index = Number(card.dataset.statIndex);
        card.querySelectorAll('[data-stat-field]').forEach((input) => input.addEventListener('input', () => {
            const field = input.dataset.statField;
            const oldKey = setupDraft.stats[index].key;
            const value = ['max', 'default'].includes(field) ? Number(input.value) : input.value;
            setupDraft.stats[index][field] = value;
            setupDraft.stats[index].min = 0;
            if (field === 'key' && oldKey !== value) {
                for (const tier of setupDraft.tiers) for (const condition of tier.requires || []) if (condition.stat === oldKey) condition.stat = value;
            }
        }));
    });
    settingsEl.querySelectorAll('[data-remove-stat]').forEach((button) => button.addEventListener('click', () => {
        const [removed] = setupDraft.stats.splice(Number(button.dataset.removeStat), 1);
        for (const tier of setupDraft.tiers) tier.requires = (tier.requires || []).filter((condition) => condition.stat !== removed.key);
        renderSettings();
    }));
    settingsEl.querySelectorAll('[data-tier-index]').forEach((card) => {
        const tierIndex = Number(card.dataset.tierIndex);
        card.querySelectorAll('[data-tier-field]').forEach((input) => input.addEventListener('input', () => { setupDraft.tiers[tierIndex][input.dataset.tierField] = input.value; }));
        card.querySelectorAll('[data-condition-index]').forEach((row) => {
            const conditionIndex = Number(row.dataset.conditionIndex);
            row.querySelectorAll('[data-condition-field]').forEach((input) => input.addEventListener('change', () => {
                const field = input.dataset.conditionField;
                setupDraft.tiers[tierIndex].requires[conditionIndex][field] = field === 'value' ? Number(input.value) : input.value;
                setupDraft.tiers[tierIndex].requires[conditionIndex].op = '>=';
            }));
        });
        card.querySelectorAll('[data-remove-condition]').forEach((button) => button.addEventListener('click', () => { setupDraft.tiers[tierIndex].requires.splice(Number(button.dataset.removeCondition), 1); renderSettings(); }));
        card.querySelector('[data-add-condition]')?.addEventListener('click', () => {
            if (!setupDraft.stats.length) return notify('Add a stat before adding tier conditions.', 'error');
            setupDraft.tiers[tierIndex].requires.push({ stat: setupDraft.stats[0].key, op: '>=', value: 10 });
            renderSettings();
        });
    });
    settingsEl.querySelectorAll('[data-remove-tier]').forEach((button) => button.addEventListener('click', () => { setupDraft.tiers.splice(Number(button.dataset.removeTier), 1); renderSettings(); }));
    settingsEl.querySelectorAll('[data-move-tier-up]').forEach((button) => button.addEventListener('click', () => { const index = Number(button.dataset.moveTierUp); [setupDraft.tiers[index - 1], setupDraft.tiers[index]] = [setupDraft.tiers[index], setupDraft.tiers[index - 1]]; renderSettings(); }));
    settingsEl.querySelectorAll('[data-move-tier-down]').forEach((button) => button.addEventListener('click', () => { const index = Number(button.dataset.moveTierDown); [setupDraft.tiers[index + 1], setupDraft.tiers[index]] = [setupDraft.tiers[index], setupDraft.tiers[index + 1]]; renderSettings(); }));
}

async function refreshConnectionProfiles() {
    const profiles = ctx().extensionSettings?.connectionManager?.profiles;
    getSettings().connectionProfiles = Array.isArray(profiles)
        ? profiles.filter((profile) => profile?.id && profile?.name).map((profile) => ({ id: String(profile.id), value: `cm:${profile.id}`, label: String(profile.name) }))
        : [];
    saveSettings();
    renderSettings();
}

function selectedLibraryEntry() {
    const id = settingsEl.querySelector('#mm-library-select')?.value;
    return (getSettings().savedSetups || []).find((entry) => entry.id === id) || null;
}

async function loadSelectedLibrarySetup() {
    const entry = selectedLibraryEntry();
    if (entry) await startTracker(entry.setup, { confirmReplace: true });
}

function deleteSelectedLibrarySetup() {
    const entry = selectedLibraryEntry();
    if (!entry || !confirm(`Delete saved setup "${entry.name}"?`)) return;
    getSettings().savedSetups = getSettings().savedSetups.filter((candidate) => candidate.id !== entry.id);
    saveSettings();
    renderSettings();
}

function saveLibraryEntry(setup) {
    const settings = getSettings();
    const id = setup.id;
    const entry = { id, name: setup.name, setup: clone(setup) };
    const index = settings.savedSetups.findIndex((candidate) => candidate.id === id);
    if (index >= 0) settings.savedSetups[index] = entry;
    else settings.savedSetups.push(entry);
    saveSettings();
}

function showEditorValidation(validation) {
    const container = settingsEl.querySelector('#mm-validation-result');
    if (container) container.innerHTML = validationHtml(validation);
}

function validatedDraft() {
    setupDraft.id = slugify(setupDraft.id || setupDraft.name, 'setup');
    setupDraft.version = String(setupDraft.version || '1.0.0');
    setupDraft.schema_version = SCHEMA_VERSION;
    setupDraft.judge ||= { prompt_guidance: '' };
    const statKeyMap = new Map();
    for (const stat of setupDraft.stats || []) {
        const oldKey = stat.key;
        stat.key = slugify(stat.key || stat.label, 'stat');
        statKeyMap.set(oldKey, stat.key);
        stat.min = 0;
        stat.max = Number(stat.max);
        stat.default = Number(stat.default);
    }
    for (const [index, tier] of (setupDraft.tiers || []).entries()) {
        tier.id = slugify(tier.id || tier.label, `tier_${index + 1}`);
        tier.requires = index === 0 ? [] : (tier.requires || []).map((condition) => ({ stat: statKeyMap.get(condition.stat) || condition.stat, op: '>=', value: Number(condition.value) }));
    }
    const setup = migrateSetup(setupDraft).setup;
    const validation = validateSetup(setup);
    showEditorValidation(validation);
    return { setup, validation };
}

async function saveSetupDraft() {
    try {
        const { setup, validation } = validatedDraft();
        if (!validation.valid) return;
        const saved = await saveSetup(setup);
        if (saved === false) return;
        setupDraft = clone(setup);
        notify('Setup saved.');
    } catch (error) {
        showError(error);
    }
}

function saveDraftToLibrary() {
    try {
        const { setup, validation } = validatedDraft();
        if (!validation.valid) return;
        saveLibraryEntry(setup);
        renderSettings(validation);
        notify('Setup saved to library.');
    } catch (error) {
        showError(error);
    }
}

async function saveSetup(input) {
    const validation = validateSetup(input);
    if (!validation.valid) throw new Error(formatValidation(validation));
    const setup = migrateSetup(input).setup;
    const root = getRoot();
    const sameScenario = root.setup?.id === setup.id;
    if (!sameScenario && root.setup && !confirm('Changing the setup ID creates a new transformation state. Continue?')) return false;
    root.setup = setup;
    root.state = sameScenario ? normalizeState(root.state, setup) : initialState(setup);
    setupDraft = clone(setup);
    setupDraftRoot = root;
    await saveMetadata();
    await refreshPromptInjection();
    renderSettings(validation);
    await renderPanel();
    return true;
}

function importSetupFile() {
    chooseJsonFile(async (data) => { await startTracker(data, { confirmReplace: true }); });
}

function resetExtensionSettings() {
    if (!confirm('Reset all Metamorph global settings and delete the saved setup library? Current chat progress remains.')) return;
    ctx().extensionSettings[MODULE_NAME] = cloneValue(defaultSettings);
    saveSettings();
    renderSettings();
    renderPanel();
}

function chooseJsonFile(handler) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.addEventListener('change', async () => {
        const file = input.files?.[0];
        if (!file) return;
        try { await handler(JSON.parse(await file.text())); } catch (error) { showError(error); }
    });
    input.click();
}

function downloadJson(filename, data) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
}

async function copyText(text) {
    await navigator.clipboard.writeText(text);
    notify('Copied.');
}

function notify(message, type = 'success') {
    if (globalThis.toastr?.[type]) globalThis.toastr[type](message, EXTENSION_NAME);
    else console[type === 'error' ? 'error' : 'log'](`[${EXTENSION_NAME}] ${message}`);
}

function showError(error) {
    notify(error?.message || String(error), 'error');
}

function mountPanel() {
    if (!document.body) return false;
    panelEl = document.getElementById('mm-panel') || panelEl || document.createElement('aside');
    panelEl.id = 'mm-panel';
    panelEl.className = 'mm-panel';
    panelEl.setAttribute('role', 'dialog');
    panelEl.setAttribute('aria-label', EXTENSION_NAME);
    panelEl.setAttribute('aria-modal', 'false');
    if (panelEl.parentElement !== document.body) document.body.appendChild(panelEl);
    mountExtensionMenuButton();
    syncPanelVisibility();
    return true;
}

function mountExtensionMenuButton() {
    launcherEl = document.getElementById('mm-panel-launcher') || launcherEl || document.createElement('button');
    launcherEl.id = 'mm-panel-launcher';
    launcherEl.type = 'button';
    launcherEl.textContent = EXTENSION_NAME;
    launcherEl.className = 'menu_button mm-panel-launcher';
    launcherEl.setAttribute('aria-controls', 'mm-panel');
    launcherEl.setAttribute('aria-expanded', String(panelOpen));
    if (launcherEl.dataset.mmBound !== 'true') {
        launcherEl.dataset.mmBound = 'true';
        launcherEl.addEventListener('click', openPanel);
    }
    const menu = getExtensionMenuContainer();
    const target = menu || document.body;
    launcherEl.classList.toggle('mm-fallback-launcher', !menu);
    if (launcherEl.parentElement !== target) target.appendChild(launcherEl);
}

function getExtensionMenuContainer() {
    for (const selector of ['#extensionsMenu', '#extensions_menu', '#extensions_menu_panel', '#extensions_popup', '#extensionsMenuPopup', '.extensionsMenu', '.extensions-menu']) {
        const element = document.querySelector(selector);
        if (element && element !== launcherEl) return element;
    }
    return null;
}

function syncPanelVisibility() {
    if (!panelEl) return;
    panelEl.classList.toggle('mm-panel-open', panelOpen);
    panelEl.toggleAttribute('hidden', !panelOpen);
    launcherEl?.setAttribute('aria-expanded', String(panelOpen));
}

async function openPanel() {
    lastFocusedBeforePanel = document.activeElement;
    panelOpen = true;
    mountPanel();
    await loadEngine();
    await renderPanel();
    syncPanelVisibility();
    panelEl.querySelector('#mm-collapse')?.focus();
}

function closePanel() {
    panelOpen = false;
    syncPanelVisibility();
    lastFocusedBeforePanel?.focus?.();
}

function panelHeader() {
    return `<div class="mm-header"><strong>${EXTENSION_NAME}</strong><button id="mm-collapse" class="mm-icon-button" type="button" aria-label="Close Metamorph">×</button></div>`;
}

function conditionMet(condition, state) {
    return passesConditions([condition], state.stats);
}

function conditionTarget(condition) {
    return Number(condition.value) + (condition.op === '>' ? 1 : 0);
}

function nextTargetForStat(stat, followingTier) {
    const conditions = (followingTier?.requires || []).filter((condition) => condition.stat === stat.key);
    if (!conditions.length) return Number(stat.max);
    return Math.min(Number(stat.max), Math.max(...conditions.map(conditionTarget)));
}

function statHtml(stat, state, followingTier) {
    const value = Number(state.stats?.[stat.key] ?? stat.default);
    const target = nextTargetForStat(stat, followingTier);
    const start = Number(stat.min);
    const pct = target <= start ? 100 : ((value - start) / (target - start)) * 100;
    const targetLabel = followingTier && (followingTier.requires || []).some((condition) => condition.stat === stat.key) ? target : stat.max;
    return `<div class="mm-stat" title="${sanitizeHtml(stat.description || '')}">
        <div class="mm-stat-head"><span><strong>${sanitizeHtml(stat.label || stat.key)}</strong><small>${sanitizeHtml(stat.key)}</small></span><span>${sanitizeHtml(value)} / ${sanitizeHtml(targetLabel)}</span></div>
        <div class="mm-bar" role="progressbar" aria-label="${sanitizeHtml(stat.label || stat.key)}" aria-valuemin="${sanitizeHtml(start)}" aria-valuemax="${sanitizeHtml(targetLabel)}" aria-valuenow="${sanitizeHtml(value)}"><div style="width:${Math.max(0, Math.min(100, pct))}%"></div></div>
        <div class="mm-stat-edit"><input data-stat-key="${sanitizeHtml(stat.key)}" aria-label="Raise ${sanitizeHtml(stat.label || stat.key)} to" type="number" min="${sanitizeHtml(value)}" max="${sanitizeHtml(stat.max)}" value="${sanitizeHtml(value)}"><button data-stat-apply="${sanitizeHtml(stat.key)}" type="button">Raise to</button></div>
    </div>`;
}

function requirementHtml(condition, state, setup) {
    const stat = setup.stats.find((candidate) => candidate.key === condition.stat);
    const value = Number(state.stats?.[condition.stat] ?? stat?.default ?? 0);
    const met = conditionMet(condition, state);
    const target = conditionTarget(condition);
    return `<div class="mm-requirement ${met ? 'mm-met' : ''}"><span aria-hidden="true">${met ? '✓' : '○'}</span><strong>${sanitizeHtml(stat?.label || condition.stat)}</strong><span>${sanitizeHtml(value)} / ${sanitizeHtml(target)}</span></div>`;
}

function hierarchyHtml(setup, state, current) {
    const currentIndex = current ? setup.tiers.findIndex((tier) => tier.id === current.id) : -1;
    return setup.tiers.map((tier, index) => {
        const status = index < currentIndex ? 'passed' : index === currentIndex ? 'active' : 'locked';
        const symbol = status === 'passed' ? '✓' : status === 'active' ? '●' : '○';
        return `<div class="mm-tier-row mm-tier-${status}"><span class="mm-tier-symbol" aria-hidden="true">${symbol}</span><div><strong>${sanitizeHtml(tier.label || tier.id)}</strong><small>${status[0].toUpperCase()}${status.slice(1)}</small></div></div>`;
    }).join('');
}

function countedChangesHtml(state) {
    const changes = state.countedChanges || [];
    if (!changes.length) return '<div class="mm-muted">No changes have been counted yet.</div>';
    return `<ul class="mm-memory">${changes.map((entry) => `<li><span>${sanitizeHtml(entry.description)}</span><small>${sanitizeHtml((entry.stats || []).join(', '))}</small></li>`).join('')}</ul>`;
}

function debugHtml(state) {
    return `<details class="mm-section mm-collapsible"><summary>Debug data</summary><pre>${sanitizeHtml(JSON.stringify({ lastJudgeResult: state.lastJudgeResult, lastError: state.lastError, processedAssistantFingerprints: state.processedAssistantFingerprints }, null, 2))}</pre></details>`;
}

async function renderPanel() {
    if (!panelEl) return;
    const settings = getSettings();
    const root = getRoot(false);
    const setup = getSetup();
    const state = getState();
    if (!settings.enabled) {
        panelEl.innerHTML = `${panelHeader()}<div class="mm-muted">Extension disabled.</div>`;
        bindPanelHeader();
        return;
    }
    if (!root?.setup || !setup || !state) {
        panelEl.innerHTML = `${panelHeader()}<section class="mm-section"><h2>Transformation tracker</h2><div class="mm-muted">No tracker is active for this chat.</div><div class="mm-row"><button id="mm-panel-start" type="button">Start blank tracker</button><button id="mm-panel-import" type="button">Import setup</button></div></section>`;
        bindPanelHeader();
        panelEl.querySelector('#mm-panel-start')?.addEventListener('click', () => startTracker().catch(showError));
        panelEl.querySelector('#mm-panel-import')?.addEventListener('click', importSetupFile);
        return;
    }

    const current = activeTier(state, setup);
    const following = nextTier(state, setup);
    const promptBlock = buildStateBlock(state, setup, settings);
    panelEl.innerHTML = `${panelHeader()}
        ${isGroupChat() ? '<div class="mm-warning"><strong>Group chat limitation</strong><div>Metamorph tracks one subject per chat.</div></div>' : ''}
        ${state.stale ? `<div class="mm-warning"><strong>Latest message changed</strong><div>${sanitizeHtml(state.stale.reason)}</div><div class="mm-row"><button id="mm-rejudge-stale" type="button">Judge current message</button><button id="mm-clear-stale" type="button">Acknowledge</button></div></div>` : ''}
        <section class="mm-section mm-summary">
            <h2>${sanitizeHtml(setup.name)}</h2>
            <div class="mm-muted">Subject: ${sanitizeHtml(root.binding?.subject?.name || getCharacterName())}</div>
            <div class="mm-status-row"><span class="mm-badge ${root.binding?.judgeEnabled ? 'mm-on' : ''}">Judge ${root.binding?.judgeEnabled ? 'on' : 'paused'}</span><span class="mm-badge ${root.binding?.promptInjectionEnabled && settings.promptInjectionMode !== 'off' ? 'mm-on' : ''}">Context ${root.binding?.promptInjectionEnabled && settings.promptInjectionMode !== 'off' ? 'on' : 'off'}</span>${postReplyBusy ? '<span class="mm-badge mm-busy">Working…</span>' : ''}</div>
            <div class="mm-row"><button id="mm-run-judge" type="button" ${postReplyBusy ? 'disabled' : ''}>Judge latest message</button><button id="mm-toggle-judge" type="button">${root.binding?.judgeEnabled ? 'Pause judge' : 'Resume judge'}</button></div>
        </section>
        <section class="mm-section"><div class="mm-tier-hero"><span>Current tier</span><h3>${sanitizeHtml(current?.label || 'No active tier')}</h3>${current?.description ? `<p>${sanitizeHtml(current.description)}</p>` : ''}${current ? `<code>${sanitizeHtml(current.world_info_key)}</code>` : ''}</div></section>
        <section class="mm-section"><h3>Progress</h3>${setup.stats.length ? setup.stats.map((stat) => statHtml(stat, state, following)).join('') : '<div class="mm-muted">No stats are configured.</div>'}</section>
        <section class="mm-section"><h3>Next tier${following ? ` · ${sanitizeHtml(following.label)}` : ''}</h3>${following ? (following.requires.length ? following.requires.map((condition) => requirementHtml(condition, state, setup)).join('') : '<div class="mm-muted">No conditions configured.</div>') : '<div class="mm-success">Final tier reached.</div>'}</section>
        <section class="mm-section"><h3>Hierarchy</h3><div class="mm-hierarchy">${hierarchyHtml(setup, state, current)}</div></section>
        <details class="mm-section mm-collapsible"><summary>Context injection</summary><label class="mm-check"><input id="mm-prompt-enabled" type="checkbox" ${root.binding?.promptInjectionEnabled ? 'checked' : ''}><span>Inject the current tier and scan it for World Info</span></label><div class="mm-row"><button id="mm-toggle-prompt" type="button" aria-expanded="false">Show context</button><button id="mm-copy-prompt" type="button" ${promptBlock ? '' : 'disabled'}>Copy context</button></div><pre id="mm-prompt-block" hidden>${sanitizeHtml(promptBlock || 'Context injection is disabled or empty.')}</pre></details>
        <details class="mm-section mm-collapsible"><summary>Counted-change memory (${sanitizeHtml((state.countedChanges || []).length)})</summary><div class="mm-muted">Used by the judge to avoid counting the same transformation twice.</div>${countedChangesHtml(state)}</details>
        ${settings.debugMode ? debugHtml(state) : ''}
        <details class="mm-section mm-collapsible mm-danger-zone"><summary>Tracker controls</summary><div class="mm-row"><button id="mm-reset-state" class="mm-danger" type="button">Reset progress</button><button id="mm-stop" class="mm-danger" type="button">Stop tracker</button></div></details>`;
    bindPanelActions();
}

function bindPanelHeader() {
    panelEl.querySelector('#mm-collapse')?.addEventListener('click', closePanel);
}

function bindPanelActions() {
    bindPanelHeader();
    const root = getRoot(false);
    const setup = getSetup();
    if (!root || !setup) return;
    panelEl.querySelector('#mm-run-judge')?.addEventListener('click', () => runPostReplyWorkflow({ forceJudge: true }));
    panelEl.querySelector('#mm-rejudge-stale')?.addEventListener('click', () => runPostReplyWorkflow({ forceJudge: true }));
    panelEl.querySelector('#mm-clear-stale')?.addEventListener('click', async () => updateState(clearStateStale(root.state)));
    panelEl.querySelector('#mm-toggle-judge')?.addEventListener('click', async () => { root.binding.judgeEnabled = !root.binding.judgeEnabled; await saveMetadata(); await renderPanel(); });
    panelEl.querySelectorAll('[data-stat-key]').forEach((input) => input.addEventListener('keydown', (event) => { if (event.key === 'Enter') commitStatInput(input); }));
    panelEl.querySelectorAll('[data-stat-apply]').forEach((button) => button.addEventListener('click', () => { const input = panelEl.querySelector(`[data-stat-key="${escapeSelector(button.dataset.statApply)}"]`); if (input) commitStatInput(input); }));
    panelEl.querySelector('#mm-prompt-enabled')?.addEventListener('change', async (event) => { root.binding.promptInjectionEnabled = event.target.checked; await saveMetadata(); await refreshPromptInjection(); await renderPanel(); });
    panelEl.querySelector('#mm-toggle-prompt')?.addEventListener('click', (event) => { const block = panelEl.querySelector('#mm-prompt-block'); const show = block.hasAttribute('hidden'); block.toggleAttribute('hidden', !show); event.currentTarget.setAttribute('aria-expanded', String(show)); event.currentTarget.textContent = show ? 'Hide context' : 'Show context'; });
    panelEl.querySelector('#mm-copy-prompt')?.addEventListener('click', () => copyText(buildStateBlock(root.state, setup, getSettings())).catch(showError));
    panelEl.querySelector('#mm-reset-state')?.addEventListener('click', async () => { if (!confirm('Reset all transformation progress and counted-change memory for this chat?')) return; root.state = initialState(setup); await saveMetadata(); await refreshPromptInjection(); await renderPanel(); });
    panelEl.querySelector('#mm-stop')?.addEventListener('click', stopTracker);
}

async function commitStatInput(input) {
    const result = setStat(getState(), input.dataset.statKey, Number(input.value), getSetup());
    if (result.error) {
        input.value = getState().stats[input.dataset.statKey];
        return notify(result.error, 'error');
    }
    await updateState(result.state);
}

async function updateState(state) {
    const root = getRoot(false);
    if (!root) return;
    root.state = state;
    await saveMetadata();
    await refreshPromptInjection();
    await renderPanel();
}

async function runPostReplyWorkflow({ forceJudge = false } = {}) {
    if (postReplyBusy) return;
    postReplyBusy = true;
    await renderPanel();
    try {
        const settings = getSettings();
        const root = getRoot(false);
        const setup = getSetup();
        const state = getState();
        if (!settings.enabled || !root?.binding || !setup || !state) return;
        if (state.stale && !forceJudge) return;
        if (!root.binding.judgeEnabled && !forceJudge) return;
        if (!setup.stats.length) throw new Error('No stats are configured for the helper judge.');
        const latest = latestAssistantMessage();
        if (!latest?.text) throw new Error('No assistant message is available to judge.');
        const fingerprint = assistantFingerprint(latest);
        if ((state.processedAssistantFingerprints || []).includes(fingerprint)) return;
        const prompt = buildJudgePrompt(state, setup, latest.text);
        const raw = await generateHelper(prompt);
        const parsed = parseJsonObject(raw);
        if (!parsed) throw new Error('The helper judge did not return valid JSON.');
        const result = applyJudgeResult(state, parsed, setup, fingerprint);
        if (result.error) throw new Error(result.error);
        root.state = result.state;
        await saveMetadata();
        await refreshPromptInjection();
        const increments = Object.keys(result.increments || {});
        notify(increments.length ? `New change counted for: ${increments.join(', ')}.` : 'No new transformation change found.');
    } catch (error) {
        const root = getRoot(false);
        if (root?.state) {
            root.state.lastError = { type: 'judge_error', message: error.message, at: new Date().toISOString() };
            await saveMetadata();
        }
        notify(`Judge failed: ${error.message}`, 'error');
    } finally {
        postReplyBusy = false;
        await renderPanel();
    }
}

async function generateHelper(prompt) {
    const context = ctx();
    const settings = getSettings();
    if (settings.debugMode) console.debug(`[${EXTENSION_NAME}] judge prompt`, prompt);
    const selected = settings.helperConnectionProfile || 'current';
    if (selected.startsWith('cm:')) {
        const service = context.ConnectionManagerRequestService;
        if (!service?.sendRequest) throw new Error('SillyTavern Connection Manager is unavailable.');
        return String(await service.sendRequest(selected.slice(3), prompt, 500, { stream: false, extractData: true, includePreset: true, includeInstruct: true }) ?? '').trim();
    }
    if (typeof context.generateRaw !== 'function') throw new Error('SillyTavern raw generation is unavailable.');
    return String(await context.generateRaw({ prompt, responseLength: 500, trimNames: false }) ?? '').trim();
}

async function markCurrentStateAsStale(reason) {
    const root = getRoot(false);
    if (!root?.state || root.state.stale?.reason === reason) return;
    root.state = markStateStale(root.state, reason);
    await saveMetadata();
    await renderPanel();
}

async function refreshPromptInjection() {
    const context = ctx();
    if (typeof context.setExtensionPrompt !== 'function') return;
    const settings = getSettings();
    const root = getRoot(false);
    const setup = getSetup();
    const state = getState();
    const enabled = settings.enabled && root?.binding?.promptInjectionEnabled && setup && state;
    context.setExtensionPrompt(LEGACY_PROMPT_KEY, '', 1, 4, false, 0);
    context.setExtensionPrompt(PROMPT_KEY, enabled ? buildStateBlock(state, setup, settings) : '', 1, 4, true, 0);
}

globalThis.metamorphGenerateInterceptor = async function metamorphGenerateInterceptor(chat, contextSize, abort, type) {
    if (['regenerate', 'swipe'].includes(type)) await markCurrentStateAsStale(`A ${type} changed the latest assistant message.`);
    if (type === 'quiet') return;
    await refreshPromptInjection();
    const context = ctx();
    if (typeof context.setExtensionPrompt === 'function') return;
    const settings = getSettings();
    const root = getRoot(false);
    const setup = getSetup();
    const state = getState();
    if (!settings.enabled || !root?.binding?.promptInjectionEnabled || !setup || !state || chat === context.chat) return;
    const block = buildStateBlock(state, setup, settings);
    if (block) chat.splice(Math.max(0, chat.length - 1), 0, { is_user: false, is_system: true, name: EXTENSION_NAME, send_date: Date.now(), mes: block });
};

function onEvent(source, eventName, handler) {
    if (eventName) source.on(eventName, handler);
}

function registerEvents() {
    if (eventsRegistered) return true;
    const context = ctx();
    const events = context.eventTypes || context.event_types || {};
    const source = context.eventSource;
    if (!source?.on) return false;
    onEvent(source, events.APP_READY, renderAll);
    onEvent(source, events.CHAT_CHANGED, async () => { await migrateCurrentChatData(); await persistLegacyStorageMigration(); await refreshPromptInjection(); await renderAll(); });
    onEvent(source, events.MESSAGE_RECEIVED, () => runPostReplyWorkflow());
    onEvent(source, events.CHARACTER_MESSAGE_RENDERED, () => runPostReplyWorkflow());
    for (const [key, reason] of [
        ['MESSAGE_EDITED', 'The latest chat message was edited.'],
        ['MESSAGE_DELETED', 'A chat message was deleted.'],
        ['MESSAGES_DELETED', 'Multiple chat messages were deleted.'],
        ['MESSAGE_SWIPED', 'The latest assistant message was swiped.'],
        ['MESSAGE_UPDATED', 'The latest chat message was updated.'],
    ]) onEvent(source, events[key], () => markCurrentStateAsStale(reason));
    onEvent(source, events.SETTINGS_UPDATED, renderSettings);
    onEvent(source, events.CONNECTION_PROFILE_CREATED, refreshConnectionProfiles);
    onEvent(source, events.CONNECTION_PROFILE_UPDATED, refreshConnectionProfiles);
    onEvent(source, events.CONNECTION_PROFILE_DELETED, refreshConnectionProfiles);
    eventsRegistered = true;
    return true;
}

async function renderAll() {
    mountSettings();
    mountPanel();
    renderSettings();
    await renderPanel();
}

function renderBootPanel(message, error = null) {
    mountPanel();
    panelEl.innerHTML = `${panelHeader()}<div class="mm-muted">${sanitizeHtml(message)}</div>${error ? `<pre>${sanitizeHtml(error.stack || error.message || String(error))}</pre>` : ''}`;
    bindPanelHeader();
}

async function init() {
    if (initialized || initializing) return;
    if (!document.body) return scheduleInitRetry();
    initializing = true;
    try {
        mountPanel();
        renderBootPanel('Loading…');
        await loadEngine();
        getSettings();
        mountSettings();
        registerEvents();
        await migrateCurrentChatData();
        await persistLegacyStorageMigration();
        await refreshPromptInjection();
        await renderAll();
        initialized = true;
        bootAttempts = 0;
        scheduleSettingsReparent();
        console.info(`[${EXTENSION_NAME}] loaded`);
    } catch (error) {
        console.error(`[${EXTENSION_NAME}] failed to initialize`, error);
        renderBootPanel('Could not initialize. The extension will retry automatically.', error);
        scheduleInitRetry();
    } finally {
        initializing = false;
    }
}

function scheduleInitRetry() {
    if (bootAttempts >= BOOT_RETRY_LIMIT) return;
    bootAttempts += 1;
    setTimeout(() => { if (!initialized) init(); }, BOOT_RETRY_MS);
}

function scheduleSettingsReparent() {
    if (reparentAttempts >= BOOT_RETRY_LIMIT) return;
    reparentAttempts += 1;
    setTimeout(() => { mountSettings(); mountExtensionMenuButton(); scheduleSettingsReparent(); }, BOOT_RETRY_MS);
}

document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && panelOpen) closePanel(); });

export async function onActivate() { await init(); }
export async function onEnable() { getSettings().enabled = true; saveSettings(); await refreshPromptInjection(); await renderAll(); }
export async function onDisable() { getSettings().enabled = false; saveSettings(); await refreshPromptInjection(); await renderAll(); }

export async function onClean() {
    const context = ctx();
    if (context.chatMetadata) {
        delete context.chatMetadata[MODULE_NAME];
        delete context.chatMetadata[LEGACY_MODULE_NAME];
        await saveMetadata();
    }
    if (context.extensionSettings) {
        delete context.extensionSettings[MODULE_NAME];
        delete context.extensionSettings[LEGACY_MODULE_NAME];
        saveSettings();
    }
    if (typeof context.setExtensionPrompt === 'function') {
        context.setExtensionPrompt(PROMPT_KEY, '', 1, 4, true, 0);
        context.setExtensionPrompt(LEGACY_PROMPT_KEY, '', 1, 4, false, 0);
    }
    await renderAll();
}

globalThis.Metamorph = { init, renderAll, renderSettings, renderPanel, openPanel, closePanel, getSettings, getRoot };

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
