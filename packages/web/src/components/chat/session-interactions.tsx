import type { SessionElicitationField } from "@morty-build/client/protocol";
import { ArrowUpRight, ChevronDown, HelpCircle, ShieldCheck } from "lucide-react";
import { useId, useRef, useState } from "react";
import { ButtonGroup } from "@/components/ui/button-group";
import { Button } from "@/components/ui/cloud-button";
import { MortyAlert } from "@/components/ui/morty-alert";
import { Select as OptionSelect } from "@/components/ui/option-select";
import { ScrollArea } from "@/components/ui/scroll-area";
import { textLinkClassName } from "@/components/ui/text-link";
import { useWrappedButtonRadius } from "@/components/utils/use-wrapped-button-radius";
import { cn } from "@/lib/utils";
import { type ElicitationFieldValue, elicitationFieldValue } from "@/services/chat/elicitation-form";
import {
    type FormElicitation,
    type PermissionFileChange,
    permissionPresentation,
} from "@/view-models/chat/session-interaction-store";
import type {
    ElicitationInteraction,
    ElicitationInteractionResponse,
    PermissionInteraction,
    PermissionInteractionResponse,
} from "@/view-models/chat/session-pane-types";
import { AgentRichContent } from "../agents/agent-rich-content.tsx";
import {
    agentThinkStepChevronClassName,
    agentThinkStepInlineLabelClassName,
    agentThinkStepTitleClassName,
    agentThinkStepTriggerClassName,
} from "./tools/tool-call-status";

export type { PermissionFileChange } from "@/view-models/chat/session-interaction-store";
export type {
    ElicitationInteraction,
    ElicitationInteractionResponse,
    PermissionInteraction,
    PermissionInteractionResponse,
} from "@/view-models/chat/session-pane-types";

function safeExternalUrl(value: string): string {
    try {
        const url = new URL(value);
        if (url.protocol === "https:" || url.protocol === "http:") {
            return url.toString();
        }
    } catch {}
    return "";
}

/** Same surface language as `MortyAlert`: a 16px shell with a hairline border, 13px text, and a muted 14px icon. */
const interactionCardClassName =
    "min-w-0 w-full rounded-[20px] border-[0.5px] border-border bg-surface-elevated px-4 py-4 text-13 [overflow-wrap:anywhere]";
const interactionIconClassName = "mt-[3px] size-4 shrink-0 text-muted-foreground";
const interactionTitleClassName = "text-15 font-semibold text-foreground";
const interactionMonoClassName = "whitespace-pre-wrap font-mono text-12 leading-5";
/** Mirrors `Input`'s border, fill, radius, and focus ring so native inputs, selects, and textareas all match it. */
const nativeFieldClassName =
    "w-full min-w-0 rounded-md border border-border bg-background px-3 text-[13px] outline-none focus:border-ring focus:outline-none! focus:shadow-[var(--focus-ring-shadow)] disabled:cursor-not-allowed disabled:opacity-50";
const fieldLabelClassName = "grid gap-1.5 text-12 font-medium text-foreground";
const fieldDescriptionClassName = "font-normal text-muted-foreground";

/** The library has no checkbox primitive, so booleans use the component library's segmented aria-pressed button idiom. */
function BooleanFieldControl({
    disabled,
    field,
    on,
    onChange,
}: {
    readonly disabled: boolean;
    readonly field: SessionElicitationField;
    readonly on: boolean;
    readonly onChange: (value: ElicitationFieldValue) => void;
}) {
    return (
        <div className={fieldLabelClassName}>
            <span>{field.title}</span>
            <fieldset aria-label={field.title} className="m-0 min-w-0 border-0 p-0">
                <ButtonGroup orientation="horizontal" size="sm">
                    <Button
                        aria-pressed={on}
                        className="min-h-11 rounded-full! md:min-h-9"
                        disabled={disabled}
                        onClick={() => onChange(true)}
                        size="sm"
                        type="button"
                        variant={on ? "primary" : "outline"}
                    >
                        Yes
                    </Button>
                    <Button
                        aria-pressed={!on}
                        className="min-h-11 rounded-full! md:min-h-9"
                        disabled={disabled}
                        onClick={() => onChange(false)}
                        size="sm"
                        type="button"
                        variant={!on ? "primary" : "outline"}
                    >
                        No
                    </Button>
                </ButtonGroup>
            </fieldset>
            {field.description.length > 0 && <span className={fieldDescriptionClassName}>{field.description}</span>}
        </div>
    );
}

