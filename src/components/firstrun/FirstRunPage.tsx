import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { ChevronRight, Copy, FolderOpen, GitBranch, LayoutTemplate, Plus } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { AgentMark } from "@/components/ui/AgentMark";
import { Button } from "@/components/ui/Button";
import { GroupHeader } from "@/components/ui/GroupHeader";
import { Kbd } from "@/components/ui/Kbd";
import { agentKeys, useAgentDetection, useAgents, useEnvironmentCheck } from "@/lib/hooks/useAgents";
import { useOpenExistingFlow } from "@/lib/hooks/useOpenExistingFlow";
import { initNotificationPermissionState, osNotificationsGranted } from "@/lib/notificationPermission";
import { tauri } from "@/lib/tauri";
import { cn } from "@/lib/utils";

/**
 * First run (A-FirstRun): no repositories yet. Left, the ways to add one;
 * right, what's ready on this Mac — agents with versions, git/gh, the
 * notification permission.
 */
export function FirstRunPage() {
  const openExisting = useOpenExistingFlow();
  const navigate = useNavigate();

  // ⌘O opens the folder picker from anywhere on this screen.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === "o") {
        e.preventDefault();
        void openExisting();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openExisting]);

  return (
    <div className="grid h-full min-h-0 grid-cols-[minmax(0,1fr)_420px] content-start gap-12 overflow-y-auto px-[72px] py-16">
      <div className="flex min-w-0 max-w-[720px] flex-col gap-7">
        <div className="flex flex-col gap-2">
          <span className="group-header">Step 1 of 2</span>
          <h1 className="m-0 text-[28px] font-semibold leading-tight tracking-[-0.01em]">
            Add a repository to start running agents
          </h1>
          <p className="m-0 max-w-[560px] text-[14px] leading-[1.55] text-(--color-text-secondary)">
            Phasr gives every task its own branch and worktree, so agents work in parallel without touching your
            checkout. Point it at a repo you already have, or create one.
          </p>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Option
            icon={<FolderOpen className="size-4" aria-hidden />}
            title="Open existing folder"
            body="A folder that is already a git repo. Phasr reads its branches and package scripts."
            aside={
              <span className="flex items-center gap-1.5 text-[12px] text-(--color-text-muted)">
                <Kbd>⌘O</Kbd> to pick a folder
              </span>
            }
            primary
            onClick={() => void openExisting()}
          />
          <Option
            icon={<Copy className="size-4" aria-hidden />}
            title="Clone from URL"
            body="https or ssh. Uses your existing git credentials."
            onClick={() => void navigate({ to: "/new-project", search: { mode: "clone" } })}
          />
          <Option
            icon={<Plus className="size-4" aria-hidden />}
            title="New empty repository"
            body="git init with a README and .gitignore."
            onClick={() => void navigate({ to: "/new-project", search: { mode: "empty" } })}
          />
          <Option
            icon={<LayoutTemplate className="size-4" aria-hidden />}
            title="From a template"
            body="Next.js + shadcn/ui · Astro blog"
            onClick={() => void navigate({ to: "/new-project", search: { mode: "template" } })}
          />
        </div>
        <p className="m-0 text-[12px] text-(--color-text-muted)">
          Nothing is written to the repo. Worktrees live in <span className="font-mono">~/.phasr/worktrees</span>.
        </p>
      </div>
      <EnvironmentPanel />
    </div>
  );
}

function Option({
  icon,
  title,
  body,
  aside,
  primary,
  onClick,
}: {
  icon: ReactNode;
  title: string;
  body: string;
  aside?: ReactNode;
  primary?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        // A-Polish card: ring, no border; the suggested option sits one
        // background step up instead of wearing an accent outline.
        "group relative flex flex-col items-start gap-2.5 rounded-(--radius-card) p-[18px] text-left shadow-(--shadow-card)",
        "transition-colors duration-(--dur-1) ease-(--ease-out)",
        "focus-visible:outline-none focus-visible:shadow-(--ring-focus)",
        primary
          ? "bg-(--color-bg-elevated) hover:bg-(--color-bg-hover)"
          : "bg-(--color-bg-surface) hover:bg-(--color-bg-elevated)",
      )}
    >
      <span
        className={cn(
          "grid size-7 shrink-0 place-items-center rounded-(--radius-control)",
          primary ? "bg-(--color-accent-500) text-(--color-accent-onfill)" : "bg-(--color-bg-elevated) text-(--color-text-secondary)",
        )}
      >
        {icon}
      </span>
      <span className="text-[14px] font-medium">{title}</span>
      <span className="text-[12px] leading-[1.5] text-(--color-text-muted)">{body}</span>
      {aside}
      <ChevronRight
        className="absolute right-3.5 top-[22px] size-3.5 text-(--color-text-faint) transition-colors duration-(--dur-1) group-hover:text-(--color-text-muted)"
        aria-hidden
      />
    </button>
  );
}

