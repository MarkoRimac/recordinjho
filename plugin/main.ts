import {
  App,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  Modal,
  TFile,
  normalizePath,
} from "obsidian";
import { spawn } from "child_process";
import * as path from "path";

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

/* ----------------------------------------------------------------- title modal */

class TitleModal extends Modal {
  private value: string;
  private onSubmit: (title: string | null) => void;
  private submitted = false;

  constructor(app: App, initial: string, onSubmit: (title: string | null) => void) {
    super(app);
    this.value = initial;
    this.onSubmit = onSubmit;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl("h3", { text: "Name this meeting" });

    const input = contentEl.createEl("input", { type: "text", value: this.value });
    input.style.width = "100%";
    input.addEventListener("input", () => (this.value = input.value));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        this.finish(this.value);
      }
    });

    const buttons = contentEl.createDiv({ cls: "modal-button-container" });
    buttons.style.marginTop = "1rem";
    const ok = buttons.createEl("button", { text: "Process recording", cls: "mod-cta" });
    ok.addEventListener("click", () => this.finish(this.value));
    const cancel = buttons.createEl("button", { text: "Cancel" });
    cancel.addEventListener("click", () => this.finish(null));

    window.setTimeout(() => {
      input.focus();
      input.select();
    }, 0);
  }

  private finish(result: string | null) {
    this.submitted = true;
    this.close();
    this.onSubmit(result);
  }

  onClose() {
    this.contentEl.empty();
    if (!this.submitted) this.onSubmit(null);
  }
}

/* -------------------------------------------------------------------- plugin */

export default class RecordinjhoPlugin extends Plugin {
  settings: RecordinjhoSettings;
  private recording = false;
  private busy = false;
  private statusBar: HTMLElement;

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

    this.addSettingTab(new RecordinjhoSettingTab(this.app, this));
  }

  onunload() {}

  private script(name: string): string {
    return path.join(this.settings.scriptsDir, name);
  }

  private updateStatus() {
    this.statusBar.setText(this.recording ? "🔴 Recording" : "");
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
    if (!this.settings.assemblyAiKey || !this.settings.anthropicKey) {
      new Notice("Set your AssemblyAI and Anthropic API keys in Recordinjho settings first.", 8000);
      return;
    }

    const { date } = nowStamp();
    new TitleModal(this.app, `${date} Meeting`, (title) => {
      if (title === null) {
        new Notice("Cancelled — recording is still running. Stop again to process.");
        return;
      }
      void this.process(sanitizeTitle(title));
    }).open();
  }

  private langEnv(): Record<string, string> {
    const lang = this.settings.language.trim();
    if (lang === "auto") return { ASSEMBLYAI_LANG_DETECT: "true" };
    if (lang !== "") return { ASSEMBLYAI_LANGUAGE: lang };
    return {};
  }

  private async process(title: string) {
    this.busy = true;
    const { date, time } = nowStamp();
    try {
      // 1) Stop & encode → .ogg path
      new Notice("Stopping & encoding…");
      const ogg = (await runScript(this.script("stop-recording.sh"), [])).trim();
      this.recording = false;
      this.updateStatus();
      if (!ogg) throw new Error("No recording file returned.");

      // 2) Transcribe (diarized)
      new Notice("Transcribing with AssemblyAI…");
      const transcript = await runScript(this.script("transcribe.sh"), [ogg, "-"], {
        env: { ASSEMBLYAI_API_KEY: this.settings.assemblyAiKey, ...this.langEnv() },
      });
      const transcriptFile = await this.writeNote(
        this.settings.transcriptFolder,
        `${date} ${title}.md`,
        transcript
      );

      // 3) Summarize → MoM (transcript via stdin)
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

      // 4) Optional teardown
      if (this.settings.autoTeardown) {
        try {
          await runScript(this.script("teardown-audio.sh"), []);
        } catch (e: any) {
          new Notice(`Note: audio teardown failed: ${e.message}`, 6000);
        }
      }

      // 5) Open the MoM note
      await this.app.workspace.getLeaf(true).openFile(momFile);
      new Notice(`Done. Transcript: ${transcriptFile.path}`, 6000);
    } catch (e: any) {
      new Notice(`Processing failed: ${e.message}`, 10000);
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
      .setName("Tear down audio routing after each meeting")
      .setDesc("Restore your default sink and unload the modules when processing finishes.")
      .addToggle((tg) =>
        tg.setValue(this.plugin.settings.autoTeardown).onChange(async (v) => {
          this.plugin.settings.autoTeardown = v;
          await save();
        })
      );
  }
}
