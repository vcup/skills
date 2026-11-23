/** Project the core's JSON Schema onto DSH's released supported subset. */
const retained = new Set(["type", "oneOf", "properties", "required", "additionalProperties", "items", "enum", "const", "description", "title"]);
function object(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }

/** The core decoder remains authoritative for recursive refs and numeric/string budgets. */
export function dshSchema(schema: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const defs = object(schema.$defs) ? schema.$defs : {};
  const convert = (value: unknown, refs: readonly string[] = []): Record<string, unknown> => {
    if (!object(value)) throw new Error("core schema node must be an object");
    if (typeof value.$ref === "string") {
      const key = value.$ref.replace(/^#\/\$defs\//, "");
      if (!object(defs[key])) throw new Error("unsupported core schema reference");
      if (refs.includes(key)) return { type: "object", description: `Nested ${key}; same closed variants as the containing reference. Limits and unknown fields are checked by the command decoder.` };
      return convert(defs[key], [...refs, key]);
    }
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      if (key === "anyOf" || key === "oneOf") {
        if (!Array.isArray(child)) throw new Error("schema variants must be an array");
        result.oneOf = child.map(branch => convert(branch, refs));
      } else if (!retained.has(key)) continue;
      else if (key === "properties") {
        if (!object(child)) throw new Error("schema properties must be an object");
        result.properties = Object.fromEntries(Object.entries(child).map(([name, property]) => [name, convert(property, refs)]));
      } else if (key === "items") result.items = convert(child, refs);
      else result[key] = child;
    }
    if (result.type === undefined && Object.hasOwn(result, "const")) result.type = result.const === null ? "null" : typeof result.const;
    if (result.type === undefined && Array.isArray(result.enum) && result.enum.length > 0) result.type = result.enum[0] === null ? "null" : typeof result.enum[0];
    return result;
  };
  return convert(schema);
}
