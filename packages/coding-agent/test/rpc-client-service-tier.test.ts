import { describe, expect, it, vi } from "vitest";
import { RpcClient } from "../src/modes/rpc/rpc-client.ts";

type RpcClientPrivate = {
	send: (command: { type: string }) => Promise<unknown>;
};

function createClient(response: unknown) {
	const client = new RpcClient();
	const send = vi.fn(async () => response);
	(client as unknown as RpcClientPrivate).send = send;
	return { client, send };
}

describe("RpcClient service tier", () => {
	it.each(["priority", null] as const)("sends set_service_tier with %s", async (serviceTier) => {
		const { client, send } = createClient({ type: "response", command: "set_service_tier", success: true });

		await client.setServiceTier(serviceTier);

		expect(send).toHaveBeenCalledWith({ type: "set_service_tier", serviceTier });
	});

	it("rejects with the error of a failed response", async () => {
		const { client } = createClient({
			type: "response",
			command: "set_service_tier",
			success: false,
			error: "Service tiers are not supported by anthropic/claude-sonnet-4-5",
		});

		await expect(client.setServiceTier("priority")).rejects.toThrow(
			"Service tiers are not supported by anthropic/claude-sonnet-4-5",
		);
	});
});
