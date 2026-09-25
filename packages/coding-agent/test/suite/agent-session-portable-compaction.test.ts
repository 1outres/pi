import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

function seedHistory(harness: Harness): void {
	const model = harness.getModel();
	for (const label of ["old", "recent"]) {
		harness.sessionManager.appendMessage({
			role: "user",
			content: label.padEnd(400, "x"),
			timestamp: Date.now() - 2000,
		});
		const assistant = fauxAssistantMessage(label.padEnd(400, "y"), { timestamp: Date.now() - 1000 });
		harness.sessionManager.appendMessage({
			...assistant,
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: { ...assistant.usage, input: 2500, totalTokens: 2500 },
		});
	}
	harness.session.refreshContext();
}

describe("portable compaction", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		vi.restoreAllMocks();
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("uses text summarization for manual compaction without native support", async () => {
		const harness = await createHarness({
			models: [
				{ id: "faux-1", contextWindow: 4000 },
				{ id: "faux-2", contextWindow: 4000 },
			],
			settings: { compaction: { keepRecentTokens: 150 } },
			tools: [],
		});
		harnesses.push(harness);
		seedHistory(harness);
		const nativeCompact = vi.spyOn(harness.session.modelRuntime, "compact");
		harness.setResponses([fauxAssistantMessage("portable summary")]);

		const result = await harness.session.compact("focus on the user's request");

		expect(result.summary).toContain("portable summary");
		expect(result.replacementHistory).toBeUndefined();
		expect(nativeCompact).not.toHaveBeenCalled();
		expect(harness.sessionManager.getBranch().at(-1)).toMatchObject({
			type: "compaction",
			summary: result.summary,
		});
		expect(
			harness.sessionManager.buildSessionContext().messages.some((message) => message.role === "compactionSummary"),
		).toBe(true);
		await harness.session.setModel(harness.getModel("faux-2")!);
		expect(harness.session.model?.id).toBe("faux-2");
	});

	it("uses text summarization before a prompt when the context is large", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 4000 }],
			settings: { compaction: { reserveTokens: 2000, keepRecentTokens: 150 } },
			tools: [],
		});
		harnesses.push(harness);
		seedHistory(harness);
		const nativeCompact = vi.spyOn(harness.session.modelRuntime, "compact");
		harness.setResponses([fauxAssistantMessage("automatic summary"), fauxAssistantMessage("continued")]);

		await harness.session.prompt("continue");

		expect(harness.eventsOfType("compaction_end")).toMatchObject([
			{ reason: "threshold", aborted: false, result: { summary: "automatic summary" } },
		]);
		expect(nativeCompact).not.toHaveBeenCalled();
		expect(harness.getPendingResponseCount()).toBe(0);
	});
});
