import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	type Model,
	type ProviderCompactionResult,
	streamSimple,
} from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionError, SessionBoundaryDraft } from "../../src/core/extensions/index.ts";
import { createHarness, type Harness, type HarnessOptions } from "./harness.ts";

const codexModelId = "gpt-6.1-sol";
const nativeUsage = fauxAssistantMessage("").usage;
const extensionError = "Extension compaction cannot replace provider-native compaction";

type NativeKind = "codex" | "unsupported-codex" | "custom-native";

function seedHistory(harness: Harness, model: Model<string>): AssistantMessage {
	harness.sessionManager.appendMessage({ role: "user", content: "remember this", timestamp: Date.now() - 2000 });
	const message = {
		...fauxAssistantMessage("remembered", { timestamp: Date.now() - 1000 }),
		api: model.api,
		provider: model.provider,
		model: model.id,
	};
	harness.sessionManager.appendMessage(message);
	harness.session.refreshContext();
	return message;
}

function useFauxStream(harness: Harness): void {
	harness.session.agent.streamFunction = (model, context, options) => {
		const output = createAssistantMessageEventStream();
		void (async () => {
			for await (const event of streamSimple(harness.getModel(), context, options)) {
				const identity = {
					api: model.api,
					provider: model.provider,
					model: model.id,
					thinkingLevel: options?.reasoning,
				};
				if (event.type === "done") output.push({ ...event, message: { ...event.message, ...identity } });
				else if (event.type === "error") output.push({ ...event, error: { ...event.error, ...identity } });
				else output.push({ ...event, partial: { ...event.partial, ...identity } });
			}
		})();
		return output;
	};
}

async function runAutoCompaction(harness: Harness): Promise<boolean> {
	return (
		harness.session as unknown as {
			_runAutoCompaction(reason: "threshold", willRetry: boolean): Promise<boolean>;
		}
	)._runAutoCompaction("threshold", false);
}

const nativeSelections = (["codex", "unsupported-codex", "custom-native"] as const).flatMap((kind) =>
	[false, true].map((virtual) => ({ kind, virtual })),
);