function EnvironmentPanel() {
  const { data: agents } = useAgents();
  const detection = useAgentDetection();
  const env = useEnvironmentCheck();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [notif, setNotif] = useState<boolean | null>(null);
  useEffect(() => {
    void initNotificationPermissionState().then(() => setNotif(osNotificationsGranted()));
  }, []);

  const redetect = async () => {
    setBusy(true);
    try {
      const [d, e] = await Promise.all([tauri.detectAgents(true), tauri.checkEnvironment(true)]);
      qc.setQueryData([...agentKeys.all, "detection"], d);
      qc.setQueryData(["environment"], e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside aria-label="Environment" className="flex flex-col gap-3.5">
      <section className="card flex flex-col gap-1 px-[18px] py-4">
        <GroupHeader
          as="h2"
          className="pb-1.5"
          action={
            <Button variant="ghost" size="sm" className="-mr-2 h-6" disabled={busy} onClick={() => void redetect()}>
              {busy ? "Detecting…" : "Re-detect"}
            </Button>
          }
        >
          Agents on this Mac
        </GroupHeader>
        <ul className="m-0 flex list-none flex-col p-0">
          {(agents ?? []).map((a) => {
            const d = detection.data?.find((x) => x.agent === a.agent);
            return (
              <li key={a.agent} className="flex h-9 items-center gap-2.5 text-[12px]">
                <AgentMark agent={a.agent} size="md" />
                <span className="flex-1">{a.label}</span>
                {!d ? (
                  <span className="text-[12px] text-(--color-text-muted)">{detection.isLoading ? "checking…" : ""}</span>
                ) : d.status === "found" ? (
                  <span className="font-mono text-[11px] text-(--color-success)">{d.version ?? ""} ✓</span>
                ) : (
                  <span className="text-[12px] text-(--color-text-muted)" title={d.installHint}>
                    {d.status === "missing" ? "not installed" : d.status}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
        <p className="m-0 pt-2 text-[12px] leading-[1.5] text-(--color-text-muted)">
          Agents use their own logins and keys. Phasr never proxies model calls.
        </p>
      </section>
      <section className="card flex flex-col gap-1 px-[18px] py-4">
        <GroupHeader as="h2" className="pb-1.5">
          Also ready
        </GroupHeader>
        <ul className="m-0 flex list-none flex-col p-0 text-[12px]">
          <Check ok={env.data ? !!env.data.git.version : null}>
            git {env.data?.git.version ?? ""}
            {env.data?.gh.installed
              ? env.data.gh.authenticated
                ? ` · gh signed in${env.data.gh.account ? ` as ${env.data.gh.account}` : ""}`
                : " · gh not signed in"
              : ""}
          </Check>
          <Check ok={notif}>
            {notif === false ? "Notifications not allowed — turn them on in System Settings" : "Notifications allowed"}
          </Check>
        </ul>
      </section>
      <p className="m-0 flex items-start gap-2 rounded-(--radius-card) bg-(--color-bg-input) px-[18px] py-3.5 text-[12px] leading-[1.5] text-(--color-text-muted)">
        <GitBranch className="mt-0.5 size-3.5 shrink-0 text-(--color-text-muted)" aria-hidden />
        Step 2 is your first task: pick an agent, write a prompt, and Phasr creates the branch and worktree for you.
      </p>
    </aside>
  );
}

function Check({ ok, children }: { ok: boolean | null; children: ReactNode }) {
  return (
    <li className="flex h-8 items-center gap-2.5">
      <span
        aria-hidden
        className={cn(
          "w-3 text-center font-semibold",
          ok === null ? "text-(--color-text-faint)" : ok ? "text-(--color-success)" : "text-(--color-warning)",
        )}
      >
        {ok === null ? "·" : ok ? "✓" : "!"}
      </span>
      <span className={ok === false ? "text-(--color-warning)" : "text-(--color-text-secondary)"}>{children}</span>
    </li>
  );
}
