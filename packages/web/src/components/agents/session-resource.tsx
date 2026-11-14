import { createContext, type ReactNode, useContext, useMemo } from "react";
import { useStore } from "zustand";
import { textLinkClassName } from "../ui/text-link.ts";
import type {
    SessionResourceReader,
    SessionResourceRequest,
    SessionResourceState,
    SessionResourceStoreFactory,
} from "./resource-reader.ts";

const StoreFactoryContext = createContext<SessionResourceStoreFactory | null>(null);

/** Provides the view-model factory that owns the resource workflow, once for the whole application. */
export function SessionResourceStoreProvider({
    createStore,
    children,
}: {
    readonly createStore: SessionResourceStoreFactory;
    readonly children: ReactNode;
}) {
    return <StoreFactoryContext value={createStore}>{children}</StoreFactoryContext>;
}

function useResourceStoreFactory(): SessionResourceStoreFactory {
    const factory = useContext(StoreFactoryContext);
    if (factory === null) {
        throw new Error("A session resource needs a SessionResourceStoreProvider above it.");
    }
    return factory;
}

/**
 * Renders a session-scoped resource through a store created by the provided
 * factory, so this component stays business-decoupled while the store owns
 * loading, cancellation, and the object URL's lifetime.
 */
export function SessionResource({
    request,
    read,
    inline = false,
    children,
}: {
    readonly request: SessionResourceRequest;
    readonly read: SessionResourceReader | undefined;
    readonly inline?: boolean;
    readonly children: (state: SessionResourceState) => ReactNode;
}) {
    const createResourceStore = useResourceStoreFactory();
    const { path, kind } = request;
    const store = useMemo(() => createResourceStore({ path, kind }, read), [createResourceStore, path, kind, read]);
    const model = useStore(store);
    const retry =
        model.state.kind === "failed" && (kind === "image" || kind === "raster-image") ? (
            <button className={`ml-2 text-xs ${textLinkClassName}`} onClick={model.retry} type="button">
                Retry image
            </button>
        ) : null;
    return inline ? (
        <span className="contents" ref={model.onAttach}>
            {children(model.state)}
            {retry}
        </span>
    ) : (
        <div className="contents" ref={model.onAttach}>
            {children(model.state)}
            {retry}
        </div>
    );
}
