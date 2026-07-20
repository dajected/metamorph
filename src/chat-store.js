export const CHAT_STORE_VERSION = 1;

function cloneValue(value) {
    if (typeof structuredClone === 'function') return structuredClone(value);
    return value == null ? value : JSON.parse(JSON.stringify(value));
}

function normalizeChatId(value) {
    return String(value ?? '').trim().replace(/\.jsonl$/i, '');
}

function currentCharacterAvatar(context) {
    const character = typeof context?.characterId === 'number'
        ? context.characters?.[context.characterId]
        : null;
    return character?.avatar || (context?.characterId != null ? context.characterId : 'unknown');
}

export function buildChatKey(context, chatId = context?.getCurrentChatId?.() ?? context?.chatId, identity = {}) {
    const normalizedChatId = normalizeChatId(chatId);
    if (!normalizedChatId) return '';
    const groupId = identity.groupId ?? context?.groupId ?? context?.selected_group;
    const scope = groupId != null
        ? `group:${groupId}`
        : `character:${identity.avatarId || currentCharacterAvatar(context)}`;
    return `${scope}::chat:${normalizedChatId}`;
}

export function createChatStore() {
    return {
        storeVersion: CHAT_STORE_VERSION,
        activeChatKey: '',
        chats: {},
    };
}

export function isChatStore(value) {
    return Boolean(value
        && typeof value === 'object'
        && value.storeVersion === CHAT_STORE_VERSION
        && value.chats
        && typeof value.chats === 'object'
        && !Array.isArray(value.chats));
}

export function migrateChatStore(value, chatKey) {
    if (isChatStore(value)) return { store: value, migrated: false };
    const store = createChatStore();
    const hasLegacyData = value
        && typeof value === 'object'
        && (value.setup || value.binding || value.state);
    if (hasLegacyData && chatKey) {
        store.chats[chatKey] = value;
        store.activeChatKey = chatKey;
    }
    return { store, migrated: true };
}

export function ensureChatRecord(store, chatKey, initializeState) {
    if (!isChatStore(store) || !chatKey) return { record: null, created: false, inherited: false };
    if (store.chats[chatKey]) {
        store.activeChatKey = chatKey;
        return { record: store.chats[chatKey], created: false, inherited: false };
    }

    const template = store.chats[store.activeChatKey];
    const record = template?.setup
        ? {
            setup: cloneValue(template.setup),
            binding: cloneValue(template.binding || {}),
            state: initializeState(cloneValue(template.setup)),
        }
        : {};
    store.chats[chatKey] = record;
    store.activeChatKey = chatKey;
    return { record, created: true, inherited: Boolean(template?.setup) };
}

export function moveChatRecord(store, oldChatKey, newChatKey) {
    if (!isChatStore(store) || !oldChatKey || !newChatKey || oldChatKey === newChatKey) return false;
    if (!store.chats[oldChatKey] || store.chats[newChatKey]) return false;
    store.chats[newChatKey] = store.chats[oldChatKey];
    delete store.chats[oldChatKey];
    if (store.activeChatKey === oldChatKey) store.activeChatKey = newChatKey;
    return true;
}
