import type { ElicitationContentValue } from "@agentclientprotocol/sdk/unstable";
import type {
    SessionElicitationField,
    SessionElicitationFormContent,
    SessionElicitationOption,
} from "@morty-build/client/protocol";
import { isRecord, readString, truncate } from "../../util/value-utils.ts";
import { AcpExecutionError } from "../acp-error.ts";

type ElicitationFieldType = SessionElicitationField["type"];

function elicitationFieldType(value: unknown): Exclude<ElicitationFieldType, "select"> {
    if (value === "boolean") {
        return "boolean";
    }
    if (value === "integer") {
        return "integer";
    }
    if (value === "number") {
        return "number";
    }
    if (value === "array") {
        return "multiselect";
    }
    return "string";
}

function normalizeElicitationOptions(schema: Readonly<Record<string, unknown>>): readonly SessionElicitationOption[] {
    const normalized: SessionElicitationOption[] = [];
    const oneOf = schema["oneOf"];
    if (Array.isArray(oneOf)) {
        for (const option of oneOf) {
            if (isRecord(option) && typeof option["const"] === "string") {
                normalized.push({
                    description: truncate(readString(option["description"]), 500),
                    label: truncate(readString(option["title"], option["const"]), 255),
                    value: truncate(option["const"], 500),
                });
            }
        }
        return normalized.slice(0, 200);
    }
    const enumValues = schema["enum"];
    if (Array.isArray(enumValues)) {
        for (const entry of enumValues) {
            if (typeof entry === "string") {
                normalized.push({ description: "", label: entry, value: entry });
            }
        }
        return normalized.slice(0, 200);
    }
    const items = schema["items"];
    if (!isRecord(items)) {
        return normalized;
    }
    const anyOf = items["anyOf"];
    if (Array.isArray(anyOf)) {
        return normalizeElicitationOptions({ oneOf: anyOf });
    }
    return normalizeElicitationOptions({ enum: items["enum"] });
}

