import { describe, expect, it } from "vitest";
import {
  originFromRepoHome,
  originFromWorkspace,
} from "@/lib/noteProvenance";
import type { InnerTab, RepoInnerTab } from "@/lib/store";

const tab = (partial: Partial<InnerTab>): InnerTab => ({
  id: "t1",
  kind: "main",
  title: "Agent",
  closable: false,
  ...partial,
});

const repoTab = (partial: Partial<RepoInnerTab>): RepoInnerTab => ({
  id: "home",
  kind: "home",
  title: "Home",
  closable: false,
  ...partial,
});

describe("originFromWorkspace", () => {
  it("agent (main) tab → workspace origin with Agent hint", () => {
    expect(originFromWorkspace("ws-1", tab({ kind: "main" }))).toEqual({
      originKind: "workspace",
      originWorkspaceId: "ws-1",
      originLabelHint: "Agent",
    });
  });

  it("terminal tab → terminal origin carrying pty id and tab title", () => {
    expect(
      originFromWorkspace(
        "ws-1",
        tab({
          kind: "terminal",
          title: "Terminal 2",
          ptySessionId: "session:abc",
        }),
      ),
    ).toEqual({
      originKind: "terminal",
      originWorkspaceId: "ws-1",
      originTerminalId: "session:abc",
      originLabelHint: "Terminal 2",
    });
  });

  it("terminal tab before its PTY registered → null terminal id", () => {
    const origin = originFromWorkspace(
      "ws-1",
      tab({ kind: "terminal", title: "Terminal 1" }),
    );
    expect(origin.originTerminalId).toBeNull();
  });

  it("preview tab / unknown tab → plain workspace origin", () => {
    expect(
      originFromWorkspace("ws-1", tab({ kind: "preview" })).originKind,
    ).toBe("workspace");
    expect(originFromWorkspace("ws-1", undefined)).toEqual({
      originKind: "workspace",
      originWorkspaceId: "ws-1",
      originLabelHint: null,
    });
  });
});

describe("originFromRepoHome", () => {
  it("home tab → repository origin", () => {
    expect(originFromRepoHome(repoTab({ kind: "home" }))).toEqual({
      originKind: "repository",
    });
    expect(originFromRepoHome(undefined)).toEqual({
      originKind: "repository",
    });
  });

  it("repo-home terminal → terminal origin with NO workspace", () => {
    const origin = originFromRepoHome(
      repoTab({
        kind: "terminal",
        title: "Terminal 1",
        ptySessionId: "session:xyz",
      }),
    );
    expect(origin).toEqual({
      originKind: "terminal",
      originTerminalId: "session:xyz",
      originLabelHint: "Terminal 1",
    });
    expect("originWorkspaceId" in origin).toBe(false);
  });
});
