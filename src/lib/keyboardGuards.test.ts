import { afterEach, describe, expect, it } from "vitest";
import { approvalKeyAllowed, inEditable, isOverlayOpen } from "@/lib/keyboardGuards";

function mount(html: string): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML = html;
  document.body.appendChild(host);
  return host;
}

afterEach(() => {
  document.body.innerHTML = "";
  window.history.replaceState({}, "", "/");
});

describe("isOverlayOpen", () => {
  it("is false on a bare page", () => {
    expect(isOverlayOpen()).toBe(false);
  });

  it("is true while a Radix dialog is open, false once it closes", () => {
    const host = mount(`<div role="dialog" data-state="open"></div>`);
    expect(isOverlayOpen()).toBe(true);
    host.firstElementChild!.setAttribute("data-state", "closed");
    expect(isOverlayOpen()).toBe(false);
  });

  it("counts an open alert dialog (confirm dialogs)", () => {
    mount(`<div role="alertdialog" data-state="open"></div>`);
    expect(isOverlayOpen()).toBe(true);
  });

  it("ignores the inline approval card (alertdialog without data-state)", () => {
    mount(`<section role="alertdialog" aria-label="Claude wants to run a shell command"></section>`);
    expect(isOverlayOpen()).toBe(false);
  });

  it("is true while the Settings sheet's search param is set", () => {
    window.history.replaceState({}, "", "/repositories/r/workspaces/w?settings=agents");
    expect(isOverlayOpen()).toBe(true);
    window.history.replaceState({}, "", "/repositories/r/workspaces/w?pane=changes");
    expect(isOverlayOpen()).toBe(false);
  });
});

describe("approvalKeyAllowed", () => {
  const surfaces = () =>
    mount(`
      <div data-testid="terminal-surface" data-terminal-role="agent"><textarea id="agent"></textarea></div>
      <div data-testid="terminal-surface" data-terminal-role="shell"><textarea id="shell"></textarea></div>
      <div data-testid="terminal-surface" data-terminal-role="run"><textarea id="run"></textarea></div>
      <input id="field" />
      <div class="cm-editor"><div id="editor" contenteditable="true"></div></div>
      <button id="button">x</button>
    `);
  const el = (id: string) => document.getElementById(id);

  it("deny (⌘⌫) never fires from any terminal — it is kill-line there", () => {
    surfaces();
    for (const id of ["agent", "shell", "run"]) {
      expect(approvalKeyAllowed("deny", el(id))).toBe(false);
    }
  });

  it("deny never fires from a field or the code editor", () => {
    surfaces();
    expect(approvalKeyAllowed("deny", el("field"))).toBe(false);
    expect(approvalKeyAllowed("deny", el("editor"))).toBe(false);
  });

  it("deny fires from the page itself", () => {
    surfaces();
    expect(approvalKeyAllowed("deny", document.body)).toBe(true);
    expect(approvalKeyAllowed("deny", el("button"))).toBe(true);
  });

  it("allow (⌘Y) fires from the page and the agent's own terminal only", () => {
    surfaces();
    expect(approvalKeyAllowed("allow", document.body)).toBe(true);
    expect(approvalKeyAllowed("allow", el("agent"))).toBe(true);
    expect(approvalKeyAllowed("allow", el("shell"))).toBe(false);
    expect(approvalKeyAllowed("allow", el("run"))).toBe(false);
    expect(approvalKeyAllowed("allow", el("field"))).toBe(false);
  });

  it("a terminal's hidden textarea is not an editable field", () => {
    surfaces();
    expect(inEditable(el("shell"))).toBe(false);
    expect(inEditable(el("field"))).toBe(true);
  });
});
