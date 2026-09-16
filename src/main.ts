import {
	App,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	TFile,
} from "obsidian";
import type { SettingControl, SettingDefinitionItem } from "obsidian";

import {
	DEFAULT_SETTINGS,
	HeadingFallback,
	JournalRolloverSettings,
	parseEnabledJournals,
} from "./settings";
import { getUnfinishedTodos } from "./todoParser";
import {
	findPreviousJournalNote,
	getJournalInfo,
	readFrontmatterRaw,
} from "./journal";

/** How long to wait for the Journals template to finish rendering a new note. */
const READY_TIMEOUT_MS = 6000;
const READY_POLL_MS = 200;
/** Debounce window to avoid processing the same new note twice. */
const RECENTLY_HANDLED_MS = 8000;

export default class JournalsAwareRolloverPlugin extends Plugin {
	settings!: JournalRolloverSettings;
	private recentlyHandled = new Map<string, number>();

	async onload() {
		await this.loadSettings();

		this.addSettingTab(new JournalsAwareRolloverSettingTab(this.app, this));

		// Obsidian fires a `create` event for every existing file while it indexes
		// the vault at startup. Registering the listener only after the layout is
		// ready skips that initial storm, so we react to genuinely new notes only.
		this.app.workspace.onLayoutReady(() => {
			this.registerEvent(
				this.app.vault.on("create", (file) => {
					if (!this.settings.autoRolloverOnCreate) return;
					if (!(file instanceof TFile) || file.extension !== "md") return;
					// Fire and forget; readiness polling happens inside.
					void this.handleCreate(file);
				})
			);
		});

		this.addCommand({
			id: "rollover-into-current-note",
			name: "Roll over todos into the current note",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!file || file.extension !== "md") return false;
				if (!checking) {
					void this.rolloverInto(file, { manual: true });
				}
				return true;
			},
		});
	}

	onunload() {
		this.recentlyHandled.clear();
	}

	async loadSettings() {
		// loadData() is typed `any`; narrow it before merging so the result stays typed.
		const saved = (await this.loadData()) as Partial<JournalRolloverSettings> | null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, saved);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	// --- Auto path ----------------------------------------------------------

	private wasRecentlyHandled(path: string): boolean {
		const now = Date.now();
		// Opportunistically prune old entries.
		for (const [p, t] of this.recentlyHandled) {
			if (now - t > RECENTLY_HANDLED_MS) this.recentlyHandled.delete(p);
		}
		return this.recentlyHandled.has(path);
	}

	private async handleCreate(file: TFile) {
		if (this.wasRecentlyHandled(file.path)) return;

		const ready = await this.waitUntilReady(file);
		if (!ready) return; // never became a journal note within the timeout

		this.recentlyHandled.set(file.path, Date.now());
		await this.rolloverInto(file, { manual: false });
	}

	/**
	 * Wait until the new note has `journal-date` frontmatter and (ideally) the
	 * target heading rendered, so we don't insert before the template writes it.
	 * Resolves true once it looks like a journal note, false on timeout.
	 */
	private async waitUntilReady(file: TFile): Promise<boolean> {
		const headingRe = this.compileHeadingRegex();
		const deadline = Date.now() + READY_TIMEOUT_MS;
		let sawJournalDate = false;

		while (Date.now() < deadline) {
			let content = "";
			try {
				content = await this.app.vault.read(file);
			} catch {
				return false; // file vanished
			}
			const fm = readFrontmatterRaw(content);
			const isJournal = fm["journal-date"] != null && fm["journal-date"] !== "";
			if (isJournal) {
				sawJournalDate = true;
				const headingPresent = headingRe ? headingRe.test(content) : false;
				if (headingPresent || this.settings.headingFallback !== "skip") {
					// Heading is there, or we can fall back — good to go. Give the
					// template one more tick to settle if the heading isn't up yet.
					if (headingPresent) return true;
				}
			}
			await sleep(READY_POLL_MS);
		}
		return sawJournalDate;
	}

	// --- Core ---------------------------------------------------------------

	private compileHeadingRegex(): RegExp | null {
		try {
			return new RegExp(this.settings.headingPattern, "i");
		} catch {
			return null;
		}
	}

	async rolloverInto(file: TFile, opts: { manual: boolean }): Promise<void> {
		const info = await getJournalInfo(this.app, file);
		if (!info) {
			if (opts.manual) {
				new Notice(
					"Journal Aware Rollover: the current note has no `journal-date` frontmatter, so it isn't a Journals note."
				);
			}
			return;
		}

		const allowed = parseEnabledJournals(this.settings.enabledJournals);
		if (allowed.length > 0 && info.journal && !allowed.includes(info.journal)) {
			if (opts.manual) {
				new Notice(
					`Journal Aware Rollover: journal "${info.journal}" is not in the enabled list.`
				);
			}
			return;
		}

		const previous = findPreviousJournalNote(this.app, file, info, allowed);
		if (!previous) {
			if (opts.manual) new Notice("Journal Aware Rollover: no earlier journal note found.");
			return;
		}

		const previousContent = await this.app.vault.read(previous);
		const todos = getUnfinishedTodos(previousContent, {
			withChildren: this.settings.rolloverChildren,
			doneStatusMarkers: this.settings.doneStatusMarkers,
			removeEmptyTodos: this.settings.removeEmptyTodos,
		});

		if (todos.length === 0) {
			if (opts.manual) {
				new Notice(`Journal Aware Rollover: no unfinished todos in ${previous.basename}.`);
			}
			return;
		}

		// Insert atomically: Vault.process hands us the current on-disk content and
		// writes the return value back in one step, so we never clobber a concurrent
		// edit. Dedup and insertion both run against that fresh content for the same
		// reason. Outcome is surfaced via outer state for the notices below.
		// Held in an object so the closure's writes aren't narrowed away by TS.
		type Outcome = "inserted" | "all-duplicates" | "no-heading";
		const result: { outcome: Outcome; rolled: string[] } = {
			outcome: "no-heading",
			rolled: [],
		};

		await this.app.vault.process(file, (data) => {
			let toInsert = todos;
			if (this.settings.skipDuplicates) {
				const existing = new Set(data.split(/\r?\n/).map((l) => l.trim()));
				toInsert = toInsert.filter((line) => !existing.has(line.trim()));
				if (toInsert.length === 0) {
					result.outcome = "all-duplicates";
					return data; // nothing new to add; leave the note untouched
				}
			}

			const inserted = this.insertTodos(data, toInsert);
			if (inserted == null) {
				// headingFallback === "skip" and no heading found.
				result.outcome = "no-heading";
				return data;
			}

			result.outcome = "inserted";
			result.rolled = toInsert;
			return inserted;
		});

		if (result.outcome === "all-duplicates") {
			if (opts.manual) {
				new Notice("Journal Aware Rollover: all todos are already present in this note.");
			}
			return;
		}
		if (result.outcome === "no-heading") {
			if (opts.manual) {
				new Notice(
					"Journal Aware Rollover: target heading not found and fallback is set to skip."
				);
			}
			return;
		}

		if (this.settings.deleteFromPrevious) {
			await this.deleteFromPrevious(previous, result.rolled);
		}

		if (this.settings.showNotice) {
			const n = result.rolled.length;
			new Notice(
				`Journal Aware Rollover: ${n} todo${n > 1 ? "s" : ""} from ${previous.basename}.`
			);
		}
	}

	/**
	 * Insert todos beneath the first heading matching the pattern, or at the
	 * configured fallback position. Returns new content, or null if it should
	 * be skipped.
	 */
	private insertTodos(content: string, todos: string[]): string | null {
		const lines = content.split(/\r?\n/);
		const headingRe = this.compileHeadingRegex();

		let headingIndex = -1;
		if (headingRe) {
			for (let i = 0; i < lines.length; i++) {
				if (/^#{1,6}\s/.test(lines[i]) && headingRe.test(lines[i])) {
					headingIndex = i;
					break;
				}
			}
		}

		if (headingIndex >= 0) {
			lines.splice(headingIndex + 1, 0, ...todos);
			return lines.join("\n");
		}

		const fallback: HeadingFallback = this.settings.headingFallback;
		if (fallback === "skip") return null;

		if (fallback === "top") {
			const bodyStart = frontmatterEndIndex(lines);
			lines.splice(bodyStart, 0, ...todos);
			return lines.join("\n");
		}

		// bottom
		const block = todos.join("\n");
		return content.endsWith("\n") || content.length === 0
			? content + block + "\n"
			: content + "\n" + block + "\n";
	}

	private async deleteFromPrevious(previous: TFile, rolled: string[]): Promise<void> {
		const remove = new Set(rolled);
		await this.app.vault.process(previous, (content) =>
			content
				.split(/\r?\n/)
				.filter((line) => !remove.has(line))
				.join("\n")
		);
	}
}