function SelectFieldControl({
    disabled,
    field,
    selected,
    onChange,
}: {
    readonly disabled: boolean;
    readonly field: Extract<SessionElicitationField, { readonly type: "select" }>;
    readonly selected: string;
    readonly onChange: (value: ElicitationFieldValue) => void;
}) {
    return (
        <div className={fieldLabelClassName}>
            <span>{field.title}</span>
            <OptionSelect
                className="min-h-11 rounded-full md:min-h-9"
                disabled={disabled}
                label={field.title}
                onValueChange={onChange}
                options={field.options.map((option) =>
                    option.description.length > 0
                        ? { label: option.label, title: option.description, value: option.value }
                        : { label: option.label, value: option.value },
                )}
                placeholder="Not selected"
                value={selected}
            />
            {field.description.length > 0 && <span className={fieldDescriptionClassName}>{field.description}</span>}
        </div>
    );
}

/** One field of the Agent's question, showing `value` and reporting each change; the form keeps no state itself. */
function FieldControl({
    disabled,
    field,
    value,
    onChange,
}: {
    readonly disabled: boolean;
    readonly field: SessionElicitationField;
    readonly value: ElicitationFieldValue;
    readonly onChange: (value: ElicitationFieldValue) => void;
}) {
    if (field.type === "boolean") {
        return <BooleanFieldControl disabled={disabled} field={field} on={value === true} onChange={onChange} />;
    }
    if (field.type === "select") {
        return (
            <SelectFieldControl
                disabled={disabled}
                field={field}
                selected={typeof value === "string" ? value : ""}
                onChange={onChange}
            />
        );
    }
    const text = typeof value === "string" ? value : "";
    if (field.type === "multiselect") {
        return (
            <label className={fieldLabelClassName}>
                {field.title}
                <select
                    className={cn(nativeFieldClassName, "min-h-11 rounded-full font-normal md:min-h-9")}
                    value={Array.isArray(value) ? [...value] : []}
                    disabled={disabled}
                    multiple
                    name={field.name}
                    onChange={(event) =>
                        onChange(Array.from(event.currentTarget.selectedOptions, (option) => option.value))
                    }
                    required={field.required}
                >
                    {field.options.map((option) => (
                        <option key={option.value} title={option.description} value={option.value}>
                            {option.label}
                        </option>
                    ))}
                </select>
                {field.description.length > 0 && <span className={fieldDescriptionClassName}>{field.description}</span>}
            </label>
        );
    }
    if (field.type === "string" && field.multiline) {
        return (
            <label className={fieldLabelClassName}>
                {field.title}
                <textarea
                    className={`min-h-20 resize-y py-2 font-normal ${nativeFieldClassName}`}
                    value={text}
                    onChange={(event) => onChange(event.currentTarget.value)}
                    disabled={disabled}
                    maxLength={field.maximumLength}
                    minLength={field.minimumLength}
                    name={field.name}
                    placeholder={field.description}
                    required={field.required && (field.minimumLength ?? 0) > 0}
                    rows={3}
                />
                {field.description.length > 0 && <span className={fieldDescriptionClassName}>{field.description}</span>}
            </label>
        );
    }
    if (field.type === "string") {
        return (
            <label className={fieldLabelClassName}>
                {field.title}
                <input
                    className={cn(nativeFieldClassName, "min-h-11 rounded-full font-normal md:min-h-9")}
                    value={text}
                    onChange={(event) => onChange(event.currentTarget.value)}
                    disabled={disabled}
                    maxLength={field.maximumLength}
                    minLength={field.minimumLength}
                    name={field.name}
                    pattern={field.pattern}
                    placeholder={field.description}
                    required={field.required && (field.minimumLength ?? 0) > 0}
                    type={
                        field.format === "email"
                            ? "email"
                            : field.format === "uri"
                              ? "url"
                              : field.format === "date"
                                ? "date"
                                : field.format === "date-time"
                                  ? "datetime-local"
                                  : "text"
                    }
                />
                {field.description.length > 0 && <span className={fieldDescriptionClassName}>{field.description}</span>}
            </label>
        );
    }
    return (
        <label className={fieldLabelClassName}>
            {field.title}
            <input
                className={cn(nativeFieldClassName, "min-h-11 rounded-full font-normal md:min-h-9")}
                value={text}
                onChange={(event) => onChange(event.currentTarget.value)}
                disabled={disabled}
                max={field.maximum}
                min={field.minimum}
                name={field.name}
                placeholder={field.description}
                required={field.required}
                step={field.type === "integer" ? 1 : "any"}
                type="number"
            />
            {field.description.length > 0 && <span className={fieldDescriptionClassName}>{field.description}</span>}
        </label>
    );
}

