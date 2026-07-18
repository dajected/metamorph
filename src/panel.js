export function supportsPopover(element) {
    return Boolean(
        element
        && typeof element.showPopover === 'function'
        && typeof element.hidePopover === 'function'
        && typeof element.matches === 'function',
    );
}

function isPopoverOpen(element) {
    try {
        return element.matches(':popover-open');
    } catch {
        return false;
    }
}

export function syncPanelElement(element, open) {
    if (!element) return 'unavailable';
    element.classList.toggle('mm-panel-open', open);
    element.setAttribute('aria-hidden', String(!open));

    if (supportsPopover(element)) {
        try {
            element.removeAttribute('hidden');
            element.setAttribute('popover', 'manual');
            const popoverOpen = isPopoverOpen(element);
            if (open && !popoverOpen) element.showPopover();
            if (!open && popoverOpen) element.hidePopover();
            return 'popover';
        } catch (error) {
            console.warn('[Metamorph] Browser popover unavailable; using fixed panel fallback.', error);
            element.removeAttribute('popover');
        }
    }

    element.toggleAttribute('hidden', !open);
    return 'fallback';
}

export function bindPanelLauncher(element, { openPanel, onError, schedule = setTimeout }) {
    if (!element || element.dataset.mmBound === 'true') return;
    element.dataset.mmBound = 'true';

    const activate = (event) => {
        event?.preventDefault?.();
        schedule(() => {
            Promise.resolve()
                .then(openPanel)
                .catch(onError);
        }, 0);
    };

    element.addEventListener('click', activate);
    element.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        activate(event);
    });
}

export function bindPanelLifecycle(element, onClosed) {
    if (!element || element.dataset.mmLifecycleBound === 'true') return;
    element.dataset.mmLifecycleBound = 'true';
    element.addEventListener('toggle', (event) => {
        if (event.target && event.target !== element) return;
        if (event.newState === 'closed') onClosed();
    });
}
