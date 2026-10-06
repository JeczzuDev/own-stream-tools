/*
 * Own Stream Portal — config editor.
 *
 * Loads deck.config.json and the live OBS inventory, lets you edit pages
 * and buttons with dropdowns of your real scenes/sources/inputs, then
 * POSTs the config back (the server validates and hot-reloads it).
 *
 * Vanilla ES module, no framework. Rendering is split into three columns
 * (pages / buttons preview / button editor); text edits update the model
 * and re-render only the preview so the editor inputs keep focus.
 */

'use strict';

/* ------------------------------------------------------------------ */
/* token + api                                                        */
/* ------------------------------------------------------------------ */

const params = new URLSearchParams(location.search);
const token = params.get('token') || localStorage.getItem('deck_token') || '';
if (params.get('token')) {
    localStorage.setItem('deck_token', token);
    history.replaceState(null, '', location.pathname);
}

function api(path, opts) {
    const sep = path.includes('?') ? '&' : '?';
    return fetch(`${path}${sep}token=${encodeURIComponent(token)}`, opts);
}

/* ------------------------------------------------------------------ */
/* tiny DOM helper                                                    */
/* ------------------------------------------------------------------ */

function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
        if (v === null || v === undefined || v === false) continue;
        if (k === 'class') node.className = v;
        else if (k === 'style') node.style.cssText = v;
        else if (k === 'html') node.innerHTML = v;
        else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
        else node.setAttribute(k, v === true ? '' : String(v));
    }
    for (const c of children.flat()) {
        if (c === null || c === undefined || c === false) continue;
        node.append(c.nodeType ? c : document.createTextNode(String(c)));
    }
    return node;
}

const $ = (sel) => document.querySelector(sel);
const uid = (p) => `${p}-${Math.random().toString(36).slice(2, 8)}`;

/* ------------------------------------------------------------------ */
/* state                                                              */
/* ------------------------------------------------------------------ */

let config = null; // working copy of deck.config.json
let obs = { connected: false, scenes: [], inputs: [], sceneSources: {} };
const filtersCache = {}; // source -> [filterName]
let pageIndex = 0;
let selectedButtonId = null;
let dirty = false;

/* macro-step expansion is UI-only state, keyed by the step object so it
 * never touches the config model and follows a step across reorders. */
const expandedSteps = new WeakSet();

/* copy/paste clipboard, persisted in localStorage (survives reloads). */
const clonePlain = (x) => JSON.parse(JSON.stringify(x));
function clipSet(kind, obj) {
    localStorage.setItem(`osp_clip_${kind}`, JSON.stringify(obj));
}
function clipGet(kind) {
    try {
        const v = localStorage.getItem(`osp_clip_${kind}`);
        return v ? JSON.parse(v) : null;
    } catch {
        return null;
    }
}

const $pages = $('[data-role="pages"]');
const $buttons = $('[data-role="buttons"]');
const $editor = $('[data-role="editor"]');
const $save = $('[data-role="save"]');
const $obsStatus = $('[data-role="obs-status"]');
const $toast = $('[data-role="toast"]');

/* ------------------------------------------------------------------ */
/* action metadata                                                    */
/* ------------------------------------------------------------------ */

const ACTION_LABELS = {
    'obs.scene': 'OBS · Cambiar escena',
    'obs.sourceVisibility': 'OBS · Mostrar/ocultar fuente',
    'obs.filter': 'OBS · Filtro on/off',
    'obs.mute': 'OBS · Silenciar audio',
    'obs.stream': 'OBS · Transmisión',
    'obs.record': 'OBS · Grabación',
    'obs.media': 'OBS · Media (play/pausa)',
    'obs.raw': 'OBS · Petición cruda',
    'keys.hotkey': 'Teclado · Atajo',
    'keys.text': 'Teclado · Escribir texto',
    media: 'Multimedia',
    volume: 'Volumen del sistema',
    'launch.app': 'Abrir programa',
    'launch.url': 'Abrir URL',
    macro: 'Macro (secuencia)'
};

function defaultAction(type) {
    switch (type) {
        case 'obs.scene': return { type, scene: '' };
        case 'obs.sourceVisibility': return { type, scene: '', source: '', visible: 'toggle' };
        case 'obs.filter': return { type, source: '', filter: '', enabled: 'toggle' };
        case 'obs.mute': return { type, input: '', mute: 'toggle' };
        case 'obs.stream': return { type, op: 'toggle' };
        case 'obs.record': return { type, op: 'toggle' };
        case 'obs.media': return { type, input: '', op: 'playpause' };
        case 'obs.raw': return { type, request: '' };
        case 'keys.hotkey': return { type, keys: '' };
        case 'keys.text': return { type, text: '' };
        case 'media': return { type, key: 'playpause' };
        case 'volume': return { type, op: 'up', steps: 2 };
        case 'launch.app': return { type, path: '', args: [] };
        case 'launch.url': return { type, url: '' };
        case 'macro': return { type, steps: [] };
        default: return { type: 'obs.scene', scene: '' };
    }
}

