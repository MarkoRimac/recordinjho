import {
  App,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  Modal,
  SuggestModal,
  TFile,
  normalizePath,
} from "obsidian";
import { spawn } from "child_process";
import * as path from "path";
import * as fs from "fs";

/* ------------------------------------------------------------------ settings */

interface RecordinjhoSettings {
  scriptsDir: string;
  assemblyAiKey: string;
  anthropicKey: string;
  model: string;
  language: string; // "" = English, "auto" = detect, or a code like "hr"
  momFolder: string;
  transcriptFolder: string;
  autoTeardown: boolean;
  longRecordingWarningMinutes: number; // 0 = disabled
}

const DEFAULT_SETTINGS: RecordinjhoSettings = {
  scriptsDir: "/home/mrimac/Documents/Projects/Recordinjho/scripts",
  assemblyAiKey: "",
  anthropicKey: "",
  model: "claude-sonnet-4-6",
  language: "auto",
  momFolder: "Meetings",
  transcriptFolder: "Meetings/Transcripts",
  autoTeardown: true,
  longRecordingWarningMinutes: 120,
};

/* -------------------------------------------------------------------- helpers */

interface RunOpts {
  env?: Record<string, string>;
  input?: string;
}

/** Run a repo script via bash; resolve stdout, reject with stderr on non-zero. */
function runScript(scriptPath: string, args: string[], opts: RunOpts = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    // GUI-launched Electron apps can have a stripped PATH; ensure the usual bins resolve.
    const basePath = process.env.PATH || "";
    const env = {
      ...process.env,
      PATH: `${basePath}:/usr/local/bin:/usr/bin:/bin`,
      ...(opts.env || {}),
    };
    const child = spawn("bash", [scriptPath, ...args], { env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err) =>
      reject(new Error(`Failed to run ${path.basename(scriptPath)}: ${err.message}`))
    );
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr.trim() || `${path.basename(scriptPath)} exited with ${code}`));
    });
    if (opts.input !== undefined) {
      child.stdin.write(opts.input);
      child.stdin.end();
    }
  });
}

