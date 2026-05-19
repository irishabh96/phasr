import * as Dialog from "@radix-ui/react-dialog";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useNavigate } from "@tanstack/react-router";
import {
  ArrowLeft,
  Check,
  FilePlus2,
  FolderOpen,
  GitBranch,
  Loader2,
  Sparkles,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { GlassButton } from "@/components/ui/GlassButton";
import { GlassInput } from "@/components/ui/GlassInput";
import { NewWorkspaceForm } from "@/components/NewWorkspaceForm";
import {
  useCreateRepository,
  useDefaultProjectsDir,
  useGitCloneRepository,
  useGitInitFromTemplate,
  useGitInitRepository,
} from "@/lib/hooks/useRepositories";
import { useUiStore } from "@/lib/store";
import { tauri } from "@/lib/tauri";
import { TEMPLATES, type Template } from "@/lib/templates";
import { cn } from "@/lib/utils";
import type { Repository } from "@/lib/types";

type Step =
  | { kind: "pick" }
  | { kind: "empty-config" }
  | { kind: "clone-config" }
  | { kind: "template-pick" }
  | { kind: "template-config"; template: Template }
  | { kind: "creating"; status: string }
  | { kind: "workspace"; repository: Repository }
  | { kind: "error"; message: string; back: Step };

const slugify = (s: string) =>
  s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "project";

export function NewProjectWizard() {
  const open = useUiStore((s) => s.newProjectModalOpen);
  const close = useUiStore((s) => s.closeNewProjectModal);
  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && close()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[180] bg-black/40 backdrop-blur-md data-[state=open]:animate-[modal-in_180ms_var(--ease-glass)]" />
        <Dialog.Content className="fixed left-1/2 top-[12vh] z-[190] w-[min(620px,calc(100vw-32px))] -translate-x-1/2 outline-none">
          <div className="glass-modal animate-[modal-in_220ms_var(--ease-glass)] overflow-hidden">
            <WizardBody onClose={close} />
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function WizardBody({ onClose }: { onClose: () => void }) {
  const [step, setStep] = useState<Step>({ kind: "pick" });

  // Reset to pick step whenever the modal opens fresh.
  const open = useUiStore((s) => s.newProjectModalOpen);
  useEffect(() => {
    if (open) setStep({ kind: "pick" });
  }, [open]);

  const title = useMemo(() => titleFor(step), [step]);
  const showBack = step.kind !== "pick" && step.kind !== "creating" && step.kind !== "workspace";

  return (
    <>
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-(--glass-border-hairline) px-4">
        {showBack && (
          <GlassButton
            variant="ghost"
            size="icon"
            onClick={() => setStep(backFor(step))}
            className="h-7 w-7"
            title="Back"
          >
            <ArrowLeft size={13} />
          </GlassButton>
        )}
        <Dialog.Title asChild>
          <h2 className="text-[13.5px] font-semibold leading-none">{title}</h2>
        </Dialog.Title>
        <div className="ml-auto">
          <GlassButton
            variant="ghost"
            size="icon"
            onClick={onClose}
            className="h-7 w-7"
            title="Close"
          >
            <X size={13} />
          </GlassButton>
        </div>
      </header>

      <div className="p-5">
        {step.kind === "pick" && <PickStep onPick={setStep} />}
        {step.kind === "empty-config" && (
          <EmptyConfigStep
            onCreated={(repository) => setStep({ kind: "workspace", repository })}
            onCreating={(status) => setStep({ kind: "creating", status })}
            onError={(message) => setStep({ kind: "error", message, back: { kind: "empty-config" } })}
          />
        )}
        {step.kind === "clone-config" && (
          <CloneConfigStep
            onCreated={(repository) => setStep({ kind: "workspace", repository })}
            onCreating={(status) => setStep({ kind: "creating", status })}
            onError={(message) => setStep({ kind: "error", message, back: { kind: "clone-config" } })}
          />
        )}
        {step.kind === "template-pick" && (
          <TemplatePickStep
            onPick={(template) => setStep({ kind: "template-config", template })}
          />
        )}
        {step.kind === "template-config" && (
          <TemplateConfigStep
            template={step.template}
            onCreated={(repository) => setStep({ kind: "workspace", repository })}
            onCreating={(status) => setStep({ kind: "creating", status })}
            onError={(message) =>
              setStep({ kind: "error", message, back: { kind: "template-config", template: step.template } })
            }
          />
        )}
        {step.kind === "creating" && <CreatingStep status={step.status} />}
        {step.kind === "workspace" && (
          <WorkspaceStep repository={step.repository} onDone={onClose} />
        )}
        {step.kind === "error" && (
          <ErrorStep message={step.message} onBack={() => setStep(step.back)} />
        )}
      </div>
    </>
  );
}

function titleFor(step: Step): string {
  switch (step.kind) {
    case "pick":
      return "Create a new project";
    case "empty-config":
      return "Empty repository";
    case "clone-config":
      return "Clone from URL";
    case "template-pick":
      return "Choose a template";
    case "template-config":
      return step.template.name;
    case "creating":
      return "Setting up your project";
    case "workspace":
      return "Create your first workspace";
    case "error":
      return "Something went wrong";
  }
}

function backFor(step: Step): Step {
  if (step.kind === "template-config") return { kind: "template-pick" };
  if (step.kind === "error") return step.back;
  return { kind: "pick" };
}

// ── Step 1: pick a sub-flow ────────────────────────────────────────

function PickStep({ onPick }: { onPick: (s: Step) => void }) {
  return (
    <div className="grid grid-cols-1 gap-2">
      <Tile
        icon={<FilePlus2 size={16} />}
        title="Empty repository"
        description="Start blank — Phasr runs git init in a new folder."
        onClick={() => onPick({ kind: "empty-config" })}
      />
      <Tile
        icon={<GitBranch size={16} />}
        title="Clone from URL"
        description="Paste a git URL and we'll clone it for you."
        onClick={() => onPick({ kind: "clone-config" })}
      />
      <Tile
        icon={<Sparkles size={16} />}
        title="From a template"
        description="Pick a starter — Next.js, Astro, T3, Tauri."
        onClick={() => onPick({ kind: "template-pick" })}
      />
    </div>
  );
}

function Tile({
  icon,
  title,
  description,
  onClick,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "glass-panel group flex items-center gap-3 p-4 text-left",
        "transition-all duration-150",
        "hover:border-(--glass-border-strong) hover:shadow-[var(--shadow-glow)]",
      )}
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] bg-[color-mix(in_oklab,var(--color-accent-500)_15%,transparent)] text-(--color-accent-400)">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[13.5px] font-medium leading-none">{title}</span>
        <span className="mt-1 block text-[12px] text-(--color-text-secondary)">{description}</span>
      </span>
      <ArrowLeft size={14} className="rotate-180 text-(--color-text-muted) transition-transform group-hover:translate-x-0.5 group-hover:text-(--color-text-primary)" />
    </button>
  );
}

