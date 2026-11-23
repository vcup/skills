/** Small closed JSON-schema interpreter shared by wire and persisted-record codecs. */
import { failure, success, type Result } from "./contracts.ts";
export type Schema = {
    readonly type: "string";
    readonly minLength?: number;
    readonly maxLength?: number;
    readonly pattern?: string;
    readonly enum?: readonly string[];
} | {
    readonly type: "integer";
    readonly minimum?: number;
    readonly maximum?: number;
} | {
    readonly type: "boolean";
} | {
    readonly type: "array";
    readonly items: Schema;
    readonly minItems?: number;
    readonly maxItems?: number;
} | {
    readonly type: "object";
    readonly properties: Readonly<Record<string, Schema>>;
    readonly required: readonly string[];
    readonly additionalProperties: false;
} | {
    readonly anyOf: readonly Schema[];
} | {
    readonly const: string | number | boolean;
} | {
    readonly $ref: string;
};
export const str = (minLength = 1, maxLength = 262144, pattern?: string): Schema => ({
    type: "string", minLength, maxLength, ...(pattern ? {
        pattern
    } : {})
});
export const integer = (minimum = 0, maximum = Number.MAX_SAFE_INTEGER): Schema => ({
    type: "integer", minimum, maximum
});
export const bool: Schema = {
    type: "boolean"
};
export const literal = (value: string | number | boolean): Schema => ({
    const: value
});
export const enumeration = (...values: string[]): Schema => ({
    type: "string", enum: values
});
export const array = (items: Schema, minItems = 0, maxItems = 10000): Schema => ({
    type: "array", items, minItems, maxItems
});
export const union = (...anyOf: Schema[]): Schema => ({
    anyOf
});
export const object = (required: Readonly<Record<string, Schema>>, optional: Readonly<Record<string, Schema>> = {}): Schema => ({
    type: "object", properties: {
        ...required, ...optional
    }, required: Object.keys(required), additionalProperties: false
});
export function extend(base: Schema, required: Readonly<Record<string, Schema>>, optional: Readonly<Record<string, Schema>> = {}): Schema {
    if (!("type" in base) || base.type !== "object")
        throw new Error("Schema extension requires an object.");
    return {
        type: "object", properties: {
            ...base.properties, ...required, ...optional
        }, required: [...base.required, ...Object.keys(required)], additionalProperties: false
    };
}
export const reference = (name: string): Schema => ({
    $ref: `#/$defs/${name}`
});
export type Definitions = Readonly<Record<string, Schema>>;
interface Invalid {
    readonly field: string;
    readonly message: string;
}
const bad = (field: string, message: string): Invalid => ({
    field, message
});
/** Reject JS-only values, cycles, accessors and huge inputs before schema traversal. */
function safeJson(value: unknown, limit: number): Invalid | undefined {
    let size = 0, nodes = 0;
    const visiting = new Set<object>();
    const walk = (item: unknown, path: string, depth: number): Invalid | undefined => {
        if (++nodes > 200000 || depth > 40)
            return bad(path, "JSON structure exceeds depth or node budget.");
        if (item === null) {
            size += 4;
            return undefined;
        }
        if (typeof item === "string") {
            if (item.length > limit)
                return bad(path, "Input exceeds byte budget.");
            // Lone surrogates would silently change bytes on UTF-8 encoding.
            for (let i = 0; i < item.length; i++) {
                const c = item.charCodeAt(i);
                if (c >= 0xd800 && c <= 0xdbff) {
                    const d = item.charCodeAt(++i);
                    if (!(d >= 0xdc00 && d <= 0xdfff))
                        return bad(path, "Unpaired UTF-16 surrogate.");
                }
                else if (c >= 0xdc00 && c <= 0xdfff)
                    return bad(path, "Unpaired UTF-16 surrogate.");
            }
            size += new TextEncoder().encode(JSON.stringify(item)).byteLength;
        }
        else if (typeof item === "boolean")
            size += 5;
        else if (typeof item === "number") {
            if (!Number.isFinite(item))
                return bad(path, "Non-finite numbers are not JSON.");
            size += 24;
        }
        else if (typeof item === "object") {
            if (visiting.has(item))
                return bad(path, "Cyclic input is not JSON.");
            const prototype = Object.getPrototypeOf(item);
            if (!Array.isArray(item) && prototype !== null && prototype !== Object.prototype)
                return bad(path, "Only plain JSON objects are accepted.");
            if (Object.getOwnPropertySymbols(item).length)
                return bad(path, "Symbol fields are not JSON.");
            visiting.add(item);
            size += 2;
            const descriptors = Object.getOwnPropertyDescriptors(item);
            for (const [key, descriptor] of Object.entries(descriptors)) {
                if (Array.isArray(item) && key === "length")
                    continue;
                if (!("value" in descriptor))
                    return bad(`${path}.${key}`, "Accessors are not accepted.");
                if (key === "__proto__" || key === "prototype" || key === "constructor")
                    return bad(`${path}.${key}`, "Reserved field.");
                size += new TextEncoder().encode(key).byteLength + 4;
                const error = walk(descriptor.value, `${path}.${key}`, depth + 1);
                if (error)
                    return error;
            }
            visiting.delete(item);
            if (Array.isArray(item) && Object.keys(item).length !== item.length)
                return bad(path, "Sparse or decorated arrays are not accepted.");
        }
        else
            return bad(path, "Only lossless JSON values are accepted.");
        return size > limit ? bad(path, "Input exceeds byte budget.") : undefined;
    };
    return walk(value, "$", 0);
}
function check(value: unknown, schema: Schema, defs: Definitions, path: string, depth = 0): Invalid | undefined {
    if (depth > 64)
        return bad(path, "Schema/reference depth exceeded.");
    if ("$ref" in schema) {
        const name = schema.$ref.replace("#/$defs/", "");
        const target = defs[name];
        return target ? check(value, target, defs, path, depth + 1) : bad(path, "Unknown schema reference.");
    }
    if ("const" in schema)
        return value === schema.const ? undefined : bad(path, `Expected ${JSON.stringify(schema.const)}.`);
    if ("anyOf" in schema) {
        const errors = schema.anyOf.map(s => check(value, s, defs, path, depth + 1));
        return errors.some(e => e === undefined) ? undefined : bad(path, `No closed variant matches: ${errors.slice(0, 3).map(e => `${e?.field}: ${e?.message}`).join("; ")}`);
    }
    switch (schema.type) {
        case "string":
            if (typeof value !== "string")
                return bad(path, "Expected string.");
            if (schema.minLength !== undefined && (value.length < schema.minLength || (schema.minLength > 0 && !value.trim())))
                return bad(path, "Nonempty text is required.");
            if (schema.maxLength !== undefined && value.length > schema.maxLength)
                return bad(path, "String length exceeds budget.");
            if (schema.enum && !schema.enum.includes(value))
                return bad(path, "Unknown enum value.");
            if (schema.pattern && !new RegExp(schema.pattern, "u").test(value))
                return bad(path, "String does not match required format.");
            return undefined;
        case "integer": return typeof value === "number" && Number.isSafeInteger(value) && (schema.minimum === undefined || value >= schema.minimum) && (schema.maximum === undefined || value <= schema.maximum) ? undefined : bad(path, "Expected bounded safe integer.");
        case "boolean": return typeof value === "boolean" ? undefined : bad(path, "Expected boolean.");
        case "array": {
            if (!Array.isArray(value))
                return bad(path, "Expected array.");
            if (value.length < (schema.minItems ?? 0) || value.length > (schema.maxItems ?? 10000))
                return bad(path, "Array length outside budget.");
            for (let i = 0; i < value.length; i++) {
                const error = check(value[i], schema.items, defs, `${path}[${i}]`, depth + 1);
                if (error)
                    return error;
            }
            return undefined;
        }
        case "object": {
            if (value === null || typeof value !== "object" || Array.isArray(value))
                return bad(path, "Expected object.");
            const fields = value as Record<string, unknown>;
            for (const key of Object.keys(fields))
                if (!Object.hasOwn(schema.properties, key))
                    return bad(`${path}.${key}`, "Unknown field.");
            for (const key of schema.required)
                if (!Object.hasOwn(fields, key))
                    return bad(`${path}.${key}`, "Required field missing.");
            for (const [key, item] of Object.entries(fields)) {
                const error = check(item, schema.properties[key]!, defs, `${path}.${key}`, depth + 1);
                if (error)
                    return error;
            }
            return undefined;
        }
    }
}
export function decode<T>(value: unknown, schema: Schema, defs: Definitions = {}, maxBytes = 256 * 1024): Result<T> {
    const unsafe = safeJson(value, maxBytes);
    if (unsafe)
        return failure(unsafe.message.includes("budget") ? "budget_exceeded" : "invalid_input", unsafe.message, unsafe.field);
    const invalid = check(value, schema, defs, "$");
    return invalid ? failure("invalid_input", invalid.message, invalid.field) : success(value as T);
}
/** JSON Schema delivered to tool registries uses precisely the validation definition. */
export function publicSchema(schema: Schema, defs: Definitions): Schema & {
    readonly $defs: Definitions;
} { return {
    ...schema, $defs: defs
}; }
