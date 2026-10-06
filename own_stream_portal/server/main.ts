/*
 * Composition root. Loads .env + deck.config.json, wires the modules and
 * prints the startup banner with the LAN URL(s), QR code and token.
 */

import { randomInt } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import qrcode from 'qrcode-terminal';
import { ConfigStore, formatConfigError } from './config.js';
import { createHttpServer } from './http.js';
import { StateStore } from './state.js';
import { WsHub } from './ws-hub.js';
import { Dispatcher, registerMacroHandler } from './actions/dispatcher.js';
import { launchApp, openUrl } from './actions/launch.js';
import { createInjector } from './actions/input.js';
import { parseHotkey, MEDIA_VK, VOLUME_VK } from './actions/keys.js';
import { ObsClient, collectInterests } from './actions/obs.js';
import { createApiHandler } from './api.js';
import { isButton, sceneList, type Button } from './schema.js';
import { log } from './log.js';

const VERSION = '1.0.0';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* Env overrides (handy for a second/staging instance and for testing):
 *   DECK_CONFIG  path to an alternate deck.config.json
 *   DECK_PORT    override the port from that config */
const CONFIG_PATH = (process.env.DECK_CONFIG ?? '').trim()
    ? path.resolve(process.env.DECK_CONFIG!.trim())
    : path.join(ROOT, 'deck.config.json');

try {
    process.loadEnvFile(path.join(ROOT, '.env'));
} catch {
    /* .env es opcional */
}

const token = (process.env.DECK_TOKEN ?? '').trim() || String(randomInt(100000, 1000000));
const tokenIsPersistent = Boolean((process.env.DECK_TOKEN ?? '').trim());

let store: ConfigStore;
try {
    store = new ConfigStore(CONFIG_PATH);
} catch (err) {
    log.error('config', `deck.config.json invalido, no puedo arrancar:\n${formatConfigError(err)}`);
    process.exit(1);
}
store.watch();

const { host } = store.current.server;
const port = Number(process.env.DECK_PORT) || store.current.server.port;

const stateStore = new StateStore();

const injector = createInjector();

const obsClient = new ObsClient(
    store.current.obs.url,
    (process.env.OBS_PASSWORD ?? '').trim() || undefined,
    stateStore,
    () => collectInterests(store.current.pages)
);

const httpServer = createHttpServer({
    uiDir: path.join(ROOT, 'ui'),
    token,
    handleApi: createApiHandler({ configPath: store.filePath, obsClient })
});

const dispatcher = new Dispatcher();
dispatcher.register('launch.app', (action) => launchApp(action.path, action.args, action.cwd));
dispatcher.register('launch.url', (action) => openUrl(action.url));
dispatcher.register('keys.hotkey', async (action) => injector.tapKeys(parseHotkey(action.keys)));
dispatcher.register('keys.text', async (action) => injector.typeText(action.text));
dispatcher.register('media', async (action) => injector.tapKey(MEDIA_VK[action.key]));
dispatcher.register('volume', async (action) => injector.tapKey(VOLUME_VK[action.op], action.steps));
dispatcher.register('obs.scene', (action) => obsClient.setScene(action.scene));
dispatcher.register('obs.sourceVisibility', (action) =>
    obsClient.setSourceVisibility(sceneList(action.scene), action.source, action.visible)
);
dispatcher.register('obs.filter', (action) => obsClient.setFilter(action.source, action.filter, action.enabled));
dispatcher.register('obs.mute', (action) => obsClient.setMute(action.input, action.mute));
dispatcher.register('obs.stream', (action) => obsClient.stream(action.op));
dispatcher.register('obs.record', (action) => obsClient.record(action.op));
dispatcher.register('obs.media', (action) => obsClient.media(action.input, action.op));
dispatcher.register('obs.raw', (action) => obsClient.raw(action.request, action.params));
registerMacroHandler(dispatcher);

function findButton(buttonId: string): Button {
    for (const page of store.current.pages) {
        for (const cell of page.buttons) {
            if (isButton(cell) && cell.id === buttonId) return cell;
        }
    }
    throw new Error(`boton desconocido: "${buttonId}"`);
}

const hub = new WsHub({
    server: httpServer,
    token,
    version: VERSION,
    getPages: () => store.current.pages,
    getState: () => stateStore.state,
    onPress: async (buttonId) => {
        const button = findButton(buttonId);
        await dispatcher.dispatch(button.action, { buttonId });
    }
});

store.on('layout-changed', () => {
    hub.broadcastLayout(store.current.pages);
    obsClient.refreshInterests();
});
stateStore.on('changed', () => hub.broadcastState(stateStore.state));

obsClient.start();
httpServer.listen(port, host, () => printBanner());

/* Home LANs are almost always 192.168.x.x; virtual adapters (Hyper-V,
 * VirtualBox, WSL) tend to sit on 172.x/10.x. Sort so the QR encodes
 * the address the phone can actually reach. */
function lanAddresses(): string[] {
    const out: string[] = [];
    for (const [, addrs] of Object.entries(os.networkInterfaces())) {
        for (const addr of addrs ?? []) {
            if (addr.family === 'IPv4' && !addr.internal) out.push(addr.address);
        }
    }
    const rank = (ip: string) => (ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : 2);
    return out.sort((a, b) => rank(a) - rank(b));
}

function printBanner(): void {
    const addresses = lanAddresses();
    const primary = addresses[0] ?? '127.0.0.1';
    const primaryUrl = `http://${primary}:${port}/?token=${token}`;

    console.log('');
    console.log('  Own Stream Portal listo');
    console.log('');
    for (const addr of addresses) {
        console.log(`  http://${addr}:${port}/?token=${token}`);
    }
    if (addresses.length === 0) {
        console.log(`  http://127.0.0.1:${port}/?token=${token} (sin red detectada)`);
    }
    if (addresses.length > 1) {
        console.log('  (varias interfaces de red: usa la IP de tu Wi-Fi/LAN real)');
    }
    console.log('');
    qrcode.generate(primaryUrl, { small: true }, (qr) => console.log(indent(qr, 2)));
    console.log(
        tokenIsPersistent
            ? `  Token: ${token} (fijo, desde .env)`
            : `  Token: ${token} (aleatorio en cada arranque; fijalo en .env -> DECK_TOKEN)`
    );
    console.log('');
    console.log(`  Editor (en el PC): http://localhost:${port}/editor.html?token=${token}`);
    console.log('');
}

function indent(block: string, spaces: number): string {
    const pad = ' '.repeat(spaces);
    return block
        .split('\n')
        .map((line) => pad + line)
        .join('\n');
}
