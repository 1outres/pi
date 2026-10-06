import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Api,
	createAssistantMessageEventStream,
	type Model,
	type ModelServiceTier,
	type ServiceTier,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";

describe("createAgentSession service tier", () => {
	let tempDir: string;
	let cwd: string;
	let agentDir: string;
	const disposers: Array<() => void> = [];

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-sdk-service-tier-"));
		cwd = join(tempDir, "project");
		agentDir = join(tempDir, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		while (disposers.length > 0) disposers.pop()?.();
		rmSync(tempDir, { recursive: true, force: true });
	});

	const FAST: ModelServiceTier[] = [{ id: "priority", name: "Fast", description: "Faster replies" }];
	const FAST_OR_FLEX: ModelServiceTier[] = [...FAST, { id: "flex", name: "Flex", description: "Cheaper replies" }];

	function createModel(api: Api, serviceTiers: ModelServiceTier[] | undefined): Model<Api> {
		return {
			id: "capture-model",
			name: "Capture Model",
			api,
			provider: "capture-provider",
			baseUrl: "https://capture.invalid/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 4096,
			...(serviceTiers ? { serviceTiers } : {}),
		};
	}

	async function createSession(options: {
		api: Api;
		serviceTiers?: ModelServiceTier[];
		serviceTier?: ServiceTier;
		populate?: (manager: SessionManager, model: Model<Api>) => void;
	}): Promise<{ session: AgentSession; sessionManager: SessionManager; requests: SimpleStreamOptions[] }> {
		const model = createModel(options.api, options.serviceTiers);
		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		await authStorage.modify(model.provider, async () => ({ type: "api_key", key: "test-api-key" }));
		const modelRegistry = await createModelRegistry(authStorage, join(agentDir, "models.json"));
		const requests: SimpleStreamOptions[] = [];
		modelRegistry.registerProvider(model.provider, {
			api: model.api,
			streamSimple: (_requestModel, _context, requestOptions) => {
				requests.push(requestOptions ?? {});
				const stream = createAssistantMessageEventStream();
				stream.end({
					role: "assistant",
					content: [{ type: "text", text: "ok" }],
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: Date.now(),
				});
				return stream;
			},
		});
		disposers.push(() => modelRegistry.unregisterProvider(model.provider));

		const sessionManager = SessionManager.inMemory(cwd);
		options.populate?.(sessionManager, model);
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model,
			modelRuntime: getModelRuntime(modelRegistry),
			settingsManager: SettingsManager.inMemory(),
			sessionManager,
			...(options.serviceTier === undefined ? {} : { serviceTier: options.serviceTier }),
		});
		disposers.push(() => session.dispose());
		return { session, sessionManager, requests };
	}

	function populateConversation(serviceTier: ServiceTier) {
		return (manager: SessionManager, model: Model<Api>) => {
			manager.appendModelChange(model.provider, model.id);
			manager.appendThinkingLevelChange("off");
			manager.appendServiceTierChange(serviceTier);
			manager.appendMessage({ role: "user", content: "earlier", timestamp: Date.now() - 1000 });
		};
	}

	function serviceTierEntries(manager: SessionManager): Array<ServiceTier | null> {
		return manager.getEntries().flatMap((entry) => (entry.type === "service_tier_change" ? [entry.serviceTier] : []));
	}

	it("sends no service tier by default and records none for a new session", async () => {
		const { session, sessionManager, requests } = await createSession({
			api: "openai-codex-responses",
			serviceTiers: FAST,
		});

		await session.prompt("test");

		expect(session.serviceTier).toBeUndefined();
		expect(requests).toHaveLength(1);
		expect(requests[0]?.serviceTier).toBeUndefined();
		expect(serviceTierEntries(sessionManager)).toEqual([]);
	});

	it("sends the tier chosen with setServiceTier on later requests", async () => {
		const { session, requests } = await createSession({ api: "openai-codex-responses", serviceTiers: FAST });

		session.setServiceTier("priority");
		await session.prompt("test");

		expect(requests[0]?.serviceTier).toBe("priority");
	});

	it("applies and records the serviceTier option", async () => {
		const { session, sessionManager, requests } = await createSession({
			api: "openai-codex-responses",
			serviceTiers: FAST,
			serviceTier: "priority",
		});

		await session.prompt("test");

		expect(session.serviceTier).toBe("priority");
		expect(requests[0]?.serviceTier).toBe("priority");
		expect(serviceTierEntries(sessionManager)).toEqual(["priority"]);
	});

	it("rejects the serviceTier option for a model without service tiers", async () => {
		await expect(createSession({ api: "anthropic-messages", serviceTier: "priority" })).rejects.toThrow(
			"Service tiers are not supported by capture-provider/capture-model",
		);
	});

	it("restores the service tier of a resumed session without recording it again", async () => {
		const { session, sessionManager, requests } = await createSession({
			api: "openai-codex-responses",
			serviceTiers: FAST,
			populate: populateConversation("priority"),
		});

		await session.prompt("test");

		expect(session.serviceTier).toBe("priority");
		expect(requests[0]?.serviceTier).toBe("priority");
		expect(serviceTierEntries(sessionManager)).toEqual(["priority"]);
	});

	it("lets the serviceTier option replace a restored tier", async () => {
		const { session, sessionManager } = await createSession({
			api: "openai-codex-responses",
			serviceTiers: FAST_OR_FLEX,
			serviceTier: "priority",
			populate: populateConversation("flex"),
		});

		expect(session.serviceTier).toBe("priority");
		expect(serviceTierEntries(sessionManager)).toEqual(["flex", "priority"]);
	});

	it("clears a restored tier that the model does not offer", async () => {
		const { session, sessionManager } = await createSession({
			api: "openai-codex-responses",
			serviceTiers: FAST,
			populate: populateConversation("flex"),
		});

		expect(session.serviceTier).toBeUndefined();
		expect(serviceTierEntries(sessionManager)).toEqual(["flex", null]);
	});

	it("clears a restored tier when the model does not support service tiers", async () => {
		const { session, sessionManager, requests } = await createSession({
			api: "anthropic-messages",
			populate: populateConversation("priority"),
		});

		await session.prompt("test");

		expect(session.serviceTier).toBeUndefined();
		expect(requests[0]?.serviceTier).toBeUndefined();
		expect(serviceTierEntries(sessionManager)).toEqual(["priority", null]);
	});
});
