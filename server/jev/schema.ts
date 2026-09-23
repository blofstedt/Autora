/**
 * Jev Mode, part one: which decisions can be scored rather than written.
 *
 * A decision qualifies when every field in it is independent of the others
 * and has a small, fixed set of possible values -- an enum, a boolean, a
 * short integer range. Such a field does not need to be generated token by
 * token: each allowed value is given a one-letter label, the model is asked
 * for the letter, and the probabilities it puts on each letter are the
 * answer and the confidence together.
 *
 * Anything else -- free text, open numbers, nested objects, or a field whose
 * value is meant to follow from another field's -- makes the whole decision
 * ineligible, and it goes to ordinary generation unchanged.
 */

/** Labels are single capital letters: one token in every tokenizer we know
    of, with or without a leading space, which is what keeps the scores
    comparable across options (see the engine). Twenty, because that is the
    most alternatives the OpenAI-style APIs will report for one token. */
export const LABELS = "ABCDEFGHIJKLMNOPQRST".split("");
export const MAX_OPTIONS = LABELS.length;

export type JevValue = string | number | boolean | null;

export interface JevOption {
  /** The one-letter label the model answers with. */
  label: string;
  /** What that letter stands for in the finished payload. */
  value: JevValue;
  /** How the option is described to the model. */
  text: string;
}

export interface JevField {
  name: string;
  description: string;
  options: JevOption[];
}

export interface ParsedSchema {
  /** True when every field is discrete and independent. */
  eligible: boolean;
  fields: JevField[];
  /** Why not, field by field, when it is not. */
  reasons: string[];
}

/** The subset of JSON Schema this reads. Unknown keywords are ignored, except
    the ones that signal a dependency, which make a field ineligible. */
export interface JsonSchema {
  type?: string | string[];
  description?: string;
  enum?: JevValue[];
  const?: JevValue;
  oneOf?: JsonSchema[];
  anyOf?: JsonSchema[];
  minimum?: number;
  maximum?: number;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  dependentRequired?: Record<string, string[]>;
  dependentSchemas?: Record<string, JsonSchema>;
  dependencies?: Record<string, unknown>;
  if?: unknown;
  then?: unknown;
  else?: unknown;
  /** Autora's own marker: this field's value depends on these fields. */
  "x-depends-on"?: string[];
  [key: string]: unknown;
}

/** An integer range this small is a choice, not a number to write out. */
const MAX_INT_RANGE = MAX_OPTIONS;

/**
 * Turn an object schema into lettered option maps, or say why it cannot be.
 */
export function parseSchema(schema: JsonSchema): ParsedSchema {
  const reasons: string[] = [];
  const props = schema?.properties;
  if (!props || typeof props !== "object" || Object.keys(props).length === 0) {
    return { eligible: false, fields: [], reasons: ["the schema has no fields"] };
  }

  // Dependencies declared at the object level.
  const dependent = new Set<string>();
  for (const key of Object.keys(schema.dependentRequired ?? {})) {
    for (const other of schema.dependentRequired![key] ?? []) dependent.add(other);
  }
  for (const key of Object.keys(schema.dependentSchemas ?? {})) {
    for (const other of Object.keys(schema.dependentSchemas![key]?.properties ?? {})) {
      dependent.add(other);
    }
  }
  for (const key of Object.keys(schema.dependencies ?? {})) dependent.add(key);
  if (schema.if !== undefined || schema.then !== undefined || schema.else !== undefined) {
    reasons.push("the schema is conditional (if/then/else), so its fields depend on each other");
  }

  const names = Object.keys(props);
  const fields: JevField[] = [];

  for (const name of names) {
    const field = props[name] ?? {};
    const description = String(field.description ?? "").trim();

    const declared = field["x-depends-on"];
    if (dependent.has(name) || (Array.isArray(declared) && declared.length > 0)) {
      reasons.push(`"${name}" depends on another field`);
      continue;
    }
    // A description that names a sibling ("based on `items`") is a
    // dependency said in prose. Quoted or backticked only: a bare word match
    // would catch "type" in every description ever written.
    const mentioned = names.find(
      (other) => other !== name && new RegExp(`[\`"']${escape(other)}[\`"']`).test(description),
    );
    if (mentioned) {
      reasons.push(`"${name}" refers to "${mentioned}", so it depends on it`);
      continue;
    }

    const options = optionsFor(field);
    if (!options) {
      reasons.push(`"${name}" is not a fixed set of values`);
      continue;
    }
    if (options.length < 2) {
      reasons.push(`"${name}" has only one possible value`);
      continue;
    }
    if (options.length > MAX_OPTIONS) {
      reasons.push(`"${name}" has ${options.length} values; at most ${MAX_OPTIONS} can be scored`);
      continue;
    }
    fields.push({
      name,
      description,
      options: options.map((o, i) => ({ label: LABELS[i], value: o.value, text: o.text })),
    });
  }

  return { eligible: reasons.length === 0 && fields.length > 0, fields, reasons };
}

function optionsFor(field: JsonSchema): { value: JevValue; text: string }[] | null {
  if (Array.isArray(field.enum)) {
    return field.enum.map((value) => ({ value, text: JSON.stringify(value) }));
  }
  const alternatives = field.oneOf ?? field.anyOf;
  if (Array.isArray(alternatives) && alternatives.every((a) => a && "const" in a)) {
    return alternatives.map((a) => ({
      value: a.const as JevValue,
      text: a.description ? `${JSON.stringify(a.const)} (${a.description})` : JSON.stringify(a.const),
    }));
  }
  const type = Array.isArray(field.type) ? field.type[0] : field.type;
  if (type === "boolean") {
    return [
      { value: true, text: "true" },
      { value: false, text: "false" },
    ];
  }
  if (type === "integer" && Number.isInteger(field.minimum) && Number.isInteger(field.maximum)) {
    const lo = field.minimum!, hi = field.maximum!;
    if (hi < lo || hi - lo + 1 > MAX_INT_RANGE) return null;
    return Array.from({ length: hi - lo + 1 }, (_, i) => ({ value: lo + i, text: String(lo + i) }));
  }
  return null;
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
