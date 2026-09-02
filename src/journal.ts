import { App, TFile, moment } from "obsidian";

/**
 * Minimal typed surface of the moment object this module uses. Declaring it
 * locally keeps the module type-safe even under strict type-aware linting that
 * resolves Obsidian's `moment` re-export to `any` (moment is a transitive
 * dependency, so its own types aren't always seen).
 */
interface Moment {
	isValid(): boolean;
	startOf(unit: "day"): Moment;
	isBefore(other: Moment, granularity: "day"): boolean;
	isAfter(other: Moment): boolean;
	format(fmt: string): string;
}

interface MomentFactory {
	(input?: string | number | Date, format?: string | string[], strict?: boolean): Moment;
	ISO_8601: string;
}

/** The moment factory, narrowed once to the typed surface above. */
const M = moment as unknown as MomentFactory;

/** Identity of a Journals note, derived from its frontmatter. */
export interface JournalInfo {
	/** The `journal` frontmatter value, e.g. "DailyNote" (may be empty). */
	journal: string;
	/** The `journal-date` value as a moment (start of day). */
	date: Moment;
	/** The raw `journal-date` string, e.g. "2026-08-28". */
	dateString: string;
}

const DATE_FORMATS: string[] = ["YYYY-MM-DD", M.ISO_8601];

/**
 * Coerce a frontmatter `journal-date` value (string, or a Date that Obsidian's
 * YAML parser produced from a bare date) into a valid moment, or null.
 */
function toMoment(value: unknown): Moment | null {
	if (value == null) return null;
	if (value instanceof Date) {
		const m = M(value);
		return m.isValid() ? m.startOf("day") : null;
	}
	const m = M(String(value), DATE_FORMATS, true);
	return m.isValid() ? m.startOf("day") : null;
}

/** Read frontmatter from a `---` fenced block at the very top of raw content. */
export function readFrontmatterRaw(content: string): Record<string, string> {
	const out: Record<string, string> = {};
	const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
	if (!match) return out;
	for (const line of match[1].split(/\r?\n/)) {
		const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
		if (kv) {
			// Strip surrounding quotes if present.
			out[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, "");
		}
	}
	return out;
}

/** Build JournalInfo from an already-parsed frontmatter record. */
export function journalInfoFromFrontmatter(
	fm: Record<string, unknown> | undefined | null
): JournalInfo | null {
	if (!fm) return null;
	const date = toMoment(fm["journal-date"]);
	if (!date) return null;
	const journal = fm["journal"] != null ? String(fm["journal"]) : "";
	return { journal, date, dateString: date.format("YYYY-MM-DD") };
}

/**
 * Resolve a file's JournalInfo. Prefers freshly-read raw content (reliable for a
 * just-created note whose metadata cache may lag); falls back to the cache.
 */
export async function getJournalInfo(app: App, file: TFile): Promise<JournalInfo | null> {
	try {
		const content = await app.vault.read(file);
		const fm = readFrontmatterRaw(content);
		const info = journalInfoFromFrontmatter(fm);
		if (info) return info;
	} catch {
		/* fall through to cache */
	}
	const cached = app.metadataCache.getFileCache(file)?.frontmatter;
	return journalInfoFromFrontmatter(cached);
}

/**
 * Find the most recent journal note strictly before `info.date` in the same
 * journal, using the metadata cache (fast; already indexed for existing notes).
 */
export function findPreviousJournalNote(
	app: App,
	currentFile: TFile,
	info: JournalInfo,
	allowedJournals: string[]
): TFile | null {
	let best: TFile | null = null;
	let bestDate: Moment | null = null;

	for (const file of app.vault.getMarkdownFiles()) {
		if (file.path === currentFile.path) continue;

		const fm = app.metadataCache.getFileCache(file)?.frontmatter;
		const candidate = journalInfoFromFrontmatter(fm);
		if (!candidate) continue;

		// Same journal as the note we're rolling into.
		if (info.journal && candidate.journal !== info.journal) continue;
		// Respect an explicit allow-list if the user set one.
		if (allowedJournals.length > 0 && !allowedJournals.includes(candidate.journal)) continue;

		if (!candidate.date.isBefore(info.date, "day")) continue;

		if (!bestDate || candidate.date.isAfter(bestDate)) {
			bestDate = candidate.date;
			best = file;
		}
	}

	return best;
}
