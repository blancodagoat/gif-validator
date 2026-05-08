/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Flogger } from ".";
import { createPickerButton } from "./components/PickerButton";

const INJECTED_ATTR = "data-vc-gif-validator-injected";
const BUTTON_CLASS = "vc-gif-validator-picker-btn";

let pickerObserver: MutationObserver | null = null;

function tryInjectInto(panel: Element): void {
    try {
        const headers = panel.querySelectorAll<HTMLElement>('[class*="searchHeader"]');
        for (const header of headers) {
            if (header.tagName !== "H3") continue;
            const flexRow = header.parentElement;
            if (!flexRow) continue;
            // idempotent guard — already has our button
            if (flexRow.querySelector(`.${BUTTON_CLASS}`)) continue;
            flexRow.setAttribute(INJECTED_ATTR, "true");
            flexRow.appendChild(createPickerButton());
        }
    } catch (err) {
        Flogger.error("tryInjectInto failed", err);
    }
}

function injectAllPanels(): void {
    document.querySelectorAll("#gif-picker-tab-panel").forEach(tryInjectInto);
}

export function startPickerInjector(): void {
    if (pickerObserver) return;

    // Initial pass — picker may already be mounted
    injectAllPanels();

    pickerObserver = new MutationObserver(mutations => {
        let shouldRescan = false;
        for (const m of mutations) {
            for (const added of m.addedNodes) {
                if (!(added instanceof Element)) continue;
                if (added.id === "gif-picker-tab-panel"
                    || added.querySelector?.("#gif-picker-tab-panel")
                    || added.matches?.('[class*="searchHeader"]')
                    || added.querySelector?.('[class*="searchHeader"]')) {
                    shouldRescan = true;
                    break;
                }
            }
            if (shouldRescan) break;
        }
        if (shouldRescan) injectAllPanels();
    });
    pickerObserver.observe(document.body, { childList: true, subtree: true });
}

export function stopPickerInjector(): void {
    pickerObserver?.disconnect();
    pickerObserver = null;

    // Remove every injected button anywhere in the DOM
    document.querySelectorAll(`.${BUTTON_CLASS}`).forEach(el => el.remove());
    document.querySelectorAll(`[${INJECTED_ATTR}]`).forEach(el => {
        el.removeAttribute(INJECTED_ATTR);
    });
}
