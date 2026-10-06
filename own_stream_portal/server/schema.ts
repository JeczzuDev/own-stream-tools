/*
 * Single source of truth for the shapes of:
 *   - deck.config.json (layout + server/obs settings)
 *   - client -> server WebSocket messages
 * Server -> client messages are plain TS types (we produce them, no
 * runtime validation needed).
 */

import { z } from 'zod';

/* ------------------------------------------------------------------ */
/* Actions                                                            */
/* ------------------------------------------------------------------ */

const toggleOrBool = z.union([z.boolean(), z.literal('toggle')]);
const startStopToggle = z.enum(['start', 'stop', 'toggle']);

const obsScene = z.object({
    type: z.literal('obs.scene'),
    scene: z.string().min(1)
});

/* One scene name, or several: the same source is shown/hidden in all of
 * them at once (toggle reads the first scene and syncs the rest). */
const oneOrManyScenes = z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]);

const obsSourceVisibility = z.object({
    type: z.literal('obs.sourceVisibility'),
    scene: oneOrManyScenes,
    source: z.string().min(1),
    visible: toggleOrBool.default('toggle')
});

const obsFilter = z.object({
    type: z.literal('obs.filter'),
    source: z.string().min(1),
    filter: z.string().min(1),
    enabled: toggleOrBool.default('toggle')
});

const obsMute = z.object({
    type: z.literal('obs.mute'),
    input: z.string().min(1),
    mute: toggleOrBool.default('toggle')
});

const obsStream = z.object({
    type: z.literal('obs.stream'),
    op: startStopToggle.default('toggle')
});

const obsRecord = z.object({
    type: z.literal('obs.record'),
    op: startStopToggle.default('toggle')
});

/* Control an OBS media/VLC source (play, pause, restart, next…). */
const obsMedia = z.object({
    type: z.literal('obs.media'),
    input: z.string().min(1),
    op: z.enum(['playpause', 'play', 'pause', 'restart', 'stop', 'next', 'previous']).default('playpause')
});

/* Escape hatch: any obs-websocket v5 request by name. */
const obsRaw = z.object({
    type: z.literal('obs.raw'),
    request: z.string().min(1),
    params: z.record(z.unknown()).optional()
});

const keysHotkey = z.object({
    type: z.literal('keys.hotkey'),
    keys: z.string().min(1) // e.g. 'ctrl+shift+f10'
});

const keysText = z.object({
    type: z.literal('keys.text'),
    text: z.string().min(1)
});

const media = z.object({
    type: z.literal('media'),
    key: z.enum(['playpause', 'next', 'prev', 'stop'])
});

const volume = z.object({
    type: z.literal('volume'),
    op: z.enum(['up', 'down', 'mute']),
    steps: z.number().int().min(1).max(50).default(2)
});

const launchApp = z.object({
    type: z.literal('launch.app'),
    path: z.string().min(1),
    args: z.array(z.string()).default([]),
    cwd: z.string().optional()
});

const launchUrl = z.object({
    type: z.literal('launch.url'),
    url: z.string().url()
});

/* Every action except macro. Macro steps reuse this, so macros cannot nest. */
const simpleActionSchema = z.discriminatedUnion('type', [
    obsScene,
    obsSourceVisibility,
    obsFilter,
    obsMute,
    obsStream,
    obsRecord,
    obsMedia,
    obsRaw,
    keysHotkey,
    keysText,
    media,
    volume,
    launchApp,
    launchUrl
]);

const macroStep = z
    .object({
        action: simpleActionSchema.optional(),
        delayMs: z.number().int().min(0).max(60000).optional()
    })
    .refine((s) => s.action !== undefined || s.delayMs !== undefined, {
        message: 'cada paso de macro necesita "action" y/o "delayMs"'
    });

const macro = z.object({
    type: z.literal('macro'),
    steps: z.array(macroStep).min(1)
});

export const actionSchema = z.discriminatedUnion('type', [
    obsScene,
    obsSourceVisibility,
    obsFilter,
    obsMute,
    obsStream,
    obsRecord,
    obsMedia,
    obsRaw,
    keysHotkey,
    keysText,
    media,
    volume,
    launchApp,
    launchUrl,
    macro
]);

