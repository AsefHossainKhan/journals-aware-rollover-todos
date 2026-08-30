/**
 * Todo extraction.
 *
 * The checkbox / children / done-marker semantics here intentionally mirror the
 * original "Rollover Daily Todos" plugin so behaviour is familiar to users
 * migrating from it, while the surrounding plugin is rewritten to be
 * Journals-aware.
 */

export interface TodoParseOptions {
	/** Also carry indented child lines beneath an unfinished todo. */
	withChildren: boolean;
	/** Characters inside `[ ]` that mark a todo as done, e.g. "xX-". */
	doneStatusMarkers: string;
	/** Drop todos that have no text (bare `- [ ]`). */
	removeEmptyTodos: boolean;
}

const BULLET_SYMBOLS = ["-", "*", "+"];

/** Segment a string into grapheme clusters so a single emoji counts as one char. */
function parseIntoChars(content: string): string[] {
	const SegmenterCtor = (Intl as unknown as { Segmenter?: unknown }).Segmenter as
		| (new (locale: string, options: { granularity: string }) => {
				segment(input: string): Iterable<{ segment: string }>;
		  })
		| undefined;
	if (typeof Intl !== "undefined" && SegmenterCtor) {
		const segmenter = new SegmenterCtor("en", { granularity: "grapheme" });
		return Array.from(segmenter.segment(content), (s) => s.segment);
	}
	return Array.from(content);
}

class TodoParser {
	private lines: string[];
	private withChildren: boolean;
	private doneStatusMarkers: string[];

	constructor(lines: string[], withChildren: boolean, doneStatusMarkers: string) {
		this.lines = lines;
		this.withChildren = withChildren;
		this.doneStatusMarkers = doneStatusMarkers
			? parseIntoChars(doneStatusMarkers)
			: ["x", "X", "-"];
	}

	/** A line is an (unfinished) todo when it is a checkbox whose single-grapheme marker is not a done marker. */
	private isTodo(s: string): boolean {
		const bulletClass = BULLET_SYMBOLS.map((b) => "\\" + b).join("");
		const match = s.match(new RegExp(`\\s*[${bulletClass}] \\[(.+?)\\]`));
		if (!match) return false;

		const checkboxContent = match[1];
		const contentChars = parseIntoChars(checkboxContent);

		// Valid checkbox content must be exactly one grapheme cluster.
		if (contentChars.length !== 1) return false;

		// Exclude zero-width / direction modifiers that are not valid standalone content.
		const graphemeModifiers = ["‮", "​", "‌", "‍"];
		if (contentChars.some((c) => graphemeModifiers.includes(c))) return false;

		// It's an unfinished todo only if the marker is NOT a done marker.
		const hasDoneMarker = contentChars.some((c) => this.doneStatusMarkers.includes(c));
		return !hasDoneMarker;
	}

	private getIndentation(l: number): number {
		return this.lines[l].search(/\S/);
	}

	private isChildOf(parentLinum: number, linum: number): boolean {
		if (parentLinum >= this.lines.length || linum >= this.lines.length) return false;
		return this.getIndentation(linum) > this.getIndentation(parentLinum);
	}

	private hasChildren(l: number): boolean {
		if (l + 1 >= this.lines.length) return false;
		return this.getIndentation(l + 1) > this.getIndentation(l);
	}

	private getChildren(parentLinum: number): string[] {
		const children: string[] = [];
		let next = parentLinum + 1;
		while (this.isChildOf(parentLinum, next)) {
			children.push(this.lines[next]);
			next++;
		}
		return children;
	}

	getTodos(): string[] {
		let todos: string[] = [];
		for (let l = 0; l < this.lines.length; l++) {
			const line = this.lines[l];
			if (this.isTodo(line)) {
				todos.push(line);
				if (this.withChildren && this.hasChildren(l)) {
					const cs = this.getChildren(l);
					todos = [...todos, ...cs];
					l += cs.length;
				}
			}
		}
		return todos;
	}
}

/**
 * Extract the unfinished todos (optionally with children) from note content.
 * Returns the raw lines, preserving indentation, in document order.
 */
export function getUnfinishedTodos(content: string, options: TodoParseOptions): string[] {
	const lines = content.split(/\r?\n|\r|\n/g);
	const parser = new TodoParser(lines, options.withChildren, options.doneStatusMarkers);
	let todos = parser.getTodos();

	if (options.removeEmptyTodos) {
		todos = todos.filter((line) => {
			const trimmed = (line || "").trim();
			return trimmed !== "- [ ]" && trimmed !== "- [  ]";
		});
	}

	return todos;
}
