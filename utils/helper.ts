import moment from "moment-timezone";

export const parseTime = (timeStr: string | undefined, defaultHour: number, defaultMinute: number) => {
    if (!timeStr) return { hour: defaultHour, minute: defaultMinute };
    const parts = timeStr.split(":");
    const hour = parseInt(parts[0], 10);
    const minute = parseInt(parts[1], 10);
    if (isNaN(hour) || isNaN(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
        return { hour: defaultHour, minute: defaultMinute };
    }
    return { hour, minute };
};

export const getSleepConfig = () => {
    const sleepTime = parseTime(process.env.SLEEP_TIME, 1, 0);
    const wakeTime = parseTime(process.env.WAKE_TIME, 7, 0);
    return { sleepTime, wakeTime };
};

export const checkIfSleepTime = () => {
    const tz = process.env.TIMEZONE || "Asia/Kolkata";
    const { sleepTime, wakeTime } = getSleepConfig();
    const now = moment().tz(tz);
    const nowMinutes = now.hour() * 60 + now.minute();
    const sleepMinutes = sleepTime.hour * 60 + sleepTime.minute;
    const wakeMinutes = wakeTime.hour * 60 + wakeTime.minute;

    if (sleepMinutes === wakeMinutes) return false;

    if (sleepMinutes < wakeMinutes) {
        return nowMinutes >= sleepMinutes && nowMinutes < wakeMinutes;
    } else {
        // Spans across midnight (e.g. sleep 23:00, wake 07:00)
        return nowMinutes >= sleepMinutes || nowMinutes < wakeMinutes;
    }
};