// ── Step 2a: empty repo ────────────────────────────────────────────

function EmptyConfigStep({
  onCreated,
  onCreating,
  onError,
}: {
  onCreated: (repo: Repository) => void;
  onCreating: (status: string) => void;
  onError: (message: string) => void;
}) {
  const { data: defaultRoot } = useDefaultProjectsDir();
  const [name, setName] = useState("");
  const [location, setLocation] = useState("");
  const createRepo = useCreateRepository();
  const initRepo = useGitInitRepository();

  const computed = name.trim() && defaultRoot ? `${defaultRoot}/${slugify(name)}` : "";
  const finalLocation = location.trim() || computed;

  const handleBrowse = async () => {
    const selected = await openDialog({
      directory: true,
      multiple: false,
      title: "Choose a parent folder",
    });
    if (typeof selected === "string") {
      const slug = slugify(name || "project");
      setLocation(`${selected}/${slug}`);
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !finalLocation) return;
    try {
      onCreating("Creating folder…");
      await tauri.ensureDir(finalLocation);
      onCreating("Running git init…");
      const repository = await createRepo.mutateAsync({
        name: name.trim(),
        localPath: finalLocation,
      });
      await initRepo.mutateAsync(repository.id);
      onCreated(repository);
    } catch (err) {
      onError(String(err));
    }
  };

  return (
    <form onSubmit={submit} className="space-y-3">
      <Field label="Project name">
        <GlassInput
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="my-app"
        />
      </Field>
      <Field
        label="Location"
        hint={!location.trim() && computed ? `Default: ${computed}` : undefined}
      >
        <div className="flex items-stretch gap-1">
          <GlassInput
            value={location}
            onChange={(e) => setLocation(e.target.value)}
            placeholder={computed || "/Users/you/PhasrProjects/my-app"}
            className="flex-1"
          />
          <GlassButton type="button" variant="outline" size="md" onClick={handleBrowse}>
            <FolderOpen size={12} />
            Browse
          </GlassButton>
        </div>
      </Field>
      <div className="flex justify-end pt-1">
        <GlassButton type="submit" variant="primary" size="md" disabled={!name.trim()}>
          <Check size={13} />
          Create empty project
        </GlassButton>
      </div>
    </form>
  );
}