/** Index of the first body line after a leading frontmatter block. */
function frontmatterEndIndex(lines: string[]): number {
	if (lines[0] !== "---") return 0;
	for (let i = 1; i < lines.length; i++) {
		if (lines[i] === "---") return i + 1;
	}
	return 0;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => window.setTimeout(resolve, ms));
}

/** The kind of control used to edit a single setting. */
type ControlSpec =
	| { type: "toggle" }
	| { type: "text"; placeholder: string; validate?: (value: string) => string | void }
	| { type: "dropdown"; options: Record<string, string> };

/**
 * One setting's storage key, labels, and control. A single source of truth
 * drives both the declarative settings API (`getSettingDefinitions`, Obsidian
 * 1.13.0+, which also feeds the settings search) and the imperative `display()`
 * fallback for older versions, so the two renderings can never drift apart.
 */
interface SettingDescriptor {
	key: keyof JournalRolloverSettings;
	name: string;
	desc: string;
	control: ControlSpec;
}

/** Keys whose stored value falls back to the default when the user clears it. */
const COERCE_EMPTY_TO_DEFAULT: ReadonlySet<keyof JournalRolloverSettings> = new Set([
	"headingPattern",
	"doneStatusMarkers",
]);

const SETTING_DESCRIPTORS: readonly SettingDescriptor[] = [
	{
		key: "autoRolloverOnCreate",
		name: "Automatic rollover on new note",
		desc: "Roll over todos automatically when the Journals plugin creates a new note. The manual command is always available regardless of this setting.",
		control: { type: "toggle" },
	},
	{
		key: "deleteFromPrevious",
		name: "Delete todos from the previous note",
		desc: "After copying todos forward, remove them from the previous note (move instead of copy). Destructive — leave off to duplicate them safely.",
		control: { type: "toggle" },
	},
	{
		key: "rolloverChildren",
		name: "Roll over child items",
		desc: "Also carry indented lines nested beneath an unfinished todo.",
		control: { type: "toggle" },
	},
	{
		key: "removeEmptyTodos",
		name: "Skip empty todos",
		desc: "Do not roll over bare `- [ ]` items that have no text.",
		control: { type: "toggle" },
	},
	{
		key: "skipDuplicates",
		name: "Skip todos already in the new note",
		desc: "Avoid inserting a todo whose exact text already exists in the target note.",
		control: { type: "toggle" },
	},
	{
		key: "headingPattern",
		name: "Target heading pattern",
		desc: "Case-insensitive regex matched against heading lines. Todos are inserted beneath the first match. Default matches headings ending in TODOS (e.g. `## FRIDAY TODOS`).",
		control: {
			type: "text",
			placeholder: DEFAULT_SETTINGS.headingPattern,
			validate: (value) => {
				try {
					// Empty falls back to the default, which is always valid.
					new RegExp(value || DEFAULT_SETTINGS.headingPattern, "i");
				} catch {
					return "Not a valid regular expression.";
				}
			},
		},
	},
	{
		key: "headingFallback",
		name: "If the heading is not found",
		desc: "Where to place todos when no heading matches the pattern.",
		control: {
			type: "dropdown",
			options: {
				bottom: "Append to bottom of note",
				top: "Insert at top (after frontmatter)",
				skip: "Skip rollover",
			},
		},
	},
	{
		key: "doneStatusMarkers",
		name: "Done status markers",
		desc: 'Characters inside `[ ]` that mean a todo is complete. Default "xX-".',
		control: { type: "text", placeholder: DEFAULT_SETTINGS.doneStatusMarkers },
	},
	{
		key: "enabledJournals",
		name: "Limit to journals",
		desc: "Comma-separated Journals names to act on (matched against the `journal` frontmatter field). Leave empty to act on every note that has a `journal-date`.",
		control: { type: "text", placeholder: "e.g. DailyNote, WeeklyNote" },
	},
	{
		key: "showNotice",
		name: "Show notice after rollover",
		desc: "Display a short summary each time todos are rolled over.",
		control: { type: "toggle" },
	},
];

