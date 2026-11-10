import { describe, expect, it } from "vitest";
import {
  attachmentFromPath,
  formatAttachmentBlock,
  nameFromAttachments,
  relativeTo,
  withAttachmentBlock,
} from "@/lib/attachments";

const REPO = "/Users/me/code/app";
const WORKTREE = "/Users/me/code/app/.phasr/worktrees/task-1";

describe("formatAttachmentBlock", () => {
  it("is empty with nothing attached", () => {
    expect(formatAttachmentBlock([], [REPO])).toBe("");
    expect(withAttachmentBlock("do it", [], [REPO])).toBe("do it");
  });

  it("lists files outside the roots by absolute path", () => {
    expect(
      formatAttachmentBlock([{ path: "/Users/me/Desktop/shot.png" }, { path: "/tmp/notes.md" }], [REPO]),
    ).toBe("Attached files:\n- /Users/me/Desktop/shot.png\n- /tmp/notes.md");
  });

  it("writes files inside the repo or worktree relative to it", () => {
    const block = formatAttachmentBlock(
      [{ path: `${REPO}/src/app.ts` }, { path: `${WORKTREE}/src/new.ts` }, { path: "/abs/x.png" }],
      [WORKTREE, REPO],
    );
    // The worktree sits inside the repo; the most specific root wins.
    expect(block).toBe("Attached files:\n- src/app.ts\n- src/new.ts\n- /abs/x.png");
  });

  it("needs a real path boundary, tolerates trailing slashes and missing roots", () => {
    expect(relativeTo(`${REPO}-other/a.ts`, [REPO])).toBeNull();
    expect(relativeTo(REPO, [REPO])).toBeNull();
    expect(relativeTo(`${REPO}/a.ts`, [`${REPO}/`])).toBe("a.ts");
    expect(relativeTo(`${REPO}/a.ts`, [null, undefined, ""])).toBeNull();
  });

  it("appends after a blank line, or stands alone without text", () => {
    expect(withAttachmentBlock("Fix the crash", [{ path: "/a/b.png" }])).toBe(
      "Fix the crash\n\nAttached files:\n- /a/b.png",
    );
    expect(withAttachmentBlock("", [{ path: "/a/b.png" }])).toBe("Attached files:\n- /a/b.png");
  });
});

describe("attachment helpers", () => {
  it("classifies images by extension and names by file", () => {
    expect(attachmentFromPath("/x/Shot 1.PNG")).toEqual({ path: "/x/Shot 1.PNG", name: "Shot 1.PNG", kind: "image" });
    expect(attachmentFromPath("/x/main.rs")).toMatchObject({ name: "main.rs", kind: "file" });
  });

  it("names a task from the first file", () => {
    expect(nameFromAttachments([attachmentFromPath("/x/Login-Error.png")])).toBe("login-error");
    expect(nameFromAttachments([attachmentFromPath("/x/Makefile")])).toBe("makefile");
    expect(nameFromAttachments([])).toBe("");
  });
});
