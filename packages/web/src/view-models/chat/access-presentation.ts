import type { LinkedDevice } from "../../services/identity/anonymous-identity-api.ts";

export type DeviceDetailField = {
    readonly label: string;
    readonly value: string;
};

type DeviceDetailRow =
    | { readonly kind: "fields"; readonly fields: readonly DeviceDetailField[] }
    | { readonly kind: "text"; readonly text: string };

export type DeviceDescription = {
    readonly name: string;
    readonly details: readonly DeviceDetailRow[];
};

const momentFormat = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
});

export function formatMoment(time: string): string {
    return momentFormat.format(new Date(time));
}

export function formatMomentNumeric(time: string): string {
    const date = new Date(time);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    const hour = String(date.getHours()).padStart(2, "0");
    const minute = String(date.getMinutes()).padStart(2, "0");
    return `${year.toString()}-${month}-${day} ${hour}:${minute}`;
}

function addedByLabel(device: LinkedDevice): string | null {
    switch (device.addedBy?.kind) {
        case "computer":
            return "Your computer";
        case "device":
            return device.addedBy.label ?? "Another browser";
        case undefined:
            return null;
    }
}

function joinedLocation(location: LinkedDevice["location"]): string | null {
    const city = location?.city ?? null;
    const country = location?.country ?? null;
    if (city !== null && country !== null) {
        return `${city}, ${country}`;
    }
    if (city !== null || country !== null) {
        return city ?? country;
    }
    return null;
}

export type LinkedDeviceDescriptionContext = "dialog" | "notice";

export function describeLinkedDevice(
    device: LinkedDevice,
    context: LinkedDeviceDescriptionContext = "dialog",
): DeviceDescription {
    const fields: DeviceDetailField[] = [{ label: "Joined", value: formatMomentNumeric(device.joinedAt) }];
    const location = joinedLocation(device.location);
    if (location !== null) {
        fields.push({ label: "Location", value: location });
    }

    if (context === "dialog") {
        const from = addedByLabel(device);
        if (from !== null) {
            fields.push({ label: "From", value: from });
        }
        fields.push({ label: "Until", value: formatMomentNumeric(device.accessExpiresAt) });
    }

    return {
        name: device.label ?? "Unknown browser",
        details: [{ kind: "fields", fields }],
    };
}
