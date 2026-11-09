import type { QueryClient } from "@tanstack/react-query";
import {
  applySavedFile,
  isFileChangedOnDisk,
  workspaceFileKeys,
} from "@/lib/hooks/useWorkspaceFiles";
import { humanizeError } from "@/lib/humanizeError";
import { fileBufferKey, useUiStore, type FileBuffer } from "@/lib/store";
import { tauri } from "@/lib/tauri";
import { showToast } from "@/lib/toast";
import type { WorkspaceFile } from "@/lib/types";

/**
 * The Files pane's editor buffers (A-Editor). Everything here reads and
 * writes `useUiStore().fileBuffers` at call time, never a render's
 * closure, so a toast's "Keep mine" or a save that finishes after the
 * editor unmounted (Edit ↔ Diff, task switch) acts on the latest state.
 */

const get = (key: string) => useUiStore.getState().fileBuffers[key];
const update = (key: string, fn: (prev: FileBuffer | undefined) => FileBuffer | undefined) =>
  useUiStore.getState().updateFileBuffer(key, fn);

function fresh(file: Pick<WorkspaceFile, "hash" | "contents">, rev = 0): FileBuffer {
  return {
    base: { hash: file.hash, contents: file.contents },
    buffer: null,
    dirty: false,
    diskChanged: false,
    saving: null,
    saveQueued: null,
    rev,
  };
}

/**
 * A disk version arrived (first load, watcher refetch, pane shown again).
 * Adopt it when nothing is lost; flag it when it lands under unsaved edits.
 * Our own write — seen by the watcher before the command replies — is
 * neither: the base moves when the reply lands.
 */
export function reconcileDiskVersion(
  workspaceId: string,
  path: string,
  file: Pick<WorkspaceFile, "hash" | "contents"> | undefined,
) {
  if (!file) return;
  update(fileBufferKey(workspaceId, path), (e) => {
    if (!e) return fresh(file);
    if (file.hash === e.base.hash) return e.diskChanged ? { ...e, diskChanged: false } : e;
    if (e.saving !== null && file.contents === e.saving) return e;
    if (!e.dirty) {
      // Nothing to lose: show the new version.
      return { ...fresh(file, e.rev + 1), saving: e.saving, saveQueued: e.saveQueued };
    }
    if (file.contents === e.buffer) {
      // The disk caught up with the buffer (e.g. the same edit made twice).
      return { ...e, base: { hash: file.hash, contents: file.contents }, buffer: null, diskChanged: false };
    }
    return e.diskChanged ? e : { ...e, diskChanged: true };
  });
}

/** The user typed. */
export function setFileBufferText(workspaceId: string, path: string, text: string) {
  update(fileBufferKey(workspaceId, path), (e) => (e && e.buffer !== text ? { ...e, buffer: text } : e));
}

/** "Reload theirs": drop the edits and take what's on disk now. */
export function reloadFileBuffer(
  workspaceId: string,
  path: string,
  file: Pick<WorkspaceFile, "hash" | "contents"> | undefined,
) {
  if (!file) return;
  update(fileBufferKey(workspaceId, path), (e) => ({
    ...fresh(file, (e?.rev ?? 0) + 1),
    saving: e?.saving ?? null,
  }));
}

function conflictToast(queryClient: QueryClient, workspaceId: string, path: string, title: string, message: string) {
  showToast({
    intent: "warning",
    title,
    message,
    // Reads the store when clicked: saves whatever is in the editor then.
    action: { label: "Keep mine", onClick: () => saveFileBuffer(queryClient, workspaceId, path, { overwrite: true }) },
  });
}

/**
 * ⌘S. Single-flight per file: a save pressed while one is in flight queues
 * exactly one follow-up (only if there are newer edits), which runs with the
 * hash the first save produced — so two quick ⌘S never race each other into
 * a false "agent changed this file". `overwrite` = "Keep mine" (no hash).
 */
export function saveFileBuffer(
  queryClient: QueryClient,
  workspaceId: string,
  path: string,
  { overwrite = false }: { overwrite?: boolean } = {},
) {
  const key = fileBufferKey(workspaceId, path);
  const e = get(key);
  if (!e || e.buffer === null) return;
  if (e.saving !== null) {
    if (e.buffer !== e.saving || overwrite) {
      update(key, (p) => p && { ...p, saveQueued: { overwrite: overwrite || !!p.saveQueued?.overwrite } });
    }
    return;
  }
  if (!e.dirty && !overwrite) return;
  if (e.diskChanged && !overwrite) {
    conflictToast(queryClient, workspaceId, path, "This file changed on disk", "Reload to take the agent's version, or keep yours.");
    return;
  }

  const contents = e.buffer;
  const fromHash = e.base.hash;
  update(key, (p) => p && { ...p, saving: contents, saveQueued: null });

  tauri.writeWorkspaceFile(workspaceId, path, contents, overwrite ? null : fromHash).then(
    (result) => {
      // The base moves BEFORE the cache does, so the editor never sees its
      // own write as a new disk version.
      update(key, (p) =>
        p && {
          ...p,
          base: { hash: result.hash, contents },
          buffer: p.buffer === contents ? null : p.buffer,
          diskChanged: false,
          saving: null,
        },
      );
      applySavedFile(queryClient, workspaceId, path, contents, result.hash, { force: overwrite, fromHash });
      // A version cached during the save that isn't ours is newer than it.
      reconcileDiskVersion(workspaceId, path, queryClient.getQueryData<WorkspaceFile>(workspaceFileKeys.file(workspaceId, path)));
      const after = get(key);
      if (after?.saveQueued) {
        const queued = after.saveQueued;
        update(key, (p) => p && { ...p, saveQueued: null });
        saveFileBuffer(queryClient, workspaceId, path, queued);
      }
    },
    (err: unknown) => {
      const conflict = isFileChangedOnDisk(err);
      update(key, (p) => p && { ...p, saving: null, saveQueued: null, diskChanged: p.diskChanged || conflict });
      if (conflict) {
        // Show the user what's on disk now.
        void queryClient.invalidateQueries({ queryKey: workspaceFileKeys.file(workspaceId, path) });
        conflictToast(
          queryClient,
          workspaceId,
          path,
          "The agent changed this file since you opened it",
          "Your edits are still in the editor.",
        );
      } else {
        showToast({ intent: "error", title: "Couldn't save", message: humanizeError(err) });
      }
    },
  );
}
