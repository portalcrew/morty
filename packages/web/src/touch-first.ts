/** Touch-first by capability, not by user agent: a tablet with a trackpad keeps the desktop flow. */
const touchFirstQuery = "(hover: none) and (pointer: coarse)";

export function isTouchFirst(): boolean {
    return window.matchMedia(touchFirstQuery).matches;
}

export function subscribeTouchFirst(onChange: () => void): () => void {
    const query = window.matchMedia(touchFirstQuery);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
}
