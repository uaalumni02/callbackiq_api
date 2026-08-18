import {
  addDaysToDateKey,
  formatDateKey,
  zonedDateTimeToUtc,
} from "./scheduling/timezone.service.js";

const PERIODS = {
  today: { days: 1, label: "Today" },
  "7d": { days: 7, label: "Last 7 days" },
  "30d": { days: 30, label: "Last 30 days" },
};

export const resolveOwnerPeriod = ({
  period = "today",
  timeZone = "America/New_York",
  now = new Date(),
} = {}) => {
  const selected = PERIODS[period] || PERIODS.today;
  const end = new Date(now);
  const todayKey = formatDateKey(end, timeZone);
  const startDateKey = addDaysToDateKey(todayKey, -(selected.days - 1));
  const start = zonedDateTimeToUtc({
    dateKey: startDateKey,
    timeKey: "00:00",
    timeZone,
  });

  return {
    key: PERIODS[period] ? period : "today",
    label: selected.label,
    timeZone,
    start,
    end,
    startDate: start.toISOString(),
    endDate: end.toISOString(),
  };
};

export { PERIODS as OWNER_DASHBOARD_PERIODS };
