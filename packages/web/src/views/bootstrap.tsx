import { ErrorBoundary, reactErrorHandler } from "@sentry/react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RemoteImageConsentProvider } from "../components/agents/remote-image-consent.tsx";
import { SessionResourceStoreProvider } from "../components/agents/session-resource.tsx";
import { ImageDownloadProvider } from "../components/images/image-download.tsx";
import { ImageViewerProvider } from "../components/images/image-gallery.tsx";
import { ToastProvider } from "../components/ui/toast.tsx";
import { installInputModalityTracking } from "../input-modality.ts";
import type { ApiTransport } from "../services/api/api-transport.ts";
import type { SetupHandoff } from "../services/device/setup-handoff.ts";
import type { Clock } from "../services/time/clock.ts";
import { createImageDownloadStore } from "../view-models/chat/image-download-store.ts";
import { createSessionResourceStore } from "../view-models/chat/session-resource-store.ts";
import { createMortyApplication, type MortyApplication } from "../view-models/morty-application.ts";
import { MortyApplicationProvider } from "./application/application-context.tsx";
import { MortyCrashFallback } from "./application/crash-fallback.tsx";
import { createSignedInRouter } from "./application/router.tsx";
import { createContinuationRouter } from "./authentication/router.tsx";
import { SessionApplication } from "./authentication/session-application.tsx";

/**
 * The one application assembly shared by production and tests: creates the
 * application, builds the continuation router once, and renders the session
 * application tree with its toast host and error boundary. `assembleMorty`
 * owns creation; `mountMorty` additionally attaches a real React root, which
 * is what the page does.
 */
export function assembleMorty(options: {
    readonly transport: ApiTransport;
    readonly origin: string;
    readonly clock?: Clock;
    readonly setupHandoff?: SetupHandoff;
}): {
    readonly application: MortyApplication;
    readonly element: React.ReactElement;
} {
    installInputModalityTracking();
    // Application-scoped workflows — the Chat API transport and the anonymous
    // identity session — are owned outside React's mount and unmount cycle.
    // They start with the page and end with it, so no component effect
    // manages them.
    const application = createMortyApplication({
        origin: options.origin,
        transport: options.transport,
        ...(options.clock === undefined ? {} : { clock: options.clock }),
        ...(options.setupHandoff === undefined ? {} : { setupHandoff: options.setupHandoff }),
    });
    // The signed-in router is assembled once with the application: its inputs
    // (the stable authorize action, the application) are fixed for the
    // application's lifetime, so no component rebuilds it while rendering.
    const signedInRouter = createSignedInRouter(application);
    const continuationRouter = createContinuationRouter();
    const element = (
        <MortyApplicationProvider application={application}>
            <ImageDownloadProvider createStore={createImageDownloadStore}>
                <SessionResourceStoreProvider createStore={createSessionResourceStore}>
                    <ToastProvider>
                        <ErrorBoundary fallback={<MortyCrashFallback dialog={application.bugReportDialog} />}>
                            <ImageViewerProvider>
                                <RemoteImageConsentProvider store={application.remoteImages}>
                                    <SessionApplication
                                        application={application}
                                        signedInRouter={signedInRouter}
                                        continuationRouter={continuationRouter}
                                    />
                                </RemoteImageConsentProvider>
                            </ImageViewerProvider>
                        </ErrorBoundary>
                    </ToastProvider>
                </SessionResourceStoreProvider>
            </ImageDownloadProvider>
        </MortyApplicationProvider>
    );
    return {
        application,
        element,
    };
}

/**
 * Attaches the assembled application to a real React root, exactly like the
 * production page. Tests render the assembled element through their own
 * renderer instead and share every other step of the assembly.
 */
export function mountMorty(options: {
    readonly element: HTMLElement;
    readonly transport: ApiTransport;
    readonly origin: string;
}): {
    readonly application: MortyApplication;
    /** Unmounts the React tree; the application keeps running. */
    readonly unmount: () => void;
    /** Releases the application's resources after its last unmount. */
    readonly dispose: () => void;
} {
    const { application, element } = assembleMorty({
        origin: options.origin,
        transport: options.transport,
    });
    const root = createRoot(options.element, {
        onUncaughtError: (error, info) => reactErrorHandler()(error, { componentStack: info.componentStack ?? null }),
        onRecoverableError: (error, info) =>
            reactErrorHandler()(error, { componentStack: info.componentStack ?? null }),
    });
    // StrictMode replays mounts in development to show that nothing the application owns depends on React's.
    root.render(<StrictMode>{element}</StrictMode>);
    return {
        application,
        unmount: () => {
            void root.unmount();
        },
        dispose: () => {
            application.dispose();
        },
    };
}
