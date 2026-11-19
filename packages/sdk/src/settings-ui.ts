// Ready-made "Connect to OBSIGAMA" toggle + live sync status for a game's settings tab.
// Pass Obsidian's `Setting` class in, so the SDK itself stays dependency-free.

import type { SClient, SyncStatus } from "./client";

export interface ToggleLike {
  setValue(v: boolean): unknown;
  onChange(cb: (v: boolean) => unknown): unknown;
}
export interface ButtonLike {
  setButtonText(t: string): unknown;
  onClick(cb: (evt: MouseEvent) => unknown): unknown;
}
export interface SettingLike {
  setName(n: string): unknown;
  setDesc(d: string): unknown;
  addToggle(cb: (t: ToggleLike) => unknown): unknown;
  addButton(cb: (b: ButtonLike) => unknown): unknown;
}
export type SettingCtor = new (containerEl: HTMLElement) => SettingLike;

export type SdkLang = "en" | "ru";

const T = {
  en: {
    name: (p: string) => `Connect to ${p}`,
    desc: (p: string) => `Off by default. When on, your stats, best scores and achievements are sent to your ${p} account after every run. The game works the same without it. Requires the ${p} plugin and an ${p} account.`,
    status: "Sync status",
    syncNow: "Sync now",
    open: (p: string) => `Open ${p}`,
    st: {
      off: "Off. Progress is saved only on this device.",
      "no-platform": (p: string) => `${p} is not installed or not enabled in this vault. Progress is kept locally.`,
      "platform-disabled": (p: string) => `${p} is offline (its "Online / sync" switch is off). Results wait in the queue.`,
      "not-configured": (p: string) => `${p} has no server configured yet. Open ${p} settings.`,
      "signed-out": (p: string) => `Sign in to ${p} to sync. Results wait in the queue.`,
      "needs-link": (p: string) => `Press "Sync now" and allow this game in ${p}.`,
      "link-denied": (p: string) => `Not allowed in ${p}. Press "Sync now" to ask again.`,
      syncing: "Syncing…",
      synced: "Synced",
      pending: "Waiting to sync",
      error: "Sync failed, will retry",
    },
    pending: (n: number) => `${n} pending`,
    last: (d: string) => `last sync ${d}`,
    as: (u: string) => `as ${u}`,
  },
  ru: {
    name: (p: string) => `Подключить к ${p}`,
    desc: (p: string) => `По умолчанию выключено. Если включить, статистика, рекорды и достижения отправляются в ваш аккаунт ${p} после каждого забега. Без этого игра работает так же. Нужен плагин ${p} и аккаунт в нём.`,
    status: "Синхронизация",
    syncNow: "Синхронизировать",
    open: (p: string) => `Открыть ${p}`,
    st: {
      off: "Выключено. Прогресс хранится только на этом устройстве.",
      "no-platform": (p: string) => `${p} не установлен или выключен в этом хранилище. Прогресс сохраняется локально.`,
      "platform-disabled": (p: string) => `${p} офлайн (выключен переключатель «Онлайн / синхронизация»). Результаты ждут в очереди.`,
      "not-configured": (p: string) => `В ${p} не настроен сервер. Откройте настройки ${p}.`,
      "signed-out": (p: string) => `Войдите в ${p}, чтобы синхронизировать. Результаты ждут в очереди.`,
      "needs-link": (p: string) => `Нажмите «Синхронизировать» и разрешите игру в ${p}.`,
      "link-denied": (p: string) => `Доступ в ${p} не разрешён. Нажмите «Синхронизировать», чтобы спросить снова.`,
      syncing: "Синхронизация…",
      synced: "Синхронизировано",
      pending: "Ожидает отправки",
      error: "Ошибка, повторим позже",
    },
    pending: (n: number) => `в очереди: ${n}`,
    last: (d: string) => `последняя: ${d}`,
    as: (u: string) => `как ${u}`,
  },
};

/** One-line human status, e.g. for a game's menu or HUD. */
export function statusText(s: SyncStatus, lang: SdkLang = "en"): string {
  const t = T[lang] ?? T.en;
  const v = t.st[s.state];
  const parts = [typeof v === "function" ? v(s.platformName) : v];
  if (s.username && (s.state === "synced" || s.state === "pending")) parts.push(t.as("@" + s.username));
  if (s.pending && s.state !== "off") parts.push(t.pending(s.pending));
  if (s.lastSyncAt) parts.push(t.last(new Date(s.lastSyncAt).toLocaleString(lang)));
  if (s.lastError && (s.state === "error" || s.state === "pending")) parts.push(`(${s.lastError})`);
  return parts.join(" · ");
}

/**
 * Adds the toggle and a live status row. Call from your PluginSettingTab.display().
 * Returns a dispose function: call it from hide() to stop status updates.
 */
export function addConnectSetting(containerEl: HTMLElement, client: SClient, Setting: SettingCtor, opts: { lang?: SdkLang } = {}): () => void {
  const t = T[opts.lang ?? "en"] ?? T.en;
  const p = client.platformName;
  const toggleRow = new Setting(containerEl);
  toggleRow.setName(t.name(p));
  toggleRow.setDesc(t.desc(p));
  toggleRow.addToggle((tg) => {
    tg.setValue(client.isConnectEnabled());
    tg.onChange((v) => { void client.setConnect(v); });
  });
  const statusRow = new Setting(containerEl);
  statusRow.setName(t.status);
  statusRow.addButton((b) => { b.setButtonText(t.syncNow); b.onClick(() => { void client.syncNow(); }); });
  statusRow.addButton((b) => { b.setButtonText(t.open(p)); b.onClick(() => client.openPlatform()); });
  const render = (s: SyncStatus) => statusRow.setDesc(statusText(s, opts.lang));
  render(client.getStatus());
  return client.on("status", render);
}
