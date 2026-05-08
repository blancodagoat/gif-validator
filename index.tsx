/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import { definePluginSettings } from "@api/Settings";
import { Button } from "@components/Button";
import { Devs } from "@utils/constants";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType, PluginNative } from "@utils/types";
import { findByPropsLazy, proxyLazyWebpack } from "@webpack";
import { FluxDispatcher, UserSettingsActionCreators } from "@webpack/common";

import { startPickerInjector, stopPickerInjector } from "./pickerInjector";
import { FavoriteGif, FavoriteGifList, ValidationResult } from "./types";
import { ProgressEvent, runWithConcurrency, ValidationOutcome, ValidatorTask } from "./utils";

export const Flogger = new Logger("GifValidator", "#cba6f7");

// Proto plumbing — mirrors the pattern in src/plugins/fakeNitro/index.tsx.
// The outer FrecencyUserSettingsActionCreators is a wrapper with `getCurrentValue`,
// `update`, etc. — it does NOT expose `toBinary`/`fromBinary`. Those live on the
// per-field proto class, which we dig out via `searchProtoClassField`.
const BINARY_READ_OPTIONS = findByPropsLazy("readerFactory");

function searchProtoClassField(localName: string, protoClass: any) {
    const field = protoClass?.fields?.find((f: any) => f.localName === localName);
    if (!field) return;
    const fieldGetter = Object.values(field).find(v => typeof v === "function") as any;
    return fieldGetter?.();
}

const FrecencyProtoClass = proxyLazyWebpack(() =>
    UserSettingsActionCreators.FrecencyUserSettingsActionCreators?.ProtoClass);
const FavoriteGifsProto = proxyLazyWebpack(() =>
    searchProtoClassField("favoriteGifs", UserSettingsActionCreators.FrecencyUserSettingsActionCreators?.ProtoClass));

// Lazy-load the modal so plugin load doesn't break before the component file exists.
export const openValidatorModal = () => {
    // @ts-expect-error - modal added in a separate task
    import("./components/ValidatorModal").then(m => m.openValidatorModal());
};

// Native bridge — mirrors the getNative() pattern from vc-message-logger-enhanced
// but inline. Uses validateGifUrl as the discriminator across pluginHelpers.
export const Native: PluginNative<typeof import("./native")> = (() => {
    if (IS_WEB) {
        return {
            validateGifUrl: async () =>
                ({ ok: false, status: 0, contentType: null, reason: "web" })
        } satisfies PluginNative<typeof import("./native")>;
    }
    return Object.values(VencordNative.pluginHelpers)
        .find((m: any) => m.validateGifUrl) as PluginNative<typeof import("./native")>;
})();

export const settings = definePluginSettings({
    concurrency: {
        type: OptionType.NUMBER,
        default: 2,
        description: "How many GIFs to validate at once. Higher values are faster but may trigger Tenor/Discord rate limits. Capped at 8."
    },
    timeoutMs: {
        type: OptionType.NUMBER,
        default: 8000,
        description: "Per-request timeout in milliseconds before treating a GIF as broken."
    },
    treatRedirectsAsValid: {
        type: OptionType.BOOLEAN,
        default: true,
        description: "Some hosts return 301/302 to a placeholder. If on, redirects are followed and the final response is checked. (Native bridge follows redirects by default — this is informational.)"
    },
    requireImageOrVideoContentType: {
        type: OptionType.BOOLEAN,
        default: true,
        description: "Require the response Content-Type to start with image/ or video/. Turn off for hosts that mislabel."
    },
    openValidator: {
        type: OptionType.COMPONENT,
        description: "Open the GIF validator UI",
        component: () => (
            <Button onClick={() => openValidatorModal()}>
                Open Validator
            </Button>
        )
    }
});

export interface GifSnapshot {
    gifs: FavoriteGifList;
    /** original proto reference, for save() */
    protoRef: any;
}

export function getFavoriteGifs(): GifSnapshot | null {
    try {
        const ac = UserSettingsActionCreators.FrecencyUserSettingsActionCreators;
        const currentValue = ac?.getCurrentValue?.();
        const gifs = currentValue?.favoriteGifs?.gifs;
        if (!gifs) return null;
        return { gifs, protoRef: currentValue };
    } catch (err) {
        Flogger.error("getFavoriteGifs failed", err);
        return null;
    }
}

export async function saveFavoriteGifs(newGifs: FavoriteGifList): Promise<boolean> {
    try {
        const ac = UserSettingsActionCreators.FrecencyUserSettingsActionCreators;
        if (!ac || !FrecencyProtoClass || !FavoriteGifsProto || !BINARY_READ_OPTIONS) {
            Flogger.error("saveFavoriteGifs: proto classes not loaded");
            return false;
        }

        const current = ac.getCurrentValue?.();
        if (!current) {
            Flogger.error("saveFavoriteGifs: no current FrecencyUserSettings value");
            return false;
        }

        // Clone just the favoriteGifs sub-message via its own proto class so we
        // preserve `hideTooltip` and any other fields, then swap in the new gifs map.
        const currentFavGifs = current.favoriteGifs;
        const newFavGifs = currentFavGifs != null
            ? FavoriteGifsProto.fromBinary(FavoriteGifsProto.toBinary(currentFavGifs), BINARY_READ_OPTIONS)
            : FavoriteGifsProto.create();

        newFavGifs.gifs = newGifs;

        // Build a partial outer proto carrying only favoriteGifs.
        const proto = FrecencyProtoClass.create();
        proto.favoriteGifs = newFavGifs;

        FluxDispatcher.dispatch({
            type: "USER_SETTINGS_PROTO_UPDATE",
            local: true,
            partial: true,
            settings: {
                type: 2, // FRECENCY_AND_FAVORITES_SETTINGS
                proto
            }
        });

        return true;
    } catch (err) {
        Flogger.error("saveFavoriteGifs failed", err);
        return false;
    }
}

export async function validateAll(
    gifs: FavoriteGifList,
    onProgress: (e: ProgressEvent<ValidationResult>) => void,
    signal?: AbortSignal
): Promise<Map<string, ValidationOutcome<ValidationResult>>> {
    const entries = Object.entries(gifs);

    const tasks: ValidatorTask<ValidationResult>[] = entries.map(([key, gif]: [string, FavoriteGif]) => ({
        key,
        run: async (): Promise<ValidationResult> => {
            const url = gif.src ?? gif.url;
            const res = await Native.validateGifUrl(url, settings.store.timeoutMs);

            const ct = res.contentType;
            const ctOk = !settings.store.requireImageOrVideoContentType
                || (ct?.startsWith("image/") ?? false)
                || (ct?.startsWith("video/") ?? false);

            const valid = res.ok && ctOk;

            return {
                url,
                valid,
                status: res.status,
                contentType: ct,
                reason: res.reason
            };
        }
    }));

    return runWithConcurrency(tasks, settings.store.concurrency, onProgress, signal);
}

export default definePlugin({
    name: "GifValidator",
    description: "Validate your favorite GIFs and remove broken/dead ones.",
    authors: [Devs.Ven],
    settings,
    toolboxActions: {
        "Validate Favorite GIFs"() {
            openValidatorModal();
        }
    },
    start() {
        startPickerInjector();
    },
    stop() {
        stopPickerInjector();
    }
});
