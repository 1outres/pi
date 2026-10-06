import {
	fauxAssistantMessage,
	fauxToolCall,
	type Model,
	type ModelServiceTier,
	type ServiceTier,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "../../src/index.ts";
import { createHarness, type Harness, type HarnessOptions } from "./harness.ts";

const FAST: ModelServiceTier[] = [{ id: "priority", name: "Fast", description: "Faster replies" }];

describe("AgentSession service tier", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	async function createServiceTierHarness(options: HarnessOptions = {}): Promise<Harness> {
		const harness = await createHarness({
			api: "openai-codex-responses",
			models: [
				{ id: "codex-1", serviceTiers: FAST },
				{ id: "codex-2", serviceTiers: FAST },
				{ id: "codex-without-tiers" },
			],
			...options,
		});
		harnesses.push(harness);
		return harness;
	}

	function withoutServiceTiers(model: Model<string>): Model<string> {
		return { ...model, api: "faux-without-service-tiers" };
	}

	function serviceTierEntries(harness: Harness): Array<ServiceTier | null> {
		return harness.sessionManager
			.getEntries()
			.flatMap((entry) => (entry.type === "service_tier_change" ? [entry.serviceTier] : []));
	}

	function serviceTierEvents(harness: Harness): Array<ServiceTier | undefined> {
		return harness.eventsOfType("service_tier_changed").map((event) => event.serviceTier);
	}

	it("records one entry and emits one event per change", async () => {
		const harness = await createServiceTierHarness();

		harness.session.setServiceTier("priority");
		harness.session.setServiceTier("priority");
		harness.session.setServiceTier(undefined);
		harness.session.setServiceTier(undefined);

		expect(harness.session.serviceTier).toBeUndefined();
		expect(serviceTierEntries(harness)).toEqual(["priority", null]);
		expect(serviceTierEvents(harness)).toEqual(["priority", undefined]);
	});

	it("sends the tier on later requests", async () => {
		const harness = await createServiceTierHarness();
		const requestTiers: Array<ServiceTier | undefined> = [];
		harness.setResponses([
			(_context, options) => {
				requestTiers.push(options?.serviceTier);
				return fauxAssistantMessage("one");
			},
			(_context, options) => {
				requestTiers.push(options?.serviceTier);
				return fauxAssistantMessage("two");
			},
		]);

		await harness.session.prompt("first");
		harness.session.setServiceTier("priority");
		await harness.session.prompt("second");

		expect(requestTiers).toEqual([undefined, "priority"]);
	});

	it("applies a tier change made during a run to the next request", async () => {
		const harness = await createServiceTierHarness({
			extensionFactories: [
				(pi) => {
					pi.registerTool({
						name: "clear_service_tier",
						label: "Clear service tier",
						description: "Clear the service tier",
						parameters: Type.Object({}),
						execute: async () => {
							pi.setServiceTier(undefined);
							return { content: [{ type: "text", text: "cleared" }], details: {} };
						},
					});
				},
			],
		});
		const requestTiers: Array<ServiceTier | undefined> = [];
		harness.setResponses([
			(_context, options) => {
				requestTiers.push(options?.serviceTier);
				return fauxAssistantMessage([fauxToolCall("clear_service_tier", {})], { stopReason: "toolUse" });
			},
			(_context, options) => {
				requestTiers.push(options?.serviceTier);
				return fauxAssistantMessage("done");
			},
		]);

		harness.session.setServiceTier("priority");
		await harness.session.prompt("run");

		expect(requestTiers).toEqual(["priority", undefined]);
	});

	it("rejects a tier for a model without service tiers", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const model = harness.getModel();

		expect(() => harness.session.setServiceTier("priority")).toThrow(
			`Service tiers are not supported by ${model.provider}/${model.id}`,
		);
		harness.session.setServiceTier(undefined);

		expect(harness.session.serviceTier).toBeUndefined();
		expect(serviceTierEntries(harness)).toEqual([]);
		expect(serviceTierEvents(harness)).toEqual([]);
	});

	it("rejects a tier that the model does not offer", async () => {
		const harness = await createServiceTierHarness();
		const model = harness.getModel();

		expect(() => harness.session.setServiceTier("flex")).toThrow(
			`Service tier "flex" is not supported by ${model.provider}/${model.id}. Supported tiers: priority`,
		);
		expect(serviceTierEntries(harness)).toEqual([]);
	});

	it("rejects a value that is not a service tier", async () => {
		const harness = await createServiceTierHarness();
		const value: string = "fast";

		expect(() => harness.session.setServiceTier(value as ServiceTier)).toThrow(
			'Invalid service tier "fast". Valid values: auto, default, flex, scale, priority',
		);
		expect(serviceTierEntries(harness)).toEqual([]);
	});

	it("clears the tier when switching to a model without service tiers", async () => {
		const harness = await createServiceTierHarness();
		harness.session.setServiceTier("priority");

		await harness.session.setModel(withoutServiceTiers(harness.getModel("codex-2")!));

		expect(harness.session.serviceTier).toBeUndefined();
		expect(serviceTierEntries(harness)).toEqual(["priority", null]);
		expect(serviceTierEvents(harness)).toEqual(["priority", undefined]);
	});

	it("clears the tier when switching to a Codex model that does not offer it", async () => {
		const harness = await createServiceTierHarness();
		harness.session.setServiceTier("priority");

		await harness.session.setModel(harness.getModel("codex-without-tiers")!);

		expect(harness.session.serviceTier).toBeUndefined();
		expect(serviceTierEntries(harness)).toEqual(["priority", null]);
	});

	it("keeps the tier when switching to another model with service tiers", async () => {
		const harness = await createServiceTierHarness();
		harness.session.setServiceTier("priority");

		await harness.session.setModel(harness.getModel("codex-2")!);

		expect(harness.session.serviceTier).toBe("priority");
		expect(serviceTierEntries(harness)).toEqual(["priority"]);
	});

	it("clears the tier when cycling to a model without service tiers", async () => {
		const harness = await createServiceTierHarness();
		harness.session.setScopedModels([
			{ model: harness.getModel("codex-1")! },
			{ model: withoutServiceTiers(harness.getModel("codex-2")!) },
		]);
		harness.session.setServiceTier("priority");

		const result = await harness.session.cycleModel();

		expect(result?.model.api).toBe("faux-without-service-tiers");
		expect(harness.session.serviceTier).toBeUndefined();
		expect(serviceTierEntries(harness)).toEqual(["priority", null]);
	});

	it("clears the tier when a provider update moves the model to an API without service tiers", async () => {
		let extensionApi: ExtensionAPI | undefined;
		const harness = await createServiceTierHarness({
			extensionFactories: [
				(pi) => {
					extensionApi = pi;
				},
			],
		});
		const model = harness.getModel();
		harness.session.setServiceTier("priority");

		extensionApi?.registerProvider(model.provider, {
			baseUrl: model.baseUrl,
			apiKey: "faux-key",
			api: "faux-without-service-tiers",
			models: [
				{
					id: model.id,
					name: model.name,
					reasoning: model.reasoning,
					input: model.input,
					cost: model.cost,
					contextWindow: model.contextWindow,
					maxTokens: model.maxTokens,
				},
			],
		});

		expect(harness.session.model?.api).toBe("faux-without-service-tiers");
		expect(harness.session.serviceTier).toBeUndefined();
		expect(serviceTierEntries(harness)).toEqual(["priority", null]);
	});

	it("reads and sets the tier through the extension API", async () => {
		let extensionApi: ExtensionAPI | undefined;
		const harness = await createServiceTierHarness({
			extensionFactories: [
				(pi) => {
					extensionApi = pi;
				},
			],
		});

		extensionApi?.setServiceTier("priority");
		expect(extensionApi?.getServiceTier()).toBe("priority");
		expect(harness.session.serviceTier).toBe("priority");

		extensionApi?.setServiceTier(undefined);
		expect(extensionApi?.getServiceTier()).toBeUndefined();
		expect(serviceTierEntries(harness)).toEqual(["priority", null]);
	});
});