function actionSummary(action) {
    if (!action) return '';
    switch (action.type) {
        case 'obs.scene': return `→ ${action.scene || '?'}`;
        case 'obs.sourceVisibility': {
            const n = Array.isArray(action.scene) ? action.scene.length : 1;
            return `${action.source || '?'} = ${visLabel(action.visible)}${n > 1 ? ` (${n} escenas)` : ''}`;
        }
        case 'obs.filter': return `${action.filter || '?'} = ${visLabel(action.enabled)}`;
        case 'obs.mute': return `${action.input || '?'}`;
        case 'obs.stream': return `stream: ${action.op}`;
        case 'obs.record': return `rec: ${action.op}`;
        case 'obs.media': return `${action.input || '?'}: ${action.op}`;
        case 'keys.hotkey': return action.keys || '?';
        case 'keys.text': return `"${action.text || ''}"`;
        case 'media': return action.key;
        case 'volume': return `${action.op} x${action.steps ?? 2}`;
        case 'launch.app': return action.path || '?';
        case 'launch.url': return action.url || '?';
        case 'macro': return `${action.steps.length} pasos`;
        case 'obs.raw': return action.request || '?';
        default: return action.type;
    }
}

const visLabel = (v) => (v === true ? 'sí' : v === false ? 'no' : 'alternar');
const triValue = (v) => (v === true ? 'true' : v === false ? 'false' : 'toggle');
const triParse = (s) => (s === 'true' ? true : s === 'false' ? false : 'toggle');

/* audio inputs first, for the mute dropdown */
function audioInputs() {
    return obs.inputs.filter((i) => /wasapi|audio|coreaudio|pulse/i.test(i.kind)).map((i) => i.name);
}
function allSources() {
    const set = new Set();
    for (const list of Object.values(obs.sceneSources)) for (const s of list) set.add(s);
    for (const i of obs.inputs) set.add(i.name);
    return [...set].sort();
}
/* media/VLC sources, for the play-pause dropdown */
function mediaInputs() {
    return obs.inputs.filter((i) => /ffmpeg|vlc/i.test(i.kind)).map((i) => i.name);
}

/* ------------------------------------------------------------------ */
/* load + boot                                                        */
/* ------------------------------------------------------------------ */

async function load() {
    const [cfgRes, obsRes] = await Promise.all([api('/api/config'), api('/api/obs')]);
    if (!cfgRes.ok) {
        showToast('No pude cargar la config (¿token?).', 'error');
        return;
    }
    config = await cfgRes.json();
    obs = await obsRes.json().catch(() => obs);
    pageIndex = Math.min(pageIndex, config.pages.length - 1);
    renderObsStatus();
    renderAll();
}

function renderObsStatus() {
    if (obs.connected) {
        $obsStatus.textContent = `OBS · ${obs.scenes.length} escenas`;
        $obsStatus.className = 'obs-status ok';
    } else {
        $obsStatus.textContent = 'OBS desconectado';
        $obsStatus.className = 'obs-status off';
    }
}

function markDirty() {
    dirty = true;
    $save.disabled = false;
    $save.textContent = 'Guardar *';
}

function renderAll() {
    renderPages();
    renderButtons();
    renderEditor();
}

/* ------------------------------------------------------------------ */
/* pages column                                                       */
/* ------------------------------------------------------------------ */

function renderPages() {
    $pages.innerHTML = '';
    $pages.append(el('div', { class: 'section-title' }, 'Páginas'));

    config.pages.forEach((page, i) => {
        const item = el(
            'div',
            { class: `page-item${i === pageIndex ? ' current' : ''}`, onclick: () => selectPage(i) },
            el('span', { class: 'name' }, page.label || '(sin nombre)'),
            el('span', {
                class: 'mini', title: 'Subir',
                onclick: (e) => { e.stopPropagation(); movePage(i, -1); }
            }, '↑'),
            el('span', {
                class: 'mini', title: 'Bajar',
                onclick: (e) => { e.stopPropagation(); movePage(i, 1); }
            }, '↓'),
            el('span', {
                class: 'mini', title: 'Eliminar página',
                onclick: (e) => { e.stopPropagation(); deletePage(i); }
            }, '✕')
        );
        $pages.append(item);
    });

    $pages.append(el('button', { class: 'btn btn-sm', style: 'margin-top:6px', onclick: addPage }, '+ Página'));

    const page = config.pages[pageIndex];
    if (!page) return;
    const settings = el('div', { class: 'page-settings' },
        el('div', { class: 'section-title' }, 'Ajustes de la página'),
        field('Nombre', textInput(page.label, (v) => { page.label = v; markDirty(); renderButtons(); }, '', () => renderPages())),
        el('div', { class: 'row' },
            field('Columnas', numInput(page.grid.cols, 1, 10, (v) => { page.grid.cols = v; markDirty(); renderButtons(); })),
            field('Filas', numInput(page.grid.rows, 1, 12, (v) => { page.grid.rows = v; markDirty(); renderButtons(); }))
        )
    );
    $pages.append(settings);
}

