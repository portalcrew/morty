export type InstallChoice = "accepted" | "dismissed";

/** The browser's offer to install Morty. Its prompt opens once, and only from a click. */
export interface InstallOffer {
    readonly prompt: () => Promise<InstallChoice>;
}

/**
 * Where this page runs on a device whose Home Screen apps keep storage apart from the browser, as iOS and iPadOS do:
 * in Safari, whose Home Screen steps and access Morty describes, or in the Home Screen app itself, which starts without
 * Safari's access. Elsewhere an installed app shares the browser's storage, so neither applies.
 */
type HomeScreenApp = "none" | "from-safari" | "running";

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
    // Other iOS browsers keep their own access and Home Screen steps, and in-app browsers such as WeChat cannot add to
    // the Home Screen; Safari alone carries Version/ and Safari/ without another browser's token.
    const safari =
        /Version\/[\d.]+.*Safari\//u.test(device.userAgent) &&
        !/CriOS|FxiOS|EdgiOS|OPiOS|OPT\/|GSA\/|Ddg\//u.test(device.userAgent);
    return safari ? "from-safari" : "none";
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
