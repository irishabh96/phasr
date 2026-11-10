import { afterEach, describe, expect, it, vi } from "vitest";
import { registerAttachmentTarget } from "@/lib/attachmentDropTarget";
import { setPromptInsertTarget } from "@/lib/promptInsertTarget";
import { routeDroppedPaths } from "@/lib/terminal/drop";

const sendInputToTask = vi.fn(() => Promise.resolve());
vi.mock("@/lib/tauri", () => ({ tauri: { sendInputToTask: (...a: unknown[]) => sendInputToTask(...(a as [])) } }));

// jsdom has no hit-testing; tests point it at what they need.
let hitElement: Element | null = null;
document.elementFromPoint = () => hitElement;

const cleanups: Array<() => void> = [];
afterEach(() => {
  hitElement = null;
  cleanups.splice(0).forEach((c) => c());
  setPromptInsertTarget(null);
  document.body.innerHTML = "";
  sendInputToTask.mockClear();
});

function mount(): HTMLElement {
  const el = document.createElement("div");
  const input = document.createElement("textarea");
  el.appendChild(input);
  document.body.appendChild(el);
  return el;
}

describe("routeDroppedPaths with attachment targets", () => {
  it("a modal target takes every drop", () => {
    const el = mount();
    const add = vi.fn();
    cleanups.push(registerAttachmentTarget({ element: () => el, modal: true, add }));
    routeDroppedPaths(["/a.png", "/b.ts"], { x: 1, y: 1 });
    expect(add).toHaveBeenCalledWith(["/a.png", "/b.ts"]);
  });

  it("a drop over the target's element becomes attachments", () => {
    const el = mount();
    const add = vi.fn();
    cleanups.push(registerAttachmentTarget({ element: () => el, add }));
    hitElement = el.firstElementChild;
    routeDroppedPaths(["/a.png"], { x: 5, y: 5 });
    expect(add).toHaveBeenCalledWith(["/a.png"]);
  });

  it("a focused target beats the prompt inserter", () => {
    const el = mount();
    const add = vi.fn();
    const insert = vi.fn();
    cleanups.push(registerAttachmentTarget({ element: () => el, add }));
    setPromptInsertTarget(insert);
    (el.firstElementChild as HTMLTextAreaElement).focus();
    routeDroppedPaths(["/a.png"], null);
    expect(add).toHaveBeenCalledWith(["/a.png"]);
    expect(insert).not.toHaveBeenCalled();
  });

  it("an unfocused target elsewhere keeps today's behaviour", () => {
    const el = mount();
    const add = vi.fn();
    const insert = vi.fn();
    cleanups.push(registerAttachmentTarget({ element: () => el, add }));
    setPromptInsertTarget(insert);
    routeDroppedPaths(["/a.png"], null);
    expect(add).not.toHaveBeenCalled();
    expect(insert).toHaveBeenCalledWith("/a.png");
  });

  it("unregistering stops routing to it", () => {
    const el = mount();
    const add = vi.fn();
    registerAttachmentTarget({ element: () => el, modal: true, add })();
    setPromptInsertTarget(vi.fn());
    routeDroppedPaths(["/a.png"], null);
    expect(add).not.toHaveBeenCalled();
  });
});