export type SimpleAction = z.infer<typeof simpleActionSchema>;
export type Action = z.infer<typeof actionSchema>;
export type MacroStep = z.infer<typeof macroStep>;

/* ------------------------------------------------------------------ */
/* Layout                                                             */
/* ------------------------------------------------------------------ */

const buttonSchema = z.object({
    id: z.string().min(1),
    label: z.string().min(1),
    icon: z.string().optional(), // emoji expected
    color: z
        .string()
        .regex(/^#[0-9a-fA-F]{3,8}$/, 'color debe ser hex, ej. #7c3aed')
        .optional(),
    position: z
        .object({
            col: z.number().int().min(1),
            row: z.number().int().min(1)
        })
        .optional(),
    action: actionSchema
});

const spacerSchema = z.object({
    type: z.literal('spacer')
});

const cellSchema = z.union([spacerSchema, buttonSchema]);

const pageSchema = z.object({
    id: z.string().min(1),
    label: z.string().min(1),
    grid: z.object({
        cols: z.number().int().min(1).max(10),
        rows: z.number().int().min(1).max(12)
    }),
    buttons: z.array(cellSchema)
});

export const deckConfigSchema = z
    .object({
        server: z
            .object({
                port: z.number().int().min(1).max(65535).default(8420),
                host: z.string().default('0.0.0.0')
            })
            .default({}),
        obs: z
            .object({
                url: z.string().default('ws://127.0.0.1:4455')
            })
            .default({}),
        pages: z.array(pageSchema).min(1)
    })
    .superRefine((config, ctx) => {
        const pageIds = new Set<string>();
        const buttonIds = new Set<string>();
        config.pages.forEach((page, p) => {
            if (pageIds.has(page.id)) {
                ctx.addIssue({
                    code: z.ZodIssueCode.custom,
                    path: ['pages', p, 'id'],
                    message: `id de pagina duplicado: "${page.id}"`
                });
            }
            pageIds.add(page.id);
            page.buttons.forEach((cell, b) => {
                if (!('id' in cell)) return; // spacer
                if (buttonIds.has(cell.id)) {
                    ctx.addIssue({
                        code: z.ZodIssueCode.custom,
                        path: ['pages', p, 'buttons', b, 'id'],
                        message: `id de boton duplicado: "${cell.id}"`
                    });
                }
                buttonIds.add(cell.id);
            });
        });
    });

export type DeckConfig = z.infer<typeof deckConfigSchema>;
export type Page = DeckConfig['pages'][number];
export type Cell = Page['buttons'][number];
export type Button = Extract<Cell, { id: string }>;

export function isButton(cell: Cell): cell is Button {
    return 'id' in cell;
}

/* Normalizes obs.sourceVisibility's `scene` (string | string[]) to a list. */
export function sceneList(scene: string | string[]): string[] {
    return Array.isArray(scene) ? scene : [scene];
}

/* ------------------------------------------------------------------ */
/* WebSocket protocol                                                 */
/* ------------------------------------------------------------------ */

/* Client -> server (validated at runtime). */
export const clientMessageSchema = z.discriminatedUnion('type', [
    z.object({
        type: z.literal('hello'),
        token: z.string(),
        client: z.string().default('unknown')
    }),
    z.object({
        type: z.literal('press'),
        pressId: z.string().min(1),
        buttonId: z.string().min(1)
    }),
    z.object({
        type: z.literal('ping')
    })
]);

export type ClientMessage = z.infer<typeof clientMessageSchema>;

/* Server -> client (plain types; always produced by us). */
export interface DeckState {
    obsConnected: boolean;
    currentScene: string | null;
    streaming: boolean;
    recording: boolean;
    /* input name -> muted */
    mutes: Record<string, boolean>;
    /* "scene/source" -> visible */
    sourceVisibility: Record<string, boolean>;
    /* "source/filter" -> enabled */
    filters: Record<string, boolean>;
}

export type ServerMessage =
    | { type: 'hello-ok'; version: string; layout: { pages: Page[] }; state: DeckState }
    | { type: 'hello-error'; reason: string }
    | { type: 'layout'; pages: Page[] }
    | { type: 'state'; state: DeckState }
    | { type: 'ack'; pressId: string; ok: boolean; error?: string }
    | { type: 'pong' };
