export type InstallChoice = "accepted" | "dismissed";

/** The browser's offer to install Morty. Its prompt opens once, and only from a click. */
export interface InstallOffer {
    readonly prompt: () => Promise<InstallChoice>;
}

/**
 * Where this page runs on a device whose Home Screen apps keep storage apart from the browser, as iOS and iPadOS do:
 * in a browser that can add Morty to the Home Screen, or in the Home Screen app itself, which starts without the
 * browser's access. Elsewhere an installed app shares the browser's storage, so neither applies.
 */
type HomeScreenApp = "none" | "from-browser" | "running";

export interface AppInstall {
    readonly homeScreenApp: HomeScreenApp;
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

function homeScreenAppOf(device: {
    readonly userAgent: string;
    readonly maxTouchPoints: number;
    readonly standalone: boolean;
}): HomeScreenApp {
    // iPadOS reports a Mac; only its touch screen tells them apart.
    const ios =
        /iPhone|iPad|iPod/u.test(device.userAgent) ||
        (/Macintosh/u.test(device.userAgent) && device.maxTouchPoints > 1);
    if (!ios) {
        return "none";
    }
    if (device.standalone) {
        return "running";
    }
    // Safari and the other iOS browsers carry a Safari token; in-app browsers such as WeChat cannot add to the Home
    // Screen and do not.
    return /Safari\//u.test(device.userAgent) ? "from-browser" : "none";
}

export function runsAsInstalledApp(): boolean {
    return (
        ("standalone" in navigator && navigator.standalone === true) ||
        window.matchMedia("(display-mode: standalone)").matches
    );
}

export function browserAppInstall(): AppInstall {
    return {
        homeScreenApp: homeScreenAppOf({
            userAgent: navigator.userAgent,
            maxTouchPoints: navigator.maxTouchPoints,
            standalone: runsAsInstalledApp(),
        }),
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
