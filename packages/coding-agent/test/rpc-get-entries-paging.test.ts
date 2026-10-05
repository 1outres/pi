import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import type { SessionEntry } from "../src/core/session-manager.ts";
import { runRpcMode } from "../src/modes/rpc/rpc-mode.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

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
		return () => {
			rpcIo.lineHandler = undefined;
		};
	}),
	serializeJsonLine: (value: unknown) => `${JSON.stringify(value)}\n`,
}));

type NodeListener = Parameters<typeof process.on>[1];

interface ListenerSnapshot {
	stdinEnd: NodeListener[];
	signals: Map<NodeJS.Signals, NodeListener[]>;
}

interface Response {
	id: string;
	success: boolean;
	error?: string;
	data?: { entries: SessionEntry[]; leafId: string | null; hasMore: boolean };
}

function takeListenerSnapshot(): ListenerSnapshot {
	const signals: NodeJS.Signals[] = process.platform === "win32" ? ["SIGTERM"] : ["SIGTERM", "SIGHUP"];
	return {
		stdinEnd: process.stdin.listeners("end") as NodeListener[],
		signals: new Map(signals.map((signal) => [signal, process.listeners(signal) as NodeListener[]])),
	};
}

function restoreListeners(snapshot: ListenerSnapshot): void {
	for (const listener of process.stdin.listeners("end") as NodeListener[]) {
		if (!snapshot.stdinEnd.includes(listener)) process.stdin.off("end", listener);
	}
	for (const [signal, previousListeners] of snapshot.signals) {
		for (const listener of process.listeners(signal) as NodeListener[]) {
			if (!previousListeners.includes(listener)) process.off(signal, listener);
		}
	}
}

function createRuntimeHost(harness: Harness): AgentSessionRuntime {
	return {
		session: harness.session,
		newSession: vi.fn(async () => ({ cancelled: true })),
		switchSession: vi.fn(async () => ({ cancelled: true })),
		fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
		dispose: vi.fn(async () => {}),
		setRebindSession: vi.fn(),
	} as unknown as AgentSessionRuntime;
}

function serializedSize(entries: SessionEntry[]): number {
	return entries.reduce((size, entry) => size + Buffer.byteLength(JSON.stringify(entry)), 0);
}

describe("RPC get_entries paging", () => {
	let harness: Harness;
	let listenerSnapshot: ListenerSnapshot;
	let sequence = 0;

	const request = async (fields: Record<string, unknown>): Promise<Response> => {
		const id = `request-${++sequence}`;
		rpcIo.lineHandler?.(JSON.stringify({ ...fields, id, type: "get_entries" }));
		return vi.waitFor(() => {
			const response = rpcIo.outputLines
				.flatMap((line) => line.split("\n"))
				.filter((line) => line.trim().length > 0)
				.map((line) => JSON.parse(line) as Response)
				.find((line) => line.id === id);
			if (!response) throw new Error(`No response for ${id}`);
			return response;
		});
	};

	beforeEach(async () => {
		listenerSnapshot = takeListenerSnapshot();
		harness = await createHarness();
		for (let index = 0; index < 6; index++) {
			harness.sessionManager.appendMessage({
				role: "user",
				content: `message ${index} ${"x".repeat(200)}`,
				timestamp: index,
			});
		}
		void runRpcMode(createRuntimeHost(harness));
		await vi.waitFor(() => expect(rpcIo.lineHandler).toBeDefined());
	});

	afterEach(() => {
		harness.cleanup();
		restoreListeners(listenerSnapshot);
		rpcIo.outputLines = [];
		rpcIo.lineHandler = undefined;
	});

	test("returns every entry without hasMore when maxBytes is not set", async () => {
		const response = await request({});

		expect(response.success).toBe(true);
		expect(response.data?.entries.map((entry) => entry.id)).toEqual(
			harness.sessionManager.getEntries().map((entry) => entry.id),
		);
		expect(response.data?.hasMore).toBe(false);
	});

	test("pages entries in append order within maxBytes", async () => {
		const all = harness.sessionManager.getEntries();
		const maxBytes = serializedSize(all.slice(0, 2)) + 10;
		const pages: SessionEntry[][] = [];
		let since: string | undefined;
		let hasMore = true;
		while (hasMore) {
			const response = await request({ since, maxBytes });
			expect(response.success).toBe(true);
			const data = response.data!;
			expect(data.leafId).toBe(harness.sessionManager.getLeafId());
			expect(serializedSize(data.entries)).toBeLessThanOrEqual(maxBytes);
			pages.push(data.entries);
			since = data.entries.at(-1)?.id;
			hasMore = data.hasMore;
		}

		expect(pages.map((page) => page.length)).toEqual([2, 2, 2]);
		expect(pages.flat().map((entry) => entry.id)).toEqual(all.map((entry) => entry.id));
	});

	test("returns an empty last page after the final entry", async () => {
		const leafId = harness.sessionManager.getLeafId();
		const response = await request({ since: leafId, maxBytes: 1024 });

		expect(response.success).toBe(true);
		expect(response.data?.entries).toEqual([]);
		expect(response.data?.hasMore).toBe(false);
	});

	test("rejects an entry larger than maxBytes", async () => {
		const [first] = harness.sessionManager.getEntries();
		const response = await request({ maxBytes: Buffer.byteLength(JSON.stringify(first)) - 1 });

		expect(response.success).toBe(false);
		expect(response.error).toBe(`Entry ${first.id} is larger than maxBytes`);
	});

	test.each([0, -1, 1.5, "1024"])("rejects maxBytes %j", async (maxBytes) => {
		const response = await request({ maxBytes });

		expect(response.success).toBe(false);
		expect(response.error).toBe("maxBytes must be a positive integer");
	});
});
