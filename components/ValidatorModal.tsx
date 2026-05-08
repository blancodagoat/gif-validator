/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { classNameFactory } from "@api/Styles";
import { Button } from "@components/Button";
import ErrorBoundary from "@components/ErrorBoundary";
import { ModalContent, ModalFooter, ModalHeader, ModalProps, ModalRoot, ModalSize, openModal } from "@utils/modal";
import { useEffect, useMemo, useRef, useState } from "@webpack/common";
import type { ReactNode } from "react";

import { Flogger, getFavoriteGifs, saveFavoriteGifs, settings, validateAll } from "..";
import type { FavoriteGif, FavoriteGifList, ValidationResult } from "../types";
import type { ProgressEvent } from "../utils";

const cl = classNameFactory("vc-gif-validator-");

interface LiveResult {
    key: string;
    gif: FavoriteGif;
    valid: boolean;
    status: number;
    contentType: string | null;
    reason?: string;
}

interface ResolvedGif extends LiveResult {
    selected: boolean;
}

type ModalState =
    | { kind: "idle"; gifCount: number; }
    | { kind: "running"; completed: number; total: number; live: LiveResult[]; abort: () => void; }
    | { kind: "done"; results: ResolvedGif[]; saving: boolean; savedSuccess?: boolean; saveError?: string; };

function describeReason(r: LiveResult): string {
    if (r.reason === "timeout") return "Timed out";
    if (r.reason === "network") return "Network error";
    if (r.reason === "invalid-protocol") return "Invalid protocol";
    if (r.reason === "web") return "Not supported on web";

    if (r.status === 404) return "Not Found";
    if (r.status === 403) return "Forbidden";
    if (r.status === 0) return "No response";

    if (r.status >= 200 && r.status < 400 && r.contentType) {
        const ct = r.contentType;
        if (!ct.startsWith("image/") && !ct.startsWith("video/")) {
            return "Wrong type: " + ct;
        }
    }

    return "HTTP " + r.status;
}

