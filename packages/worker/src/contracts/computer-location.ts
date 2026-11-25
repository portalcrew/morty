import * as v from "valibot";

// Preserve the ID prefixes understood by older Workers, including on replacement retries.
export const computerRegionCodes = ["wn", "ap", "an", "as"] as const;
export type ComputerRegionCode = (typeof computerRegionCodes)[number];

const northeastAsia = new Set(["CN", "HK", "JP", "KP", "KR", "MO", "MN", "TW"]);
const southeastAsia = new Set(["BN", "ID", "KH", "LA", "MM", "MY", "PH", "SG", "TH", "TL", "VN"]);

// Use Cloudflare's request metadata, not client-supplied headers or JSON.
export function computerRegion(request: Request): ComputerRegionCode {
    const metadata = v.safeParse(
        v.object({
            continent: v.picklist(["AF", "AN", "AS", "EU", "NA", "OC", "SA"]),
            country: v.optional(v.string()),
        }),
        "cf" in request ? request.cf : undefined,
    );
    if (!metadata.success) {
        return "ap";
    }
    if (metadata.output.continent !== "AS") {
        return metadata.output.continent === "OC" ? "ap" : "wn";
    }
    if (metadata.output.country !== undefined && northeastAsia.has(metadata.output.country)) {
        return "an";
    }
    if (metadata.output.country !== undefined && southeastAsia.has(metadata.output.country)) {
        return "as";
    }
    return "ap";
}
