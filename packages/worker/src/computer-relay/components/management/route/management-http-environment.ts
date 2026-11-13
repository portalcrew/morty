import type { CloudBindings } from "../../../../contracts/cloud-bindings.ts";
import type { ComputerTargetEnvironment } from "../../../../http/computer-target.ts";

export type ManagementHttpEnvironment = {
    readonly Bindings: CloudBindings;
    readonly Variables: ComputerTargetEnvironment["Variables"] & {
        readonly signal: AbortSignal;
    };
};
