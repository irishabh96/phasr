import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type RefObject,
} from "react";
import { registerAttachmentTarget } from "@/lib/attachmentDropTarget";
import { attachmentFromPath, PASTE_IMAGE_EXT, type Attachment } from "@/lib/attachments";
import { humanizeError } from "@/lib/humanizeError";
import { tauri } from "@/lib/tauri";
import { showToast } from "@/lib/toast";

/**
 * One draft's attachments (New task, the composer): local state only.
 *
 * Three ways in:
 *   - `pick()`: the native file picker;
 *   - `onPaste`: image data on the clipboard (a screenshot) is saved by the
 *     backend and attached; a paste with text in it is left to the textarea;
 *   - drops: while `dropRef`'s element is mounted, Tauri file drops on it
 *     (or anywhere, when `modal`) become attachments instead of path text.
 */
export function useAttachments({
  dropRef,
  modal = false,
}: {
  dropRef?: RefObject<HTMLElement | null>;
  /** Take every drop while mounted (a dialog over the app). */
  modal?: boolean;
} = {}) {
  const [items, setItems] = useState<Attachment[]>([]);
  const pasteSeq = useRef(0);

  const addAttachments = useCallback((next: Attachment[]) => {
    setItems((cur) => {
      const seen = new Set(cur.map((a) => a.path));
      const fresh = next.filter((a) => {
        if (seen.has(a.path)) return false;
        seen.add(a.path);
        return true;
      });
      return fresh.length ? [...cur, ...fresh] : cur;
    });
  }, []);

  const addPaths = useCallback(
    (paths: string[]) => addAttachments(paths.filter(Boolean).map(attachmentFromPath)),
    [addAttachments],
  );

  const remove = useCallback((path: string) => {
    setItems((cur) => {
      const gone = cur.find((a) => a.path === path);
      if (gone?.previewUrl) URL.revokeObjectURL(gone.previewUrl);
      return cur.filter((a) => a.path !== path);
    });
  }, []);

  const clear = useCallback(() => {
    setItems((cur) => {
      for (const a of cur) if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
      return [];
    });
  }, []);

  // Free thumbnails when the draft goes away.
  const itemsRef = useRef(items);
  itemsRef.current = items;
  useEffect(
    () => () => {
      for (const a of itemsRef.current) if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
    },
    [],
  );

  const pick = useCallback(async () => {
    try {
      const picked = await openDialog({ multiple: true, directory: false, title: "Attach files" });
      if (!picked) return;
      addPaths(Array.isArray(picked) ? picked : [picked]);
    } catch (err) {
      showToast({ intent: "error", title: "Couldn't open the file picker", message: humanizeError(err) });
    }
  }, [addPaths]);

  const onPaste = useCallback(
    (e: ClipboardEvent<HTMLElement>) => {
      const data = e.clipboardData;
      if (!data) return;
      // Text wins: a spreadsheet copy carries an image AND the text, and the
      // text is what the user meant.
      if (data.getData("text/plain")) return;
      const images: File[] = [];
      for (const item of Array.from(data.items ?? [])) {
        if (item.kind !== "file" || !item.type.startsWith("image/")) continue;
        const file = item.getAsFile();
        if (file) images.push(file);
      }
      if (images.length === 0) return;
      e.preventDefault();
      for (const file of images) {
        const ext = PASTE_IMAGE_EXT[file.type];
        if (!ext) {
          showToast({
            intent: "warning",
            title: "Can't attach that image",
            message: "Paste a PNG, JPEG, GIF or WebP image.",
          });
          continue;
        }
        void (async () => {
          try {
            const bytes = new Uint8Array(await file.arrayBuffer());
            const path = await tauri.saveAttachment(bytes, ext);
            const n = ++pasteSeq.current;
            addAttachments([
              {
                path,
                name: n === 1 ? `Pasted image.${ext}` : `Pasted image ${n}.${ext}`,
                kind: "image",
                size: file.size,
                ...(typeof URL.createObjectURL === "function" ? { previewUrl: URL.createObjectURL(file) } : {}),
              },
            ]);
          } catch (err) {
            showToast({ intent: "error", title: "Couldn't attach the image", message: humanizeError(err) });
          }
        })();
      }
    },
    [addAttachments],
  );

  // Register as a drop target while mounted. Refs keep the registration
  // stable across renders.
  const addPathsRef = useRef(addPaths);
  addPathsRef.current = addPaths;
  useEffect(() => {
    if (!dropRef) return;
    return registerAttachmentTarget({
      element: () => dropRef.current,
      modal,
      add: (paths) => addPathsRef.current(paths),
    });
  }, [dropRef, modal]);

  return { items, addPaths, remove, clear, pick, onPaste };
}
