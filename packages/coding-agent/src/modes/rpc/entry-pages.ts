import type { SessionEntry } from "../../core/session-manager.ts";

export interface SessionEntryPage {
	entries: SessionEntry[];
	hasMore: boolean;
}

/**
 * Take entries from the front while their total JSON size stays within `maxBytes`.
 * Without `maxBytes`, every entry is returned in one page.
 */
export function takeEntryPage(entries: SessionEntry[], maxBytes: number | undefined): SessionEntryPage {
	if (maxBytes === undefined) return { entries, hasMore: false };
	if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
		throw new Error("maxBytes must be a positive integer");
	}
	let size = 0;
	for (const [index, entry] of entries.entries()) {
		size += Buffer.byteLength(JSON.stringify(entry));
		if (size > maxBytes) {
			if (index === 0) throw new Error(`Entry ${entry.id} is larger than maxBytes`);
			return { entries: entries.slice(0, index), hasMore: true };
		}
	}
	return { entries, hasMore: false };
}
