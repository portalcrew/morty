import * as v from "valibot";

/** Roughly where a connection came from, as Cloudflare located it: never its address. */
export interface ClientLocation {
    readonly city: string | null;
    readonly country: string | null;
}

const citySchema = v.pipe(v.string(), v.trim(), v.regex(/^[^\p{C}]{1,80}$/u));
const countrySchema = v.pipe(v.string(), v.regex(/^[A-Z]{2}$/u));
const locationSchema = v.object({ city: v.nullable(citySchema), country: v.nullable(countrySchema) });

export const clientLocationHeader = "Morty-Client-Location";

export function clientLocationOf(request: Request): ClientLocation | null {
    const metadata = v.safeParse(
        v.object({ city: v.optional(v.unknown()), country: v.optional(v.unknown()) }),
        "cf" in request ? request.cf : undefined,
    );
    if (!metadata.success) {
        return null;
    }
    const city = v.safeParse(citySchema, metadata.output.city);
    const country = v.safeParse(countrySchema, metadata.output.country);
    const location = { city: city.success ? city.output : null, country: country.success ? country.output : null };
    return location.city === null && location.country === null ? null : location;
}

/** Header values are bytes; a city name may not be, so the location travels percent-encoded. */
export function encodeClientLocation(location: ClientLocation): string {
    return encodeURIComponent(JSON.stringify(location));
}

export function decodeClientLocation(value: string | null): ClientLocation | null {
    if (value === null) {
        return null;
    }
    try {
        const parsed = v.safeParse(locationSchema, JSON.parse(decodeURIComponent(value)));
        return parsed.success ? parsed.output : null;
    } catch {
        return null;
    }
}