function finiteNumber(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
    return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function nonEmpty(value: string, maximum: number): string | undefined {
    const text = truncate(value, maximum);
    return text.length === 0 ? undefined : text;
}

function normalizeElicitationField(
    name: string,
    property: Readonly<Record<string, unknown>>,
    required: boolean,
): SessionElicitationField {
    const common = {
        description: truncate(readString(property["description"]), 500),
        name: truncate(name, 128),
        required,
        title: truncate(readString(property["title"], name), 255),
    };
    const type = elicitationFieldType(property["type"]);
    const options = normalizeElicitationOptions(property);
    const defaultValue = property["default"];
    switch (type) {
        case "boolean":
            return { ...common, type, ...(typeof defaultValue === "boolean" ? { default: defaultValue } : {}) };
        case "integer":
        case "number": {
            const initial = finiteNumber(defaultValue);
            const maximum = finiteNumber(property["maximum"]);
            const minimum = finiteNumber(property["minimum"]);
            return {
                ...common,
                type,
                ...(initial === undefined ? {} : { default: initial }),
                ...(maximum === undefined ? {} : { maximum }),
                ...(minimum === undefined ? {} : { minimum }),
            };
        }
        case "multiselect": {
            const maximumSelections = nonNegativeInteger(property["maxItems"]);
            const minimumSelections = nonNegativeInteger(property["minItems"]);
            return {
                ...common,
                type,
                ...(Array.isArray(defaultValue)
                    ? {
                          default: defaultValue
                              .filter((entry): entry is string => typeof entry === "string")
                              .slice(0, 200)
                              .map((entry) => truncate(entry, 500)),
                      }
                    : {}),
                ...(maximumSelections === undefined ? {} : { maximumSelections }),
                ...(minimumSelections === undefined ? {} : { minimumSelections }),
                options,
            };
        }
        case "string": {
            if (options.length > 0) {
                return {
                    ...common,
                    type: "select",
                    ...(typeof defaultValue === "string" ? { default: truncate(defaultValue, 500) } : {}),
                    options,
                };
            }
            const format = nonEmpty(readString(property["format"]), 64);
            const maximumLength = nonNegativeInteger(property["maxLength"]);
            const minimumLength = nonNegativeInteger(property["minLength"]);
            const pattern = nonEmpty(readString(property["pattern"]), 500);
            const metadata = property["_meta"];
            return {
                ...common,
                type,
                ...(typeof defaultValue === "string" ? { default: truncate(defaultValue, 10_000) } : {}),
                ...(format === undefined ? {} : { format }),
                ...(maximumLength === undefined ? {} : { maximumLength }),
                ...(minimumLength === undefined ? {} : { minimumLength }),
                multiline: isRecord(metadata) && metadata["io.morty/multiline"] === true,
                ...(pattern === undefined ? {} : { pattern }),
            };
        }
        default:
            return type satisfies never;
    }
}

export function normalizeElicitationFields(requestedSchema: unknown): readonly SessionElicitationField[] {
    if (!isRecord(requestedSchema) || !isRecord(requestedSchema["properties"])) {
        return [];
    }
    const properties = requestedSchema["properties"];
    const requiredValues = requestedSchema["required"];
    const required = new Set<string>(
        Array.isArray(requiredValues) ? requiredValues.filter((entry) => typeof entry === "string") : [],
    );
    const normalized: SessionElicitationField[] = [];
    for (const [name, property] of Object.entries(properties)) {
        if (isRecord(property)) {
            normalized.push(normalizeElicitationField(name, property, required.has(name)));
        }
    }
    return normalized.slice(0, 100);
}

function validateStringValue(name: string, value: string, schema: Readonly<Record<string, unknown>>): void {
    const minimum = schema["minLength"];
    const maximum = schema["maxLength"];
    if (typeof minimum === "number" && value.length < minimum) {
        throw new AcpExecutionError(
            `Elicitation field ${name} is shorter than allowed`,
            {},
            "invalid_elicitation_response",
        );
    }
    if (typeof maximum === "number" && value.length > maximum) {
        throw new AcpExecutionError(
            `Elicitation field ${name} is longer than allowed`,
            {},
            "invalid_elicitation_response",
        );
    }
    const pattern = schema["pattern"];
    if (typeof pattern === "string" && !new RegExp(pattern, "u").test(value)) {
        throw new AcpExecutionError(
            `Elicitation field ${name} does not match the required format`,
            {},
            "invalid_elicitation_response",
        );
    }
    const allowed = normalizeElicitationOptions(schema);
    if (allowed.length > 0 && !allowed.some((entry) => entry.value === value)) {
        throw new AcpExecutionError(
            `Elicitation field ${name} is not an allowed value`,
            {},
            "invalid_elicitation_response",
        );
    }
}

function validateNumericValue(
    name: string,
    value: number,
    schema: Readonly<Record<string, unknown>>,
    integer: boolean,
): void {
    if (!Number.isFinite(value) || (integer && !Number.isInteger(value))) {
        throw new AcpExecutionError(
            `Elicitation field ${name} is not a valid number`,
            {},
            "invalid_elicitation_response",
        );
    }
    const minimum = schema["minimum"];
    const maximum = schema["maximum"];
    if ((typeof minimum === "number" && value < minimum) || (typeof maximum === "number" && value > maximum)) {
        throw new AcpExecutionError(
            `Elicitation field ${name} is outside the allowed range`,
            {},
            "invalid_elicitation_response",
        );
    }
}

export function validateElicitationContent(
    decoded: SessionElicitationFormContent,
    requestedSchema: unknown,
): Readonly<Record<string, ElicitationContentValue>> {
    if (!isRecord(requestedSchema) || !isRecord(requestedSchema["properties"])) {
        throw new AcpExecutionError(
            "Elicitation response does not match the requested form",
            {},
            "invalid_elicitation_response",
        );
    }
    const properties = requestedSchema["properties"];
    const requiredValue = requestedSchema["required"];
    const required = new Set<string>(
        Array.isArray(requiredValue) ? requiredValue.filter((entry) => typeof entry === "string") : [],
    );
    for (const name of required) {
        if (!(name in decoded)) {
            throw new AcpExecutionError(`Elicitation field ${name} is required`, {}, "invalid_elicitation_response");
        }
    }
    const validated: Record<string, ElicitationContentValue> = {};
    for (const [name, value] of Object.entries(decoded)) {
        const property = properties[name];
        if (!isRecord(property)) {
            throw new AcpExecutionError(
                `Elicitation field ${name} was not requested`,
                {},
                "invalid_elicitation_response",
            );
        }
        if (property["type"] === "string" && typeof value === "string") {
            validateStringValue(name, value, property);
            validated[name] = value;
            continue;
        }
        if (property["type"] === "number" && typeof value === "number") {
            validateNumericValue(name, value, property, false);
            validated[name] = value;
            continue;
        }
        if (property["type"] === "integer" && typeof value === "number") {
            validateNumericValue(name, value, property, true);
            validated[name] = value;
            continue;
        }
        if (property["type"] === "boolean" && typeof value === "boolean") {
            validated[name] = value;
            continue;
        }
        if (property["type"] === "array" && Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
            const minimum = property["minItems"];
            const maximum = property["maxItems"];
            if (
                (typeof minimum === "number" && value.length < minimum) ||
                (typeof maximum === "number" && value.length > maximum)
            ) {
                throw new AcpExecutionError(
                    `Elicitation field ${name} has an invalid selection count`,
                    {},
                    "invalid_elicitation_response",
                );
            }
            const allowed = normalizeElicitationOptions(property);
            if (allowed.length > 0 && value.some((entry) => !allowed.some((option) => option.value === entry))) {
                throw new AcpExecutionError(
                    `Elicitation field ${name} contains an invalid selection`,
                    {},
                    "invalid_elicitation_response",
                );
            }
            validated[name] = value;
            continue;
        }
        throw new AcpExecutionError(`Elicitation field ${name} has the wrong type`, {}, "invalid_elicitation_response");
    }
    return validated;
}