class JournalsAwareRolloverSettingTab extends PluginSettingTab {
	plugin: JournalsAwareRolloverPlugin;

	constructor(app: App, plugin: JournalsAwareRolloverPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	/**
	 * Declarative settings (Obsidian 1.13.0+). Returning a non-empty array makes
	 * Obsidian render the tab from these definitions and index them for settings
	 * search; `display()` below is then not called and only serves older builds.
	 */
	getSettingDefinitions(): SettingDefinitionItem[] {
		return SETTING_DESCRIPTORS.map((d) => ({
			name: d.name,
			desc: d.desc,
			control: buildControl(d),
		}));
	}

	getControlValue(key: string): unknown {
		return this.plugin.settings[key as keyof JournalRolloverSettings];
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		this.store(key as keyof JournalRolloverSettings, value);
		await this.plugin.saveSettings();
	}

	/** Coerce and write one setting value into the settings object. */
	private store(key: keyof JournalRolloverSettings, value: unknown): void {
		const settings = this.plugin.settings as unknown as Record<string, unknown>;
		if (typeof value === "string" && value === "" && COERCE_EMPTY_TO_DEFAULT.has(key)) {
			settings[key] = DEFAULT_SETTINGS[key];
			return;
		}
		settings[key] = value;
	}

	/**
	 * Imperative fallback for Obsidian < 1.13.0, where `getSettingDefinitions`
	 * is not consulted. Renders the same descriptors with the classic API.
	 */
	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		for (const d of SETTING_DESCRIPTORS) {
			const setting = new Setting(containerEl).setName(d.name).setDesc(d.desc);
			this.addControl(setting, d);
		}
	}

