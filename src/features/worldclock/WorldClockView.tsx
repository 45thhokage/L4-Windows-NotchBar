import { useEffect, useState } from "react";
import { Clock, Plus, X } from "@phosphor-icons/react";
import { HeaderActions } from "../../notch/header";
import { settings, updateSettings } from "../../settings/store";
import { locale, t } from "../../i18n";
import { Button, Empty, Select } from "../../ui/controls";

/*
 * World clock: one row per zone, live time plus GMT offset. Zones are added
 * from an Apple-style city list and any row (added or default) can be removed.
 * Pure Intl API, no backend: `timeZone` does all the work.
 */

/** Apple-style city list (city label + IANA zone), ASCII labels on purpose. */
export const APPLE_CITIES: { city: string; zone: string }[] = [
  { city: "Cupertino", zone: "America/Los_Angeles" },
  { city: "New York", zone: "America/New_York" },
  { city: "Chicago", zone: "America/Chicago" },
  { city: "Denver", zone: "America/Denver" },
  { city: "Anchorage", zone: "America/Anchorage" },
  { city: "Honolulu", zone: "Pacific/Honolulu" },
  { city: "Toronto", zone: "America/Toronto" },
  { city: "Mexico City", zone: "America/Mexico_City" },
  { city: "Sao Paulo", zone: "America/Sao_Paulo" },
  { city: "London", zone: "Europe/London" },
  { city: "Paris", zone: "Europe/Paris" },
  { city: "Berlin", zone: "Europe/Berlin" },
  { city: "Athens", zone: "Europe/Athens" },
  { city: "Moscow", zone: "Europe/Moscow" },
  { city: "Dubai", zone: "Asia/Dubai" },
  { city: "Mumbai", zone: "Asia/Kolkata" },
  { city: "Bangkok", zone: "Asia/Bangkok" },
  { city: "Singapore", zone: "Asia/Singapore" },
  { city: "Hong Kong", zone: "Asia/Hong_Kong" },
  { city: "Shanghai", zone: "Asia/Shanghai" },
  { city: "Tokyo", zone: "Asia/Tokyo" },
  { city: "Seoul", zone: "Asia/Seoul" },
  { city: "Sydney", zone: "Australia/Sydney" },
  { city: "Auckland", zone: "Pacific/Auckland" },
];

export function cityFor(zone: string): string {
  return APPLE_CITIES.find((c) => c.zone === zone)?.city ?? zone;
}

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
  const list = s.worldclock.zones;
  const left = APPLE_CITIES.filter((c) => !list.includes(c.zone));

  const add = () => {
    if (!pick) return;
    updateSettings((s) => ({ worldclock: { zones: [...s.worldclock.zones, pick] } }));
    setPick("");
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
      <div className="flex items-center gap-1.5 pt-2">
        <Select
          width="w-44"
          value={pick}
          onChange={setPick}
          options={[{ value: "", label: t("Stadt wählen") }, ...left.map((c) => ({ value: c.zone, label: c.city }))]}
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
