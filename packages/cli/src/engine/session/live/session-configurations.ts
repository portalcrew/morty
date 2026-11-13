import type { SessionConfigOption, SessionConfigurationSelection } from "@morty-build/client/protocol";
import { z } from "zod";
import { inDependencyOrder } from "../settings/configuration-dependencies.ts";

export type StoredSessionConfiguration = SessionConfigurationSelection;

const storedSessionConfigurationSchema = z.discriminatedUnion("type", [
    z.object({ booleanValue: z.boolean(), configId: z.string().max(128), type: z.literal("boolean") }),
    z.object({ configId: z.string().max(128), type: z.literal("select"), value: z.string().max(500) }),
]);

export const decodeStoredSessionConfigurations = (value: unknown): readonly StoredSessionConfiguration[] =>
    z
        .array(z.unknown())
        .max(100)
        .parse(value)
        .flatMap((configuration) => {
            const decoded = storedSessionConfigurationSchema.safeParse(configuration);
            return decoded.success ? [decoded.data] : [];
        });

export type ApplyStoredSessionConfiguration = (
    configuration: StoredSessionConfiguration,
    signal: AbortSignal,
) => Promise<void>;

export const storedSessionConfiguration = (option: SessionConfigOption): StoredSessionConfiguration =>
    option.type === "boolean"
        ? { booleanValue: option.booleanValue, configId: option.id, type: "boolean" }
        : { configId: option.id, type: "select", value: option.currentValue };

/**
 * Applies, in dependency order, each selection the Agent offers but does not hold. Settings are
 * re-read after every change because a change can alter the choices the Agent offers; values it
 * does not offer are left as they are.
 */
export async function replaySessionConfigurations(
    selections: readonly StoredSessionConfiguration[],
    options: () => readonly SessionConfigOption[],
    apply: ApplyStoredSessionConfiguration,
    signal: AbortSignal,
): Promise<void> {
    for (const selection of inDependencyOrder(selections, options())) {
        const current = options().find((option) => option.id === selection.configId && option.type === selection.type);
        if (current === undefined) {
            continue;
        }
        if (current.type === "boolean" && selection.type === "boolean") {
            if (current.booleanValue !== selection.booleanValue) {
                await apply(selection, signal);
            }
            continue;
        }
        if (
            current.type === "select" &&
            selection.type === "select" &&
            current.currentValue !== selection.value &&
            current.values.some((value) => value.value === selection.value)
        ) {
            await apply(selection, signal);
        }
    }
}

/** The settings a user chose for a Session, following the changes the Agent later makes to them. */
export class SessionConfigurations {
    #selected: readonly StoredSessionConfiguration[] = [];

    readonly stored = (): readonly StoredSessionConfiguration[] => this.#selected;

    /** Follows the Agent's own changes, such as leaving Plan mode, to the settings a user chose. */
    readonly capture = (options: readonly SessionConfigOption[]): void => {
        this.#selected = this.#selected.map((selection) => {
            const current = options.find(
                (option) => option.id === selection.configId && option.type === selection.type,
            );
            return current === undefined ? selection : storedSessionConfiguration(current);
        });
    };

    readonly select = (option: SessionConfigOption): void => {
        const selected = storedSessionConfiguration(option);
        this.#selected = [...this.#selected.filter((selection) => selection.configId !== selected.configId), selected];
    };

    readonly restore = async (
        stored: readonly StoredSessionConfiguration[],
        options: () => readonly SessionConfigOption[],
        apply: ApplyStoredSessionConfiguration,
        signal: AbortSignal,
    ): Promise<void> => {
        this.#selected = stored;
        await replaySessionConfigurations(stored, options, apply, signal);
    };
}
