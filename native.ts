/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { IpcMainInvokeEvent } from "electron";

const USER_AGENT = "Mozilla/5.0 (compatible; Vencord-GifValidator)";
const DEFAULT_TIMEOUT_MS = 8000;

export interface GifValidationResponse {
    ok: boolean;
    status: number;
    contentType: string | null;
    reason?: string;
}

export async function validateGifUrl(
    _event: IpcMainInvokeEvent,
    url: string,
    timeoutMs?: number
): Promise<GifValidationResponse> {
    if (typeof url !== "string" || (!url.startsWith("http://") && !url.startsWith("https://"))) {
        return { ok: false, status: 0, contentType: null, reason: "invalid-protocol" };
    }

    const effectiveTimeout = typeof timeoutMs === "number" && timeoutMs > 0
        ? timeoutMs
        : DEFAULT_TIMEOUT_MS;

    const doFetch = async (method: "HEAD" | "GET", extraHeaders?: Record<string, string>) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), effectiveTimeout);
        try {
            return await fetch(url, {
                method,
                redirect: "follow",
                signal: controller.signal,
                headers: {
                    "User-Agent": USER_AGENT,
                    ...extraHeaders
                }
            });
        } finally {
            clearTimeout(timer);
        }
    };

    try {
        let res = await doFetch("HEAD");

        if (res.status === 405) {
            res = await doFetch("GET", { Range: "bytes=0-0" });
        }

        return {
            ok: res.ok,
            status: res.status,
            contentType: res.headers.get("content-type")
        };
    } catch (err: any) {
        const isAbort = err?.name === "AbortError"
            || err?.code === "ABORT_ERR"
            || err?.code === 20;
        if (isAbort) {
            return { ok: false, status: 0, contentType: null, reason: "timeout" };
        }
        return { ok: false, status: 0, contentType: null, reason: "network" };
    }
}
