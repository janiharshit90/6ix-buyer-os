import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { RELEASED_PROMPTS } from "@/lib/ai/prompts/registry";
import { offerCheckV1 } from "@/lib/ai/prompts/offer-check/v1";

const hashesPath = path.join(import.meta.dirname, "../../lib/ai/prompts/hashes.json");
const frozen = z.record(z.string(), z.string()).parse(JSON.parse(readFileSync(hashesPath, "utf8")));

describe("released prompts are frozen", () => {
  it.each(RELEASED_PROMPTS.map((p) => [p.id, p] as const))("%s matches hashes.json", (id, p) => {
    const actual = p.fingerprint();
    expect(
      frozen[id],
      `New prompt ${id}: add "${id}": "${actual}" to lib/ai/prompts/hashes.json`,
    ).toBeDefined();
    expect(
      actual,
      `${id} changed after release. Add a new version (e.g. v${Number(id.split("@")[1]) + 1}) instead of editing it, or undo the change to its shared pieces.`,
    ).toBe(frozen[id]);
  });

  it("hashes.json lists only released prompts", () => {
    expect(Object.keys(frozen).sort()).toEqual(RELEASED_PROMPTS.map((p) => p.id).sort());
  });

  it("prompt ids are unique", () => {
    const ids = RELEASED_PROMPTS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("offer-check@1 output schema", () => {
  it("has no numeric fields: the AI never produces numbers", () => {
    const schema = JSON.stringify(z.toJSONSchema(offerCheckV1.outputSchema));
    expect(schema).not.toMatch(/"type":"(number|integer)"/);
  });

  it("accepts its own example-style output and rejects unknown fields", () => {
    const ok = offerCheckV1.outputSchema.safeParse({
      findings: [{ field: "vertical", kind: "suspicious", severity: "info", message: "Check it." }],
    });
    expect(ok.success).toBe(true);
    const bad = offerCheckV1.outputSchema.safeParse({
      findings: [{ field: "payout_amount", kind: "suspicious", severity: "info", message: "x" }],
    });
    expect(bad.success).toBe(false);
  });
});