/** The shell command when this is an `execute` request carrying one. */
function executeCommand(permission: PermissionInteraction): string | undefined {
    if (permission.toolKind !== "execute") {
        return undefined;
    }
    const rawInput: unknown = permission.details.rawInput;
    if (typeof rawInput !== "object" || rawInput === null || !("command" in rawInput)) {
        return undefined;
    }
    const command: unknown = rawInput.command;
    return typeof command === "string" && command.length > 0 ? command : undefined;
}

/** What the card shows first: the change itself when the tool call carries diffs, then the command, then the raw input. */
type PermissionPreview =
    | { readonly kind: "changes"; readonly changes: readonly PermissionFileChange[] }
    | { readonly kind: "command"; readonly command: string; readonly cwd: string }
    | { readonly kind: "input" }
    | { readonly kind: "none" };

function permissionPreview(
    permission: PermissionInteraction,
    fileChanges: readonly PermissionFileChange[],
): PermissionPreview {
    if (fileChanges.length > 0) {
        return { kind: "changes", changes: fileChanges };
    }
    if (permission.details === undefined) {
        return { kind: "none" };
    }
    const command = executeCommand(permission);
    return command === undefined ? { kind: "input" } : { kind: "command", command, cwd: permission.details.cwd };
}

function PermissionPreviewContent({ input, preview }: { readonly input: string; readonly preview: PermissionPreview }) {
    switch (preview.kind) {
        case "changes":
            return <AgentRichContent contents={preview.changes} />;
        case "command":
            return (
                <ScrollArea
                    className="mt-3 max-h-56 rounded-md bg-muted"
                    orientation="both"
                    viewportClassName="max-h-[inherit] p-3"
                >
                    <pre className={interactionMonoClassName}>
                        <span className="text-muted-foreground">{preview.cwd} $ </span>
                        {preview.command}
                    </pre>
                </ScrollArea>
            );
        case "input":
            return (
                <ScrollArea
                    className="mt-3 max-h-56 rounded-md bg-muted"
                    orientation="both"
                    viewportClassName="max-h-[inherit] p-3"
                >
                    <pre className={interactionMonoClassName}>{input}</pre>
                </ScrollArea>
            );
        case "none":
            return (
                <p className="mt-3 rounded-md bg-muted p-3 text-12 leading-5 text-muted-foreground">
                    The agent sent no details with this request.
                </p>
            );
    }
}