function selectPage(i) {
    pageIndex = i;
    selectedButtonId = null;
    renderAll();
}

function addPage() {
    config.pages.push({ id: uid('page'), label: 'Nueva', grid: { cols: 4, rows: 2 }, buttons: [] });
    pageIndex = config.pages.length - 1;
    selectedButtonId = null;
    markDirty();
    renderAll();
}

function movePage(i, dir) {
    const j = i + dir;
    if (j < 0 || j >= config.pages.length) return;
    [config.pages[i], config.pages[j]] = [config.pages[j], config.pages[i]];
    if (pageIndex === i) pageIndex = j;
    else if (pageIndex === j) pageIndex = i;
    markDirty();
    renderAll();
}

function deletePage(i) {
    if (config.pages.length <= 1) { showToast('Debe quedar al menos una página.', 'error'); return; }
    if (!confirm(`¿Eliminar la página "${config.pages[i].label}"?`)) return;
    config.pages.splice(i, 1);
    pageIndex = Math.max(0, Math.min(pageIndex, config.pages.length - 1));
    selectedButtonId = null;
    markDirty();
    renderAll();
}

/* ------------------------------------------------------------------ */
/* buttons preview column                                             */
/* ------------------------------------------------------------------ */

function renderButtons() {
    $buttons.innerHTML = '';
    const page = config.pages[pageIndex];
    if (!page) return;

    $buttons.append(
        el('div', { class: 'buttons-head' },
            el('h2', {}, page.label || '(sin nombre)'),
            el('button', { class: 'btn btn-sm', onclick: () => addButton(false) }, '+ Botón'),
            el('button', { class: 'btn btn-sm btn-ghost', onclick: () => addButton(true) }, '+ Hueco'),
            clipGet('button') ? el('button', { class: 'btn btn-sm btn-ghost', onclick: pasteButton }, '📋 Pegar botón') : null
        )
    );

    const grid = el('div', { class: 'preview-grid', style: `grid-template-columns:repeat(${page.grid.cols},1fr)` });
    page.buttons.forEach((cell, i) => {
        if (!('id' in cell)) {
            grid.append(el('div', {
                class: 'pv-btn spacer-cell', title: 'Hueco (clic para editar)',
                onclick: () => { selectedButtonId = `__spacer_${i}`; renderButtons(); renderEditor(); }
            },
                el('span', { class: 'lb' }, 'hueco'),
                selectedButtonId === `__spacer_${i}` ? el('span', { class: 'ic' }, '·') : null
            ));
            return;
        }
        const selected = cell.id === selectedButtonId;
        grid.append(el('div', {
            class: `pv-btn${selected ? ' selected' : ''}`,
            style: cell.color ? `--btn-color:${cell.color}` : '',
            onclick: () => { selectedButtonId = cell.id; renderButtons(); renderEditor(); }
        },
            el('span', { class: 'ic' }, cell.icon || '·'),
            el('span', { class: 'lb' }, cell.label || '(sin nombre)')
        ));
    });
    grid.append(el('button', { class: 'pv-add', onclick: () => addButton(false) }, '+'));
    $buttons.append(grid);
}

function addButton(isSpacer) {
    const page = config.pages[pageIndex];
    if (isSpacer) {
        page.buttons.push({ type: 'spacer' });
    } else {
        const id = uid('btn');
        page.buttons.push({ id, label: 'Nuevo', icon: '⭐', action: defaultAction('obs.scene') });
        selectedButtonId = id;
    }
    markDirty();
    renderButtons();
    renderEditor();
}

function pasteButton() {
    const clip = clipGet('button');
    if (!clip) return;
    const btn = { ...clonePlain(clip), id: uid('btn') };
    config.pages[pageIndex].buttons.push(btn);
    selectedButtonId = btn.id;
    markDirty();
    renderButtons();
    renderEditor();
    showToast('Botón pegado.', 'ok');
}

/* ------------------------------------------------------------------ */
/* button editor column                                               */
/* ------------------------------------------------------------------ */

function selectedCell() {
    const page = config.pages[pageIndex];
    if (!page || !selectedButtonId) return null;
    if (selectedButtonId.startsWith('__spacer_')) {
        const i = Number(selectedButtonId.slice('__spacer_'.length));
        return { cell: page.buttons[i], index: i, page };
    }
    const index = page.buttons.findIndex((c) => 'id' in c && c.id === selectedButtonId);
    if (index < 0) return null;
    return { cell: page.buttons[index], index, page };
}