// ── Step 2b: clone URL ─────────────────────────────────────────────

function CloneConfigStep({
  onCreated,
  onCreating,
  onError,
}: {
  onCreated: (repo: Repository) => void;
  onCreating: (status: string) => void;
  onError: (message: string) => void;
}) {
  const { data: defaultRoot } = useDefaultProjectsDir();
  const [url, setUrl] = useState("");
  const [location, setLocation] = useState("");
  const createRepo = useCreateRepository();
  const cloneRepo = useGitCloneRepository();

  // Best-effort: derive a folder name from the URL.
  const derivedSlug = useMemo(() => {
    if (!url.trim()) return "";
    const cleaned = url.trim().replace(/\.git$/, "").replace(/\/$/, "");
    const last = cleaned.split(/[\\/]/).pop() ?? "";
    return slugify(last);
  }, [url]);

  const computed = derivedSlug && defaultRoot ? `${defaultRoot}/${derivedSlug}` : "";
  const finalLocation = location.trim() || computed;

  const handleBrowse = async () => {
    const selected = await openDialog({
      directory: true,
      multiple: false,
      title: "Choose a parent folder",
    });
    if (typeof selected === "string") {
      const slug = derivedSlug || "repo";
      setLocation(`${selected}/${slug}`);
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!url.trim() || !finalLocation) return;
    try {
      onCreating("Preparing folder…");
      const parent = finalLocation.split("/").slice(0, -1).join("/");
      if (parent) await tauri.ensureDir(parent);
      onCreating("Cloning repository…");
      await cloneRepo.mutateAsync({ url: url.trim(), destinationPath: finalLocation });
      onCreating("Registering project…");
      const repository = await createRepo.mutateAsync({
        name: derivedSlug || "repo",
        localPath: finalLocation,
      });
      onCreated(repository);
    } catch (err) {
      onError(String(err));
    }
  };

  return (
    <form onSubmit={submit} className="space-y-3">
      <Field label="Git URL">
        <GlassInput
          autoFocus
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://github.com/owner/repo.git"
        />
      </Field>
      <Field
        label="Location"
        hint={!location.trim() && computed ? `Default: ${computed}` : undefined}
      >
        <div className="flex items-stretch gap-1">
          <GlassInput
            value={location}
            onChange={(e) => setLocation(e.target.value)}
            placeholder={computed || "/Users/you/PhasrProjects/<repo>"}
            className="flex-1"
          />
          <GlassButton type="button" variant="outline" size="md" onClick={handleBrowse}>
            <FolderOpen size={12} />
            Browse
          </GlassButton>
        </div>
      </Field>
      <div className="flex justify-end pt-1">
        <GlassButton type="submit" variant="primary" size="md" disabled={!url.trim()}>
          <Check size={13} />
          Clone
        </GlassButton>
      </div>
    </form>
  );
}

// ── Step 2c: template pick + config ────────────────────────────────

