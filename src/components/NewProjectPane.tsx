import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { homeDir } from "@tauri-apps/api/path";
import { ArrowLeft, FolderOpen, FolderPlus, GitBranch, LayoutGrid } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { useNavigateToRepoEntry } from "@/lib/hooks/useNavigateToRepoEntry";
import {
  repositoryKeys,
  useCreateRepository,
} from "@/lib/hooks/useRepositories";
import { tauri } from "@/lib/tauri";
import { TEMPLATES, type Template } from "@/lib/templates";
import { GlassButton } from "@/components/ui/GlassButton";
import { GlassInput } from "@/components/ui/GlassInput";
import { cn } from "@/lib/utils";

type Mode = "empty" | "clone" | "template";

/**
 * Center-pane that replaces NewProjectWizard. Always-visible Location
 * field + three mode tiles. Selecting a tile reveals the per-mode form:
 *
 *   - Empty:    git init <location>/<name>          → Create
 *   - Clone:    git clone <url> <location>/<name>   → Clone (button shows "Cloning…" in flight)
 *   - Template: pick + git_init_from_template       → Use template (uses the existing TEMPLATES list)
 *
 * On success, registers the new Repository row and navigates to
 * repo entry. Empty mode does NOT route through the
 * GitInitConfirmModal because the user explicitly chose to create a
 * fresh git repo.
 */
