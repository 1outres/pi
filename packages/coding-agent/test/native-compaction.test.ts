import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, type StreamFn } from "@earendil-works/pi-agent-core";
import type { Model, ProviderCompactionResult, ProviderHistoryMessage, Usage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { convertToLlm } from "../src/core/messages.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createTestResourceLoader } from "./utilities.ts";

const model: Model<"openai-codex-responses"> = {
	id: "gpt-5.6-sol",
	name: "GPT-5.6 Sol",
	api: "openai-codex-responses",
	provider: "openai-codex",
	baseUrl: "https://chatgpt.com/backend-api",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1_050_000,
	maxTokens: 128_000,
};

const portableModel: Model<"test-native-compaction"> = {
	id: "portable-model",
	name: "Portable Model",
	api: "test-native-compaction",
	provider: "native-test",
	baseUrl: "https://native.test/v1",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1_050_000,
	maxTokens: 128_000,
};

const usage: Usage = {
	input: 10,
	output: 2,
	cacheRead: 3,
	cacheWrite: 0,
	reasoning: 1,
	totalTokens: 15,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const history: ProviderHistoryMessage = {
	role: "providerHistory",
	api: model.api,
	provider: model.provider,
	model: model.id,
	items: [
		{ type: "message", role: "user", content: [{ type: "input_text", text: "remember this" }] },
		{ type: "compaction", encrypted_content: "opaque-state" },
	],
	timestamp: 2,
};

const portableHistory: ProviderHistoryMessage = {
	role: "providerHistory",
	api: portableModel.api,
	provider: portableModel.provider,
	model: portableModel.id,
	items: [{ type: "native-summary", payload: "opaque-state" }],
	timestamp: 2,
};

function seed(manager: SessionManager, selectedModel: Model<any> = model): string {
	const firstEntryId = manager.appendMessage({ role: "user", content: "remember this", timestamp: 1 });
	manager.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "remembered" }],
		api: selectedModel.api,
		provider: selectedModel.provider,
		model: selectedModel.id,
		usage: { ...usage, totalTokens: 100 },
		stopReason: "stop",
		timestamp: 2,
	});
	return firstEntryId;
}

