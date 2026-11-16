export type ComputerLocationHint = "wnam" | "apac" | "apac-ne" | "apac-se";

import * as v from "valibot";

const northeastAsia = new Set(["CN", "HK", "JP", "KP", "KR", "MO", "MN", "TW"]);
const southeastAsia = new Set(["BN", "ID", "KH", "LA", "MM", "MY", "PH", "SG", "TH", "TL", "VN"]);

// Use Cloudflare's request metadata, not client-supplied headers or JSON.
export function computerLocationHint(request: Request): ComputerLocationHint | undefined {
    const metadata = v.safeParse(
        v.object({
            continent: v.picklist(["AF", "AN", "AS", "EU", "NA", "OC", "SA"]),
            country: v.optional(v.string()),
        }),
        "cf" in request ? request.cf : undefined,
    );
    if (!metadata.success) {
        return undefined;
    }
    if (metadata.output.continent !== "AS") {
        return metadata.output.continent === "OC" ? "apac" : "wnam";
    }
    if (metadata.output.country !== undefined && northeastAsia.has(metadata.output.country)) {
        return "apac-ne";
    }
    if (metadata.output.country !== undefined && southeastAsia.has(metadata.output.country)) {
        return "apac-se";
    }
    return "apac";
}
