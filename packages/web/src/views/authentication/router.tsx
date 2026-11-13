import { createRootRoute, createRoute, createRouter, Outlet } from "@tanstack/react-router";
import type { ContinueStoreApi } from "../../view-models/authentication/continue-store.ts";
import { useExternalStore } from "../../view-models/external-store.ts";
import type { MortyApplication } from "../../view-models/morty-application.ts";
import { reportApplicationError } from "../../view-models/report-error.ts";
import { useMortyApplication } from "../application/application-context.tsx";
import { NotFoundPage } from "../application/not-found-page.tsx";
import { BugReportButton } from "../diagnostics/bug-report-button.tsx";
import { ContinuePageContent } from "./continue-page-content.tsx";

function ContinuePageLive({
    application,
    continuation,
}: {
    readonly application: MortyApplication;
    readonly continuation: ContinueStoreApi;
}) {
    // The application creates the redeem with itself; the page only
    // subscribes.
    const { retry, enterMorty, state, diagnostics, continueHref } = useExternalStore(continuation);
    return (
        <>
            <ContinuePageContent continueHref={continueHref} enterMorty={enterMorty} retry={retry} state={state} />
            <BugReportButton appearance="floating" daemonSource={diagnostics} dialog={application.bugReportDialog} />
        </>
    );
}

function ContinuePage() {
    const application = useMortyApplication();
    return <ContinuePageLive application={application} continuation={application.continuation} />;
}

const rootRoute = createRootRoute({ component: Outlet, notFoundComponent: NotFoundPage });
const continueRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/continue",
    component: ContinuePage,
});
export const createContinuationRouter = () =>
    createRouter({
        routeTree: rootRoute.addChildren([continueRoute]),
        defaultOnCatch: (error) => reportApplicationError(error, "continuation-route"),
        scrollRestoration: true,
    });
