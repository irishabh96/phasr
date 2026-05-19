import { open } from "@tauri-apps/plugin-dialog";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { AlertTriangle, CheckCircle2, FolderOpen, XCircle } from "lucide-react";
import { useState } from "react";
import { useCreateRepository, useRepositories } from "@/lib/hooks/useRepositories";
import { tauri } from "@/lib/tauri";

export function AddRepositoryForm() {
  const [name, setName] = useState("");
  const [localPath, setLocalPath] = useState("");
  const createRepository = useCreateRepository();
  const { data: existing } = useRepositories();
  const navigate = useNavigate();

  const trimmedPath = localPath.trim();

  const validation = useQuery({
    queryKey: ["pathValidation", trimmedPath],
    queryFn: () => tauri.validateRepositoryPath(trimmedPath),
    enabled: trimmedPath.length > 0,
    staleTime: 1000,
  });

  const status = validation.data;
  const canSubmit =
    name.trim().length > 0 &&
    (trimmedPath.length === 0 || (status?.exists === true && status.isDir === true));

  const duplicate = trimmedPath
    ? existing?.find(
        (r) =>
          r.localPath &&
          status?.absolutePath &&
          r.localPath.replace(/\/$/, "") === status.absolutePath.replace(/\/$/, ""),
      )
    : undefined;

  const handleBrowse = async () => {
    const selected = await open({
      directory: true,
      multiple: false,
      title: "Pick a folder to use as a repository",
    });
    if (typeof selected === "string") {
      setLocalPath(selected);
      if (!name.trim()) {
        const segments = selected.split(/[/\\]/).filter(Boolean);
        const last = segments[segments.length - 1];
        if (last) setName(last);
      }
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    const repository = await createRepository.mutateAsync({
      name: name.trim(),
      ...(trimmedPath ? { localPath: trimmedPath } : {}),
    });
    setName("");
    setLocalPath("");
    navigate({
      to: "/repositories/$repositoryId",
      params: { repositoryId: repository.id },
    });
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Repository name"
          className="min-w-[180px] flex-1"
        />
        <div className="flex min-w-[280px] flex-[2] items-stretch gap-1">
          <input
            value={localPath}
            onChange={(e) => setLocalPath(e.target.value)}
            placeholder="/Users/you/code/repo (optional)"
            className="flex-1"
          />
          <button
            type="button"
            onClick={handleBrowse}
            title="Browse for folder"
            className="flex items-center gap-1 rounded-md border border-(--color-border-default) bg-(--color-bg-input) px-2.5 text-sm text-(--color-text-secondary) transition-colors hover:border-(--color-border-strong) hover:text-(--color-text-primary)"
          >
            <FolderOpen size={14} />
            Browse
          </button>
        </div>
        <button
          type="submit"
          disabled={createRepository.isPending || !canSubmit}
          className="rounded-md border border-(--color-accent-600) bg-(--color-accent-600) px-3 py-1.5 text-sm text-white transition-colors hover:bg-(--color-accent-500) disabled:opacity-50"
        >
          {createRepository.isPending ? "Adding…" : "Add repository"}
        </button>
      </div>

      {trimmedPath.length > 0 && status && <ValidationBadge status={status} />}
      {duplicate && (
        <div className="flex items-center gap-2 text-xs text-(--color-text-secondary)">
          <span>Already connected as "{duplicate.name}".</span>
          <button
            type="button"
            onClick={() =>
              navigate({
                to: "/repositories/$repositoryId",
                params: { repositoryId: duplicate.id },
              })
            }
            className="rounded border border-(--color-border-default) px-2 py-0.5 text-xs hover:border-(--color-accent-500)"
          >
            Open it
          </button>
        </div>
      )}
    </form>
  );
}

function ValidationBadge({
  status,
}: {
  status: {
    exists: boolean;
    isDir: boolean;
    isGitRepo: boolean;
    message: string | null;
    absolutePath: string | null;
  };
}) {
  if (!status.exists || !status.isDir) {
    return (
      <div className="flex items-center gap-2 text-xs text-(--color-danger)">
        <XCircle size={14} />
        <span>{status.message ?? "Path is not usable"}</span>
      </div>
    );
  }
  if (!status.isGitRepo) {
    return (
      <div className="flex items-center gap-2 text-xs text-(--color-warning)">
        <AlertTriangle size={14} />
        <span>{status.message ?? "Folder is not a git repository"}</span>
        <span className="text-(--color-text-muted)">
          (we'll offer to run `git init` later — repository will still add)
        </span>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2 text-xs text-(--color-success)">
      <CheckCircle2 size={14} />
      <span>
        Valid git repo
        {status.absolutePath ? (
          <span className="ml-2 text-(--color-text-muted)">{status.absolutePath}</span>
        ) : null}
      </span>
    </div>
  );
}
