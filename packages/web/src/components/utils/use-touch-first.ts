import { useSyncExternalStore } from "react";
import { isTouchFirst, subscribeTouchFirst } from "../../touch-first.ts";

export function useTouchFirst(): boolean {
    return useSyncExternalStore(subscribeTouchFirst, isTouchFirst);
}
