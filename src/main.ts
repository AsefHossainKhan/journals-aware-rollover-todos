import {
	App,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	TFile,
} from "obsidian";

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

class JournalsAwareRolloverSettingTab extends PluginSettingTab {
	plugin: JournalsAwareRolloverPlugin;

	constructor(app: App, plugin: JournalsAwareRolloverPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Automatic rollover on new note")
			.setDesc(
				"Roll over todos automatically when the Journals plugin creates a new note. The manual command is always available regardless of this setting."
			)
			.addToggle((t) =>
				t.setValue(this.plugin.settings.autoRolloverOnCreate).onChange(async (v) => {
					this.plugin.settings.autoRolloverOnCreate = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Delete todos from the previous note")
			.setDesc(
				"After copying todos forward, remove them from the previous note (move instead of copy). Destructive — leave off to duplicate them safely."
			)
			.addToggle((t) =>
				t.setValue(this.plugin.settings.deleteFromPrevious).onChange(async (v) => {
					this.plugin.settings.deleteFromPrevious = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Roll over child items")
			.setDesc("Also carry indented lines nested beneath an unfinished todo.")
			.addToggle((t) =>
				t.setValue(this.plugin.settings.rolloverChildren).onChange(async (v) => {
					this.plugin.settings.rolloverChildren = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Skip empty todos")
			.setDesc("Do not roll over bare `- [ ]` items that have no text.")
			.addToggle((t) =>
				t.setValue(this.plugin.settings.removeEmptyTodos).onChange(async (v) => {
					this.plugin.settings.removeEmptyTodos = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Skip todos already in the new note")
			.setDesc("Avoid inserting a todo whose exact text already exists in the target note.")
			.addToggle((t) =>
				t.setValue(this.plugin.settings.skipDuplicates).onChange(async (v) => {
					this.plugin.settings.skipDuplicates = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Target heading pattern")
			.setDesc(
				"Case-insensitive regex matched against heading lines. Todos are inserted beneath the first match. Default matches headings ending in TODOS (e.g. `## FRIDAY TODOS`)."
			)
			.addText((t) =>
				t
					.setPlaceholder(DEFAULT_SETTINGS.headingPattern)
					.setValue(this.plugin.settings.headingPattern)
					.onChange(async (v) => {
						this.plugin.settings.headingPattern = v || DEFAULT_SETTINGS.headingPattern;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("If the heading is not found")
			.setDesc("Where to place todos when no heading matches the pattern.")
			.addDropdown((d) =>
				d
					.addOptions({
						bottom: "Append to bottom of note",
						top: "Insert at top (after frontmatter)",
						skip: "Skip rollover",
					})
					.setValue(this.plugin.settings.headingFallback)
					.onChange(async (v) => {
						this.plugin.settings.headingFallback = v as HeadingFallback;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Done status markers")
			.setDesc('Characters inside `[ ]` that mean a todo is complete. Default "xX-".')
			.addText((t) =>
				t
					.setPlaceholder(DEFAULT_SETTINGS.doneStatusMarkers)
					.setValue(this.plugin.settings.doneStatusMarkers)
					.onChange(async (v) => {
						this.plugin.settings.doneStatusMarkers = v || DEFAULT_SETTINGS.doneStatusMarkers;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Limit to journals")
			.setDesc(
				"Comma-separated Journals names to act on (matched against the `journal` frontmatter field). Leave empty to act on every note that has a `journal-date`."
			)
			.addText((t) =>
				t
					.setPlaceholder("e.g. DailyNote, WeeklyNote")
					.setValue(this.plugin.settings.enabledJournals)
					.onChange(async (v) => {
						this.plugin.settings.enabledJournals = v;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Show notice after rollover")
			.setDesc("Display a short summary each time todos are rolled over.")
			.addToggle((t) =>
				t.setValue(this.plugin.settings.showNotice).onChange(async (v) => {
					this.plugin.settings.showNotice = v;
					await this.plugin.saveSettings();
				})
			);
	}
}
