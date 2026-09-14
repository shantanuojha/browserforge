/**
 * Curated rule packs (Pro). Packs are bundled JSON: no network, no remote
 * config. `{{KEY}}` placeholders in rule fields are filled from user-supplied
 * variables at install time.
 */

import { isRecord } from "@browserforge/shared";
import { parseRule, type Rule } from "../rules/model";
import ampToCanonical from "./amp-to-canonical.json";
import oldReddit from "./old-reddit.json";
import privacyFrontends from "./privacy-frontends.json";

export interface PackVariable {
  key: string;
  label: string;
  placeholder?: string;
  default: string;
}

export interface RulePack {
  id: string;
  name: string;
  description: string;
  variables: PackVariable[];
  /** Rules without ids (validated by parseRule at install). */
  rules: unknown[];
}

function parsePackVariable(input: unknown): PackVariable | null {
  if (!isRecord(input) || typeof input.key !== "string" || typeof input.label !== "string") {
    return null;
  }
  const variable: PackVariable = {
    key: input.key,
    label: input.label,
    default: typeof input.default === "string" ? input.default : "",
  };
  if (typeof input.placeholder === "string") variable.placeholder = input.placeholder;
  return variable;
}

/** `undefined` reads as no variables; anything malformed is `null`. */
function parsePackVariables(input: unknown): PackVariable[] | null {
  if (input === undefined) return [];
  if (!Array.isArray(input)) return null;
  const variables = input.map(parsePackVariable);
  return variables.every((v): v is PackVariable => v !== null) ? variables : null;
}

export function parsePack(input: unknown): RulePack | null {
  if (!isRecord(input)) return null;
  const { id, name, description, rules } = input;
  if (typeof id !== "string" || typeof name !== "string" || typeof description !== "string") {
    return null;
  }
  if (!Array.isArray(rules)) return null;
  const variables = parsePackVariables(input.variables);
  if (variables === null) return null;
  return { id, name, description, variables, rules };
}

const BUNDLED: unknown[] = [oldReddit, privacyFrontends, ampToCanonical];

export const RULE_PACKS: RulePack[] = BUNDLED.map((p) => {
  const pack = parsePack(p);
  if (!pack) throw new Error("Bundled rule pack is malformed");
  return pack;
});

export function fillPlaceholders(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{([A-Z0-9_]+)\}\}/g, (m, key: string) => vars[key] ?? m);
}

export function missingVariables(pack: RulePack, vars: Record<string, string>): string[] {
  return pack.variables.filter((v) => !(vars[v.key] ?? v.default).trim()).map((v) => v.key);
}

export interface InstantiatedPack {
  rules: Rule[];
  errors: string[];
}

/** Produces fresh rules (new ids) with variables substituted into include/exclude/redirectTo. */
export function instantiatePack(
  pack: RulePack,
  vars: Record<string, string> = {},
): InstantiatedPack {
  const merged: Record<string, string> = {};
  for (const v of pack.variables) merged[v.key] = (vars[v.key] ?? v.default).trim();
  const rules: Rule[] = [];
  const errors: string[] = [];
  pack.rules.forEach((raw, i) => {
    const res = parseRule(raw, i);
    if (!res.ok) {
      errors.push(res.error);
      return;
    }
    const r = res.value;
    rules.push({
      ...r,
      name: r.name ? `${pack.name}: ${r.name}` : pack.name,
      include: fillPlaceholders(r.include, merged),
      exclude: r.exclude.map((e) => fillPlaceholders(e, merged)),
      redirectTo: fillPlaceholders(r.redirectTo, merged),
    });
  });
  return { rules, errors };
}
