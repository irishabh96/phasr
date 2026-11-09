import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { settingLabel, settingsInScope, SyncedSettingsBanner } from "@/components/settings/SyncedSettingsBanner";
import type { UnconfirmedSetting } from "@/lib/types";

const listUnconfirmedSettings = vi.fn();
const confirmSettingsOnThisMachine = vi.fn();

vi.mock("@/lib/tauri", () => ({
  tauri: {
    listUnconfirmedSettings: () => listUnconfirmedSettings(),
    confirmSettingsOnThisMachine: (keys: string[]) => confirmSettingsOnThisMachine(keys),
  },
}));
vi.mock("@/lib/toast", () => ({ showToast: vi.fn() }));

const LONG = `claude --model opus ${"--flag ".repeat(20)}{{prompt}}`;
const ROWS: UnconfirmedSetting[] = [
  { key: "agentCommands.claude", value: LONG },
  { key: "agentCommands.codex", value: "codex --full-auto" },
  { key: "terminalShell", value: "/bin/zsh" },
  { key: "defaultPermissionMode", value: "skip-all" },
];

function renderBanner(scope: Parameters<typeof SyncedSettingsBanner>[0]["scope"]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <SyncedSettingsBanner scope={scope} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  listUnconfirmedSettings.mockReset().mockResolvedValue(ROWS);
  confirmSettingsOnThisMachine.mockReset().mockResolvedValue([]);
});

describe("settingsInScope", () => {
  it("keeps only the scope's own keys", () => {
    expect(settingsInScope(ROWS, "agentCommands").map((s) => s.key)).toEqual([
      "agentCommands.claude",
      "agentCommands.codex",
    ]);
    expect(settingsInScope(ROWS, "terminalShell").map((s) => s.key)).toEqual(["terminalShell"]);
    expect(settingsInScope(ROWS, "defaultPermissionMode").map((s) => s.key)).toEqual(["defaultPermissionMode"]);
  });
  it("tolerates an old string[] answer or nothing", () => {
    expect(settingsInScope(["terminalShell"] as never, "terminalShell")).toEqual([]);
    expect(settingsInScope(undefined, "terminalShell")).toEqual([]);
  });
  it("labels keys", () => {
    expect(settingLabel("agentCommands.claude")).toBe("Claude command template");
    expect(settingLabel("defaultPermissionMode")).toBe("Default permission mode");
  });
});

describe("SyncedSettingsBanner", () => {
  it("shows each value and allows one at a time, by exact key", async () => {
    renderBanner("agentCommands");
    expect(await screen.findByText("codex --full-auto")).toBeInTheDocument();
    expect(screen.getByText(LONG)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Allow Codex command template on this Mac" }));
    await waitFor(() => expect(confirmSettingsOnThisMachine).toHaveBeenCalledWith(["agentCommands.codex"]));
  });

  it("\"Allow all shown\" trusts exactly the shown keys, nothing from other scopes", async () => {
    renderBanner("agentCommands");
    fireEvent.click(await screen.findByRole("button", { name: "Allow all shown" }));
    await waitFor(() =>
      expect(confirmSettingsOnThisMachine).toHaveBeenCalledWith(["agentCommands.claude", "agentCommands.codex"]),
    );
  });

  it("expands a long value", async () => {
    renderBanner("agentCommands");
    const toggle = await screen.findByRole("button", { name: "Show full value" });
    fireEvent.click(toggle);
    expect(screen.getByRole("button", { name: "Show less" })).toHaveAttribute("aria-expanded", "true");
  });

  it("covers a synced default permission mode", async () => {
    renderBanner("defaultPermissionMode");
    expect(await screen.findByText(/Skip all \(skip-all\)/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Allow all shown" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Allow Default permission mode/ }));
    await waitFor(() => expect(confirmSettingsOnThisMachine).toHaveBeenCalledWith(["defaultPermissionMode"]));
  });

  it("renders nothing when there's nothing to confirm", async () => {
    listUnconfirmedSettings.mockResolvedValue([]);
    const { container } = renderBanner("terminalShell");
    await waitFor(() => expect(listUnconfirmedSettings).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });
});
