import { ChevronDown } from "lucide-react";
import type { ReactNode } from "react";
import { dataTestId } from "../../data-testid.ts";
import { ExternalLink } from "../ui/external-link.tsx";
import { Textarea } from "../ui/textarea.tsx";

const nextStepClassName = "mt-3 min-h-10 text-center text-sm leading-5 text-morty-text-2";

export function SetupPromptIdleHint(): ReactNode {
    return <p className={nextStepClassName}>Next: paste it into the agent running on your computer.</p>;
}

export function SetupPromptCopiedHint(): ReactNode {
    return (
        <p aria-atomic="true" aria-label="Setup next step" className={nextStepClassName} role="status">
            Paste into your agent, then open the link it returns.
        </p>
    );
}

/** A read-only prompt the person can select when the clipboard write is unavailable. */
function SetupPromptField({ prompt }: { readonly prompt: string }) {
    return (
        <div className="overflow-hidden rounded-[12px] bg-muted">
            <Textarea
                aria-label="Agent setup prompt"
                className="min-h-0 [field-sizing:content] cursor-text rounded-[12px] bg-background p-3 text-[12px] leading-5 text-morty-text-2 lg:text-[12px]"
                data-testid={dataTestId.pairingInstruction}
                onFocus={(event) => event.currentTarget.select()}
                readOnly
                rows={1}
                value={prompt}
            />
        </div>
    );
}

/** The note and review disclosure shown under a setup-prompt button. */
export function SetupPromptDetails({ prompt }: { readonly prompt: string }) {
    return (
        <>
            <p className="mt-3 text-center text-xs leading-5 text-pretty text-morty-text-3">
                Setup interrupts the agent's current task; continue it here afterwards. Keep that computer awake and
                online.
            </p>
            <details
                aria-label="Setup details"
                className="disclosure-details group w-full text-xs leading-5 text-morty-text-3"
            >
                <summary className="mt-5 flex h-6 cursor-pointer list-none items-center justify-center gap-1.5 rounded-lg outline-none hover:text-morty-text-2 keyboard-focus:focus-visible:ring-[3px] keyboard-focus:focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
                    Review what setup does
                    <ChevronDown
                        aria-hidden="true"
                        className="size-3.5 transition-[rotate] duration-300 ease-out group-open:rotate-180 motion-reduce:transition-none"
                    />
                </summary>
                <div className="mt-1 rounded-[16px] border border-border/60 bg-muted/50 p-1 text-left">
                    <ul
                        aria-label="What setup does"
                        className="list-disc space-y-1 py-2 pr-3 pl-7 text-morty-text-3 marker:text-morty-text-4 [&_code]:whitespace-nowrap"
                    >
                        <li>
                            Installs the Morty CLI (<code>@morty-build/cli</code>) from npm. Use{" "}
                            <code>npx @morty-build/cli@latest restart</code> to install updates.
                        </li>
                        <li>
                            Runs a background connection until restart or <code>morty stop</code>.
                        </li>
                        <li>Keeps this computer's Morty identity in your user data folder.</li>
                        <li>Asks before replacing a missing connection, which ends earlier shared access.</li>
                        <li>
                            Returns a private link for one device, valid for 10 minutes. That device can control your
                            agent for one day unless you revoke access; ask the agent for 1 hour, 7 days or 30 days
                            instead.
                        </li>
                    </ul>
                    <p className="px-3 pb-2">
                        <ExternalLink
                            className="text-morty-text-2 hover:text-foreground"
                            href={`${window.location.origin}/doc/setup.md`}
                        >
                            Read setup.md
                        </ExternalLink>
                    </p>
                    <SetupPromptField prompt={prompt} />
                </div>
            </details>
        </>
    );
}