	private addControl(setting: Setting, d: SettingDescriptor): void {
		const key = d.key;
		const commit = async (value: unknown): Promise<void> => {
			this.store(key, value);
			await this.plugin.saveSettings();
		};

		switch (d.control.type) {
			case "toggle":
				setting.addToggle((t) =>
					t
						.setValue(this.plugin.settings[key] as boolean)
						.onChange((v) => void commit(v))
				);
				break;
			case "dropdown": {
				const options = d.control.options;
				setting.addDropdown((dd) =>
					dd
						.addOptions(options)
						.setValue(this.plugin.settings[key] as string)
						.onChange((v) => void commit(v))
				);
				break;
			}
			case "text": {
				const placeholder = d.control.placeholder;
				setting.addText((t) =>
					t
						.setPlaceholder(placeholder)
						.setValue(this.plugin.settings[key] as string)
						.onChange((v) => void commit(v))
				);
				break;
			}
		}
	}
}

/** Build the declarative control object for a descriptor. */
function buildControl(d: SettingDescriptor): SettingControl {
	const key = d.key;
	switch (d.control.type) {
		case "toggle":
			return { type: "toggle", key };
		case "dropdown":
			return { type: "dropdown", key, options: d.control.options };
		case "text":
			return {
				type: "text",
				key,
				placeholder: d.control.placeholder,
				validate: d.control.validate,
			};
	}
}
