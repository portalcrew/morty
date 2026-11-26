const LOCAL_FILE_URL_ORIGIN = "https://local-file.morty.invalid";

function withoutSourceLocation(path: string): string {
    const value = path.replace(/:\d+(?::\d+)?$/u, "");
    return /^[A-Za-z]:[\\/]/u.test(value) ? value.replaceAll("/", "\\") : value;
}

function fileSystemPath(href: string): string | null {
    if (href.startsWith("file:")) {
        try {
            const url = new URL(href);
            if (url.protocol !== "file:" || url.host.length > 0) {
                return null;
            }
            const path = decodeURIComponent(url.pathname);
            return withoutSourceLocation(/^\/[A-Za-z]:\//u.test(path) ? path.slice(1) : path);
        } catch {
            return null;
        }
    }
    try {
        const decoded = decodeURI(href);
        return decoded.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(decoded) ? withoutSourceLocation(decoded) : null;
    } catch {
        return null;
    }
}

export function relativeFilePath(href: string): string | null {
    try {
        const path = decodeURIComponent(href);
        return path.length > 0 && !/^(?:[a-z][a-z0-9+.-]*:|[\\/]|[?#])/iu.test(path) && !path.includes("\0")
            ? path
            : null;
    } catch {
        return null;
    }
}

export function localFilePath(href: string): string | null {
    try {
        const url = new URL(href);
        if (url.origin !== LOCAL_FILE_URL_ORIGIN) {
            return fileSystemPath(href);
        }
        const path = url.searchParams.get("path");
        return path === null ? null : (fileSystemPath(path) ?? relativeFilePath(path));
    } catch {
        return fileSystemPath(href);
    }
}

export function encodeLocalFileUrl(path: string): string {
    const url = new URL(LOCAL_FILE_URL_ORIGIN);
    url.searchParams.set("path", path);
    return url.href;
}
