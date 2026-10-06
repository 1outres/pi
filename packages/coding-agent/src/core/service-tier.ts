import {
	type Api,
	getSupportedServiceTiers,
	isServiceTier,
	type Model,
	SERVICE_TIERS,
	type ServiceTier,
} from "@earendil-works/pi-ai";
import { formatNoModelSelectedMessage } from "./auth-guidance.ts";

export function formatInvalidServiceTierMessage(value: string): string {
	return `Invalid service tier "${value}". Valid values: ${SERVICE_TIERS.join(", ")}`;
}

export function modelOffersServiceTier(model: Model<Api> | undefined, tier: ServiceTier): boolean {
	return model !== undefined && getSupportedServiceTiers(model).includes(tier);
}

/**
 * Throw unless `tier` is a service tier that requests to `model` can carry.
 * Callers that receive untyped input (RPC, extensions) rely on the value check.
 */
export function assertServiceTierSupported(model: Model<Api> | undefined, tier: ServiceTier): void {
	if (!isServiceTier(tier)) {
		throw new Error(formatInvalidServiceTierMessage(String(tier)));
	}
	if (!model) {
		throw new Error(formatNoModelSelectedMessage());
	}
	const supported = getSupportedServiceTiers(model);
	if (supported.length === 0) {
		throw new Error(`Service tiers are not supported by ${model.provider}/${model.id}`);
	}
	if (!supported.includes(tier)) {
		throw new Error(
			`Service tier "${tier}" is not supported by ${model.provider}/${model.id}. Supported tiers: ${supported.join(", ")}`,
		);
	}
}
