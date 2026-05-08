const { google } = require('googleapis');

const CLIENT_ID     = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;

// Returns an OAuth2 client, or null if credentials are missing.
function getAuth() {
    if (!CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN) return null;

    const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET);
    oauth2Client.setCredentials({ refresh_token: REFRESH_TOKEN });
    return oauth2Client;
}

// Format a JS Date to spoken time: "9 AM", "noon", "3:30 PM", etc.
function formatTime(date) {
    const hours   = date.getHours();
    const minutes = date.getMinutes();

    if (hours === 12 && minutes === 0) return 'noon';
    if (hours === 0  && minutes === 0) return 'midnight';

    const period = hours < 12 ? 'AM' : 'PM';
    const h12    = hours % 12 || 12;
    if (minutes === 0) return `${h12} ${period}`;
    const mm = String(minutes).padStart(2, '0');
    return `${h12}:${mm} ${period}`;
}

// Format a spoken date label like "Monday, May 8th"
function formatDateLabel(date) {
    const days   = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const months = ['January', 'February', 'March', 'April', 'May', 'June',
                    'July', 'August', 'September', 'October', 'November', 'December'];
    const d      = date.getDate();
    const suffix = d === 1 || d === 21 || d === 31 ? 'st'
                 : d === 2 || d === 22             ? 'nd'
                 : d === 3 || d === 23             ? 'rd'
                 : 'th';
    return `${days[date.getDay()]}, ${months[date.getMonth()]} ${d}${suffix}`;
}

// Describe a single calendar event in spoken English.
function describeEvent(event) {
    const title = event.summary || 'an event';

    // All-day events have only a date, not a dateTime
    if (event.start.date && !event.start.dateTime) {
        return `all day, ${title}`;
    }

    const start = new Date(event.start.dateTime);
    return `at ${formatTime(start)}, ${title}`;
}

// Build a spoken summary for a list of events on a single day label.
function summarizeDay(label, events) {
    if (events.length === 0) return `${label}: no events.`;

    const count = events.length;
    const noun  = count === 1 ? 'event' : 'events';
    const descriptions = events.map(describeEvent);

    if (count === 1) {
        return `${label} you have 1 ${noun}: ${descriptions[0]}.`;
    }

    const last  = descriptions.pop();
    return `${label} you have ${count} ${noun}: ${descriptions.join(', ')}, and ${last}.`;
}

// Fetch events from the primary calendar between two timestamps.
async function fetchEvents(auth, timeMin, timeMax) {
    const calendar = google.calendar({ version: 'v3', auth });
    const res = await calendar.events.list({
        calendarId: 'primary',
        timeMin:    timeMin.toISOString(),
        timeMax:    timeMax.toISOString(),
        singleEvents: true,
        orderBy:   'startTime',
        maxResults: 50,
    });
    return res.data.items || [];
}

// Returns a spoken summary of today's events.
async function getToday(auth) {
    if (!auth) return 'Calendar not configured.';

    try {
        const now   = new Date();
        const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
        const end   = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);

        const events = await fetchEvents(auth, start, end);
        const count  = events.length;

        if (count === 0) return "You have no events today.";

        const noun = count === 1 ? 'event' : 'events';
        const descriptions = events.map(describeEvent);

        if (count === 1) {
            return `You have 1 event today: ${descriptions[0]}.`;
        }

        const last = descriptions.pop();
        return `You have ${count} ${noun} today. ${descriptions.join('. ')}. And ${last}.`;
    } catch (err) {
        console.error('[Calendar] getToday error:', err.message);
        return 'I had trouble reading your calendar.';
    }
}

// Returns a spoken summary of the next N days (default 7).
async function getUpcoming(auth, days = 7) {
    if (!auth) return 'Calendar not configured.';

    try {
        const now   = new Date();
        const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
        const end   = new Date(start.getTime() + days * 24 * 60 * 60 * 1000);

        const events = await fetchEvents(auth, start, end);

        if (events.length === 0) {
            return `You have no events in the next ${days} days.`;
        }

        // Group by calendar day
        const byDay = {};
        for (const event of events) {
            const dt = event.start.dateTime
                ? new Date(event.start.dateTime)
                : new Date(event.start.date);
            const key = `${dt.getFullYear()}-${dt.getMonth()}-${dt.getDate()}`;
            if (!byDay[key]) byDay[key] = { date: dt, events: [] };
            byDay[key].events.push(event);
        }

        // Sort by date and build spoken summary
        const dayKeys   = Object.keys(byDay).sort();
        const today     = new Date();
        const todayKey  = `${today.getFullYear()}-${today.getMonth()}-${today.getDate()}`;
        const tomorrowDate = new Date(today.getTime() + 24 * 60 * 60 * 1000);
        const tomorrowKey  = `${tomorrowDate.getFullYear()}-${tomorrowDate.getMonth()}-${tomorrowDate.getDate()}`;

        const sentences = dayKeys.map(key => {
            const { date, events: dayEvents } = byDay[key];
            let label;
            if (key === todayKey)    label = 'Today';
            else if (key === tomorrowKey) label = 'Tomorrow';
            else                     label = formatDateLabel(date);
            return summarizeDay(label, dayEvents);
        });

        return sentences.join(' ');
    } catch (err) {
        console.error('[Calendar] getUpcoming error:', err.message);
        return 'I had trouble reading your calendar.';
    }
}

module.exports = { getAuth, getToday, getUpcoming };
