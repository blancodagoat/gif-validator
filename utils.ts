/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export interface ValidatorTask<T> {
    key: string;
    run: () => Promise<T>;
}

export type ValidationOutcome<T> =
    | { kind: "ok"; value: T }
    | { kind: "error"; error: unknown };

export interface ProgressEvent<T> {
    completed: number;
    total: number;
    key: string;
    result: ValidationOutcome<T>;
}

export async function runWithConcurrency<T>(
    tasks: ValidatorTask<T>[],
    concurrency: number,
    onProgress: (e: ProgressEvent<T>) => void,
    signal?: AbortSignal
): Promise<Map<string, ValidationOutcome<T>>> {
    const results = new Map<string, ValidationOutcome<T>>();
    const total = tasks.length;
    if (total === 0) return results;

    const cap = Math.max(1, Math.min(Number.isFinite(concurrency) ? concurrency : 1, 10));

    let nextIndex = 0;
    let completed = 0;
    let aborted = signal?.aborted ?? false;

    const onAbort = () => { aborted = true; };
    if (signal && !signal.aborted) {
        signal.addEventListener("abort", onAbort, { once: true });
    }

    const runWorker = async () => {
        while (true) {
            if (aborted) return;
            const i = nextIndex++;
            if (i >= total) return;

            const task = tasks[i];
            let outcome: ValidationOutcome<T>;
            try {
                const value = await task.run();
                outcome = { kind: "ok", value };
            } catch (error) {
                outcome = { kind: "error", error };
            }

            results.set(task.key, outcome);
            completed++;

            try {
                onProgress({ completed, total, key: task.key, result: outcome });
            } catch {
                // never let a progress callback break the runner
            }
        }
    };

    const workerCount = Math.min(cap, total);
    const workers: Promise<void>[] = [];
    for (let i = 0; i < workerCount; i++) workers.push(runWorker());

    try {
        await Promise.all(workers);
    } finally {
        if (signal) signal.removeEventListener("abort", onAbort);
    }

    return results;
}