describe("native compaction regressions", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		vi.restoreAllMocks();
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});

	async function createNativeHarness(
		{
			kind = "codex",
			virtual = false,
			directToText = false,
		}: {
			kind?: NativeKind;
			virtual?: boolean;
			directToText?: boolean;
		} = {},
		options: HarnessOptions = {},
	) {
		const routes: string[] = [];
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			...options,
			extensionFactories: [
				...(options.extensionFactories ?? []),
				(pi) => {
					if (!virtual) return;
					pi.registerVirtualModel({
						provider: "router",
						id: "native",
						name: "Native router",
						contextWindow: 1000,
						route: (request, ctx) => {
							routes.push(request.reason);
							return {
								model:
									kind === "custom-native" || (directToText && request.reason === "direct")
										? ctx.modelRegistry.find("faux", "faux-1")!
										: ctx.modelRegistry.find("openai-codex", codexModelId)!,
								thinkingLevel: "low",
							};
						},
					});
				},
			],
		});
		harnesses.push(harness);
		const runtime = harness.session.modelRuntime;
		const physical = kind === "custom-native" ? harness.getModel() : runtime.getModel("openai-codex", codexModelId)!;
		expect(physical).toBeDefined();
		vi.spyOn(runtime, "hasConfiguredAuth").mockReturnValue(true);
		vi.spyOn(runtime, "checkAuth").mockResolvedValue({ type: "api_key" });
		vi.spyOn(runtime, "getAuth").mockResolvedValue({ auth: { apiKey: "faux-key" } });
		if (kind !== "codex") {
			vi.spyOn(runtime, "supportsCompaction").mockImplementation(
				(model) => kind === "custom-native" && model.provider === physical.provider && model.id === physical.id,
			);
		}
		if (virtual) await harness.session.setModel(runtime.getModel("router", "native")!);
		else harness.session.agent.state.model = physical;
		const compact = vi.spyOn(runtime, "compact").mockImplementation(
			async (selected): Promise<ProviderCompactionResult> => ({
				history: {
					role: "providerHistory",
					api: selected.api,
					provider: selected.provider,
					model: selected.id,
					items: [{ type: "compaction", encrypted_content: "native-state" }],
					timestamp: Date.now(),
				},
				responseId: "native-response",
				usage: nativeUsage,
			}),
		);
		harness.session.agent.streamFunction = () => {
			throw new Error("Text summarization must not run");
		};
		return { harness, physical, compact, routes };
	}

	describe.each(nativeSelections)("$kind (virtual=$virtual)", (selection) => {
		it.each(["manual", "automatic"] as const)(
			"rejects an extension result on the %s path before the first native compaction",
			async (trigger) => {
				const hook = vi.fn();
				const { harness, physical, compact } = await createNativeHarness(selection, {
					extensionFactories: [
						(pi) => {
							pi.on("session_before_compact", ({ preparation }) => {
								hook();
								return {
									compaction: {
										summary: "extension text summary",
										firstKeptEntryId: preparation.firstKeptEntryId,
										tokensBefore: preparation.tokensBefore,
									},
								};
							});
						},
					],
				});
				seedHistory(harness, physical);

				if (trigger === "manual") await expect(harness.session.compact()).rejects.toThrow(extensionError);
				else await runAutoCompaction(harness);

				expect(hook).toHaveBeenCalledOnce();
				expect(harness.eventsOfType("compaction_end")).toMatchObject([
					{ result: undefined, aborted: false, errorMessage: expect.stringContaining(extensionError) },
				]);
				expect(compact).not.toHaveBeenCalled();
				expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toEqual([]);
			},
		);

		it.each(["turn_end", "agent_before_settle"] as const)(
			"rejects a %s draft using the physical turn model",
			async (boundary) => {
				const hook = vi.fn();
				const { harness, compact, routes } = await createNativeHarness(
					{ ...selection, directToText: true },
					{
						settings: { compaction: { enabled: false, keepRecentTokens: 1 } },
						extensionFactories: [
							(pi) => {
								const draft = () => {
									hook();
									return {
										entries: [
											{ type: "compaction", summary: "boundary text summary", firstKeptEntryId: null },
										] satisfies SessionBoundaryDraft[],
									};
								};
								if (boundary === "turn_end") pi.on("turn_end", draft);
								else pi.on("agent_before_settle", draft);
							},
						],
					},
				);
				const errors: ExtensionError[] = [];
				harness.session.extensionRunner.onError((error) => errors.push(error));
				useFauxStream(harness);
				harness.setResponses([fauxAssistantMessage("first answer")]);

				await harness.session.prompt("first question");

				expect(hook).toHaveBeenCalledOnce();
				expect(errors).toMatchObject([{ event: boundary, error: `Invalid boundary entries: ${extensionError}` }]);
				expect(routes).toEqual(selection.virtual ? ["user"] : []);
				expect(compact).not.toHaveBeenCalled();
				expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toEqual([]);
			},
		);
	});

	it.each(["manual", "automatic"] as const)(
		"keeps notification and cancellation hooks on the %s routed native path",
		async (trigger) => {
			let cancel = true;
			const hook = vi.fn();
			const { harness, physical, compact } = await createNativeHarness(
				{ virtual: true },
				{
					extensionFactories: [
						(pi) => {
							pi.on("session_before_compact", () => {
								hook();
								return cancel ? { cancel: true } : undefined;
							});
						},
					],
				},
			);
			seedHistory(harness, physical);
			if (trigger === "manual") await expect(harness.session.compact()).rejects.toThrow("Compaction cancelled");
			else await runAutoCompaction(harness);
			expect(compact).not.toHaveBeenCalled();
			expect(harness.eventsOfType("compaction_end").at(-1)).toMatchObject({ aborted: true });

			cancel = false;
			if (trigger === "manual") await harness.session.compact();
			else await runAutoCompaction(harness);

			expect(hook).toHaveBeenCalledTimes(2);
			expect(compact).toHaveBeenCalledOnce();
			expect(harness.eventsOfType("compaction_end").at(-1)?.result?.replacementHistory?.[0]).toMatchObject({
				role: "providerHistory",
			});
		},
	);

	it.each(["manual", "automatic", "threshold", "overflow", "request"] as const)(
		"uses native compaction for virtual Codex on the %s path",
		async (trigger) => {
			const { harness, physical, compact, routes } = await createNativeHarness(
				{ virtual: true, directToText: trigger === "threshold" || trigger === "overflow" || trigger === "request" },
				{
					settings: { compaction: { keepRecentTokens: 1, reserveTokens: 20_000 } },
				},
			);
			const response = seedHistory(harness, physical);
			if (trigger === "manual") await harness.session.compact();
			else if (trigger === "automatic") await runAutoCompaction(harness);
			else if (trigger === "request") {
				useFauxStream(harness);
				harness.setResponses([fauxAssistantMessage("answer")]);
				await harness.session.prompt("x".repeat(physical.contextWindow * 4));
			} else {
				response.usage = { ...nativeUsage, input: physical.contextWindow - 10_000 };
				response.thinkingLevel = "low";
				if (trigger === "overflow") {
					response.stopReason = "error";
					response.errorMessage = "context length exceeded";
				}
				await (
					harness.session as unknown as {
						_checkCompaction(message: AssistantMessage): Promise<boolean>;
					}
				)._checkCompaction(response);
			}

			expect(compact).toHaveBeenCalledOnce();
			expect(compact.mock.calls[0]?.[0]).toMatchObject({ provider: physical.provider, id: physical.id });
			expect(compact.mock.calls[0]?.[2]).toMatchObject({ reasoning: "low" });
			expect(routes).toEqual(
				trigger === "manual" || trigger === "automatic" ? ["direct"] : trigger === "request" ? ["user"] : [],
			);
			expect(harness.sessionManager.getEntries().find((entry) => entry.type === "compaction")).toMatchObject({
				type: "compaction",
				replacementHistory: [{ role: "providerHistory", provider: physical.provider, model: physical.id }],
			});
		},
	);
});
