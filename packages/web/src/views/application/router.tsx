import { isIdentifier } from "@morty-build/client/protocol";
import { createRootRoute, createRoute, createRouter, Outlet, useRouter } from "@tanstack/react-router";
import { Button } from "../../components/ui/cloud-button.tsx";
import { describePageFailure } from "../../view-models/format-error.ts";
import type { MortyApplication } from "../../view-models/morty-application.ts";
import { reportApplicationError } from "../../view-models/report-error.ts";
import {
    SetupCardDescription,
    SetupCardFailureIcon,
    SetupCardSection,
    SetupCardShell,
    SetupCardTitle,
    setupPrimaryButtonClassName,
    setupPrimaryButtonSize,
} from "../setup/setup-card-shell.tsx";
import { MortyChat } from "./morty-chat.tsx";
import { NotFoundPage } from "./not-found-page.tsx";

function RootRoute() {
    return <Outlet />;
}

function routeFailureMessage(error: Error): string {
    const message = error.message.trim() || "The application could not be loaded.";
    const separatorIndex = message.lastIndexOf(": ");
    if (separatorIndex < 0) {
        return message;
    }
    const candidate = message.slice(separatorIndex + 2);
    try {
        const url = new URL(candidate);
        if (url.protocol === "http:" || url.protocol === "https:") {
            return message.slice(0, separatorIndex);
        }
    } catch {
        return message;
    }
    return message;
}

function RouteFailureContent({ error, onRetry }: { readonly error: Error; readonly onRetry: () => void }) {
    const copy = describePageFailure(routeFailureMessage(error), "Something went wrong");
    return (
        <SetupCardShell cardClassName="pb-10" cardLeading={<SetupCardFailureIcon />} titleId="route-failure-title">
            <div className="min-w-0" role="alert">
                <SetupCardTitle className="[overflow-wrap:anywhere]" id="route-failure-title">
                    {copy.title}
                </SetupCardTitle>
                <SetupCardDescription className="[overflow-wrap:anywhere]">{copy.content}</SetupCardDescription>
            </div>
            <SetupCardSection className="mt-4">
                <Button className={setupPrimaryButtonClassName} onClick={onRetry} size={setupPrimaryButtonSize}>
                    Try again
                </Button>
            </SetupCardSection>
        </SetupCardShell>
    );
}

function RouteFailure({ error, reset }: { readonly error: unknown; readonly reset: () => void }) {
    const router = useRouter();
    return (
        <RouteFailureContent
            error={error instanceof Error ? error : new Error("The application could not be loaded.")}
            onRetry={() => {
                reset();
                void router.invalidate();
            }}
        />
    );
}

export function createSignedInRouter(application: MortyApplication) {
    const root = createRootRoute({
        beforeLoad: async ({ abortController }) =>
            await application.anonymousSession.getState().authorize(abortController.signal),
        component: RootRoute,
        notFoundComponent: NotFoundPage,
        errorComponent: (props) => <RouteFailure {...props} />,
    });
    function page(path: "/" | "/chat") {
        const route = createRoute({
            getParentRoute: () => root,
            path,
            validateSearch: (search) => {
                const sessionId = Reflect.get(search, "sessionId");
                return {
                    sessionId: isIdentifier(sessionId) ? sessionId : undefined,
                };
            },
            component: function ApplicationRoute() {
                return <MortyChat application={application} />;
            },
        });
        return route;
    }
    return createRouter({
        routeTree: root.addChildren([page("/"), page("/chat")]),
        defaultOnCatch: (error) => reportApplicationError(error, "application-route"),
        scrollRestoration: true,
    });
}
