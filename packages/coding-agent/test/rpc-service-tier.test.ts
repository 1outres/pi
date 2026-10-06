import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import { type Api, getModel, type Model } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { runRpcMode } from "../src/modes/rpc/rpc-mode.ts";
import { createInMemoryModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";
import { createTestResourceLoader } from "./utilities.ts";

const rpcIo = vi.hoisted(() => ({
	outputLines: [] as string[],
	lineHandler: undefined as ((line: string) => void) | undefined,
}));

vi.mock("../src/core/output-guard.js", () => ({
	flushRawStdout: vi.fn(async () => {}),
	takeOverStdout: vi.fn(),
	waitForRawStdoutBackpressure: vi.fn(async () => {}),
	writeRawStdout: (line: string) => {
		rpcIo.outputLines.push(line);
	},
}));

vi.mock("../src/modes/interactive/theme/theme.js", () => ({ theme: {} }));

vi.mock("../src/modes/rpc/jsonl.js", () => ({
	attachJsonlLineReader: vi.fn((_stream: NodeJS.ReadableStream, onLine: (line: string) => void) => {
		rpcIo.lineHandler = onLine;
		return () => {};
	}),
	serializeJsonLine: (value: unknown) => `${JSON.stringify(value)}\n`,
}));

type OutputRecord = Record<string, unknown>;

function outputRecords(): OutputRecord[] {
	return rpcIo.outputLines
		.flatMap((line) => line.split("\n"))
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as OutputRecord);
}

function responseFor(id: string): OutputRecord | undefined {
	return outputRecords().find((record) => record.type === "response" && record.id === id);
}

async function startRpcMode(model: Model<Api>): Promise<{
	send: (command: Record<string, unknown>) => Promise<OutputRecord>;
	cleanup: () => void;
}> {
	rpcIo.outputLines = [];
	rpcIo.lineHandler = undefined;
	const tempDir = join(tmpdir(), `pi-rpc-service-tier-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(tempDir, { recursive: true });

	const agent = new Agent({
		initialState: { model, systemPrompt: "Test", tools: [] },
		streamFn: () => {
			throw new Error("Unexpected provider request");
		},
	});
	const session = new AgentSession({
		agent,
		sessionManager: SessionManager.inMemory(),
		settingsManager: SettingsManager.create(tempDir, tempDir),
		cwd: tempDir,
		modelRuntime: getModelRuntime(await createInMemoryModelRegistry(AuthStorage.create(join(tempDir, "auth.json")))),
		resourceLoader: createTestResourceLoader(),
	});
	const runtimeHost = {
		session,
		newSession: vi.fn(async () => ({ cancelled: true })),
		switchSession: vi.fn(async () => ({ cancelled: true })),
		fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
		dispose: vi.fn(async () => {}),
		setRebindSession: vi.fn(),
	} as unknown as AgentSessionRuntime;

	void runRpcMode(runtimeHost);
	await vi.waitFor(() => expect(rpcIo.lineHandler).toBeDefined());
	const lineHandler = rpcIo.lineHandler!;

	return {
		send: async (command) => {
			lineHandler(JSON.stringify(command));
			let response: OutputRecord | undefined;
			await vi.waitFor(() => {
				response = responseFor(String(command.id));
				expect(response).toBeDefined();
			});
			return response!;
		},
		cleanup: () => {
			session.dispose();
			if (existsSync(tempDir)) rmSync(tempDir, { recursive: true });
		},
	};
}

describe("RPC service tier", () => {
	afterEach(() => {
		rpcIo.outputLines = [];
		rpcIo.lineHandler = undefined;
	});

	it("sets, reports, and clears the service tier", async () => {
		const rpc = await startRpcMode(getModel("openai-codex", "gpt-5.5"));
		try {
			expect(await rpc.send({ id: "initial", type: "get_state" })).toMatchObject({
				success: true,
				data: { serviceTier: null },
			});

			expect(await rpc.send({ id: "set", type: "set_service_tier", serviceTier: "priority" })).toEqual({
				id: "set",
				type: "response",
				command: "set_service_tier",
				success: true,
			});
			expect(outputRecords()).toContainEqual({ type: "service_tier_changed", serviceTier: "priority" });
			expect(await rpc.send({ id: "priority", type: "get_state" })).toMatchObject({
				data: { serviceTier: "priority" },
			});

			expect(await rpc.send({ id: "clear", type: "set_service_tier", serviceTier: null })).toEqual({
				id: "clear",
				type: "response",
				command: "set_service_tier",
				success: true,
			});
			expect(await rpc.send({ id: "cleared", type: "get_state" })).toMatchObject({
				data: { serviceTier: null },
			});
		} finally {
			rpc.cleanup();
		}
	});

	it("fails when the current model does not support service tiers", async () => {
		const rpc = await startRpcMode(getModel("anthropic", "claude-sonnet-4-5"));
		try {
			expect(await rpc.send({ id: "set", type: "set_service_tier", serviceTier: "priority" })).toEqual({
				id: "set",
				type: "response",
				command: "set_service_tier",
				success: false,
				error: "Service tiers are not supported by anthropic/claude-sonnet-4-5",
			});
			expect(await rpc.send({ id: "state", type: "get_state" })).toMatchObject({
				data: { serviceTier: null },
			});
		} finally {
			rpc.cleanup();
		}
	});

	it.each([
		[{}, "set_service_tier requires serviceTier: a service tier or null"],
		[{ serviceTier: "fast" }, 'Invalid service tier "fast". Valid values: auto, default, flex, scale, priority'],
	])("rejects the request %j", async (fields, error) => {
		const rpc = await startRpcMode(getModel("openai-codex", "gpt-5.5"));
		try {
			expect(await rpc.send({ id: "set", type: "set_service_tier", ...fields })).toEqual({
				id: "set",
				type: "response",
				command: "set_service_tier",
				success: false,
				error,
			});
		} finally {
			rpc.cleanup();
		}
	});
});
