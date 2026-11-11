import { describe, expect, it } from "vitest";
import type { VoiceModel } from "@/lib/types";
import { activePolisher, activeVoiceModel, formatBytes } from "./prefs";
import { applyModelProgress } from "./useVoiceModels";

const model = (id: string, over: Partial<VoiceModel> = {}): VoiceModel => ({
  id,
  label: id,
  detail: "",
  sizeBytes: 100,
  languages: "english",
  installed: false,
  downloading: null,
  ...over,
});

describe("activeVoiceModel", () => {
  it("uses the preferred model only once it is downloaded", () => {
    const models = [model("a", { installed: true }), model("b")];
    expect(activeVoiceModel(models, "b")?.id).toBe("a");
    expect(activeVoiceModel([model("a", { installed: true }), model("b", { installed: true })], "b")?.id).toBe("b");
    expect(activeVoiceModel([model("a"), model("b")], null)).toBeNull();
    expect(activeVoiceModel(undefined, "a")).toBeNull();
  });
});

describe("applyModelProgress", () => {
  const base = [model("a"), model("b")];
  const p = (phase: "downloading" | "done" | "failed" | "cancelled", downloaded = 0) => ({
    modelId: "a",
    phase,
    downloaded,
    total: 100,
    error: null,
  });

  it("tracks bytes, then installs on done", () => {
    const mid = applyModelProgress(base, p("downloading", 40))!;
    expect(mid[0]).toMatchObject({ downloading: 40, installed: false });
    expect(mid[1]).toBe(base[1]);
    expect(applyModelProgress(mid, p("done", 100))![0]).toMatchObject({ downloading: null, installed: true });
  });

  it("clears progress on failure or cancel without installing", () => {
    const mid = applyModelProgress(base, p("downloading", 40))!;
    for (const phase of ["failed", "cancelled"] as const) {
      expect(applyModelProgress(mid, p(phase))![0]).toMatchObject({ downloading: null, installed: false });
    }
  });
});

it("formats sizes", () => {
  expect(formatBytes(147_964_211)).toBe("148 MB");
  expect(formatBytes(574_041_195)).toBe("574 MB");
  expect(formatBytes(1_624_555_275)).toBe("1.6 GB");
});

describe("activePolisher", () => {
  const both = [
    { id: "claude" as const, label: "Claude Haiku", available: true },
    { id: "codex" as const, label: "Codex gpt-6-luna", available: true },
  ];
  it("auto prefers Claude, falls back to Codex, else none", () => {
    expect(activePolisher("auto", both)?.id).toBe("claude");
    expect(activePolisher("auto", [{ ...both[0]!, available: false }, both[1]!])?.id).toBe("codex");
    expect(activePolisher("auto", both.map((p) => ({ ...p, available: false })))).toBeNull();
  });
  it("honours an explicit choice only when it's installed, and off", () => {
    expect(activePolisher("codex", both)?.id).toBe("codex");
    expect(activePolisher("codex", [both[0]!, { ...both[1]!, available: false }])).toBeNull();
    expect(activePolisher("off", both)).toBeNull();
    expect(activePolisher("auto", undefined)).toBeNull();
  });
});