export function NewProjectPane() {
  const navigate = useNavigate();
  const navigateToRepoEntry = useNavigateToRepoEntry();
  const queryClient = useQueryClient();
  const createRepository = useCreateRepository();

  const [location, setLocation] = useState("");
  const [mode, setMode] = useState<Mode>("empty");

  // Empty mode pre-fills "my-project" rather than just showing it as
  // placeholder — Create is one click away.
  const [name, setName] = useState("my-project");
  const [url, setUrl] = useState("");
  const [selectedTemplate, setSelectedTemplate] = useState<Template | null>(null);
  const [templateName, setTemplateName] = useState("");
  // Tracks whether the user has edited the template-mode name field.
  // While `false`, switching templates re-fills the field with the
  // newly-selected template's id. The first manual edit flips it
  // permanently for this session.
  const [templateNameDirty, setTemplateNameDirty] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Seed the location default from `${homeDir}/.phasr/projects` on mount.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const home = await homeDir();
        const trimmed = home.replace(/\/$/, "");
        if (!cancelled) setLocation(`${trimmed}/.phasr/projects`);
      } catch {
        if (!cancelled) setLocation("");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const browse = async () => {
    const selected = await openDialog({
      directory: true,
      multiple: false,
      title: "Pick a parent folder for the new project",
      ...(location ? { defaultPath: location } : {}),
    });
    if (typeof selected === "string") setLocation(selected);
  };

  const settle = async (repoName: string, dest: string) => {
    const repo = await createRepository.mutateAsync({
      name: repoName,
      localPath: dest,
    });
    queryClient.invalidateQueries({ queryKey: repositoryKeys.list() });
    void navigateToRepoEntry(repo.id);
    void navigate({ to: "/" });
  };

  const runEmpty = async () => {
    if (!name.trim() || !location.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      const dest = `${location.replace(/\/$/, "")}/${name.trim()}`;
      await tauri.gitInitEmptyRepository(dest);
      await settle(name.trim(), dest);
    } catch (err) {
      setError(String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const runClone = async () => {
    if (!url.trim() || !location.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      const derived = deriveNameFromUrl(url.trim());
      const dest = `${location.replace(/\/$/, "")}/${derived}`;
      await tauri.gitCloneRepository(url.trim(), dest);
      await settle(derived, dest);
    } catch (err) {
      setError(String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const runTemplate = async () => {
    if (!selectedTemplate || !templateName.trim() || !location.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      const dest = `${location.replace(/\/$/, "")}/${templateName.trim()}`;
      await tauri.gitInitFromTemplate(selectedTemplate.gitUrl, dest);
      await settle(templateName.trim(), dest);
    } catch (err) {
      setError(String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 items-center justify-center overflow-y-auto px-6 py-10">
      <div className="my-auto w-full max-w-3xl space-y-6">
        <header>
          <button
            type="button"
            onClick={() => void navigate({ to: "/" })}
            className="mb-5 inline-flex items-center gap-1.5 text-[11px] text-(--color-text-muted) transition-colors hover:text-(--color-text-primary)"
          >
            <ArrowLeft size={11} />
            Back
          </button>
          <h1 className="text-[22px] font-semibold leading-tight tracking-tight text-(--color-text-primary)">
            New Project
          </h1>
        </header>

        <div className="space-y-2">
          <label className="block text-[12px] font-medium text-(--color-text-primary)">
            Location
          </label>
          <div className="flex items-stretch gap-2">
            <GlassInput
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              placeholder="/Users/you/projects"
              className="h-10 flex-1 font-mono text-[12.5px]"
            />
            <button
              type="button"
              onClick={browse}
              aria-label="Browse for parent folder"
              title="Browse for parent folder"
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] border border-(--glass-border-strong) bg-(--color-bg-elevated) text-(--color-text-secondary) transition-colors hover:bg-(--color-bg-hover) hover:text-(--color-text-primary)"
            >
              <FolderOpen size={14} />
            </button>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-3">
          <ModeTile
            active={mode === "empty"}
            onClick={() => setMode("empty")}
            icon={<FolderPlus size={20} />}
            title="Empty"
            description="New git repository from scratch"
          />
          <ModeTile
            active={mode === "clone"}
            onClick={() => setMode("clone")}
            icon={<GitBranch size={20} />}
            title="Clone"
            description="Clone from a remote URL"
          />
          <ModeTile
            active={mode === "template"}
            onClick={() => setMode("template")}
            icon={<LayoutGrid size={20} />}
            title="Template"
            description="Start from a project template"
          />
        </div>

        {mode === "empty" && (
          <div className="space-y-2 border-t border-(--color-border-subtle) pt-5">
            <label className="block text-[12px] font-medium text-(--color-text-primary)">
              Repository Name
            </label>
            <GlassInput
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="my-project"
              className="h-10"
              autoFocus
            />
            <Footer
              error={error}
              right={
                <GlassButton
                  variant="primary"
                  size="md"
                  onClick={() => void runEmpty()}
                  disabled={submitting || !name.trim() || !location.trim()}
                >
                  {submitting ? "Creating…" : "Create"}
                </GlassButton>
              }
            />
          </div>
        )}

        {mode === "clone" && (
          <div className="space-y-2 border-t border-(--color-border-subtle) pt-5">
            <label className="block text-[12px] font-medium text-(--color-text-primary)">
              Repository URL
            </label>
            <GlassInput
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https:// or git@github.com:user/repo.git"
              className="h-10 font-mono text-[12.5px]"
              autoFocus
            />
            <Footer
              error={error}
              right={
                <GlassButton
                  variant="primary"
                  size="md"
                  onClick={() => void runClone()}
                  disabled={submitting || !url.trim() || !location.trim()}
                >
                  {submitting ? "Cloning…" : "Clone"}
                </GlassButton>
              }
            />
          </div>
        )}

        {mode === "template" && (
          <div className="space-y-3 border-t border-(--color-border-subtle) pt-5">
            <div className="grid grid-cols-2 gap-2">
              {TEMPLATES.map((t) => (
                <TemplateCard
                  key={t.id}
                  template={t}
                  active={selectedTemplate?.id === t.id}
                  onClick={() => {
                    setSelectedTemplate(t);
                    // Refill the name field with the new template's id
                    // unless the user has manually edited it. An empty
                    // field is treated as "still auto-fillable".
                    if (!templateNameDirty || templateName.trim().length === 0) {
                      setTemplateName(t.id);
                      setTemplateNameDirty(false);
                    }
                  }}
                />
              ))}
            </div>
            {selectedTemplate && (
              <div className="space-y-2">
                <label className="block text-[12px] font-medium text-(--color-text-primary)">
                  Repository Name
                </label>
                <GlassInput
                  value={templateName}
                  onChange={(e) => {
                    setTemplateName(e.target.value);
                    setTemplateNameDirty(true);
                  }}
                  placeholder={selectedTemplate.id}
                  className="h-10"
                />
              </div>
            )}
            <Footer
              error={error}
              right={
                <GlassButton
                  variant="primary"
                  size="md"
                  onClick={() => void runTemplate()}
                  disabled={
                    submitting ||
                    !selectedTemplate ||
                    !templateName.trim() ||
                    !location.trim()
                  }
                >
                  {submitting ? "Setting up…" : "Use template"}
                </GlassButton>
              }
            />
          </div>
        )}
      </div>
    </div>
  );
}

function ModeTile({
  active,
  onClick,
  icon,
  title,
  description,
}: {
  active: boolean;
  onClick: () => void;
  icon: ReactNode;
  title: string;
  description: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "flex flex-col items-center gap-2 rounded-[10px] border-2 px-4 py-5 text-center transition-all",
        active
          ? "border-(--color-accent-500) bg-[color-mix(in_oklab,var(--color-accent-500)_15%,transparent)] shadow-[0_0_0_3px_color-mix(in_oklab,var(--color-accent-500)_20%,transparent)]"
          : "border-(--glass-border-hairline) bg-(--color-bg-surface) hover:border-(--glass-border-strong) hover:bg-(--color-bg-hover)",
      )}
    >
      <span className={cn(active ? "text-(--color-accent-400)" : "text-(--color-text-primary)")}>
        {icon}
      </span>
      <span
        className={cn(
          "text-[14px] text-(--color-text-primary)",
          active ? "font-semibold" : "font-medium",
        )}
      >
        {title}
      </span>
      <span className="text-[11.5px] text-(--color-text-secondary)">{description}</span>
    </button>
  );
}

function TemplateCard({
  template,
  active,
  onClick,
}: {
  template: Template;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "flex flex-col gap-1 rounded-[10px] border-2 p-3 text-left transition-all",
        active
          ? "border-(--color-accent-500) bg-[color-mix(in_oklab,var(--color-accent-500)_15%,transparent)] shadow-[0_0_0_3px_color-mix(in_oklab,var(--color-accent-500)_20%,transparent)]"
          : "border-(--glass-border-hairline) bg-(--color-bg-surface) hover:border-(--glass-border-strong) hover:bg-(--color-bg-hover)",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span
          className={cn(
            "text-[13px] text-(--color-text-primary)",
            active ? "font-semibold" : "font-medium",
          )}
        >
          {template.name}
        </span>
        {template.tag && (
          <span className="rounded bg-(--color-bg-elevated) px-1.5 py-0.5 text-[10px] uppercase tracking-[0.08em] text-(--color-text-muted)">
            {template.tag}
          </span>
        )}
      </div>
      <span className="text-[11.5px] text-(--color-text-secondary)">{template.description}</span>
    </button>
  );
}

function Footer({ error, right }: { error: string | null; right: ReactNode }) {
  return (
    <div className="mt-3 flex items-center justify-between border-t border-(--color-border-subtle) pt-3">
      {error ? (
        <span className="truncate text-[12px] text-(--color-danger)">{error}</span>
      ) : (
        <span />
      )}
      {right}
    </div>
  );
}

/**
 * `git@github.com:user/repo.git` → `repo`
 * `https://github.com/user/repo.git` → `repo`
 * `https://github.com/user/repo` → `repo`
 * Falls back to `"project"` for anything we can't parse.
 */
function deriveNameFromUrl(url: string): string {
  const trimmed = url.trim().replace(/\.git\/?$/, "").replace(/\/$/, "");
  const lastSlash = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf(":"));
  const tail = lastSlash >= 0 ? trimmed.slice(lastSlash + 1) : trimmed;
  return tail.length > 0 ? tail : "project";
}