function TemplatePickStep({ onPick }: { onPick: (template: Template) => void }) {
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
      {TEMPLATES.map((t) => (
        <button
          key={t.id}
          type="button"
          onClick={() => onPick(t)}
          className="glass-panel group flex flex-col gap-1.5 p-4 text-left transition-all duration-150 hover:border-(--glass-border-strong) hover:shadow-[var(--shadow-glow)]"
        >
          <div className="flex items-center justify-between">
            <span className="text-[13.5px] font-medium leading-none">{t.name}</span>
            {t.tag && (
              <span className="rounded-full bg-[color-mix(in_oklab,var(--color-accent-500)_15%,transparent)] px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-(--color-accent-400)">
                {t.tag}
              </span>
            )}
          </div>
          <p className="text-[12px] text-(--color-text-secondary)">{t.description}</p>
          <code className="mt-1 truncate text-[10.5px] text-(--color-text-muted)">
            {t.gitUrl.replace(/^https?:\/\//, "")}
          </code>
        </button>
      ))}
    </div>
  );
}

function TemplateConfigStep({
  template,
  onCreated,
  onCreating,
  onError,
}: {
  template: Template;
  onCreated: (repo: Repository) => void;
  onCreating: (status: string) => void;
  onError: (message: string) => void;
}) {
  const { data: defaultRoot } = useDefaultProjectsDir();
  const [name, setName] = useState("");
  const [location, setLocation] = useState("");
  const createRepo = useCreateRepository();
  const fromTemplate = useGitInitFromTemplate();

  const computed = name.trim() && defaultRoot ? `${defaultRoot}/${slugify(name)}` : "";
  const finalLocation = location.trim() || computed;

  const handleBrowse = async () => {
    const selected = await openDialog({
      directory: true,
      multiple: false,
      title: "Choose a parent folder",
    });
    if (typeof selected === "string") {
      const slug = slugify(name || "project");
      setLocation(`${selected}/${slug}`);
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !finalLocation) return;
    try {
      onCreating(`Cloning ${template.name}…`);
      const parent = finalLocation.split("/").slice(0, -1).join("/");
      if (parent) await tauri.ensureDir(parent);
      await fromTemplate.mutateAsync({
        templateGitUrl: template.gitUrl,
        destinationPath: finalLocation,
      });
      onCreating("Registering project…");
      const repository = await createRepo.mutateAsync({
        name: name.trim(),
        localPath: finalLocation,
      });
      onCreated(repository);
    } catch (err) {
      onError(String(err));
    }
  };

  return (
    <form onSubmit={submit} className="space-y-3">
      <div className="rounded-[10px] border border-(--glass-border-hairline) bg-[color-mix(in_oklab,white_3%,transparent)] p-3">
        <div className="text-[12px] text-(--color-text-secondary)">{template.description}</div>
        <code className="mt-1 block truncate text-[10.5px] text-(--color-text-muted)">
          {template.gitUrl}
        </code>
      </div>
      <Field label="Project name">
        <GlassInput
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="my-app"
        />
      </Field>
      <Field
        label="Location"
        hint={!location.trim() && computed ? `Default: ${computed}` : undefined}
      >
        <div className="flex items-stretch gap-1">
          <GlassInput
            value={location}
            onChange={(e) => setLocation(e.target.value)}
            placeholder={computed || "/Users/you/PhasrProjects/my-app"}
            className="flex-1"
          />
          <GlassButton type="button" variant="outline" size="md" onClick={handleBrowse}>
            <FolderOpen size={12} />
            Browse
          </GlassButton>
        </div>
      </Field>
      <div className="flex justify-end pt-1">
        <GlassButton type="submit" variant="primary" size="md" disabled={!name.trim()}>
          <Check size={13} />
          Create from template
        </GlassButton>
      </div>
    </form>
  );
}

// ── Helper: labelled field ─────────────────────────────────────────

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string | undefined;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-[11px] font-medium uppercase tracking-[0.1em] text-(--color-text-muted)">
        {label}
      </label>
      {children}
      {hint && <p className="text-[11px] text-(--color-text-muted)">{hint}</p>}
    </div>
  );
}

// ── Step 3: creating spinner ───────────────────────────────────────

function CreatingStep({ status }: { status: string }) {
  return (
    <div className="flex items-center gap-3 py-6">
      <Loader2 size={18} className="shrink-0 animate-spin text-(--color-accent-400)" />
      <span className="text-[13px] text-(--color-text-secondary)">{status}</span>
    </div>
  );
}

// ── Step 4: workspace creation (or skip → repo detail) ─────────────

function WorkspaceStep({ repository, onDone }: { repository: Repository; onDone: () => void }) {
  const navigate = useNavigate();
  const skipToRepo = () => {
    onDone();
    navigate({
      to: "/repositories/$repositoryId",
      params: { repositoryId: repository.id },
    });
  };
  return (
    <div className="space-y-4">
      <p className="text-[12.5px] text-(--color-text-secondary)">
        Project <span className="font-medium text-(--color-text-primary)">{repository.name}</span>{" "}
        is ready. Spin up your first agent workspace, or skip and do it later.
      </p>
      <NewWorkspaceForm
        repositoryId={repository.id}
        submitLabel="Create workspace & open"
        showCancel={false}
        onCreated={(workspace) => {
          onDone();
          navigate({
            to: "/repositories/$repositoryId/workspaces/$workspaceId",
            params: { repositoryId: repository.id, workspaceId: workspace.id },
          });
        }}
      />
      <div className="flex justify-start border-t border-(--glass-border-hairline) pt-3">
        <GlassButton variant="ghost" size="sm" onClick={skipToRepo}>
          skip
        </GlassButton>
      </div>
    </div>
  );
}

// ── Step 5: error ──────────────────────────────────────────────────

function ErrorStep({ message, onBack }: { message: string; onBack: () => void }) {
  return (
    <div className="space-y-4">
      <p className="rounded-[10px] border border-(--color-danger)/40 bg-[color-mix(in_oklab,var(--color-danger)_8%,transparent)] p-3 text-[12px] text-(--color-danger)">
        {message}
      </p>
      <div className="flex justify-end">
        <GlassButton variant="outline" size="sm" onClick={onBack}>
          <ArrowLeft size={12} />
          Back
        </GlassButton>
      </div>
    </div>
  );
}
