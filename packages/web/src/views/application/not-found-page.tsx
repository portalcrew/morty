import { Button } from "../../components/ui/cloud-button.tsx";
import {
    SetupCardDescription,
    SetupCardSection,
    SetupCardShell,
    SetupCardTitle,
    setupPrimaryButtonClassName,
    setupPrimaryButtonSize,
} from "../setup/setup-card-shell.tsx";

export function NotFoundPage() {
    return (
        <SetupCardShell cardClassName="pb-8" titleId="not-found-title">
            <title>Page not found · Morty</title>
            <meta name="robots" content="noindex" />
            <p className="mb-2 text-sm font-semibold tracking-widest text-morty-text-3">404</p>
            <SetupCardTitle id="not-found-title">Page not found</SetupCardTitle>
            <SetupCardDescription>
                This address doesn't exist on Morty. Check the link, or start again from the home page.
            </SetupCardDescription>
            <SetupCardSection>
                <Button asChild className={setupPrimaryButtonClassName} size={setupPrimaryButtonSize}>
                    <a href="/">Go to Morty home</a>
                </Button>
            </SetupCardSection>
        </SetupCardShell>
    );
}
