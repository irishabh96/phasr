import { useQuery } from "@tanstack/react-query";
import { ChevronDown, Copy, ExternalLink, FolderOpen, TerminalSquare } from "lucide-react";
import { Fragment } from "react";
import { Button } from "@/components/ui/Button";
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from "@/components/ui/Menu";
import { useWorkspaceActions } from "@/components/WorkspaceActionsMenu";
import { reportP0Error } from "@/lib/sentry";
import { tauri } from "@/lib/tauri";
import { showToast } from "@/lib/toast";
import type { Launcher, LauncherKind, Workspace } from "@/lib/types";

const KIND_LABEL: Record<LauncherKind, string> = {
  editor: "Code editors",
  terminal: "Terminals",
  filemanager: "File manager",
};
const KIND_ORDER: LauncherKind[] = ["editor", "terminal", "filemanager"];

function KindIcon({ kind }: { kind: LauncherKind }) {
  if (kind === "editor") return <ExternalLink size={13} />;
  if (kind === "terminal") return <TerminalSquare size={13} />;
  return <FolderOpen size={13} />;
}

/**
 * "Open in ▾" on the session bar (A-Workspace). Holds everything that acts
 * on the task from outside the agent:
 * - the external launchers (editors, terminals, file manager);
 * - "Copy worktree path" (the inspector's Worktree row moved here);
 * - the task actions that used to sit in the "…" menu: Open pull request,
 *   Merge into base, Archive and Delete.
 */
export function SessionOpenInMenu({ workspace }: { workspace: Workspace }) {
  const path = workspace.worktreePath;
  const { actions, dialogs } = useWorkspaceActions(workspace);
  const { data: launchers } = useQuery({
    queryKey: ["launchers"],
    queryFn: () => tauri.listLaunchers(),
    staleTime: 60_000,
  });

  if (!path && actions.length === 0) return null;

  const grouped: Record<LauncherKind, Launcher[]> = { editor: [], terminal: [], filemanager: [] };
  for (const l of launchers ?? []) grouped[l.kind].push(l);

  const launch = async (l: Launcher) => {
    if (!l.available || !path) return;
    try {
      await tauri.launchApp(l.id, path);
    } catch (err) {
      reportP0Error(`Failed to open via ${l.id}`, err, {
        area: "launcher",
        operation: "open_external_tool",
        launcherId: l.id,
      });
    }
  };

  const copyPath = () => {
    if (!path) return;
    void navigator.clipboard
      ?.writeText(path)
      .then(() => showToast({ intent: "success", title: "Worktree path copied", message: path.replace(/^\/Users\/[^/]+/, "~") }))
      .catch(() => showToast({ intent: "error", title: "Couldn't copy the path", message: path }));
  };

  const main = actions.filter((a) => !a.danger);
  const danger = actions.filter((a) => a.danger);

  return (
    <>
      <Menu>
        <MenuTrigger asChild>
          <Button variant="ghost" size="sm" className="h-[28px] gap-[6px] px-[10px]" title="Open this worktree, or act on the task">
            Open in
            <ChevronDown aria-hidden className="size-[12px]" strokeWidth={2} />
          </Button>
        </MenuTrigger>
        <MenuContent align="end" width={260}>
          {path ? (
            <>
              {launchers && launchers.length === 0 ? (
                <p className="m-0 px-[8px] py-[8px] text-(--color-text-muted)">No editors or terminals detected.</p>
              ) : null}
              {KIND_ORDER.map((kind) =>
                grouped[kind].length === 0 ? null : (
                  <Fragment key={kind}>
                    <MenuLabel>{KIND_LABEL[kind]}</MenuLabel>
                    {grouped[kind].map((l) => (
                      <MenuItem
                        key={l.id}
                        icon={<KindIcon kind={l.kind} />}
                        disabled={!l.available}
                        title={l.available ? l.name : "Not installed or not found"}
                        onSelect={() => void launch(l)}
                      >
                        {l.name}
                      </MenuItem>
                    ))}
                  </Fragment>
                ),
              )}
              <MenuSeparator />
              <MenuItem icon={<Copy size={13} />} onSelect={copyPath}>
                {workspace.workspaceKind === "local" ? "Copy path" : "Copy worktree path"}
              </MenuItem>
            </>
          ) : null}
          {main.length > 0 ? (
            <>
              {path ? <MenuSeparator /> : null}
              {main.map((a) => (
                <MenuItem
                  key={a.id}
                  icon={a.icon}
                  disabled={!!a.disabled}
                  {...(a.title ? { title: a.title } : {})}
                  onSelect={a.onSelect}
                  // A disabled item takes no pointer, so its tooltip never
                  // shows: say why inline.
                  trailing={
                    a.disabled && a.title ? (
                      <span className="max-w-[110px] truncate text-[11px] text-(--color-text-muted)">{a.title}</span>
                    ) : null
                  }
                >
                  {a.label}
                </MenuItem>
              ))}
            </>
          ) : null}
          {danger.length > 0 ? (
            <>
              {path || main.length > 0 ? <MenuSeparator /> : null}
              {danger.map((a) => (
                <MenuItem key={a.id} icon={a.icon} tone="danger" disabled={!!a.disabled} onSelect={a.onSelect}>
                  {a.label}
                </MenuItem>
              ))}
            </>
          ) : null}
        </MenuContent>
      </Menu>
      {dialogs}
    </>
  );
}
