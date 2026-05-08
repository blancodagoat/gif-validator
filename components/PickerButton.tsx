/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Flogger, openValidatorModal } from "..";

export function createPickerButton(): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "vc-gif-validator-picker-btn";
    btn.textContent = "Validate";
    btn.title = "Validate favorite GIFs and remove broken ones";
    btn.addEventListener("click", e => {
        e.preventDefault();
        e.stopPropagation();
        try {
            openValidatorModal();
        } catch (err) {
            Flogger.error("Failed to open validator modal from picker button", err);
        }
    });
    return btn;
}
