import { create } from "zustand";
import type { ApiTransport } from "../services/api/api-transport.ts";
import type { DaemonDiagnosticsSource } from "../services/diagnostics/browser-diagnostics.ts";
import { sentryBugReportSink } from "../services/diagnostics/bug-report.ts";
import { type BugReportStoreApi, createBugReportStore } from "./bug-report-store.ts";

export type BugReportDialogStore = ReturnType<typeof createBugReportDialogStore>;

/**
 * Creates the shared bug-report dialog state: any entry point opens the
 * single dialog; `show` builds a fresh report store for the opening and
 * `hide` cancels any in-flight send through the store's own close path.
 * Owned by the application root, so the transport it reports through is the
 * application's transport.
 */
export const createBugReportDialogStore = (transport: () => ApiTransport | null) =>
    create<{
        readonly report: BugReportStoreApi | null;
        readonly show: (daemonSource: DaemonDiagnosticsSource | null) => void;
        readonly hide: () => void;
    }>((set, get) => ({
        report: null,
        show: (daemonSource) => set({ report: createBugReportStore(sentryBugReportSink, transport(), daemonSource) }),
        hide: () => {
            const report = get().report;
            set({ report: null });
            report?.getState().close();
        },
    }));
