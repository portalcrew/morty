import { getByRole, queryByRole } from "@testing-library/dom";
import { expect, test } from "vitest";
import { dataTestId } from "../src/data-testid.ts";
import type { AppInstall, InstallChoice } from "../src/services/device/app-install.ts";
import { readyComposer } from "./infra/application-scenario.ts";
import { createTestApp, type TestApp } from "./infra/test-app.tsx";

/** A browser that offers to install Morty on every page it loads, and answers its dialog with `choice`. */
function browserOfferingInstall(choice: InstallChoice): AppInstall {
    return {
        watch: ({ offered, installed }) => {
            offered({
                prompt: async () => {
                    if (choice === "accepted") {
                        queueMicrotask(installed);
                    }
                    return choice;
                },
            });
        },
    };
}

async function installSuggestion(app: TestApp): Promise<HTMLElement> {
    const accessNotice = queryByRole(document.body, "status", { name: "This browser's access" });
    if (accessNotice !== null) {
        await app.user.click(getByRole(accessNotice, "button", { name: "Got it" }));
    }
    return await app.waitForView(() => getByRole(document.body, "status", { name: "Install Morty" }));
}

async function userMenuItem(app: TestApp, name: string): Promise<HTMLElement | null> {
    await app.user.click(await app.queryElementByTestId(dataTestId.userMenu));
    await app.waitForView(() => getByRole(document.body, "menuitem", { name: "Devices" }));
    return queryByRole(document.body, "menuitem", { name });
}

test("Given a connected browser that can install Morty, When the person installs it from the suggestion, Then the suggestion and the Install app entry are gone", {
    timeout: 60_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true, appInstall: browserOfferingInstall("accepted") });
    await readyComposer(app);

    await app.user.click(getByRole(await installSuggestion(app), "button", { name: "Install" }));

    await app.waitForView(() => expect(queryByRole(document.body, "status", { name: "Install Morty" })).toBeNull());
    expect(await userMenuItem(app, "Install app")).toBeNull();
});

test("Given a connected browser that can install Morty, When the person chooses Not now, Then the suggestion stays away after a reload and Install app stays in the menu", {
    timeout: 60_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true, appInstall: browserOfferingInstall("dismissed") });
    await readyComposer(app);

    await app.user.click(getByRole(await installSuggestion(app), "button", { name: "Not now" }));
    await app.waitForView(() => expect(queryByRole(document.body, "status", { name: "Install Morty" })).toBeNull());

    const reloaded = await app.reload();
    await readyComposer(reloaded);
    const install = await userMenuItem(reloaded, "Install app");
    expect(install).not.toBeNull();
    expect(queryByRole(document.body, "status", { name: "Install Morty" })).toBeNull();
});
