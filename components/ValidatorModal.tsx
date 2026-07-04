/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { classNameFactory } from "@api/Styles";
import { Button, TextButton } from "@components/Button";
import ErrorBoundary from "@components/ErrorBoundary";
import { classes } from "@utils/misc";
import { ModalContent, ModalFooter, ModalHeader, ModalProps, ModalRoot, ModalSize, openModal } from "@utils/modal";
import { Checkbox, Forms, ScrollerThin, Text, useEffect, useMemo, useRef, useState } from "@webpack/common";
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

function ModalTitleBlock({ subtitle }: { subtitle?: string; }) {
    return (
        <div className={cl("header")}>
            <div className={cl("header-icon")} aria-hidden>GIF</div>
            <div className={cl("header-text")}>
                <Text variant="text-lg/semibold" className={cl("header-title")}>
                    Favorite GIF Validator
                </Text>
                <Text variant="text-sm/normal" color="text-muted" className={cl("header-subtitle")}>
                    {subtitle ?? "Check your saved GIFs and clean up broken links"}
                </Text>
            </div>
        </div>
    );
}

function StatCard({ label, value, tone }: { label: string; value: ReactNode; tone?: "default" | "positive" | "danger"; }) {
    return (
        <div className={cl("stat")}>
            <Text variant="text-xs/semibold" color="text-muted" className={cl("stat-label")}>
                {label}
            </Text>
            <Text
                tag="div"
                variant="text-lg/semibold"
                className={classes(
                    cl("stat-value"),
                    tone === "positive" && cl("stat-value-positive"),
                    tone === "danger" && cl("stat-value-danger"),
                )}
            >
                {value}
            </Text>
        </div>
    );
}

function EmptyState({ icon, title, children }: { icon: string; title: string; children: ReactNode; }) {
    return (
        <div className={cl("empty")}>
            <div className={cl("empty-icon")} aria-hidden>{icon}</div>
            <Text variant="text-lg/semibold" className={cl("empty-title")}>{title}</Text>
            <Text variant="text-md/normal" color="text-muted" className={cl("empty-text")}>{children}</Text>
        </div>
    );
}

