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

function seed(manager: SessionManager): string {
	const firstEntryId = manager.appendMessage({ role: "user", content: "remember this", timestamp: 1 });
	manager.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "remembered" }],
		api: model.api,
		provider: model.provider,
		model: model.id,
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
			summary: "OpenAI native compaction",
			replacementHistory: [history],
			details: {
				type: "openai.responses.compaction",
				provider: model.provider,
				model: model.id,
				responseId: "resp_compact_1",
			},
		});
	});

	it("does not save a summary when native compaction fails", async () => {
		const manager = SessionManager.inMemory();
		seed(manager);
		const runtime = {
			compact: vi.fn().mockRejectedValue(new Error("native endpoint unavailable")),
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
			settingsManager: SettingsManager.inMemory({ compaction: { keepRecentTokens: 1 } }),
			cwd: process.cwd(),
			modelRuntime: runtime,
			resourceLoader: createTestResourceLoader(),
		});
		sessions.push(session);

		await expect(session.compact()).rejects.toThrow("native endpoint unavailable");
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
		const runtime = { compact, getModel: () => model } as unknown as ModelRuntime;
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
});

describe("OpenAI Codex model restriction", () => {
	it("filters the runtime and rejects provider registration outside the allowlist", async () => {
		const runtime = await ModelRuntime.create({
			modelsPath: null,
			refreshOnCreate: false,
			allowedProviders: ["openai-codex"],
		});

		expect(runtime.getProviders().map((provider) => provider.id)).toEqual(["openai-codex"]);
		expect(runtime.getModels().every((candidate) => candidate.provider === "openai-codex")).toBe(true);
		expect(() => runtime.registerProvider("anthropic", {})).toThrow("Provider anthropic is disabled");
	});
});
