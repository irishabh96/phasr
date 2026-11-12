import { describe, expect, it } from "vitest";
import { disableTextAssistance } from "./textAssist";

describe("disableTextAssistance", () => {
  it("turns off predictions, spellcheck, autocorrect and autocomplete on the hidden textarea", () => {
    const ta = document.createElement("textarea");
    disableTextAssistance(ta);
    expect(ta.getAttribute("writingsuggestions")).toBe("false");
    expect(ta.getAttribute("spellcheck")).toBe("false");
    expect(ta.getAttribute("autocorrect")).toBe("off");
    expect(ta.getAttribute("autocapitalize")).toBe("off");
    expect(ta.getAttribute("autocomplete")).toBe("off");
  });

  it("covers the contenteditable host too, which is what term.focus() focuses", () => {
    const host = document.createElement("div");
    host.setAttribute("contenteditable", "true");
    host.setAttribute("role", "textbox");
    disableTextAssistance(host);
    expect(host.getAttribute("writingsuggestions")).toBe("false");
    expect(host.getAttribute("spellcheck")).toBe("false");
    expect(host.getAttribute("autocorrect")).toBe("off");
    expect(host.getAttribute("autocapitalize")).toBe("off");
    expect(host.getAttribute("aria-autocomplete")).toBe("none");
    // `autocomplete` is a form-control attribute; the host doesn't get one.
    expect(host.hasAttribute("autocomplete")).toBe(false);
  });
});
