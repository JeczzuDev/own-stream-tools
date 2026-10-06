/*
 * Deck rendering: layout -> DOM grid, state -> visual classes.
 * Pure DOM module; networking lives in app.js and reaches us through
 * the onPress callback given to init().
 */

'use strict';

const $grid = document.querySelector('[data-role="grid"]');
const $tabs = document.querySelector('[data-role="tabs"]');
const $toast = document.querySelector('[data-role="toast"]');

let pages = [];
let activePageId = null;
let onPressCallback = null;
/* pressId -> buttonId, so acks can flash the right button */
const pendingPresses = new Map();
/* buttonId -> { el, action } for state rendering */
const buttonIndex = new Map();
let lastState = null;
let toastTimer = null;

/* swipe navigation */
const SWIPE_THRESHOLD = 55; // min horizontal px to change page
let swipe = null;
/* a swipe ends with a click event on the button under the finger; ignore
 * clicks for a moment after a swipe so navigation never fires a button */
let suppressClickUntil = 0;

export function init(onPress) {
    onPressCallback = onPress;
    initSwipe();
}

export function renderLayout(newPages) {
    pages = newPages;
    if (!pages.some((p) => p.id === activePageId)) {
        activePageId = pages.length ? pages[0].id : null;
    }
    renderTabs();
    renderGrid();
    if (lastState) renderState(lastState);
}

export function renderState(state) {
    lastState = state;
    for (const { el, action } of buttonIndex.values()) {
        el.classList.toggle('is-disabled', isObsAction(action) && !state.obsConnected);
        el.classList.toggle('is-active', isActionActive(action, state));
        el.classList.toggle(
            'is-muted',
            action.type === 'obs.mute' && state.mutes[action.input] === true
        );
    }
}

export function handleAck(pressId, ok, error) {
    const buttonId = pendingPresses.get(pressId);
    pendingPresses.delete(pressId);
    if (!buttonId) return;
    const entry = buttonIndex.get(buttonId);
    if (!entry) return;
    flash(entry.el, ok ? 'flash-ok' : 'flash-error');
    if (!ok && error) showToast(error);
}

export function showToast(text) {
    $toast.textContent = text;
    $toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
        $toast.hidden = true;
    }, 4000);
}

/* ------------------------------------------------------------------ */

function isObsAction(action) {
    if (action.type.startsWith('obs.')) return true;
    if (action.type === 'macro') {
        return action.steps.some((s) => s.action && s.action.type.startsWith('obs.'));
    }
    return false;
}

function isActionActive(action, state) {
    switch (action.type) {
        case 'obs.scene':
            return action.scene === state.currentScene;
        case 'obs.stream':
            return state.streaming;
        case 'obs.record':
            return state.recording;
        case 'obs.sourceVisibility':
        {
            /* multi-scene: the first scene is the reference (same one toggle reads) */
            const scene = Array.isArray(action.scene) ? action.scene[0] : action.scene;
            return state.sourceVisibility[`${scene}/${action.source}`] === true;
        }
        case 'obs.filter':
            return state.filters[`${action.source}/${action.filter}`] === true;
        default:
            return false;
    }
}

function renderTabs() {
    $tabs.innerHTML = '';
    $tabs.hidden = pages.length <= 1;
    for (const page of pages) {
        const tab = document.createElement('button');
        tab.type = 'button';
        tab.className = 'tab';
        tab.textContent = page.label;
        tab.classList.toggle('is-current', page.id === activePageId);
        tab.addEventListener('click', () => goToPage(page.id));
        $tabs.appendChild(tab);
    }
}

/* ------------------------------------------------------------------ */
/* Page navigation (tabs, swipe, arrow keys)                          */
/* ------------------------------------------------------------------ */

function goToPage(pageId, dir = 0) {
    if (pageId === activePageId) return;
    activePageId = pageId;
    renderTabs();
    renderGrid();
    if (lastState) renderState(lastState);
    if (dir !== 0) {
        $grid.classList.remove('slide-from-left', 'slide-from-right');
        void $grid.offsetWidth; // restart the animation
        $grid.classList.add(dir < 0 ? 'slide-from-right' : 'slide-from-left');
    }
}

