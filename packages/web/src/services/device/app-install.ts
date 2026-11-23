export type InstallChoice = "accepted" | "dismissed";

/** The browser's offer to install Morty. Its prompt opens once, and only from a click. */
export interface InstallOffer {
    readonly prompt: () => Promise<InstallChoice>;
}

export interface AppInstall {
    readonly watch: (
        listeners: { readonly offered: (offer: InstallOffer) => void; readonly installed: () => void },
        signal: AbortSignal,
    ) => void;
}

interface BeforeInstallPromptEvent extends Event {
    readonly prompt: () => Promise<unknown>;
    readonly userChoice: Promise<{ readonly outcome: InstallChoice }>;
}

function isInstallPrompt(event: Event): event is BeforeInstallPromptEvent {
    return "prompt" in event && typeof event.prompt === "function" && "userChoice" in event;
}

export function browserAppInstall(): AppInstall {
    return {
        watch: ({ offered, installed }, signal) => {
            window.addEventListener(
                "beforeinstallprompt",
                (event) => {
                    if (!isInstallPrompt(event)) {
                        return;
                    }
                    // Morty offers installation itself once the browser is connected, instead of the browser's banner.
                    event.preventDefault();
                    offered({
                        prompt: async () => {
                            await event.prompt();
                            return (await event.userChoice).outcome;
                        },
                    });
                },
                { signal },
            );
            window.addEventListener("appinstalled", installed, { signal });
        },
    };
}