function renderEditor() {
    $editor.innerHTML = '';
    const sel = selectedCell();
    if (!sel) {
        $editor.append(el('div', { class: 'editor-empty' }, 'Selecciona un botón para editarlo, o añade uno nuevo.'));
        return;
    }
    const { cell, index, page } = sel;

    /* spacer */
    if (!('id' in cell)) {
        $editor.append(
            el('div', { class: 'section-title' }, 'Hueco'),
            el('p', { class: 'hint' }, 'Un hueco deja una celda vacía en la cuadrícula.'),
            reorderRow(index, page),
            el('button', { class: 'btn btn-danger', style: 'margin-top:12px', onclick: () => deleteButton(index) }, 'Eliminar hueco')
        );
        return;
    }

    $editor.append(el('div', { class: 'section-title' }, 'Botón'));

    $editor.append(field('Etiqueta', textInput(cell.label, (v) => { cell.label = v; markDirty(); renderButtons(); })));
    $editor.append(
        el('div', { class: 'row' },
            field('Icono (emoji)', textInput(cell.icon || '', (v) => { cell.icon = v || undefined; markDirty(); renderButtons(); })),
            field('Color', el('div', { class: 'swatch-row' },
                el('input', {
                    type: 'color', value: cell.color || '#2a3244',
                    oninput: (e) => { cell.color = e.target.value; markDirty(); renderButtons(); }
                }),
                el('button', { class: 'btn btn-sm btn-ghost', title: 'Quitar color', onclick: () => { cell.color = undefined; markDirty(); renderEditor(); renderButtons(); } }, '✕')
            ))
        )
    );

    /* action editor */
    const actionCard = el('div', { class: 'card' },
        el('div', { class: 'card-head' },
            el('span', { class: 't' }, 'Acción'),
            el('span', { style: 'flex:1' }),
            el('button', {
                class: 'btn btn-sm btn-ghost', title: 'Copiar esta acción',
                onclick: () => { clipSet('action', cell.action); renderEditor(); showToast('Acción copiada.', 'ok'); }
            }, '⧉ Copiar'),
            clipGet('action') ? el('button', {
                class: 'btn btn-sm btn-ghost', title: 'Reemplazar por la acción copiada',
                onclick: () => { cell.action = clonePlain(clipGet('action')); markDirty(); renderEditor(); renderButtons(); showToast('Acción pegada.', 'ok'); }
            }, '📋 Pegar') : null
        ),
        renderActionEditor(cell.action, (next) => { cell.action = next; markDirty(); renderEditor(); renderButtons(); }, { allowMacro: true })
    );
    $editor.append(actionCard);

    $editor.append(reorderRow(index, page));
    $editor.append(
        el('div', { class: 'row', style: 'margin-top:12px' },
            el('button', {
                class: 'btn btn-sm btn-ghost',
                onclick: () => { clipSet('button', cell); renderButtons(); showToast('Botón copiado (usa "Pegar botón").', 'ok'); }
            }, '⧉ Copiar botón'),
            el('button', { class: 'btn btn-sm btn-danger', onclick: () => deleteButton(index) }, 'Eliminar botón')
        )
    );
}

function reorderRow(index, page) {
    return el('div', { class: 'row', style: 'margin-top:10px' },
        el('button', { class: 'btn btn-sm', onclick: () => moveButton(index, -1) }, '← Mover'),
        el('button', { class: 'btn btn-sm', onclick: () => moveButton(index, 1) }, 'Mover →')
    );
}

function moveButton(index, dir) {
    const page = config.pages[pageIndex];
    const j = index + dir;
    if (j < 0 || j >= page.buttons.length) return;
    [page.buttons[index], page.buttons[j]] = [page.buttons[j], page.buttons[index]];
    markDirty();
    renderButtons();
    renderEditor();
}

function deleteButton(index) {
    const page = config.pages[pageIndex];
    page.buttons.splice(index, 1);
    selectedButtonId = null;
    markDirty();
    renderButtons();
    renderEditor();
}

/* ------------------------------------------------------------------ */
/* action editor (used for buttons and macro steps)                   */
/* ------------------------------------------------------------------ */

/* onReplace(newAction) is called when the action object is replaced
 * (type change). Field edits mutate `action` in place + markDirty. */
function renderActionEditor(action, onReplace, { allowMacro }) {
    const wrap = el('div', {});

    const types = Object.keys(ACTION_LABELS).filter((t) => allowMacro || t !== 'macro');
    const typeSel = el('select', {
        onchange: (e) => onReplace(defaultAction(e.target.value))
    }, types.map((t) => el('option', { value: t, selected: t === action.type }, ACTION_LABELS[t])));
    wrap.append(field('Tipo', typeSel));

    wrap.append(renderActionFields(action));
    return wrap;
}

