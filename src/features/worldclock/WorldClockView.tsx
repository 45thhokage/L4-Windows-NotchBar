import { useEffect, useState } from "react";
import { Clock, MagnifyingGlass, Plus, X } from "@phosphor-icons/react";
import { HeaderActions } from "../../notch/header";
import { settings, updateSettings } from "../../settings/store";
import { locale, t } from "../../i18n";
import { Button, Empty, Select } from "../../ui/controls";
import { APPLE_CITIES, cityFor, searchZones } from "./zones";

/*
 * World clock: one row per zone, live time plus GMT offset. Zones are added
 * from the Apple-style city list, or found through the search over every
 * country; any row (added or default) can be removed.
 * Pure Intl API, no backend: `timeZone` does all the work.
 */

function useNow(interval: number): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), interval);
    return () => clearInterval(id);
  }, [interval]);
  return now;
}

export function WorldClockView() {
  const s = settings.use();
  const clock = s.units.clock;
  const now = useNow(5000);
  const [pick, setPick] = useState("");
  const [query, setQuery] = useState("");
  const list = s.worldclock.zones;
  const appleLeft = APPLE_CITIES.filter((c) => !list.includes(c.zone));
  // Empty search: the familiar short list. Typed: every matching country.
  const found = searchZones(query, list);
  const searching = query.trim().length > 0;

  const add = () => {
    if (!pick) return;
    updateSettings((s) => ({ worldclock: { zones: [...s.worldclock.zones, pick] } }));
    setPick("");
    setQuery("");
  };
  const remove = (zone: string) =>
    updateSettings((s) => ({ worldclock: { zones: s.worldclock.zones.filter((z) => z !== zone) } }));

  return (
    <div className="flex h-full flex-col px-4 pt-1 pb-3">
      <HeaderActions>
        <span className="tabular mr-1 text-caption text-label-3">
          {list.length === 0 ? t("Keine Uhren") : `${list.length} ${list.length === 1 ? t("Uhr") : t("Uhren")}`}
        </span>
      </HeaderActions>
      {list.length === 0 ? (
        <Empty icon={Clock} title={t("Keine Uhren")} text={t("Füge unten eine Stadt hinzu")} />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto [scrollbar-width:none]">
          {list.map((zone) => (
            <div key={zone} className="group flex items-center justify-between gap-3 rounded-[12px] bg-fill-1 px-3 py-2">
              <div className="min-w-0">
                <div className="truncate text-body font-medium text-label">{cityFor(zone)}</div>
                <div className="tabular text-caption text-label-3">{offset(now, zone)}</div>
              </div>
              <div className="flex items-center gap-2">
                <span className="tabular text-title font-semibold text-label">{time(now, zone, clock)}</span>
                <button
                  aria-label={t("Entfernen")}
                  title={t("Entfernen")}
                  onClick={() => remove(zone)}
                  className="pressable flex size-5 items-center justify-center rounded-full bg-fill-3 text-label-2 opacity-0 transition-opacity duration-150 group-hover:opacity-100 hover:text-label"
                >
                  <X size={10} weight="bold" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      <div className="flex h-9 items-center gap-2 rounded-[12px] bg-fill-1 px-3">
        <MagnifyingGlass size={14} weight="bold" className="shrink-0 text-label-3" />
        <input
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setPick("");
          }}
          placeholder={t("Land oder Stadt suchen")}
          className="min-w-0 flex-1 bg-transparent text-body text-label outline-none placeholder:text-label-4"
        />
      </div>
      <div className="flex items-center gap-1.5 pt-2">
        <Select
          width="w-44"
          value={pick}
          onChange={setPick}
          options={[
            { value: "", label: searching ? t("Treffer wählen") : t("Stadt wählen") },
            ...(searching
              ? found.map((c) => ({ value: c.zone, label: `${c.city}, ${c.country}` }))
              : appleLeft.map((c) => ({ value: c.zone, label: c.city }))),
          ]}
        />
        <Button disabled={!pick} onClick={add}>
          <span className="flex items-center gap-1">
            <Plus size={12} weight="bold" /> {t("Hinzufügen")}
          </span>
        </Button>
      </div>
    </div>
  );
}

function time(now: number, zone: string, clock: "24" | "12"): string {
  try {
    return new Intl.DateTimeFormat(locale(), {
      hour: "2-digit",
      minute: "2-digit",
      hour12: clock === "12",
      timeZone: zone,
    }).format(now);
  } catch {
    return "--:--";
  }
}

function offset(now: number, zone: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZoneName: "shortOffset", timeZone: zone }).formatToParts(now);
    return parts.find((p) => p.type === "timeZoneName")?.value ?? "";
  } catch {
    return "";
  }
}