function GifRow({ result: r, showBadge, checkbox, muted }: {
    result: LiveResult;
    showBadge?: boolean;
    checkbox?: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; };
    muted?: boolean;
}) {
    const url = r.gif.src ?? r.gif.url ?? r.key;
    const reason = !r.valid ? describeReason(r) : null;

    return (
        <div
            className={classes(
                cl("row"),
                r.valid ? cl("row-valid") : cl("row-broken"),
                muted && cl("row-muted"),
            )}
        >
            {checkbox && (
                <div className={cl("row-check")}>
                    <Checkbox
                        value={checkbox.checked}
                        disabled={checkbox.disabled}
                        onChange={() => checkbox.onChange(!checkbox.checked)}
                    />
                </div>
            )}
            <div className={cl("thumb-wrap")}>
                <img
                    className={cl("thumb")}
                    src={r.gif.src}
                    loading="lazy"
                    width={56}
                    height={56}
                    alt=""
                />
            </div>
            <div className={cl("meta")}>
                <div className={cl("meta-top")}>
                    {showBadge && (
                        <span className={classes(cl("badge"), r.valid ? cl("badge-valid") : cl("badge-broken"))}>
                            {r.valid ? "Valid" : "Broken"}
                        </span>
                    )}
                    {reason && <span className={cl("reason")}>{reason}</span>}
                </div>
                <span className={cl("url")} title={url}>
                    <Text variant="text-xs/normal" color="text-muted">{url}</Text>
                </span>
            </div>
        </div>
    );
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
                const resolved: ResolvedGif[] = liveAcc
                    .slice()
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

        const newGifs: FavoriteGifList = {};
        for (const [key, gif] of Object.entries(originalGifs)) {
            if (toRemove.includes(key)) continue;
            newGifs[key] = { ...gif };
        }

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

    let headerSubtitle: string | undefined;
    let body: ReactNode;
    let footer: ReactNode;

    if (!snapshot) {
        headerSubtitle = "Unable to load favorites";
        body = (
            <EmptyState icon="!" title={"Couldn't read favorites"}>
                Discord&apos;s favorite GIF store isn&apos;t available right now. Make sure you&apos;re signed in and try again.
            </EmptyState>
        );
        footer = <Button onClick={modalProps.onClose}>Close</Button>;
    } else if (state.kind === "idle" && state.gifCount === 0) {
        headerSubtitle = "No favorites yet";
        body = (
            <EmptyState icon="☆" title="No favorite GIFs">
                Star GIFs in the picker and they&apos;ll show up here for validation.
            </EmptyState>
        );
        footer = <Button onClick={modalProps.onClose}>Close</Button>;
    } else if (state.kind === "idle") {
        const concurrency = settings.store.concurrency;
        const timeoutSec = settings.store.timeoutMs / 1000;
        headerSubtitle = `${state.gifCount} favorites ready to scan`;

        body = (
            <div className={cl("content")}>
                <div className={cl("stats")}>
                    <StatCard label="Favorites" value={state.gifCount} />
                    <StatCard label="Parallel" value={concurrency} />
                    <StatCard label="Timeout" value={`${timeoutSec}s`} />
                </div>

                <div className={cl("panel")}>
                    <Forms.FormTitle tag="h5">What this does</Forms.FormTitle>
                    <Text variant="text-md/normal" color="text-muted" className={cl("panel-muted")}>
                        Each favorite gets a quick HEAD request (with GET fallback) to confirm the URL still responds.
                        Broken links — 404s, timeouts, wrong content types — can be bulk-removed afterward.
                    </Text>
                    <Text variant="text-md/normal" color="text-muted" className={cl("panel-muted")}>
                        Up to <strong>{concurrency}</strong> GIFs are checked at once with a{" "}
                        <strong>{timeoutSec}s</strong> timeout each. When one finishes, the next starts immediately.
                    </Text>
                </div>

                <Text variant="text-sm/normal" className={classes(cl("banner"), cl("banner-warn"))}>
                    Tenor sometimes returns a placeholder image instead of a real 404. Review the list before removing if you&apos;re unsure.
                </Text>
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
        const brokenSoFar = state.live.filter(r => !r.valid).length;
        headerSubtitle = `Scanning ${state.completed} of ${state.total}`;

        body = (
            <div className={cl("content")}>
                <div className={cl("panel")}>
                    <div className={cl("progress-panel")}>
                        <div className={cl("progress-head")}>
                            <div>
                                <Text variant="text-sm/semibold" className={cl("progress-label")}>
                                    Validation in progress
                                </Text>
                                <Text variant="text-sm/normal" color="text-muted" className={cl("progress-meta")}>
                                    {state.completed} of {state.total} checked
                                    {brokenSoFar > 0 && ` · ${brokenSoFar} broken so far`}
                                </Text>
                            </div>
                            <span className={cl("progress-pct")}>{pct}%</span>
                        </div>
                        <div className={classes(cl("progress-track"), cl("progress-track-active"))}>
                            <div className={cl("progress-fill")} style={{ width: `${pct}%` }} />
                        </div>
                    </div>
                </div>

                {state.live.length > 0 ? (
                    <>
                        <Text variant="text-xs/semibold" color="text-muted" className={cl("section-title")}>
                            Live results
                        </Text>
                        <ScrollerThin className={cl("row-list")} fade={true}>
                            {state.live.map(r => (
                                <GifRow key={r.key} result={r} showBadge />
                            ))}
                        </ScrollerThin>
                    </>
                ) : (
                    <Text variant="text-sm/normal" className={classes(cl("banner"), cl("banner-info"))}>
                        Starting parallel checks&hellip;
                    </Text>
                )}
            </div>
        );
        footer = (
            <Button variant="dangerPrimary" onClick={state.abort}>Stop Scan</Button>
        );
    } else if (state.kind === "done" && state.savedSuccess) {
        headerSubtitle = "Cleanup complete";
        body = (
            <div className={cl("content")}>
                <div className={cl("empty")}>
                    <div className={cl("success-icon")} aria-hidden>✓</div>
                    <Text variant="text-lg/semibold" className={cl("empty-title")}>Removed successfully</Text>
                    <Text variant="text-md/normal" color="text-muted" className={cl("empty-text")}>
                        Selected broken GIFs were removed from your favorites. Discord will sync the change automatically.
                    </Text>
                </div>
            </div>
        );
        footer = <Button onClick={modalProps.onClose}>Close</Button>;
    } else {
        const broken = state.results.filter(r => !r.valid);
        const valid = state.results.filter(r => r.valid);
        const selectedCount = broken.filter(r => r.selected).length;
        headerSubtitle = broken.length === 0
            ? "All favorites look healthy"
            : `${broken.length} broken · ${valid.length} valid`;

        body = (
            <div className={cl("content")}>
                <div className={cl("stats")}>
                    <StatCard label="Broken" value={broken.length} tone={broken.length > 0 ? "danger" : "default"} />
                    <StatCard label="Valid" value={valid.length} tone="positive" />
                    <StatCard label="Total" value={state.results.length} />
                </div>

                {state.saveError && (
                    <Text variant="text-sm/normal" className={classes(cl("banner"), cl("banner-error"))}>
                        {state.saveError}
                    </Text>
                )}

                {broken.length === 0 ? (
                    <Text variant="text-sm/normal" className={classes(cl("banner"), cl("banner-info"))}>
                        Every favorite responded successfully. Nothing to remove.
                    </Text>
                ) : (
                    <>
                        <div className={cl("toolbar")}>
                            <TextButton variant="primary" onClick={() => setAllSelected(true)}>Select all</TextButton>
                            <TextButton variant="secondary" onClick={() => setAllSelected(false)}>Deselect all</TextButton>
                            <span className={cl("toolbar-divider")} />
                            <TextButton variant="link" onClick={() => setShowValidToo(v => !v)}>
                                {showValidToo ? "Hide valid GIFs" : `Show valid (${valid.length})`}
                            </TextButton>
                        </div>

                        <Text variant="text-xs/semibold" color="text-muted" className={cl("section-title")}>
                            Broken favorites
                        </Text>
                        <ScrollerThin className={cl("row-list")} fade={true}>
                            {broken.map(r => (
                                <GifRow
                                    key={r.key}
                                    result={r}
                                    checkbox={{
                                        checked: r.selected,
                                        disabled: state.saving,
                                        onChange: v => setSelected(r.key, v)
                                    }}
                                />
                            ))}
                        </ScrollerThin>
                    </>
                )}

                {showValidToo && valid.length > 0 && (
                    <>
                        <Text variant="text-xs/semibold" color="text-muted" className={cl("section-title")}>
                            Valid favorites ({valid.length})
                        </Text>
                        <ScrollerThin className={cl("row-list")} fade={true}>
                            {valid.map(r => (
                                <GifRow key={r.key} result={r} showBadge muted />
                            ))}
                        </ScrollerThin>
                    </>
                )}
            </div>
        );

        footer = (
            <>
                {broken.length > 0 && (
                    <Button
                        variant="dangerPrimary"
                        disabled={state.saving || selectedCount === 0}
                        onClick={removeSelected}
                    >
                        {state.saving ? "Removing…" : `Remove Selected (${selectedCount})`}
                    </Button>
                )}
                <Button variant="secondary" onClick={modalProps.onClose}>
                    {broken.length > 0 ? "Cancel" : "Close"}
                </Button>
            </>
        );
    }

    return (
        <ModalRoot {...modalProps} size={ModalSize.LARGE} className={cl("root")}>
            <ModalHeader>
                <ModalTitleBlock subtitle={headerSubtitle} />
            </ModalHeader>
            <ModalContent>
                {body}
            </ModalContent>
            <ModalFooter className={cl("footer")}>
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