function renderActionFields(action) {
    const box = el('div', {});

    switch (action.type) {
        case 'obs.scene':
            box.append(field('Escena', comboInput(action.scene, obs.scenes, (v) => { action.scene = v; markDirty(); renderButtons(); })));
            break;

        case 'obs.sourceVisibility': {
            /* build the source combo first so the scene fields can refresh its
             * suggestions in place (no re-render → the input keeps focus) */
            const srcCombo = comboInput(action.source, sourcesInScenes(sceneArray(action.scene)), (v) => { action.source = v; markDirty(); renderButtons(); });
            box.append(sceneListField(action, srcCombo));
            box.append(field('Fuente', srcCombo));
            box.append(field('Visibilidad', triSelect(action.visible, ['Alternar', 'Mostrar', 'Ocultar'], (v) => { action.visible = v; markDirty(); })));
            break;
        }

        case 'obs.filter': {
            const filterCombo = comboInput(action.filter, filtersCache[action.source] || [], (v) => { action.filter = v; markDirty(); renderButtons(); });
            box.append(field('Fuente', comboInput(action.source, allSources(),
                (v) => { action.source = v; markDirty(); },
                (v) => loadFilters(v).then(() => updateDatalist(filterCombo, filtersCache[v]))
            )));
            box.append(field('Filtro', filterCombo));
            box.append(field('Estado', triSelect(action.enabled, ['Alternar', 'Activar', 'Desactivar'], (v) => { action.enabled = v; markDirty(); })));
            if (action.source && !filtersCache[action.source]) loadFilters(action.source).then(() => updateDatalist(filterCombo, filtersCache[action.source]));
            break;
        }

        case 'obs.mute':
            box.append(field('Entrada de audio', comboInput(action.input, audioInputs(), (v) => { action.input = v; markDirty(); renderButtons(); })));
            box.append(field('Acción', triSelect(action.mute, ['Alternar', 'Silenciar', 'Activar sonido'], (v) => { action.mute = v; markDirty(); })));
            break;

        case 'obs.stream':
        case 'obs.record':
            box.append(field('Operación', selectInput(action.op, [['toggle', 'Alternar'], ['start', 'Iniciar'], ['stop', 'Detener']], (v) => { action.op = v; markDirty(); })));
            break;

        case 'obs.media':
            box.append(field('Fuente de media', comboInput(action.input, mediaInputs(), (v) => { action.input = v; markDirty(); renderButtons(); })));
            box.append(field('Operación', selectInput(action.op, [
                ['playpause', 'Play / Pausa (alternar)'],
                ['play', 'Play'],
                ['pause', 'Pausa'],
                ['restart', 'Reiniciar'],
                ['stop', 'Detener'],
                ['next', 'Siguiente'],
                ['previous', 'Anterior']
            ], (v) => { action.op = v; markDirty(); renderButtons(); })));
            break;

        case 'obs.raw':
            box.append(field('Petición (request)', textInput(action.request, (v) => { action.request = v; markDirty(); renderButtons(); })));
            box.append(rawParamsField(action));
            break;

        case 'keys.hotkey':
            box.append(field('Teclas', textInput(action.keys, (v) => { action.keys = v; markDirty(); renderButtons(); }, 'ej: ctrl+shift+f10, alt+1, f13')));
            box.append(el('p', { class: 'hint' }, 'Combina con +. Modificadores: ctrl, shift, alt, win. Teclas: a-z, 0-9, f1-f24, enter, space, up…'));
            break;

        case 'keys.text':
            box.append(field('Texto a escribir', textInput(action.text, (v) => { action.text = v; markDirty(); renderButtons(); })));
            break;

        case 'media':
            box.append(field('Tecla', selectInput(action.key, [['playpause', 'Play/Pausa'], ['next', 'Siguiente'], ['prev', 'Anterior'], ['stop', 'Detener']], (v) => { action.key = v; markDirty(); renderButtons(); })));
            break;

        case 'volume':
            box.append(el('div', { class: 'row' },
                field('Operación', selectInput(action.op, [['up', 'Subir'], ['down', 'Bajar'], ['mute', 'Silenciar']], (v) => { action.op = v; markDirty(); renderButtons(); })),
                field('Pasos', numInput(action.steps ?? 2, 1, 50, (v) => { action.steps = v; markDirty(); }))
            ));
            break;

        case 'launch.app':
            box.append(field('Ruta del programa (.exe, .bat, .cmd)', textInput(action.path, (v) => { action.path = v; markDirty(); renderButtons(); }, 'ej: notepad.exe o D:\\...\\start-server.bat')));
            box.append(field('Carpeta de trabajo (opcional)', textInput(action.cwd || '', (v) => { action.cwd = v || undefined; markDirty(); }, 'ej: D:\\Program Files\\obs-studio\\bin\\64bit')));
            box.append(field('Argumentos (separados por espacio)', textInput((action.args || []).join(' '), (v) => {
                action.args = v.trim() ? v.trim().split(/\s+/) : [];
                markDirty();
            })));
            box.append(el('p', { class: 'hint' }, 'Para OBS: la ruta a obs64.exe y su carpeta bin\\64bit como carpeta de trabajo.'));
            break;

        case 'launch.url':
            box.append(field('URL', textInput(action.url, (v) => { action.url = v; markDirty(); renderButtons(); }, 'https://…')));
            break;

        case 'macro':
            box.append(renderMacroEditor(action));
            break;
    }
    return box;
}