function nowStamp(): { date: string; time: string } {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return {
    date: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`,
    time: `${p(d.getHours())}:${p(d.getMinutes())}`,
  };
}

function sanitizeTitle(t: string): string {
  return t.replace(/[\\/:*?"<>|]/g, "-").replace(/\s+/g, " ").trim() || "Meeting";
}

function formatHM(totalMinutes: number): string {
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function formatDuration(seconds: number | null): string {
  if (seconds === null || !isFinite(seconds)) return "unknown length";
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

/* ----------------------------------------------------------------- title modal */

type ProcessChoice = { action: "process"; title: string } | { action: "keep" };

/**
 * Shown after a recording is stopped & saved (audio already back to normal).
 * Lets the user decide whether to send the audio off for transcription + summary,
 * or just keep the .ogg and send nothing. Closing the dialog = keep (send nothing).
 */
class ProcessModal extends Modal {
  private value: string;
  private oggPath: string;
  private durationLabel: string;
  private onChoose: (choice: ProcessChoice) => void;
  private decided = false;

  constructor(
    app: App,
    initialTitle: string,
    oggPath: string,
    durationLabel: string,
    onChoose: (choice: ProcessChoice) => void
  ) {
    super(app);
    this.value = initialTitle;
    this.oggPath = oggPath;
    this.durationLabel = durationLabel;
    this.onChoose = onChoose;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl("h3", { text: "Recording saved" });
    contentEl.createEl("p", {
      text: `Audio (${this.durationLabel}) saved and your audio routing is back to normal. Send it for transcription (AssemblyAI) and a Claude summary?`,
    });
    const fileLine = contentEl.createEl("p");
    fileLine.style.fontSize = "0.8em";
    fileLine.style.opacity = "0.7";
    fileLine.setText(this.oggPath);

    const label = contentEl.createEl("label", { text: "Meeting title" });
    label.style.display = "block";
    label.style.marginTop = "0.5rem";
    const input = contentEl.createEl("input", { type: "text", value: this.value });
    input.style.width = "100%";
    input.addEventListener("input", () => (this.value = input.value));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        this.finish({ action: "process", title: this.value });
      }
    });

    const buttons = contentEl.createDiv({ cls: "modal-button-container" });
    buttons.style.marginTop = "1rem";
    const go = buttons.createEl("button", { text: "Transcribe & summarize", cls: "mod-cta" });
    go.addEventListener("click", () => this.finish({ action: "process", title: this.value }));
    const keep = buttons.createEl("button", { text: "Just keep the audio" });
    keep.addEventListener("click", () => this.finish({ action: "keep" }));

    window.setTimeout(() => {
      input.focus();
      input.select();
    }, 0);
  }

  private finish(choice: ProcessChoice) {
    this.decided = true;
    this.close();
    this.onChoose(choice);
  }

  onClose() {
    this.contentEl.empty();
    if (!this.decided) this.onChoose({ action: "keep" }); // closing = send nothing
  }
}

interface RecItem {
  path: string;
  name: string;
  subtitle: string;
}

/** Picker over the .ogg files in the recordings/ folder (newest first). */
class RecordingSuggestModal extends SuggestModal<RecItem> {
  private items: RecItem[];
  private onPick: (item: RecItem) => void;

  constructor(app: App, items: RecItem[], onPick: (item: RecItem) => void) {
    super(app);
    this.items = items;
    this.onPick = onPick;
    this.setPlaceholder("Pick a recording to transcribe & summarize");
  }

  getSuggestions(query: string): RecItem[] {
    const q = query.toLowerCase();
    return this.items.filter((i) => i.name.toLowerCase().includes(q));
  }

  renderSuggestion(item: RecItem, el: HTMLElement) {
    el.createEl("div", { text: item.name });
    const sub = el.createEl("small", { text: item.subtitle });
    sub.style.opacity = "0.7";
  }

  onChooseSuggestion(item: RecItem) {
    this.onPick(item);
  }
}

/* -------------------------------------------------------------------- plugin */

export default class RecordinjhoPlugin extends Plugin {
  settings: RecordinjhoSettings;
  private recording = false;
  private busy = false;
  private statusBar: HTMLElement;
  private warnIntervalId?: number;
  private recordingStartedAt = 0;

  async onload() {
    await this.loadSettings();

    if (process.platform !== "linux") {
      new Notice(
        "Recordinjho: recording works on Linux/PipeWire only. Other platforms are not yet supported."
      );
    }

    this.statusBar = this.addStatusBarItem();
    this.updateStatus();

    this.addRibbonIcon("mic", "Recordinjho: start/stop meeting recording", () => {
      this.recording ? this.stopAndProcess() : this.startRecording();
    });

    this.addCommand({
      id: "start-recording",
      name: "Start meeting recording",
      callback: () => this.startRecording(),
    });
    this.addCommand({
      id: "stop-and-process",
      name: "Stop recording & process (transcribe + summarize)",
      callback: () => this.stopAndProcess(),
    });
    this.addCommand({
      id: "process-existing",
      name: "Process an existing recording",
      callback: () => this.processExisting(),
    });

    this.addSettingTab(new RecordinjhoSettingTab(this.app, this));
  }

  onunload() {
    this.clearWarnTimer();
  }

  private script(name: string): string {
    return path.join(this.settings.scriptsDir, name);
  }

  private updateStatus() {
    this.statusBar.setText(this.recording ? "🔴 Recording" : "");
  }

  /* ------------------------------------------------------- long-recording timer */

  private startWarnTimer() {
    this.clearWarnTimer();
    const mins = this.settings.longRecordingWarningMinutes;
    if (!mins || mins <= 0) return;
    this.recordingStartedAt = Date.now();
    this.warnIntervalId = window.setInterval(() => {
      const elapsed = Math.round((Date.now() - this.recordingStartedAt) / 60000);
      new Notice(
        `⚠️ Recordinjho: still recording — ${formatHM(elapsed)} elapsed. Check whether you want to wrap up.`,
        0 // stays until clicked
      );
    }, mins * 60_000);
    this.registerInterval(this.warnIntervalId);
  }

  private clearWarnTimer() {
    if (this.warnIntervalId !== undefined) {
      window.clearInterval(this.warnIntervalId);
      this.warnIntervalId = undefined;
    }
  }

  /** Best-effort audio length via ffprobe (returns null on any failure). */
  private getDurationSeconds(file: string): Promise<number | null> {
    return new Promise((resolve) => {
      const env = { ...process.env, PATH: `${process.env.PATH || ""}:/usr/local/bin:/usr/bin:/bin` };
      const child = spawn(
        "ffprobe",
        ["-v", "quiet", "-show_entries", "format=duration", "-of", "csv=p=0", file],
        { env }
      );
      let out = "";
      child.stdout.on("data", (d) => (out += d.toString()));
      child.on("error", () => resolve(null));
      child.on("close", () => {
        const n = parseFloat(out.trim());
        resolve(isFinite(n) ? n : null);
      });
    });
  }

  /* ---------------------------------------------------------------- actions */

  async startRecording() {
    if (this.busy) return;
    if (this.recording) {
      new Notice("Already recording.");
      return;
    }
    this.busy = true;
    try {
      await runScript(this.script("start-recording.sh"), []);
      this.recording = true;
      this.updateStatus();
      this.startWarnTimer();
      new Notice("Recording started.");
    } catch (e: any) {
      new Notice(`Start failed: ${e.message}`, 8000);
    } finally {
      this.busy = false;
    }
  }

  async stopAndProcess() {
    if (this.busy) return;
    if (!this.recording) {
      new Notice("Not currently recording.");
      return;
    }
    this.busy = true;
    let ogg = "";
    try {
      // 1) Stop & encode → .ogg path. Do this no matter what comes next.
      new Notice("Stopping & encoding…");
      ogg = (await runScript(this.script("stop-recording.sh"), [])).trim();
      this.recording = false;
      this.clearWarnTimer();
      this.updateStatus();
      if (!ogg) throw new Error("No recording file returned.");

      // 2) Restore normal audio immediately (independent of the transcribe choice).
      if (this.settings.autoTeardown) {
        try {
          await runScript(this.script("teardown-audio.sh"), []);
        } catch (e: any) {
          new Notice(`Note: audio teardown failed: ${e.message}`, 6000);
        }
      }
    } catch (e: any) {
      this.recording = false;
      this.clearWarnTimer();
      this.updateStatus();
      this.busy = false;
      new Notice(`Stop failed: ${e.message}`, 10000);
      return;
    }
    this.busy = false;

    // 3) Ask whether to send it anywhere at all.
    await this.confirmAndProcess(ogg);
  }

  /** Show the confirm+title dialog for a saved .ogg and process it if accepted. */
  private async confirmAndProcess(ogg: string) {
    const { date } = nowStamp();
    const durationLabel = formatDuration(await this.getDurationSeconds(ogg));
    new ProcessModal(this.app, `${date} Meeting`, ogg, durationLabel, (choice) => {
      if (choice.action === "keep") {
        new Notice(`Kept audio only — nothing sent. ${ogg}`, 6000);
        return;
      }
      void this.transcribeAndSummarize(ogg, sanitizeTitle(choice.title));
    }).open();
  }

  /** Pick an existing recording from recordings/ and process it. */
  private processExisting() {
    if (this.busy) {
      new Notice("Busy — try again in a moment.");
      return;
    }
    const recDir = path.join(path.dirname(this.settings.scriptsDir), "recordings");
    let items: RecItem[];
    try {
      items = fs
        .readdirSync(recDir)
        .filter((f) => f.toLowerCase().endsWith(".ogg"))
        .map((f) => {
          const full = path.join(recDir, f);
          const st = fs.statSync(full);
          return {
            path: full,
            name: f,
            subtitle: `${(st.size / 1024 / 1024).toFixed(1)} MB · ${new Date(st.mtimeMs).toLocaleString()}`,
            mtime: st.mtimeMs,
          };
        })
        .sort((a, b) => b.mtime - a.mtime)
        .map(({ path, name, subtitle }) => ({ path, name, subtitle }));
    } catch (e: any) {
      new Notice(`Could not read recordings folder (${recDir}): ${e.message}`, 8000);
      return;
    }
    if (items.length === 0) {
      new Notice(`No .ogg recordings found in ${recDir}.`, 6000);
      return;
    }
    new RecordingSuggestModal(this.app, items, (item) => {
      void this.confirmAndProcess(item.path);
    }).open();
  }

  private langEnv(): Record<string, string> {
    const lang = this.settings.language.trim();
    if (lang === "auto") return { ASSEMBLYAI_LANG_DETECT: "true" };
    if (lang !== "") return { ASSEMBLYAI_LANGUAGE: lang };
    return {};
  }

  /** Send a saved recording for transcription + summary and write the notes. */
  private async transcribeAndSummarize(ogg: string, title: string) {
    if (!this.settings.assemblyAiKey || !this.settings.anthropicKey) {
      new Notice(
        `Missing API keys — set AssemblyAI + Anthropic in Recordinjho settings. Your audio is kept at: ${ogg}`,
        10000
      );
      return;
    }
    this.busy = true;
    const { date, time } = nowStamp();
    try {
      // Transcribe (diarized)
      new Notice("Transcribing with AssemblyAI…");
      const transcript = await runScript(this.script("transcribe.sh"), [ogg, "-"], {
        env: { ASSEMBLYAI_API_KEY: this.settings.assemblyAiKey, ...this.langEnv() },
      });
      const transcriptFile = await this.writeNote(
        this.settings.transcriptFolder,
        `${date} ${title}.md`,
        transcript
      );

      // Summarize → MoM (transcript via stdin)
      new Notice("Summarizing with Claude…");
      const mom = await runScript(this.script("summarize.sh"), ["-", "-"], {
        env: {
          ANTHROPIC_API_KEY: this.settings.anthropicKey,
          RECORDINJHO_MODEL: this.settings.model,
          MOM_DATE: date,
          MOM_TIME: time,
          MOM_TITLE: title,
        },
        input: transcript,
      });
      const momFile = await this.writeNote(this.settings.momFolder, `${date} ${title}.md`, mom);

      await this.app.workspace.getLeaf(true).openFile(momFile);
      new Notice(`Done. Transcript: ${transcriptFile.path}`, 6000);
    } catch (e: any) {
      new Notice(`Processing failed (audio is safe at ${ogg}): ${e.message}`, 10000);
    } finally {
      this.busy = false;
    }
  }

  /* ----------------------------------------------------------------- vault io */

  private async ensureFolder(folder: string) {
    const norm = normalizePath(folder);
    const parts = norm.split("/").filter(Boolean);
    let cur = "";
    for (const part of parts) {
      cur = cur ? `${cur}/${part}` : part;
      if (!this.app.vault.getAbstractFileByPath(cur)) {
        try {
          await this.app.vault.createFolder(cur);
        } catch {
          /* race / already exists */
        }
      }
    }
  }

  /** Create a note, avoiding overwrite by appending " (n)" on collision. */
  private async writeNote(folder: string, filename: string, content: string): Promise<TFile> {
    await this.ensureFolder(folder);
    const base = filename.replace(/\.md$/, "");
    let candidate = normalizePath(`${folder}/${base}.md`);
    let i = 2;
    while (this.app.vault.getAbstractFileByPath(candidate)) {
      candidate = normalizePath(`${folder}/${base} (${i}).md`);
      i++;
    }
    return await this.app.vault.create(candidate, content);
  }

  /* ---------------------------------------------------------------- settings */

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }
  async saveSettings() {
    await this.saveData(this.settings);
  }
}

/* --------------------------------------------------------------- settings tab */

class RecordinjhoSettingTab extends PluginSettingTab {
  plugin: RecordinjhoPlugin;
  constructor(app: App, plugin: RecordinjhoPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    const save = () => this.plugin.saveSettings();

    new Setting(containerEl)
      .setName("Scripts directory")
      .setDesc("Absolute path to the Recordinjho repo's scripts/ folder.")
      .addText((t) =>
        t
          .setPlaceholder("/path/to/Recordinjho/scripts")
          .setValue(this.plugin.settings.scriptsDir)
          .onChange(async (v) => {
            this.plugin.settings.scriptsDir = v.trim();
            await save();
          })
      );

    new Setting(containerEl)
      .setName("AssemblyAI API key")
      .setDesc("Stored in this plugin's data.json (plaintext, inside your vault).")
      .addText((t) => {
        t.inputEl.type = "password";
        t.setValue(this.plugin.settings.assemblyAiKey).onChange(async (v) => {
          this.plugin.settings.assemblyAiKey = v.trim();
          await save();
        });
      });

    new Setting(containerEl)
      .setName("Anthropic API key")
      .setDesc("Stored in this plugin's data.json (plaintext, inside your vault).")
      .addText((t) => {
        t.inputEl.type = "password";
        t.setValue(this.plugin.settings.anthropicKey).onChange(async (v) => {
          this.plugin.settings.anthropicKey = v.trim();
          await save();
        });
      });

    new Setting(containerEl)
      .setName("Claude model")
      .addText((t) =>
        t.setValue(this.plugin.settings.model).onChange(async (v) => {
          this.plugin.settings.model = v.trim() || DEFAULT_SETTINGS.model;
          await save();
        })
      );

    new Setting(containerEl)
      .setName("Transcription language")
      .setDesc('"auto" to detect, a code like "hr"/"en"/"de", or empty for English.')
      .addText((t) =>
        t.setValue(this.plugin.settings.language).onChange(async (v) => {
          this.plugin.settings.language = v.trim();
          await save();
        })
      );

    new Setting(containerEl)
      .setName("Minutes-of-Meeting folder")
      .addText((t) =>
        t.setValue(this.plugin.settings.momFolder).onChange(async (v) => {
          this.plugin.settings.momFolder = v.trim() || DEFAULT_SETTINGS.momFolder;
          await save();
        })
      );

    new Setting(containerEl)
      .setName("Transcript folder")
      .addText((t) =>
        t.setValue(this.plugin.settings.transcriptFolder).onChange(async (v) => {
          this.plugin.settings.transcriptFolder = v.trim() || DEFAULT_SETTINGS.transcriptFolder;
          await save();
        })
      );

    new Setting(containerEl)
      .setName("Restore audio when recording stops")
      .setDesc("Tear down the routing (restore your default sink, unload the modules) the moment you stop, before any transcription.")
      .addToggle((tg) =>
        tg.setValue(this.plugin.settings.autoTeardown).onChange(async (v) => {
          this.plugin.settings.autoTeardown = v;
          await save();
        })
      );

    new Setting(containerEl)
      .setName("Long-recording warning (minutes)")
      .setDesc("Pop a reminder once a recording passes this many minutes (repeats each interval). 0 disables it.")
      .addText((t) =>
        t.setValue(String(this.plugin.settings.longRecordingWarningMinutes)).onChange(async (v) => {
          const n = parseInt(v.trim(), 10);
          this.plugin.settings.longRecordingWarningMinutes = isNaN(n) || n < 0 ? 0 : n;
          await save();
        })
      );
  }
}