function PermissionCard({
    busy,
    fileChanges,
    permission,
    respond,
    stop,
}: {
    readonly busy: boolean;
    readonly fileChanges: readonly PermissionFileChange[];
    readonly permission: PermissionInteraction;
    readonly stop: () => void;
    readonly respond: (response: PermissionInteractionResponse) => void;
}) {
    const presentation = permissionPresentation(permission);
    const preview = permissionPreview(permission, fileChanges);
    const [detailsOpen, setDetailsOpen] = useState(false);
    const detailsContentId = useId();
    const actionRow = useRef<HTMLDivElement>(null);
    useWrappedButtonRadius(actionRow);
    if (permission.state.kind === "resolved") {
        const answer = permission.state.answer;
        const chosen =
            answer.outcome === "selected"
                ? presentation.options.find((option) => option.optionId === answer.optionId)
                : undefined;
        return (
            <section className={interactionCardClassName} role="alertdialog" aria-label="Agent permission request">
                <div className="flex items-start gap-2">
                    <ShieldCheck aria-hidden="true" className={interactionIconClassName} />
                    <div className="min-w-0 flex-1">
                        <p className={interactionTitleClassName}>Confirmed</p>
                        <p className="mt-1 text-13 leading-5 text-foreground">{permission.title}</p>
                        {chosen !== undefined && (
                            <dl className="mt-2 grid gap-1 text-12 leading-5">
                                <div className="flex flex-wrap gap-x-1.5">
                                    <dt className="text-muted-foreground">Decision:</dt>
                                    <dd className="font-medium text-foreground">{chosen.label}</dd>
                                </div>
                            </dl>
                        )}
                    </div>
                </div>
            </section>
        );
    }
    const locationsLabel =
        presentation.locations.length === 1 ? "1 affected path" : `${presentation.locations.length} affected paths`;
    const disclosureLabel =
        presentation.locations.length > 0
            ? `Details · ${locationsLabel}`
            : preview.kind === "input"
              ? "Details · working directory"
              : "Details · full input";
    return (
        <section className={interactionCardClassName} role="alertdialog" aria-label="Agent permission request">
            <div className="flex items-start gap-2">
                <ShieldCheck aria-hidden="true" className={interactionIconClassName} />
                <div className="min-w-0 flex-1">
                    <p className={interactionTitleClassName}>Agent needs permission</p>
                    <p className="mt-1 text-13 leading-5 text-foreground">{permission.title}</p>
                    <PermissionPreviewContent input={presentation.input} preview={preview} />
                    {permission.details !== undefined && (
                        <div className="mt-3 min-w-0">
                            <button
                                aria-controls={detailsContentId}
                                aria-expanded={detailsOpen}
                                className={agentThinkStepTriggerClassName}
                                onClick={() => setDetailsOpen(!detailsOpen)}
                                type="button"
                            >
                                <span className={agentThinkStepInlineLabelClassName}>
                                    <span className={agentThinkStepTitleClassName}>{disclosureLabel}</span>
                                    <ChevronDown
                                        aria-hidden="true"
                                        className={cn(
                                            agentThinkStepChevronClassName,
                                            detailsOpen && "visible rotate-0",
                                        )}
                                    />
                                </span>
                            </button>
                            {detailsOpen && (
                                <div className="mb-2 grid gap-2 text-12 leading-5" id={detailsContentId}>
                                    {preview.kind !== "command" && (
                                        <p>
                                            <span className="text-muted-foreground">Session working directory: </span>
                                            <code className="break-all">{presentation.cwd}</code>
                                        </p>
                                    )}
                                    {presentation.locations.length > 0 && (
                                        <section aria-label="Affected paths" className="break-all font-mono">
                                            {presentation.locations.map((location) => (
                                                <p key={location}>{location}</p>
                                            ))}
                                        </section>
                                    )}
                                    {preview.kind !== "input" && (
                                        <ScrollArea
                                            className="max-h-56 rounded-md bg-muted"
                                            orientation="both"
                                            viewportClassName="max-h-[inherit] p-3"
                                        >
                                            <pre className="whitespace-pre-wrap font-mono">{presentation.input}</pre>
                                        </ScrollArea>
                                    )}
                                </div>
                            )}
                        </div>
                    )}
                    {/* Pinned to the bottom of the bounded interaction scroller, above its edge fade, so long
                        details scroll behind the decisions instead of pushing them out of view on short screens. */}
                    <div
                        className="sticky bottom-0 z-20 flex flex-wrap items-center gap-2 bg-surface-elevated pt-3"
                        ref={actionRow}
                    >
                        {presentation.options.map((option) => (
                            <Button
                                className="max-w-full whitespace-normal py-[7.5px]!"
                                disabled={busy}
                                key={option.optionId}
                                onClick={() => {
                                    respond({
                                        answer: { outcome: "selected", optionId: option.optionId },
                                        interactionId: permission.interactionId,
                                        target: permission.target,
                                    });
                                }}
                                size="sm"
                                variant={option.allow ? "primary" : "outline"}
                            >
                                {option.label}
                            </Button>
                        ))}
                        <Button
                            className="max-w-full whitespace-normal py-[7.5px]!"
                            disabled={busy}
                            onClick={stop}
                            size="sm"
                            variant="ghost"
                        >
                            Stop turn
                        </Button>
                    </div>
                </div>
            </div>
        </section>
    );
}

/** A one-word note on how a decided information request ended. */
function answeredNote(state: Exclude<ElicitationInteraction["state"], { readonly kind: "pending" }>): string {
    if (state.kind === "resolved" && state.action === "decline") {
        return "Declined";
    }
    if (state.kind === "resolved" && state.action === "cancel") {
        return "Cancelled";
    }
    return "Accepted";
}

