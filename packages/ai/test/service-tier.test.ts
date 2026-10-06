import { describe, expect, it } from "vitest";
import { getModel } from "../src/compat.ts";
import { getSupportedServiceTiers, isServiceTier, SERVICE_TIERS, supportsServiceTier } from "../src/models.ts";
import type { Api, Model, ModelServiceTier } from "../src/types.ts";

const FAST: ModelServiceTier = { id: "priority", name: "Fast", description: "1.5x speed, increased usage" };

function createModel(api: Api, provider: string, serviceTiers?: ModelServiceTier[]): Model<Api> {
	return {
		id: "test-model",
		name: "Test Model",
		api,
		provider,
		baseUrl: "https://example.invalid",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
		...(serviceTiers ? { serviceTiers } : {}),
	};
}

describe("getSupportedServiceTiers", () => {
	it.each([
		["openai-codex-responses", "openai-codex"],
		["openai-codex-responses", "custom-codex-proxy"],
	])("returns the tiers that %s models from %s declare", (api, provider) => {
		expect(getSupportedServiceTiers(createModel(api, provider, [FAST]))).toEqual(["priority"]);
		expect(supportsServiceTier(createModel(api, provider, [FAST]))).toBe(true);
	});

	it("returns no tiers for Codex models that declare none", () => {
		expect(getSupportedServiceTiers(createModel("openai-codex-responses", "openai-codex"))).toEqual([]);
		expect(supportsServiceTier(createModel("openai-codex-responses", "openai-codex"))).toBe(false);
	});

	it("returns every tier for OpenAI Responses models", () => {
		expect(getSupportedServiceTiers(createModel("openai-responses", "openai"))).toEqual(SERVICE_TIERS);
		expect(supportsServiceTier(createModel("openai-responses", "openai"))).toBe(true);
	});

	it.each([
		["openai-responses", "xai"],
		["openai-responses", "github-copilot"],
		["openai-responses", "opencode"],
		["azure-openai-responses", "azure-openai-responses"],
		["openai-completions", "openai"],
		["anthropic-messages", "anthropic"],
	])("returns no tiers for %s models from %s, even when they declare some", (api, provider) => {
		expect(getSupportedServiceTiers(createModel(api, provider, [FAST]))).toEqual([]);
		expect(supportsServiceTier(createModel(api, provider, [FAST]))).toBe(false);
	});
});

describe("built-in Codex service tiers", () => {
	it.each([
		"gpt-6.1-sol",
		"gpt-6-astra",
		"gpt-6-sol",
		"gpt-6-luna",
		"gpt-5.6-sol",
		"gpt-5.6-terra",
		"gpt-5.6-luna",
		"gpt-5.5",
	] as const)("offers Fast on %s", (id) => {
		expect(getModel("openai-codex", id).serviceTiers).toEqual([
			expect.objectContaining({ id: "priority", name: "Fast" }),
		]);
	});

	it("does not offer Fast on GPT-5.3 Codex Spark", () => {
		expect(getModel("openai-codex", "gpt-5.3-codex-spark").serviceTiers).toBeUndefined();
	});
});

describe("isServiceTier", () => {
	it("lists every pi service tier", () => {
		expect(SERVICE_TIERS).toEqual(["auto", "default", "flex", "scale", "priority"]);
	});

	it.each(SERVICE_TIERS)("accepts %s", (tier) => {
		expect(isServiceTier(tier)).toBe(true);
	});

	it.each(["fast", "ultrafast", "Priority", "", null, undefined, 1, {}])("rejects %j", (value) => {
		expect(isServiceTier(value)).toBe(false);
	});
});