/* delta: +1 next page, -1 previous. Does not wrap around the ends. */
function stepPage(delta) {
    const i = pages.findIndex((p) => p.id === activePageId);
    const next = i + delta;
    if (i < 0 || next < 0 || next >= pages.length) return;
    goToPage(pages[next].id, delta);
}

function initSwipe() {
    $grid.addEventListener('pointerdown', onSwipeStart);
    document.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowRight') stepPage(1);
        else if (e.key === 'ArrowLeft') stepPage(-1);
    });
}

function onSwipeStart(e) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    swipe = { x0: e.clientX, y0: e.clientY, id: e.pointerId, fired: false };
    /* listen on window so a drag that leaves the grid still completes */
    window.addEventListener('pointermove', onSwipeMove);
    window.addEventListener('pointerup', onSwipeEnd);
    window.addEventListener('pointercancel', onSwipeEnd);
}

/* Decide during the drag, not at release: this fires the moment the
 * finger crosses the threshold, so it still works even if the browser
 * later cancels the pointer (which is what silently killed swipes that
 * only checked at pointerup). */
function onSwipeMove(e) {
    if (!swipe || e.pointerId !== swipe.id || swipe.fired) return;
    const dx = e.clientX - swipe.x0;
    const dy = e.clientY - swipe.y0;
    if (Math.abs(dx) > SWIPE_THRESHOLD && Math.abs(dx) > Math.abs(dy) * 1.3) {
        swipe.fired = true;
        suppressClickUntil = Date.now() + 600; // the release will fire a click; ignore it
        for (const { el } of buttonIndex.values()) el.classList.remove('pressed');
        stepPage(dx < 0 ? 1 : -1);
    }
}

function onSwipeEnd() {
    window.removeEventListener('pointermove', onSwipeMove);
    window.removeEventListener('pointerup', onSwipeEnd);
    window.removeEventListener('pointercancel', onSwipeEnd);
    swipe = null;
}

function renderGrid() {
    $grid.innerHTML = '';
    buttonIndex.clear();
    const page = pages.find((p) => p.id === activePageId);
    if (!page) return;

    $grid.style.gridTemplateColumns = `repeat(${page.grid.cols}, 1fr)`;
    $grid.style.gridTemplateRows = `repeat(${page.grid.rows}, 1fr)`;

    for (const cell of page.buttons) {
        if (!('id' in cell)) {
            const spacer = document.createElement('div');
            spacer.className = 'spacer';
            $grid.appendChild(spacer);
            continue;
        }
        $grid.appendChild(createButton(cell));
    }
}

function createButton(btn) {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'deck-btn';
    el.dataset.buttonId = btn.id;
    if (btn.color) el.style.setProperty('--btn-color', btn.color);
    if (btn.position) {
        el.style.gridColumn = String(btn.position.col);
        el.style.gridRow = String(btn.position.row);
    }

    const icon = document.createElement('span');
    icon.className = 'deck-btn-icon';
    icon.textContent = btn.icon || '';
    const label = document.createElement('span');
    label.className = 'deck-btn-label';
    label.textContent = btn.label;
    el.append(icon, label);

    el.addEventListener('pointerdown', () => {
        el.classList.add('pressed');
        if (navigator.vibrate) navigator.vibrate(15);
    });
    const release = () => el.classList.remove('pressed');
    el.addEventListener('pointerup', release);
    el.addEventListener('pointercancel', release);
    el.addEventListener('pointerleave', release);

    el.addEventListener('click', () => {
        if (Date.now() < suppressClickUntil) return; // just swiped, not a tap
        if (el.classList.contains('is-disabled')) {
            showToast('OBS desconectado');
            return;
        }
        const pressId = `p-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        pendingPresses.set(pressId, btn.id);
        if (onPressCallback) onPressCallback(pressId, btn.id);
    });

    buttonIndex.set(btn.id, { el, action: btn.action });
    return el;
}

function flash(el, className) {
    el.classList.remove('flash-ok', 'flash-error');
    /* restart the animation even on repeated flashes */
    void el.offsetWidth;
    el.classList.add(className);
    el.addEventListener(
        'animationend',
        () => el.classList.remove('flash-ok', 'flash-error'),
        { once: true }
    );
}