function ElicitationCard({
    busy,
    elicitation,
    draft,
    requiredNotice,
    respond,
    accept,
    editAnswer,
}: {
    readonly busy: boolean;
    readonly elicitation: ElicitationInteraction;
    /** What the user typed into this question so far. */
    readonly draft: Readonly<Record<string, ElicitationFieldValue>>;
    /** Why the question cannot be accepted yet, once the user tried; empty otherwise. */
    readonly requiredNotice: string;
    readonly respond: (response: ElicitationInteractionResponse) => void;
    readonly accept: (elicitation: FormElicitation) => void;
    readonly editAnswer: (fieldName: string, value: ElicitationFieldValue) => void;
}) {
    const externalUrl = elicitation.mode === "url" ? safeExternalUrl(elicitation.url) : "";
    const answered = elicitation.state.kind !== "pending";
    const refuse = (action: "cancel" | "decline"): void => {
        respond({
            answer: { action },
            interactionId: elicitation.interactionId,
            target: elicitation.target,
        });
    };
    if (elicitation.state.kind !== "pending" && elicitation.mode === "form") {
        const note = answeredNote(elicitation.state);
        return (
            <section className={interactionCardClassName} role="dialog" aria-label="Agent information request">
                <div className="flex items-start gap-2">
                    <HelpCircle aria-hidden="true" className={interactionIconClassName} />
                    <div className="min-w-0 flex-1">
                        <p className={interactionTitleClassName}>Asked</p>
                        <p className="mt-1 text-13 leading-5 text-foreground">{elicitation.message}</p>
                        <p className="mt-1 text-12 leading-5 text-muted-foreground">{note}</p>
                    </div>
                </div>
            </section>
        );
    }

    return (
        <section className={interactionCardClassName} role="dialog" aria-label="Agent information request">
            <div className="flex items-start gap-2">
                <HelpCircle aria-hidden="true" className={interactionIconClassName} />
                <div className="min-w-0 flex-1">
                    {answered ? (
                        <p className={interactionTitleClassName}>Asked</p>
                    ) : (
                        <p aria-label="Waiting for your answer" className={interactionTitleClassName} role="status">
                            Waiting for your answer
                        </p>
                    )}
                    <p className="mt-1 text-13 leading-5 text-foreground">{elicitation.message}</p>
                    {elicitation.mode === "url" ? (
                        <div className="mt-2.5">
                            <code className="block break-all rounded-md bg-muted px-3 py-2 font-mono text-12 leading-5 text-foreground">
                                {externalUrl.length > 0 ? externalUrl : elicitation.url}
                            </code>
                            {elicitation.state.kind === "submitted" ||
                            (elicitation.state.kind === "resolved" && elicitation.state.action === "accept") ? (
                                <div className="mt-2.5 flex flex-wrap items-center gap-2">
                                    <span className="text-12 text-muted-foreground">
                                        Waiting for the agent to confirm completion…
                                    </span>
                                    {externalUrl.length > 0 && (
                                        <a
                                            className={`inline-flex min-h-11 items-center gap-1 rounded-sm text-13 font-medium outline-none keyboard-focus:focus-visible:ring-[3px] keyboard-focus:focus-visible:ring-ring/70 md:min-h-9 ${textLinkClassName}`}
                                            href={externalUrl}
                                            rel="noreferrer"
                                            target="_blank"
                                        >
                                            Open again <ArrowUpRight aria-hidden="true" className="size-3.5" />
                                        </a>
                                    )}
                                </div>
                            ) : (
                                <div className="mt-2.5 flex flex-wrap gap-2">
                                    {externalUrl.length > 0 && (
                                        <Button
                                            className="gap-[6px] min-h-11 md:min-h-9"
                                            disabled={busy || answered}
                                            onClick={() => {
                                                window.open(externalUrl, "_blank", "noopener,noreferrer");
                                                respond({
                                                    answer: { action: "accept-url" },
                                                    interactionId: elicitation.interactionId,
                                                    target: elicitation.target,
                                                });
                                            }}
                                            size="sm"
                                        >
                                            Open page <ArrowUpRight aria-hidden="true" className="size-3.5" />
                                        </Button>
                                    )}
                                    <Button
                                        className="min-h-11 md:min-h-9"
                                        disabled={busy || answered}
                                        onClick={() => refuse("decline")}
                                        size="sm"
                                        variant="outline"
                                    >
                                        Decline
                                    </Button>
                                    <Button
                                        className="min-h-11 md:min-h-9"
                                        disabled={busy || answered}
                                        onClick={() => refuse("cancel")}
                                        size="sm"
                                        variant="ghost"
                                    >
                                        Cancel
                                    </Button>
                                </div>
                            )}
                        </div>
                    ) : (
                        <form
                            className="mt-3 grid gap-3"
                            onSubmit={(event) => {
                                event.preventDefault();
                                accept(elicitation);
                            }}
                        >
                            {elicitation.fields.map((field) => (
                                <FieldControl
                                    disabled={busy || answered}
                                    field={field}
                                    key={field.name}
                                    value={elicitationFieldValue(field, draft)}
                                    onChange={(value) => editAnswer(field.name, value)}
                                />
                            ))}
                            {requiredNotice.length > 0 && <MortyAlert>{requiredNotice}</MortyAlert>}
                            <div className="flex flex-wrap gap-2">
                                <Button
                                    className="min-h-11 md:min-h-9"
                                    disabled={busy || answered}
                                    size="sm"
                                    type="submit"
                                >
                                    Continue
                                </Button>
                                <Button
                                    className="min-h-11 md:min-h-9"
                                    disabled={busy || answered}
                                    onClick={() => refuse("decline")}
                                    size="sm"
                                    variant="outline"
                                >
                                    Decline
                                </Button>
                                <Button
                                    className="min-h-11 md:min-h-9"
                                    disabled={busy || answered}
                                    onClick={() => refuse("cancel")}
                                    size="sm"
                                    variant="ghost"
                                >
                                    Cancel
                                </Button>
                            </div>
                        </form>
                    )}
                </div>
            </div>
        </section>
    );
}

