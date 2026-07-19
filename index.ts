import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DEFAULT_TIMEOUT_SECONDS = 15;
const SESSION_STATE_ENTRY = "pi-bark-reminder-state";
const SETTINGS_FILE = join(homedir(), ".pi", "agent", "pi-bark-reminder.json");

type ReminderSettings = {
  defaultEnabled: boolean;
  barkEndpoint: string;
  barkLevel: string;
  barkGroup: string;
  barkSound: string;
  barkTimeoutSeconds: number;
};

function defaultSettings(): ReminderSettings {
  return {
    defaultEnabled: false,
    barkEndpoint: "",
    barkLevel: "timeSensitive",
    barkGroup: "pi",
    barkSound: "",
    barkTimeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
  };
}

function asNonEmptyString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function asPositiveNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

async function loadSettings(): Promise<ReminderSettings> {
  const defaults = defaultSettings();
  try {
    const raw = JSON.parse(await readFile(SETTINGS_FILE, "utf8")) as Partial<ReminderSettings>;
    return {
      defaultEnabled: raw.defaultEnabled === true,
      barkEndpoint: typeof raw.barkEndpoint === "string" ? raw.barkEndpoint.trim().replace(/\/+$/, "") : "",
      barkLevel: asNonEmptyString(raw.barkLevel, defaults.barkLevel),
      barkGroup: asNonEmptyString(raw.barkGroup, defaults.barkGroup),
      barkSound: typeof raw.barkSound === "string" ? raw.barkSound.trim() : "",
      barkTimeoutSeconds: asPositiveNumber(raw.barkTimeoutSeconds, defaults.barkTimeoutSeconds),
    };
  } catch {
    return defaults;
  }
}

async function saveSettings(settings: ReminderSettings): Promise<void> {
  await mkdir(dirname(SETTINGS_FILE), { recursive: true });
  const temporaryFile = `${SETTINGS_FILE}.${process.pid}.tmp`;
  await writeFile(temporaryFile, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  await rename(temporaryFile, SETTINGS_FILE);
}

function getSavedSessionEnabled(ctx: ExtensionContext): boolean | undefined {
  for (const entry of [...ctx.sessionManager.getBranch()].reverse()) {
    if (entry.type !== "custom" || entry.customType !== SESSION_STATE_ENTRY) continue;
    const data = entry.data as { enabled?: unknown } | undefined;
    if (typeof data?.enabled === "boolean") return data.enabled;
  }
  return undefined;
}

async function sendBark(settings: ReminderSettings, title: string, body: string): Promise<void> {
  const query = new URLSearchParams({
    level: settings.barkLevel,
    group: settings.barkGroup,
  });
  if (settings.barkSound) query.set("sound", settings.barkSound);

  const url = `${settings.barkEndpoint}/${encodeURIComponent(title)}/${encodeURIComponent(body)}?${query}`;
  const timeoutMs = settings.barkTimeoutSeconds * 1000;

  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) {
      throw new Error(`Bark returned HTTP ${response.status}: ${await response.text()}`);
    }
  } catch (fetchError) {
    if (process.platform === "win32") throw fetchError;

    // A Bark server may fail its TLS handshake from WSL even though Windows
    // can reach it. Use the Windows network stack as a transparent fallback.
    try {
      await execFileAsync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "$r = Invoke-RestMethod -Uri $env:PI_BARK_REQUEST_URL -Method Get -TimeoutSec 15; if ($r.code -ne 200) { throw ($r | ConvertTo-Json -Compress) }",
        ],
        {
          timeout: timeoutMs,
          // This temporary process environment keeps the private URL out of
          // PowerShell's command-line arguments. It is not user configuration.
          env: { ...process.env, PI_BARK_REQUEST_URL: url },
          windowsHide: true,
        },
      );
    } catch (windowsError) {
      throw new Error(`WSL 和 Windows 发送均失败：${String(windowsError)}`, { cause: fetchError });
    }
  }
}

function formatDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return remainingSeconds ? `${minutes} 分 ${remainingSeconds} 秒` : `${minutes} 分钟`;
}

export default function barkReminder(pi: ExtensionAPI) {
  let startedAt: number | undefined;
  let enabled = false;

  const updateStatus = (ctx: ExtensionContext) => {
    if (!ctx.hasUI) return;
    const text = enabled ? "[Bark: ON]" : "[Bark: OFF]";
    ctx.ui.setStatus("pi-bark-reminder", ctx.ui.theme.fg(enabled ? "success" : "dim", text));
  };

  pi.on("session_start", async (_event, ctx) => {
    const settings = await loadSettings();
    enabled = getSavedSessionEnabled(ctx) ?? settings.defaultEnabled;
    startedAt = undefined;
    updateStatus(ctx);
  });

  pi.registerCommand("bark", {
    description: "切换当前会话及未来新会话的 Bark 完成提醒",
    handler: async (_args, ctx) => {
      const settings = await loadSettings();
      enabled = !enabled;
      settings.defaultEnabled = enabled;

      try {
        await saveSettings(settings);
        pi.appendEntry(SESSION_STATE_ENTRY, { enabled });
      } catch (error) {
        enabled = !enabled;
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Bark 设置保存失败：${message}`, "error");
        return;
      }

      updateStatus(ctx);
      ctx.ui.notify(
        `当前会话及未来新会话的 Bark 提醒已${enabled ? "开启" : "关闭"}`,
        "info",
      );
    },
  });

  pi.on("agent_start", () => {
    startedAt ??= Date.now();
  });

  pi.on("agent_settled", async (_event, ctx) => {
    const runStartedAt = startedAt;
    startedAt = undefined;
    if (runStartedAt === undefined || !enabled) return;

    const settings = await loadSettings();
    if (!settings.barkEndpoint) {
      if (ctx.hasUI) ctx.ui.notify("Bark 提醒未发送：请配置 barkEndpoint", "warning");
      return;
    }

    const project = basename(ctx.cwd) || ctx.cwd;
    const session = pi.getSessionName();
    const body = [
      `项目：${project}`,
      session ? `会话：${session}` : undefined,
      `耗时：${formatDuration(Date.now() - runStartedAt)}`,
    ].filter(Boolean).join("\n");

    try {
      await sendBark(settings, "pi 会话已停止", body);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[pi-bark-reminder] ${message}`);
      if (ctx.hasUI) ctx.ui.notify(`Bark 提醒发送失败：${message}`, "warning");
    }
  });
}