/* obs.sourceVisibility `scene` is a string (one scene) or an array (several).
 * The editor works on arrays and writes back a plain string for one scene,
 * so single-scene configs stay unchanged on disk. */
const sceneArray = (scene) => (Array.isArray(scene) ? scene : [scene ?? '']);
const sceneValue = (list) => (list.length === 1 ? list[0] : list);

/* union of the sources in the given scenes (all sources if none known) */
function sourcesInScenes(scenes) {
    const set = new Set();
    for (const s of scenes) for (const src of obs.sceneSources[s] || []) set.add(src);
    return set.size ? [...set].sort() : allSources();
}

function sceneListField(action, srcCombo) {
    const scenes = sceneArray(action.scene);
    const commit = () => { action.scene = sceneValue(scenes); markDirty(); renderButtons(); };
    const rerender = () => { commit(); renderEditor(); };

    const wrap = el('div', { class: 'field' },
        el('span', {}, scenes.length > 1 ? `Escenas (${scenes.length})` : 'Escena'));
    scenes.forEach((scene, i) => {
        wrap.append(el('div', { class: 'scene-row' },
            comboInput(scene, obs.scenes, (v) => {
                scenes[i] = v;
                commit();
                updateDatalist(srcCombo, sourcesInScenes(scenes));
            }),
            scenes.length > 1
                ? el('button', { class: 'btn btn-sm btn-ghost', title: 'Quitar escena', onclick: () => { scenes.splice(i, 1); rerender(); } }, '✕')
                : null
        ));
    });

    /* scenes (from the live OBS inventory) that contain the chosen source */
    const containing = () => obs.scenes.filter((s) => (obs.sceneSources[s] || []).includes(action.source));
    wrap.append(el('div', { class: 'row', style: 'margin-top:4px' },
        el('button', { class: 'btn btn-sm', onclick: () => { scenes.push(''); rerender(); } }, '+ Escena'),
        obs.connected
            ? el('button', {
                class: 'btn btn-sm btn-ghost', title: 'Usar todas las escenas donde está esta fuente',
                onclick: () => {
                    const found = containing();
                    if (!action.source || !found.length) { showToast('Elige primero una fuente que exista en OBS.', 'error'); return; }
                    scenes.splice(0, scenes.length, ...found);
                    rerender();
                    showToast(`${found.length} escena(s) con "${action.source}".`, 'ok');
                }
            }, 'Todas con la fuente')
            : null
    ));
    if (scenes.length > 1) {
        wrap.append(el('p', { class: 'hint' }, 'Se aplica en todas. "Alternar" lee la primera escena y deja las demás igual.'));
    }
    return wrap;
}

function rawParamsField(action) {
    const wrap = el('div', {});
    const ta = el('textarea', { rows: 4 }, JSON.stringify(action.params ?? {}, null, 2));
    const hint = el('p', { class: 'hint' }, 'Parámetros JSON (opcional).');
    ta.addEventListener('input', () => {
        const t = ta.value.trim();
        if (!t) { delete action.params; hint.className = 'hint'; hint.textContent = 'Parámetros JSON (opcional).'; markDirty(); return; }
        try {
            action.params = JSON.parse(t);
            hint.className = 'hint';
            hint.textContent = 'JSON válido.';
            markDirty();
        } catch (e) {
            hint.className = 'hint error';
            hint.textContent = 'JSON inválido: ' + e.message;
        }
    });
    wrap.append(field('Parámetros', ta), hint);
    return wrap;
}

async function loadFilters(source) {
    if (!source || filtersCache[source]) return;
    try {
        const r = await api(`/api/obs/filters?source=${encodeURIComponent(source)}`);
        const data = await r.json();
        filtersCache[source] = data.filters || [];
    } catch {
        filtersCache[source] = [];
    }
}

/* ------------------------------------------------------------------ */
/* macro editor                                                       */
/* ------------------------------------------------------------------ */