const NO_ANSWERS: Readonly<Record<string, ElicitationFieldValue>> = {};

export function SessionInteractionCards({
    elicitations,
    answerDrafts,
    requiredNotices,
    onElicitationAnswer,
    onElicitationAccept,
    fileChanges,
    permissions,
    onElicitationResponse,
    onPermissionResponse,
    onStop,
    busyInteractionIds,
    error,
}: {
    readonly elicitations: readonly ElicitationInteraction[];
    /** What the user typed into each pending question, by interaction id. */
    readonly answerDrafts: ReadonlyMap<string, Readonly<Record<string, ElicitationFieldValue>>>;
    /** Why a question cannot be accepted yet, by interaction id, once the user tried. */
    readonly requiredNotices: ReadonlyMap<string, string>;
    readonly onElicitationAnswer: (interactionId: string, fieldName: string, value: ElicitationFieldValue) => void;
    readonly onElicitationAccept: (elicitation: FormElicitation) => void;
    /** The diffs announced for each permission's tool call, by interaction id. */
    readonly fileChanges: ReadonlyMap<string, readonly PermissionFileChange[]>;
    readonly permissions: readonly PermissionInteraction[];
    readonly onStop: () => void;
    readonly onElicitationResponse: (response: ElicitationInteractionResponse) => void;
    readonly onPermissionResponse: (response: PermissionInteractionResponse) => void;
    readonly busyInteractionIds: ReadonlySet<string>;
    readonly error: string;
}) {
    if (permissions.length === 0 && elicitations.length === 0) {
        return null;
    }
    return (
        <div className="grid w-full gap-3">
            {permissions.map((permission) => (
                <PermissionCard
                    busy={busyInteractionIds.has(permission.interactionId)}
                    fileChanges={fileChanges.get(permission.interactionId) ?? []}
                    key={permission.interactionId}
                    permission={permission}
                    respond={onPermissionResponse}
                    stop={onStop}
                />
            ))}
            {elicitations.map((elicitation) => (
                <ElicitationCard
                    busy={busyInteractionIds.has(elicitation.interactionId)}
                    accept={onElicitationAccept}
                    draft={answerDrafts.get(elicitation.interactionId) ?? NO_ANSWERS}
                    requiredNotice={requiredNotices.get(elicitation.interactionId) ?? ""}
                    editAnswer={(fieldName, value) => onElicitationAnswer(elicitation.interactionId, fieldName, value)}
                    elicitation={elicitation}
                    key={elicitation.interactionId}
                    respond={onElicitationResponse}
                />
            ))}
            {error.length > 0 && <MortyAlert>{error}</MortyAlert>}
        </div>
    );
}
