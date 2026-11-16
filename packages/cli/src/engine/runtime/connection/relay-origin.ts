export type RelayOrigin =
    | { readonly kind: "valid"; readonly url: URL }
    | { readonly kind: "malformed" }
    | { readonly kind: "unsupported-protocol" }
    | { readonly kind: "credentials" }
    | { readonly kind: "insecure-remote" };

export function readRelayOrigin(value: string): RelayOrigin {
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        return { kind: "malformed" };
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
        return { kind: "unsupported-protocol" };
    }
    if (url.username.length > 0 || url.password.length > 0) {
        return { kind: "credentials" };
    }
    if (url.protocol === "http:" && url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
        return { kind: "insecure-remote" };
    }
    url.hash = "";
    url.pathname = "/";
    url.search = "";
    return { kind: "valid", url };
}