function renderMacroEditor(macro) {
    const box = el('div', {});

    const allExpanded = macro.steps.length > 0 && macro.steps.every((s) => expandedSteps.has(s));
    box.append(el('div', { class: 'card-head' },
        el('span', { class: 't' }, `Pasos (${macro.steps.length})`),
        el('span', { style: 'flex:1' }),
        macro.steps.length > 0
            ? el('button', {
                class: 'btn btn-sm btn-ghost',
                onclick: () => {
                    if (allExpanded) macro.steps.forEach((s) => expandedSteps.delete(s));
                    else macro.steps.forEach((s) => expandedSteps.add(s));
                    renderEditor();
                }
            }, allExpanded ? 'Colapsar todo' : 'Expandir todo')
            : null
    ));

    macro.steps.forEach((step, i) => {
        const isDelay = step.delayMs !== undefined && step.action === undefined;
        const expanded = expandedSteps.has(step);
        const summary = isDelay ? `Espera ${step.delayMs ?? 0} ms` : actionSummary(step.action);

        const stepBox = el('div', { class: `step${expanded ? '' : ' collapsed'}` });

        stepBox.append(el('div', { class: 'step-head' },
            el('span', {
                class: 'step-summary',
                onclick: () => { if (expanded) expandedSteps.delete(step); else expandedSteps.add(step); renderEditor(); }
            },
                el('span', { class: 'caret' }, expanded ? '▾' : '▸'),
                el('span', { class: 'n' }, `${i + 1}`),
                el('span', { class: 'sum' }, summary || '(vacío)')
            ),
            el('button', { class: 'btn btn-sm btn-ghost', title: 'Copiar paso', onclick: () => { clipSet('step', step); renderEditor(); showToast('Paso copiado.', 'ok'); } }, '⧉'),
            el('button', { class: 'btn btn-sm btn-ghost', title: 'Subir', onclick: () => moveStep(macro, i, -1) }, '↑'),
            el('button', { class: 'btn btn-sm btn-ghost', title: 'Bajar', onclick: () => moveStep(macro, i, 1) }, '↓'),
            el('button', { class: 'btn btn-sm btn-ghost', title: 'Eliminar', onclick: () => { macro.steps.splice(i, 1); markDirty(); renderEditor(); } }, '✕')
        ));

        if (expanded) {
            const body = el('div', { class: 'step-body' });
            body.append(field('Tipo de paso', selectInput(isDelay ? 'delay' : 'action', [['action', 'Acción'], ['delay', 'Espera (ms)']], (v) => {
                const next = v === 'delay' ? { delayMs: 300 } : { action: defaultAction('obs.sourceVisibility') };
                macro.steps[i] = next;
                expandedSteps.add(next);
                markDirty(); renderEditor();
            })));
            if (isDelay) {
                body.append(field('Milisegundos', numInput(step.delayMs, 0, 60000, (v) => { step.delayMs = v; markDirty(); })));
            } else {
                if (!step.action) step.action = defaultAction('obs.sourceVisibility');
                body.append(renderActionEditor(step.action, (nextA) => { step.action = nextA; markDirty(); renderEditor(); }, { allowMacro: false }));
            }
            stepBox.append(body);
        }
        box.append(stepBox);
    });

    const addStep = (make) => { const s = make(); macro.steps.push(s); expandedSteps.add(s); markDirty(); renderEditor(); };
    box.append(el('div', { class: 'row', style: 'margin-top:4px' },
        el('button', { class: 'btn btn-sm', onclick: () => addStep(() => ({ action: defaultAction('obs.sourceVisibility') })) }, '+ Acción'),
        el('button', { class: 'btn btn-sm', onclick: () => addStep(() => ({ delayMs: 300 })) }, '+ Espera'),
        clipGet('step')
            ? el('button', { class: 'btn btn-sm btn-ghost', onclick: () => addStep(() => clonePlain(clipGet('step'))) }, '📋 Pegar paso')
            : null
    ));

    box.append(el('button', {
        class: 'btn btn-sm btn-ghost', style: 'margin-top:8px;width:100%',
        onclick: () => togglePresetHelper(macro, box)
    }, '⚡ Generar preset de fondo exclusivo'));

    return box;
}

function moveStep(macro, i, dir) {
    const j = i + dir;
    if (j < 0 || j >= macro.steps.length) return;
    [macro.steps[i], macro.steps[j]] = [macro.steps[j], macro.steps[i]];
    markDirty();
    renderEditor();
}

/* Background preset helper: pick a scene, mark each source Mostrar/
 * Ocultar/(nada), and append the matching sourceVisibility steps. This
 * builds the "show one background, hide the rest" macros in one go. */
function togglePresetHelper(macro, box) {
    const existing = box.querySelector('.preset-helper');
    if (existing) { existing.remove(); return; }

    let scene = obs.scenes[0] || '';
    const helper = el('div', { class: 'card preset-helper', style: 'margin-top:8px' });

    const rebuild = () => {
        helper.innerHTML = '';
        helper.append(el('div', { class: 'card-head' }, el('span', { class: 't' }, 'Preset de fondo')));
        helper.append(field('Escena', comboInput(scene, obs.scenes, (v) => { scene = v; }, () => rebuild())));
        const sources = obs.sceneSources[scene] || [];
        if (!sources.length) {
            helper.append(el('p', { class: 'hint' }, 'Sin fuentes conocidas para esta escena (¿OBS conectado?).'));
        }
        const rows = el('div', {});
        const choices = {};
        for (const src of sources) {
            const sel = el('select', { onchange: (e) => { choices[src] = e.target.value; } },
                el('option', { value: 'none', selected: true }, '—'),
                el('option', { value: 'show' }, 'Mostrar'),
                el('option', { value: 'hide' }, 'Ocultar')
            );
            choices[src] = 'none';
            rows.append(el('label', { class: 'field', style: 'margin-bottom:6px' },
                el('div', { class: 'row' }, el('span', { style: 'flex:2;align-self:center;font-size:12px' }, src), sel)));
        }
        helper.append(rows);
        helper.append(el('button', {
            class: 'btn btn-sm btn-primary', style: 'margin-top:6px',
            onclick: () => {
                let added = 0;
                for (const [src, choice] of Object.entries(choices)) {
                    if (choice === 'none') continue;
                    macro.steps.push({ action: { type: 'obs.sourceVisibility', scene, source: src, visible: choice === 'show' } });
                    added++;
                }
                if (!added) { showToast('Marca al menos una fuente como Mostrar u Ocultar.', 'error'); return; }
                markDirty();
                renderEditor();
                showToast(`Añadidos ${added} pasos.`, 'ok');
            }
        }, 'Generar pasos'));
    };
    rebuild();
    box.append(helper);
}

