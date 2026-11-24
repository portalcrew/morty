export interface ComputerUpdate {
    /**
     * Resolves once `announce` has run and this Computer has begun stopping, leaving its updater to start `version`.
     * Rejects with an OperationError, with this Computer still serving unchanged, when the update cannot begin.
     */
    readonly restartInto: (version: string, announce: () => void, signal: AbortSignal) => Promise<void>;
}
