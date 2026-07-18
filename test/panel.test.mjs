import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { bindPanelLauncher, bindPanelLifecycle, syncPanelElement } from '../src/panel.js';

class FakeClassList {
    values = new Set();

    toggle(value, force) {
        if (force) this.values.add(value);
        else this.values.delete(value);
    }

    contains(value) {
        return this.values.has(value);
    }
}

class FakeElement {
    constructor({ popover = false } = {}) {
        this.attributes = new Map();
        this.classList = new FakeClassList();
        this.dataset = {};
        this.listeners = new Map();
        this.popoverOpen = false;
        if (popover) {
            this.showPopover = () => { this.popoverOpen = true; };
            this.hidePopover = () => { this.popoverOpen = false; };
            this.matches = (selector) => selector === ':popover-open' && this.popoverOpen;
        }
    }

    addEventListener(type, listener) {
        const listeners = this.listeners.get(type) || [];
        listeners.push(listener);
        this.listeners.set(type, listeners);
    }

    dispatch(type, event = {}) {
        for (const listener of this.listeners.get(type) || []) listener(event);
    }

    setAttribute(name, value) {
        this.attributes.set(name, String(value));
    }

    removeAttribute(name) {
        this.attributes.delete(name);
    }

    toggleAttribute(name, force) {
        if (force) this.attributes.set(name, '');
        else this.attributes.delete(name);
    }

    hasAttribute(name) {
        return this.attributes.has(name);
    }

    getAttribute(name) {
        return this.attributes.get(name) ?? null;
    }
}

const popoverPanel = new FakeElement({ popover: true });
assert.equal(syncPanelElement(popoverPanel, true), 'popover');
assert.equal(popoverPanel.popoverOpen, true);
assert.equal(popoverPanel.classList.contains('mm-panel-open'), true);
assert.equal(popoverPanel.getAttribute('aria-hidden'), 'false');
assert.equal(popoverPanel.getAttribute('popover'), 'manual');

assert.equal(syncPanelElement(popoverPanel, false), 'popover');
assert.equal(popoverPanel.popoverOpen, false);
assert.equal(popoverPanel.classList.contains('mm-panel-open'), false);
assert.equal(popoverPanel.getAttribute('aria-hidden'), 'true');

const fallbackPanel = new FakeElement();
assert.equal(syncPanelElement(fallbackPanel, true), 'fallback');
assert.equal(fallbackPanel.hasAttribute('hidden'), false);
assert.equal(syncPanelElement(fallbackPanel, false), 'fallback');
assert.equal(fallbackPanel.hasAttribute('hidden'), true);

const scheduled = [];
const launcher = new FakeElement();
let openCount = 0;
let prevented = false;
bindPanelLauncher(launcher, {
    openPanel: () => { openCount += 1; },
    onError: assert.fail,
    schedule: (callback) => scheduled.push(callback),
});
bindPanelLauncher(launcher, {
    openPanel: assert.fail,
    onError: assert.fail,
    schedule: assert.fail,
});

launcher.dispatch('click', { preventDefault: () => { prevented = true; } });
assert.equal(prevented, true);
assert.equal(openCount, 0, 'activation waits until the host menu click has finished bubbling');
assert.equal(scheduled.length, 1, 'binding is idempotent');
scheduled.shift()();
await Promise.resolve();
assert.equal(openCount, 1);

launcher.dispatch('keydown', { key: 'ArrowDown', preventDefault: assert.fail });
assert.equal(scheduled.length, 0);
launcher.dispatch('keydown', { key: 'Enter', preventDefault: () => {} });
assert.equal(scheduled.length, 1);
scheduled.shift()();
await Promise.resolve();
assert.equal(openCount, 2);

const failingLauncher = new FakeElement();
let reportedError = null;
bindPanelLauncher(failingLauncher, {
    openPanel: () => { throw new Error('render failed'); },
    onError: (error) => { reportedError = error; },
    schedule: (callback) => callback(),
});
failingLauncher.dispatch('click', { preventDefault: () => {} });
await Promise.resolve();
await Promise.resolve();
assert.match(reportedError?.message || '', /render failed/);

const lifecyclePanel = new FakeElement();
let closedCount = 0;
bindPanelLifecycle(lifecyclePanel, () => { closedCount += 1; });
bindPanelLifecycle(lifecyclePanel, assert.fail);
lifecyclePanel.dispatch('toggle', { newState: 'open' });
lifecyclePanel.dispatch('toggle', { newState: 'closed', target: new FakeElement() });
lifecyclePanel.dispatch('toggle', { newState: 'closed' });
assert.equal(closedCount, 1);

const stylesheet = readFileSync(new URL('../style.css', import.meta.url), 'utf8');
assert.match(stylesheet, /max-height:\s*min\(78vh,\s*720px\)/, 'mobile panel needs a legacy viewport-height fallback');
assert.match(stylesheet, /max-height:\s*min\(78dvh,\s*720px\)/, 'mobile panel should follow the dynamic viewport when supported');
assert.match(stylesheet, /touch-action:\s*pan-y/, 'mobile panel must retain vertical touch scrolling');

console.log('panel tests passed');
