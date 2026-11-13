import type {
    CreateElicitationResponse,
    ElicitationContentValue,
    RequestPermissionResponse,
} from "@agentclientprotocol/sdk/unstable";

import type { SessionElicitationRequestedEvent, SessionPermissionRequestedEvent } from "@morty-build/client/protocol";

export class PendingPermission {
    readonly completion: PromiseWithResolvers<RequestPermissionResponse> =
        Promise.withResolvers<RequestPermissionResponse>();
    readonly request: SessionPermissionRequestedEvent;
    readonly optionIds: ReadonlySet<string>;
    #settled = false;

    constructor(request: SessionPermissionRequestedEvent) {
        this.request = request;
        this.optionIds = new Set(request.options.map((option) => option.optionId));
    }

    readonly cancel = (): boolean => {
        if (this.#settled) {
            return false;
        }
        this.#settled = true;
        this.completion.resolve({ outcome: { outcome: "cancelled" } });
        return true;
    };

    readonly select = (optionId: string): boolean => {
        if (this.#settled) {
            return false;
        }
        this.#settled = true;
        this.completion.resolve({
            outcome: { optionId, outcome: "selected" },
        });
        return true;
    };
}

export class PendingElicitation {
    readonly completion: PromiseWithResolvers<CreateElicitationResponse> =
        Promise.withResolvers<CreateElicitationResponse>();
    readonly request: SessionElicitationRequestedEvent;
    /** The form the Agent asked for; a URL request has none. */
    readonly requestedSchema: unknown;
    #settled = false;

    constructor(request: SessionElicitationRequestedEvent, requestedSchema: unknown) {
        this.request = request;
        this.requestedSchema = requestedSchema;
    }

    readonly accept = (content: Readonly<Record<string, ElicitationContentValue>>): boolean => {
        if (this.#settled) {
            return false;
        }
        this.#settled = true;
        this.completion.resolve({ action: "accept", content });
        return true;
    };

    readonly cancel = (): boolean => {
        if (this.#settled) {
            return false;
        }
        this.#settled = true;
        this.completion.resolve({ action: "cancel" });
        return true;
    };

    readonly decline = (): boolean => {
        if (this.#settled) {
            return false;
        }
        this.#settled = true;
        this.completion.resolve({ action: "decline" });
        return true;
    };
}
