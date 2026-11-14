import type { AnyRouter } from "@tanstack/react-router";
import { useStore } from "zustand";
import type { MortyApplication } from "../../view-models/morty-application.ts";
import { App } from "../application/app.tsx";
import { NotFoundPage } from "../application/not-found-page.tsx";

export function SessionApplication({
    application,
    signedInRouter,
    continuationRouter,
}: {
    readonly application: MortyApplication;
    readonly signedInRouter: AnyRouter;
    readonly continuationRouter: AnyRouter;
}) {
    const { state } = useStore(application.anonymousSession);
    // Missing pages must not be hidden by loading, pairing, or setup screens.
    if (!/^\/(?:chat\/?|setup\/?|continue\/?)?$/.test(window.location.pathname)) {
        return <NotFoundPage />;
    }
    const continuationPath = window.location.pathname.startsWith("/continue");
    if (continuationPath) {
        return (
            <App
                bugReportDialog={application.bugReportDialog}
                state={{ kind: "authentication", router: continuationRouter }}
            />
        );
    }
    if (state.kind === "loading") {
        return <App bugReportDialog={application.bugReportDialog} state={{ kind: "loading" }} />;
    }
    if (state.kind === "failed") {
        return (
            <App
                bugReportDialog={application.bugReportDialog}
                state={{
                    kind: "failed",
                    retry: application.reloadIdentity,
                    retrying: state.retrying,
                }}
            />
        );
    }
    if (state.kind === "invalid-link" || state.kind === "unpaired") {
        return <App bugReportDialog={application.bugReportDialog} state={state} />;
    }
    // Every branch renders the same App component, so the tree — and the bug
    // report dialog host inside it — survives the loading → setup/active
    // transition without unmounting or cancelling an in-flight send.
    if (state.kind === "setup") {
        return (
            <App
                bugReportDialog={application.bugReportDialog}
                state={{
                    kind: "setup",
                    notice: state.notice,
                    returnHref: state.returnHref,
                    setupHandoff: application.setupHandoff,
                }}
            />
        );
    }
    return <App bugReportDialog={application.bugReportDialog} state={{ kind: "signed-in", router: signedInRouter }} />;
}
