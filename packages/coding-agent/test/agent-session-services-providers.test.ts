import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createAgentSessionServices } from "../src/core/agent-session-services.ts";

it("makes non-Codex providers available in the default session services", async () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-provider-services-"));
	try {
		const services = await createAgentSessionServices({ cwd: directory, agentDir: directory });
		const providerIds = services.modelRuntime.getProviders().map((provider) => provider.id);
		expect(providerIds).toContain("openai-codex");
		expect(providerIds).toContain("anthropic");
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