/* ------------------------------------------------------------------ */
/* small input builders                                               */
/* ------------------------------------------------------------------ */

function field(labelText, control) {
    return el('label', { class: 'field' }, el('span', {}, labelText), control);
}

/* onChange fires per keystroke (model + light preview); optional onCommit
 * fires on blur/enter ('change') — use it for anything that re-renders the
 * editor, so typing never destroys the focused input. */
function textInput(value, onChange, placeholder, onCommit) {
    const inp = el('input', { type: 'text', value: value ?? '', placeholder: placeholder || '' });
    inp.addEventListener('input', () => onChange(inp.value));
    if (onCommit) inp.addEventListener('change', () => onCommit(inp.value));
    return inp;
}

function numInput(value, min, max, onChange) {
    const inp = el('input', { type: 'number', value: String(value ?? ''), min, max });
    inp.addEventListener('input', () => { const n = Number(inp.value); if (!Number.isNaN(n)) onChange(n); });
    return inp;
}

function selectInput(value, options, onChange) {
    const sel = el('select', {}, options.map(([v, label]) => el('option', { value: v, selected: v === value }, label)));
    sel.addEventListener('change', () => onChange(sel.value));
    return sel;
}

function triSelect(value, [tog, yes, no], onChange) {
    const sel = el('select', {},
        el('option', { value: 'toggle', selected: value !== true && value !== false }, tog),
        el('option', { value: 'true', selected: value === true }, yes),
        el('option', { value: 'false', selected: value === false }, no)
    );
    sel.addEventListener('change', () => onChange(triParse(sel.value)));
    return sel;
}

/* text input with datalist suggestions (free-typeable). onChange fires per
 * keystroke; optional onCommit fires on 'change' (blur/pick). */
function comboInput(value, suggestions, onChange, onCommit) {
    const listId = uid('dl');
    const inp = el('input', { type: 'text', value: value ?? '', list: listId, placeholder: 'escribe o elige…' });
    const dl = el('datalist', { id: listId }, (suggestions || []).map((s) => el('option', { value: s })));
    inp.addEventListener('input', () => onChange(inp.value));
    if (onCommit) inp.addEventListener('change', () => onCommit(inp.value));
    const wrap = el('div', {});
    wrap.append(inp, dl);
    return wrap;
}

/* swap a combo's suggestion list in place, without re-rendering (keeps focus) */
function updateDatalist(comboWrap, options) {
    const dl = comboWrap.querySelector('datalist');
    if (!dl) return;
    dl.innerHTML = '';
    for (const s of options || []) dl.append(el('option', { value: s }));
}

/* ------------------------------------------------------------------ */
/* save                                                               */
/* ------------------------------------------------------------------ */

async function save() {
    $save.disabled = true;
    $save.textContent = 'Guardando…';
    try {
        const res = await api('/api/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(config)
        });
        const data = await res.json();
        if (data.ok) {
            dirty = false;
            $save.textContent = 'Guardado';
            $save.disabled = true;
            showToast('Guardado. Los dispositivos se actualizan solos.', 'ok');
        } else {
            $save.disabled = false;
            $save.textContent = 'Guardar *';
            showToast('No se guardó:\n' + data.error, 'error');
        }
    } catch (e) {
        $save.disabled = false;
        $save.textContent = 'Guardar *';
        showToast('Error de red: ' + e.message, 'error');
    }
}

let toastTimer = null;
function showToast(text, kind) {
    $toast.textContent = text;
    $toast.className = `toast ${kind || ''}`;
    $toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { $toast.hidden = true; }, 4500);
}

/* ------------------------------------------------------------------ */
/* boot                                                               */
/* ------------------------------------------------------------------ */

$save.addEventListener('click', save);
$('[data-role="reload"]').addEventListener('click', () => {
    if (dirty && !confirm('Hay cambios sin guardar. ¿Descartar y recargar?')) return;
    dirty = false;
    load();
});
window.addEventListener('beforeunload', (e) => {
    if (dirty) { e.preventDefault(); e.returnValue = ''; }
});

if (!token) {
    showToast('Falta el token. Abre /editor.html?token=… (el token está en la consola del servidor).', 'error');
} else {
    load();
}