describe("native-only AgentSession compaction", () => {
	const sessions: AgentSession[] = [];

	afterEach(() => {
		vi.restoreAllMocks();
		while (sessions.length > 0) sessions.pop()?.dispose();
	});

	it("uses provider capability without checking provider names or opaque item formats", async () => {
		const manager = SessionManager.inMemory();
		seed(manager, portableModel);
		const supportsCompaction = vi.fn(() => true);
		const compact = vi.fn(
			async (): Promise<ProviderCompactionResult> => ({
				history: portableHistory,
				responseId: "native-response-1",
				usage,
			}),
		);
		const runtime = {
			supportsCompaction,
			compact,
			getModel: () => portableModel,
		} as unknown as ModelRuntime;
		const agent = new Agent({
			streamFn: vi.fn() as unknown as StreamFn,
			initialState: { model: portableModel, messages: manager.buildSessionContext().messages },
			convertToLlm,
		});
		const session = new AgentSession({
			agent,
			sessionManager: manager,
			settingsManager: SettingsManager.inMemory({ compaction: { keepRecentTokens: 1 } }),
			cwd: process.cwd(),
			modelRuntime: runtime,
			resourceLoader: createTestResourceLoader(),
		});
		sessions.push(session);

		const result = await session.compact();

		expect(supportsCompaction).toHaveBeenCalledWith(portableModel);
		expect(compact).toHaveBeenCalledOnce();
		expect(result).toMatchObject({
			summary: "Provider native compaction",
			replacementHistory: [portableHistory],
			details: {
				type: "provider.compaction",
				provider: portableModel.provider,
				model: portableModel.id,
				responseId: "native-response-1",
			},
		});
	});

	it("uses ModelRuntime.compact and never calls the summary stream", async () => {
		const manager = SessionManager.inMemory();
		seed(manager);
		const summaryStream = vi.fn(() => {
			throw new Error("Pi summary compaction must not run");
		});
		const compact = vi.fn(
			async (): Promise<ProviderCompactionResult> => ({
				history,
				responseId: "resp_compact_1",
				usage,
			}),
		);
		const runtime = {
			supportsCompaction: vi.fn(() => true),
			compact,
			getModel: () => model,
			getAuth: vi.fn(),
		} as unknown as ModelRuntime;
		const agent = new Agent({
			streamFn: summaryStream as unknown as StreamFn,
			initialState: { model, messages: manager.buildSessionContext().messages },
			convertToLlm,
		});
		const session = new AgentSession({
			agent,
			sessionManager: manager,
			settingsManager: SettingsManager.inMemory({ compaction: { keepRecentTokens: 1 } }),
			cwd: process.cwd(),
			modelRuntime: runtime,
			resourceLoader: createTestResourceLoader(),
		});
		sessions.push(session);

		const result = await session.compact();

		expect(summaryStream).not.toHaveBeenCalled();
		expect(compact).toHaveBeenCalledOnce();
		expect(result.replacementHistory).toEqual([history]);
		expect(manager.buildSessionContext().messages).toEqual([history]);
		const entry = manager.getEntries().find((candidate) => candidate.type === "compaction");
		expect(entry).toMatchObject({
			type: "compaction",
			summary: "Provider native compaction",
			replacementHistory: [history],
			details: {
				type: "provider.compaction",
				provider: model.provider,
				model: model.id,
				responseId: "resp_compact_1",
			},
		});
	});

	it("does not save a summary when native compaction fails", async () => {
		const manager = SessionManager.inMemory();
		seed(manager);
		const summaryStream = vi.fn();
		const runtime = {
			supportsCompaction: vi.fn(() => true),
			compact: vi.fn().mockRejectedValue(new Error("native endpoint unavailable")),
			getModel: () => model,
		} as unknown as ModelRuntime;
		const agent = new Agent({
			streamFn: summaryStream as unknown as StreamFn,
			initialState: { model, messages: manager.buildSessionContext().messages },
			convertToLlm,
		});
		const session = new AgentSession({
			agent,
			sessionManager: manager,
			settingsManager: SettingsManager.inMemory({ compaction: { keepRecentTokens: 1 } }),
			cwd: process.cwd(),
			modelRuntime: runtime,
			resourceLoader: createTestResourceLoader(),
		});
		sessions.push(session);

		await expect(session.compact()).rejects.toThrow("native endpoint unavailable");
		expect(summaryStream).not.toHaveBeenCalled();
		expect(manager.getEntries().some((entry) => entry.type === "compaction")).toBe(false);
	});

	it("does not summarize Codex models without native capability", async () => {
		const manager = SessionManager.inMemory();
		seed(manager);
		const summaryStream = vi.fn(() => {
			throw new Error("Pi summary compaction must not run");
		});
		const compact = vi.fn();
		const runtime = {
			supportsCompaction: vi.fn(() => false),
			compact,
			getModel: () => model,
		} as unknown as ModelRuntime;
		const agent = new Agent({
			streamFn: summaryStream as unknown as StreamFn,
			initialState: { model, messages: manager.buildSessionContext().messages },
			convertToLlm,
		});
		const session = new AgentSession({
			agent,
			sessionManager: manager,
			settingsManager: SettingsManager.inMemory({ compaction: { keepRecentTokens: 1 } }),
			cwd: process.cwd(),
			modelRuntime: runtime,
			resourceLoader: createTestResourceLoader(),
		});
		sessions.push(session);

		await expect(session.compact()).rejects.toThrow(
			`Provider ${model.provider} does not support context compaction for ${model.id}`,
		);
		expect(compact).not.toHaveBeenCalled();
		expect(summaryStream).not.toHaveBeenCalled();
		expect(manager.getEntries().some((entry) => entry.type === "compaction")).toBe(false);
	});

	it("uses the same native-only path for automatic compaction", async () => {
		const manager = SessionManager.inMemory();
		seed(manager);
		const summaryStream = vi.fn(() => {
			throw new Error("Pi summary compaction must not run");
		});
		const compact = vi.fn(
			async (): Promise<ProviderCompactionResult> => ({
				history,
				responseId: "resp_auto_compact_1",
				usage,
			}),
		);
		const runtime = {
			supportsCompaction: vi.fn(() => true),
			compact,
			getModel: () => model,
		} as unknown as ModelRuntime;
		const agent = new Agent({
			streamFn: summaryStream as unknown as StreamFn,
			initialState: { model, messages: manager.buildSessionContext().messages },
			convertToLlm,
		});
		const session = new AgentSession({
			agent,
			sessionManager: manager,
			settingsManager: SettingsManager.inMemory({ compaction: { keepRecentTokens: 1 } }),
			cwd: process.cwd(),
			modelRuntime: runtime,
			resourceLoader: createTestResourceLoader(),
		});
		sessions.push(session);

		await (
			session as unknown as {
				_runAutoCompaction(reason: "threshold" | "overflow", willRetry: boolean): Promise<boolean>;
			}
		)._runAutoCompaction("threshold", false);

		expect(summaryStream).not.toHaveBeenCalled();
		expect(compact).toHaveBeenCalledOnce();
		expect(manager.buildSessionContext().messages).toEqual([history]);
	});

	it("restores opaque provider history from a persisted session", () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-native-compaction-"));
		try {
			const manager = SessionManager.create(process.cwd(), directory);
			const firstEntryId = seed(manager);
			manager.appendCompaction(
				"OpenAI native compaction",
				firstEntryId,
				100,
				{ type: "openai.responses.compaction", responseId: "resp_compact_1" },
				false,
				usage,
				[history],
			);
			const sessionFile = manager.getSessionFile();
			expect(sessionFile).toBeDefined();

			const reopened = SessionManager.open(sessionFile!);
			expect(reopened.buildSessionContext().messages).toEqual([history]);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("rejects model changes that cannot replay the active native history", async () => {
		const manager = SessionManager.inMemory();
		const firstEntryId = seed(manager);
		manager.appendCompaction("Provider native compaction", firstEntryId, 100, undefined, false, usage, [history]);
		const alternatives: Model<any>[] = [
			{ ...model, id: "another-model" },
			{ ...model, provider: "another-provider" },
			{ ...model, api: "another-api" },
		];
		const runtime = {
			checkAuth: vi.fn(async () => true),
			getAvailableSnapshot: () => [model, ...alternatives],
			getModel: () => model,
		} as unknown as ModelRuntime;
		const agent = new Agent({
			streamFn: vi.fn() as unknown as StreamFn,
			initialState: { model, messages: manager.buildSessionContext().messages },
			convertToLlm,
		});
		const session = new AgentSession({
			agent,
			sessionManager: manager,
			settingsManager: SettingsManager.inMemory(),
			cwd: process.cwd(),
			modelRuntime: runtime,
			resourceLoader: createTestResourceLoader(),
		});
		sessions.push(session);

		for (const alternative of alternatives) {
			const entryCount = manager.getEntries().length;
			await expect(session.setModel(alternative, { persist: true })).rejects.toThrow(
				"Native compaction history requires openai-codex/gpt-5.6-sol via openai-codex-responses",
			);
			expect(session.model).toBe(model);
			expect(manager.getEntries()).toHaveLength(entryCount);
			expect(session.settingsManager.getDefaultModel()).toBeUndefined();
		}
		await session.setModel({ ...model });
		const selectedModel = session.model;

		await expect(session.cycleModel()).rejects.toThrow("Native compaction history requires");
		expect(session.model).toBe(selectedModel);
		session.setScopedModels([{ model }, { model: alternatives[0] }]);
		await expect(session.cycleModel()).rejects.toThrow("Native compaction history requires");
		expect(session.model).toBe(selectedModel);
	});

	it("allows compatible model changes before native compaction and after leaving its branch", async () => {
		const manager = SessionManager.inMemory();
		const firstEntryId = seed(manager);
		const nextModel = { ...model, id: "another-model" };
		const runtime = {
			checkAuth: vi.fn(async () => true),
			getModel: () => model,
		} as unknown as ModelRuntime;
		const agent = new Agent({
			streamFn: vi.fn() as unknown as StreamFn,
			initialState: { model, messages: manager.buildSessionContext().messages },
			convertToLlm,
		});
		const session = new AgentSession({
			agent,
			sessionManager: manager,
			settingsManager: SettingsManager.inMemory(),
			cwd: process.cwd(),
			modelRuntime: runtime,
			resourceLoader: createTestResourceLoader(),
		});
		sessions.push(session);

		await session.setModel(nextModel);
		expect(session.model).toBe(nextModel);
		await session.setModel(model);
		manager.appendCompaction("Provider native compaction", firstEntryId, 100, undefined, false, usage, [history]);
		manager.branch(firstEntryId);
		await session.setModel(nextModel);
		expect(session.model).toBe(nextModel);
	});

	it("does not switch between Codex and other providers without native history", async () => {
		for (const [current, next] of [
			[model, portableModel],
			[portableModel, model],
		] as const) {
			const manager = SessionManager.inMemory();
			seed(manager, current);
			const runtime = { checkAuth: vi.fn(async () => true) } as unknown as ModelRuntime;
			const agent = new Agent({
				streamFn: vi.fn() as unknown as StreamFn,
				initialState: { model: current, messages: manager.buildSessionContext().messages },
				convertToLlm,
			});
			const session = new AgentSession({
				agent,
				sessionManager: manager,
				settingsManager: SettingsManager.inMemory(),
				cwd: process.cwd(),
				modelRuntime: runtime,
				resourceLoader: createTestResourceLoader(),
			});
			sessions.push(session);

			await expect(session.setModel(next)).rejects.toThrow(
				"Start a new session to switch between Codex and other providers",
			);
			expect(session.model).toBe(current);
		}
	});

	it("rejects an incompatible model when restoring active native history", () => {
		const manager = SessionManager.inMemory();
		const firstEntryId = seed(manager);
		manager.appendCompaction("Provider native compaction", firstEntryId, 100, undefined, false, usage, [history]);
		const otherModel = { ...model, id: "another-model" };
		const agent = new Agent({
			streamFn: vi.fn() as unknown as StreamFn,
			initialState: { model: otherModel, messages: manager.buildSessionContext().messages },
			convertToLlm,
		});

		expect(
			() =>
				new AgentSession({
					agent,
					sessionManager: manager,
					settingsManager: SettingsManager.inMemory(),
					cwd: process.cwd(),
					modelRuntime: { getModel: () => otherModel } as unknown as ModelRuntime,
					resourceLoader: createTestResourceLoader(),
				}),
		).toThrow("Native compaction history requires openai-codex/gpt-5.6-sol via openai-codex-responses");
	});
});

describe("OpenAI Codex model restriction", () => {
	it("filters the runtime without failing disabled extension provider registration", async () => {
		const runtime = await ModelRuntime.create({
			modelsPath: null,
			refreshOnCreate: false,
			allowedProviders: ["openai-codex"],
		});
		const openAICodex = runtime.getProvider("openai-codex");
		expect(openAICodex).toBeDefined();

		expect(runtime.getProviders().map((provider) => provider.id)).toEqual(["openai-codex"]);
		expect(runtime.getModels().every((candidate) => candidate.provider === "openai-codex")).toBe(true);
		expect(runtime.supportsCompaction(model)).toBe(true);
		expect(runtime.supportsCompaction(portableModel)).toBe(false);
		expect(() => runtime.registerProvider("anthropic", {})).not.toThrow();
		expect(() =>
			runtime.registerNativeProvider({ ...openAICodex!, id: "llama.cpp", name: "llama.cpp" }),
		).not.toThrow();
		expect(runtime.getProvider("anthropic")).toBeUndefined();
		expect(runtime.getProvider("llama.cpp")).toBeUndefined();
	});
});
