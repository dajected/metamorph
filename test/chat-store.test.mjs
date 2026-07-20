import assert from 'node:assert/strict';
import {
    buildChatKey,
    ensureChatRecord,
    migrateChatStore,
    moveChatRecord,
} from '../src/chat-store.js';

const context = {
    characterId: 0,
    characters: [{ avatar: 'same-character.png' }],
};
const firstKey = buildChatKey(context, 'Chat one');
const secondKey = buildChatKey(context, 'Chat two');
assert.notEqual(firstKey, secondKey, 'different chats for one character need different storage keys');
assert.equal(buildChatKey(context, 'Chat one.jsonl'), firstKey, 'chat filenames should normalize their extension');

const legacy = {
    setup: { id: 'setup', stats: [{ key: 'change', default: 0 }] },
    binding: { judgeEnabled: true },
    state: { stats: { change: 7 }, countedChanges: ['existing'] },
};
const migration = migrateChatStore(legacy, firstKey);
assert.equal(migration.migrated, true);
assert.equal(migration.store.chats[firstKey].state.stats.change, 7, 'existing chat progress must survive migration');

const fresh = ensureChatRecord(migration.store, secondKey, (setup) => ({
    stats: Object.fromEntries(setup.stats.map((stat) => [stat.key, stat.default])),
    countedChanges: [],
}));
assert.equal(fresh.inherited, true, 'a copied chat should retain its tracker setup');
assert.equal(fresh.record.state.stats.change, 0, 'a copied chat must begin with fresh progress');
assert.notStrictEqual(fresh.record.state, migration.store.chats[firstKey].state, 'chat states must not share references');

fresh.record.state.stats.change = 3;
assert.equal(migration.store.chats[firstKey].state.stats.change, 7, 'editing one chat must not affect another');
fresh.record.state = { stats: { change: 0 }, countedChanges: [] };
assert.equal(migration.store.chats[firstKey].state.stats.change, 7, 'resetting one chat must not affect another');

const renamedKey = buildChatKey(context, 'Renamed chat');
assert.equal(moveChatRecord(migration.store, secondKey, renamedKey), true);
assert.equal(migration.store.chats[renamedKey].state.stats.change, 0, 'renaming a chat must preserve its own progress');
assert.equal(migration.store.chats[secondKey], undefined);

console.log('chat store tests passed');
