import { useNavigate, useSearch } from "@tanstack/react-router";
import { useCallback } from "react";
import { SETTINGS_SECTION_IDS, type SettingsSectionId } from "./sections";

/**
 * The settings sheet is URL state on the `/_app` layout: `?settings=<section>`
 * opens it over whatever route is showing, so terminals underneath stay
 * mounted and a palette row can deep-link straight to a row
 * (`&settingsRow=<id>`). `settingsRepo` picks the repository for the
 * REPOSITORY group.
 */
export interface SettingsSearch {
  settings?: SettingsSectionId;
  settingsRepo?: string;
  settingsRow?: string;
}

export function validateSettingsSearch(search: Record<string, unknown>): SettingsSearch {
  const out: SettingsSearch = {};
  const section = search.settings;
  if (typeof section === "string" && (SETTINGS_SECTION_IDS as readonly string[]).includes(section)) {
    out.settings = section as SettingsSectionId;
  }
  if (typeof search.settingsRepo === "string") out.settingsRepo = search.settingsRepo;
  if (typeof search.settingsRow === "string") out.settingsRow = search.settingsRow;
  return out;
}

const LAST_SECTION_KEY = "phasr.settings.lastSection";

export function lastSettingsSection(): SettingsSectionId {
  try {
    const raw = localStorage.getItem(LAST_SECTION_KEY);
    if (raw && (SETTINGS_SECTION_IDS as readonly string[]).includes(raw)) return raw as SettingsSectionId;
  } catch {
    /* ignore */
  }
  return "appearance";
}

export function useSettingsRoute() {
  const search = useSearch({ strict: false }) as SettingsSearch;
  const navigate = useNavigate();

  const open = useCallback(
    (section?: SettingsSectionId, opts: { repositoryId?: string; row?: string } = {}) => {
      const target = section ?? lastSettingsSection();
      try {
        localStorage.setItem(LAST_SECTION_KEY, target);
      } catch {
        /* ignore */
      }
      void navigate({
        to: ".",
        search: (prev: Record<string, unknown>) => {
          const next: Record<string, unknown> = { ...prev, settings: target };
          if (opts.repositoryId) next.settingsRepo = opts.repositoryId;
          else delete next.settingsRepo;
          if (opts.row) next.settingsRow = opts.row;
          else delete next.settingsRow;
          return next;
        },
        replace: !!search.settings,
      } as never);
    },
    [navigate, search.settings],
  );

  const close = useCallback(() => {
    void navigate({
      to: ".",
      search: (prev: Record<string, unknown>) => {
        const { settings: _s, settingsRepo: _r, settingsRow: _w, ...rest } = prev;
        return rest;
      },
      replace: true,
    } as never);
  }, [navigate]);

  return {
    section: search.settings ?? null,
    repositoryId: search.settingsRepo ?? null,
    row: search.settingsRow ?? null,
    open,
    close,
  };
}
