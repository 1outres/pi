import { describe, expect, it, vi } from "vitest";
import { compact } from "../src/api/openai-codex-responses.ts";
import { convertResponsesMessages } from "../src/api/openai-responses-shared.ts";
import type { Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const model: Model<"openai-codex-responses"> = {
	id: "gpt-5.6-sol",
	name: "GPT-5.6 Sol",
	api: "openai-codex-responses",
	provider: "openai-codex",
	baseUrl: "https://chatgpt.com/backend-api",
	reasoning: true,
	input: ["text"],
	cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 },
	contextWindow: 1_050_000,
	maxTokens: 128_000,
};

function token(accountId = "account-1"): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } }),
	).toString("base64");
	return `header.${payload}.signature`;
}

function sse(events: unknown[]): Response {
	return new Response(`${events.map((event) => `data: ${JSON.stringify(event)}`).join("\n\n")}\n\n`, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

describe("OpenAI Codex native compaction", () => {
	it("returns opaque provider history for replay", async () => {
		const compactedItem = { type: "compaction", id: "cmp_1", encrypted_content: "opaque-state" };
		const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
			const headers = new Headers(init?.headers);
			expect(headers.get("x-codex-beta-features")).toContain("remote_compaction_v2");
			expect(headers.get("authorization")).toBe(`Bearer ${token()}`);
			const body = JSON.parse(String(init?.body)) as { input: Array<Record<string, unknown>> };
			expect(body.input.at(-1)).toEqual({ type: "compaction_trigger" });
			expect(body.input.filter((item) => item.type === "compaction_trigger")).toHaveLength(1);
			return sse([
				{ type: "response.output_item.done", item: compactedItem },
				{
					type: "response.completed",
					response: {
						id: "resp_compact_1",
						created_at: 1_700_000_000,
						usage: {
							input_tokens: 12,
							output_tokens: 3,
							total_tokens: 15,
							input_tokens_details: { cached_tokens: 2 },
							output_tokens_details: { reasoning_tokens: 1 },
						},
					},
				},
			]);
		});
		const context = normalizeContext({
			systemPrompt: "system",
			messages: [
				{ role: "user", content: "remember this", timestamp: 1 },
				{
					role: "assistant",
					content: [{ type: "text", text: "remembered" }],
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
					timestamp: 2,
				},
			],
		});

		const result = await compact(model, context, {
			apiKey: token(),
			reasoning: "xhigh",
			sessionId: "session-1",
			fetch: fetchMock,
		});

		expect(fetchMock).toHaveBeenCalledOnce();
		expect(result).toMatchObject({
			responseId: "resp_compact_1",
			history: {
				role: "providerHistory",
				api: model.api,
				provider: model.provider,
				model: model.id,
				items: [expect.objectContaining({ role: "user" }), compactedItem],
				timestamp: 1_700_000_000_000,
			},
			usage: { input: 10, output: 3, cacheRead: 2, reasoning: 1, totalTokens: 15 },
		});
		const replay = convertResponsesMessages(
			model,
			normalizeContext({ messages: [result.history] }),
			new Set(["openai-codex"]),
			{ includeSystemPrompt: false },
		);
		expect(replay).toEqual(result.history.items);
	});

	it("rejects a response without one valid compaction item", async () => {
		const context = normalizeContext({ messages: [{ role: "user", content: "hello", timestamp: 1 }] });
		const fetchMock = vi.fn(async () =>
			sse([
				{
					type: "response.completed",
					response: {
						id: "resp_invalid",
						usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 },
					},
				},
			]),
		);

		await expect(compact(model, context, { apiKey: token(), fetch: fetchMock })).rejects.toThrow(
			"exactly one valid compaction item",
		);
	});
});
