/**
 * A short description of this browser, such as "iPhone · Safari", that the owner's other devices show when it joins.
 * It only helps people recognize their own devices: any browser can describe itself however it likes.
 */
export function describeBrowser(userAgent: string, installedApp: boolean): string {
    const relay = /iPhone/u.test(userAgent)
        ? "iPhone"
        : /iPad/u.test(userAgent)
          ? "iPad"
          : /Android/u.test(userAgent)
            ? "Android"
            : /Macintosh|Mac OS X/u.test(userAgent)
              ? "Mac"
              : /Windows/u.test(userAgent)
                ? "Windows"
                : /CrOS/u.test(userAgent)
                  ? "ChromeOS"
                  : /Linux/u.test(userAgent)
                    ? "Linux"
                    : "Unknown device";
    const browser = installedApp
        ? "Home Screen app"
        : /MicroMessenger/u.test(userAgent)
          ? "WeChat"
          : /Edg\//u.test(userAgent)
            ? "Edge"
            : /OPR\//u.test(userAgent)
              ? "Opera"
              : /Firefox\/|FxiOS/u.test(userAgent)
                ? "Firefox"
                : /Chrome\/|CriOS/u.test(userAgent)
                  ? "Chrome"
                  : /Safari\//u.test(userAgent)
                    ? "Safari"
                    : "Browser";
    return `${relay} · ${browser}`;
}