function ValidatorModalInner({ modalProps }: { modalProps: ModalProps; }) {
    const snapshot = useMemo(() => getFavoriteGifs(), []);
    const originalGifs = snapshot?.gifs ?? null;

    const initial: ModalState = useMemo(() => {
        if (!originalGifs) return { kind: "idle", gifCount: 0 };
        return { kind: "idle", gifCount: Object.keys(originalGifs).length };
    }, [originalGifs]);

    const [state, setState] = useState<ModalState>(initial);
    const abortRef = useRef<AbortController | null>(null);
    const [showValidToo, setShowValidToo] = useState(false);

    // On unmount: abort any in-flight validation.
    useEffect(() => {
        return () => {
            abortRef.current?.abort();
        };
    }, []);

    const startValidation = () => {
        if (!originalGifs) return;

        const total = Object.keys(originalGifs).length;
        if (total === 0) return;

        const controller = new AbortController();
        abortRef.current = controller;

        // Capture mutable accumulator to build results / live list outside React state.
        const liveAcc: LiveResult[] = [];

        setState({
            kind: "running",
            completed: 0,
            total,
            live: [],
            abort: () => controller.abort()
        });

        const onProgress = (e: ProgressEvent<ValidationResult>) => {
            const gif = originalGifs[e.key];
            if (!gif) return;

            let live: LiveResult;
            if (e.result.kind === "ok") {
                const v = e.result.value;
                live = {
                    key: e.key,
                    gif,
                    valid: v.valid,
                    status: v.status,
                    contentType: v.contentType,
                    reason: v.reason
                };
            } else {
                live = {
                    key: e.key,
                    gif,
                    valid: false,
                    status: 0,
                    contentType: null,
                    reason: "network"
                };
            }

            // newest first
            liveAcc.unshift(live);
            setState(prev => {
                if (prev.kind !== "running") return prev;
                return {
                    ...prev,
                    completed: e.completed,
                    total: e.total,
                    live: liveAcc.slice()
                };
            });
        };

        validateAll(originalGifs, onProgress, controller.signal)
            .then(() => {
                // Use the live accumulator (which we've built incrementally) as the source of truth.
                // It already reflects every progress event, including ones that fired after abort.
                const resolved: ResolvedGif[] = liveAcc
                    .slice()
                    // Display order: broken first, then valid; within each, keep arrival order (newest first already).
                    .sort((a, b) => Number(a.valid) - Number(b.valid))
                    .map(r => ({ ...r, selected: !r.valid }));

                setState({ kind: "done", results: resolved, saving: false });
            })
            .catch(err => {
                Flogger.error("validateAll failed", err);
                const resolved: ResolvedGif[] = liveAcc
                    .slice()
                    .sort((a, b) => Number(a.valid) - Number(b.valid))
                    .map(r => ({ ...r, selected: !r.valid }));
                setState({ kind: "done", results: resolved, saving: false });
            });
    };

    const setSelected = (key: string, selected: boolean) => {
        setState(prev => {
            if (prev.kind !== "done") return prev;
            return {
                ...prev,
                results: prev.results.map(r => r.key === key ? { ...r, selected } : r)
            };
        });
    };

    const setAllSelected = (selected: boolean) => {
        setState(prev => {
            if (prev.kind !== "done") return prev;
            return {
                ...prev,
                results: prev.results.map(r => r.valid ? r : { ...r, selected })
            };
        });
    };

    const removeSelected = async () => {
        if (state.kind !== "done" || !originalGifs) return;

        const toRemove = state.results.filter(r => !r.valid && r.selected).map(r => r.key);
        if (toRemove.length === 0) return;

        setState({ ...state, saving: true, saveError: undefined });

        // Shallow-copy each retained entry so we never mutate the live store.
        const newGifs: FavoriteGifList = {};
        for (const [key, gif] of Object.entries(originalGifs)) {
            if (toRemove.includes(key)) continue;
            newGifs[key] = { ...gif };
        }

        // Re-number `order` on the survivors based on existing order.
        Object.values(newGifs)
            .sort((a, b) => a.order - b.order)
            .forEach((g, i) => { g.order = i; });

        try {
            const ok = await saveFavoriteGifs(newGifs);
            if (ok) {
                setState(prev => prev.kind === "done"
                    ? { ...prev, saving: false, savedSuccess: true }
                    : prev);
            } else {
                setState(prev => prev.kind === "done"
                    ? { ...prev, saving: false, saveError: "Save failed. See console for details." }
                    : prev);
            }
        } catch (err) {
            Flogger.error("removeSelected save failed", err);
            setState(prev => prev.kind === "done"
                ? { ...prev, saving: false, saveError: "Save threw an error. See console for details." }
                : prev);
        }
    };

    // ---------- render branches ----------

    const renderRow = (r: LiveResult, opts: {
        showPill?: boolean;
        checkbox?: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; };
        muted?: boolean;
    }) => {
        const url = r.gif.src ?? r.gif.url ?? r.key;
        const reason = !r.valid ? describeReason(r) : null;

        return (
            <div
                key={r.key}
                className={cl("row")}
                style={opts.muted ? { opacity: 0.6 } : undefined}
            >
                {opts.checkbox && (
                    <input
                        type="checkbox"
                        checked={opts.checkbox.checked}
                        disabled={opts.checkbox.disabled}
                        onChange={ev => opts.checkbox!.onChange(ev.currentTarget.checked)}
                    />
                )}
                <img
                    className={cl("thumb")}
                    src={r.gif.src}
                    loading="lazy"
                    width={60}
                    height={60}
                    alt=""
                />
                <div className={cl("meta")}>
                    {opts.showPill && (
                        r.valid
                            ? <span className={cl("pill-valid")}>{"✔ valid"}</span>
                            : <span className={cl("pill-broken")}>{"✘ broken"}</span>
                    )}
                    {reason && <span className={cl("reason")}>{reason}</span>}
                    <span className={cl("url")} title={url}>{url}</span>
                </div>
            </div>
        );
    };

    let body: ReactNode;
    let footer: ReactNode;

    if (!snapshot) {
        body = (
            <div className={cl("empty")}>
                Couldn&apos;t read favorite GIFs from Discord. Are you signed in?
            </div>
        );
        footer = (
            <Button onClick={modalProps.onClose}>Close</Button>
        );
    } else if (state.kind === "idle" && state.gifCount === 0) {
        body = (
            <div className={cl("empty")}>
                You have no favorite GIFs.
            </div>
        );
        footer = (
            <Button onClick={modalProps.onClose}>Close</Button>
        );
    } else if (state.kind === "idle") {
        const concurrency = settings.store.concurrency;
        body = (
            <div>
                <p>
                    This tool checks each of your favorite GIFs to see if it still loads,
                    then lets you remove any that are broken (404, timeout, wrong content type, etc.).
                </p>
                <p>
                    You have <strong>{state.gifCount}</strong> favorite GIFs.
                    Will check {concurrency} at a time.
                </p>
            </div>
        );
        footer = (
            <>
                <Button onClick={startValidation}>Start Validation</Button>
                <Button variant="secondary" onClick={modalProps.onClose}>Cancel</Button>
            </>
        );
    } else if (state.kind === "running") {
        const pct = state.total === 0 ? 0 : Math.round((state.completed / state.total) * 100);
        body = (
            <div>
                <div className={cl("progress")}>
                    <div
                        className={cl("progress-fill")}
                        style={{ width: `${pct}%` }}
                    />
                </div>
                <p className={cl("summary")}>
                    Checking {state.completed} of {state.total}&hellip;
                </p>
                <div className={cl("row-list")}>
                    {state.live.map(r => renderRow(r, { showPill: true }))}
                </div>
            </div>
        );
        footer = (
            <Button variant="dangerPrimary" onClick={state.abort}>Cancel</Button>
        );
    } else if (state.kind === "done" && state.savedSuccess) {
        body = (
            <div className={cl("empty")}>
                Removed selected GIFs successfully.
            </div>
        );
        footer = (
            <Button onClick={modalProps.onClose}>Close</Button>
        );
    } else {
        // done state
        const broken = state.results.filter(r => !r.valid);
        const valid = state.results.filter(r => r.valid);
        const selectedCount = broken.filter(r => r.selected).length;

        body = (
            <div>
                <p className={cl("summary")}>
                    Found <strong>{broken.length}</strong> broken GIFs out of <strong>{state.results.length}</strong>.
                </p>

                {state.saveError && (
                    <div className={cl("empty")}>
                        {state.saveError}
                    </div>
                )}

                {broken.length > 0 && (
                    <>
                        <div className={cl("actions")}>
                            <a
                                href="#"
                                className={cl("link")}
                                onClick={e => { e.preventDefault(); setAllSelected(true); }}
                            >Select All</a>
                            {" · "}
                            <a
                                href="#"
                                className={cl("link")}
                                onClick={e => { e.preventDefault(); setAllSelected(false); }}
                            >Deselect All</a>
                            {" · "}
                            <a
                                href="#"
                                className={cl("link")}
                                onClick={e => { e.preventDefault(); setShowValidToo(v => !v); }}
                            >{showValidToo ? "Hide valid GIFs" : "Show valid GIFs too"}</a>
                        </div>
                        <div className={cl("row-list")}>
                            {broken.map(r => renderRow(r, {
                                checkbox: {
                                    checked: r.selected,
                                    disabled: state.saving,
                                    onChange: v => setSelected(r.key, v)
                                }
                            }))}
                        </div>
                    </>
                )}

                {showValidToo && valid.length > 0 && (
                    <div>
                        <p className={cl("summary")}>Valid GIFs ({valid.length})</p>
                        <div className={cl("row-list")}>
                            {valid.map(r => renderRow(r, { showPill: true, muted: true }))}
                        </div>
                    </div>
                )}
            </div>
        );

        footer = (
            <>
                <Button
                    variant="dangerPrimary"
                    disabled={state.saving || selectedCount === 0}
                    onClick={removeSelected}
                >
                    {state.saving ? "Removing…" : `Remove Selected (${selectedCount})`}
                </Button>
                <Button variant="secondary" onClick={modalProps.onClose}>Cancel</Button>
            </>
        );
    }

    return (
        <ModalRoot {...modalProps} size={ModalSize.LARGE}>
            <ModalHeader>
                <h2 style={{ margin: 0 }}>Favorite GIF Validator</h2>
            </ModalHeader>
            <ModalContent className={cl("modal")}>
                {body}
            </ModalContent>
            <ModalFooter>
                {footer}
            </ModalFooter>
        </ModalRoot>
    );
}

export function openValidatorModal(): void {
    openModal(modalProps => (
        <ErrorBoundary>
            <ValidatorModalInner modalProps={modalProps} />
        </ErrorBoundary>
    ));
}
