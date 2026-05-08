/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export interface FavoriteGif {
    format: number;
    src: string;
    width: number;
    height: number;
    order: number;
    url: string;
}

export type FavoriteGifList = Record<string, FavoriteGif>;

export interface ValidationResult {
    url: string;
    valid: boolean;
    status: number;
    contentType: string | null;
    reason?: string;
}
