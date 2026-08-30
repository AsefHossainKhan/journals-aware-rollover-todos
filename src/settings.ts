/** Where to place rolled-over todos when the target heading is not found. */
export type HeadingFallback = "bottom" | "top" | "skip";

export interface JournalRolloverSettings {
	/**
	 * Comma-separated Journals journal names to act on (matched against the
	 * `journal` frontmatter field). Empty = act on any note that carries a
	 * `journal-date` frontmatter value.
	 */
	enabledJournals: string;

	/** Roll over automatically when the Journals plugin creates a new note. */
	autoRolloverOnCreate: boolean;

	/** After copying todos forward, delete them from the previous note. */
	deleteFromPrevious: boolean;

	/** Carry indented child lines beneath an unfinished todo. */
	rolloverChildren: boolean;

	/** Skip bare `- [ ]` todos with no text. */
	removeEmptyTodos: boolean;

	/** Characters inside `[ ]` that count as done, e.g. "xX-". */
	doneStatusMarkers: string;

	/**
	 * Regular expression (matched case-insensitively against a whole heading
	 * line) that identifies the heading to insert todos beneath. Default matches
	 * headings ending in "TODOS", e.g. `## FRIDAY TODOS`.
	 */
	headingPattern: string;

	/** Where to insert when no heading matches `headingPattern`. */
	headingFallback: HeadingFallback;

	/** Do not insert a todo whose exact trimmed text is already in the new note. */
	skipDuplicates: boolean;

	/** Show a notice summarising each rollover. */
	showNotice: boolean;
}

export const DEFAULT_SETTINGS: JournalRolloverSettings = {
	enabledJournals: "",
	autoRolloverOnCreate: true,
	deleteFromPrevious: false,
	rolloverChildren: true,
	removeEmptyTodos: true,
	doneStatusMarkers: "xX-",
	headingPattern: "^#{1,6}\\s+.*TODOS\\s*$",
	headingFallback: "bottom",
	skipDuplicates: true,
	showNotice: true,
};

/** Parse the comma-separated journal list into a trimmed, non-empty array. */
export function parseEnabledJournals(value: string): string[] {
	return value
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
}
