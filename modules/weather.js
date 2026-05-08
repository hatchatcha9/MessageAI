const https = require('https');

const WEATHER_API_KEY = process.env.OPENWEATHER_API_KEY;

// Convert "City State" (e.g. "Draper Utah") → "City,US" for OpenWeather compatibility
function normalizeLocation(location) {
    const parts = location.trim().split(/\s+/);
    return parts.length >= 2 ? parts[0] + ',US' : location.trim();
}

function fetchUrl(url) {
    return new Promise((resolve, reject) => {
        https.get(url, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); }
                catch (e) { reject(e); }
            });
        }).on('error', reject);
    });
}

async function getWeather(location) {
    if (!WEATHER_API_KEY) {
        return 'Weather is not configured. Add OPENWEATHER_API_KEY to your .env file.';
    }

    const queries = [location.trim(), normalizeLocation(location)];

    for (const query of queries) {
        try {
            const url = `https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(query)}&appid=${WEATHER_API_KEY}&units=imperial`;
            const json = await fetchUrl(url);
            if (json.cod !== 200) continue;
            const temp = Math.round(json.main.temp);
            const feels = Math.round(json.main.feels_like);
            const desc = json.weather[0].description;
            const humidity = json.main.humidity;
            const city = json.name;
            const high = Math.round(json.main.temp_max);
            const low = Math.round(json.main.temp_min);
            return `${city} is currently ${temp} degrees Fahrenheit, feels like ${feels}. ${desc}. High of ${high}, low of ${low}. Humidity is ${humidity} percent.`;
        } catch (e) {
            continue;
        }
    }

    return `I couldn't find weather for "${location}".`;
}

async function getForecast(location) {
    if (!WEATHER_API_KEY) {
        return 'Weather is not configured. Add OPENWEATHER_API_KEY to your .env file.';
    }

    const queries = [location.trim(), normalizeLocation(location)];

    for (const query of queries) {
        try {
            const url = `https://api.openweathermap.org/data/2.5/forecast?q=${encodeURIComponent(query)}&appid=${WEATHER_API_KEY}&units=imperial&cnt=6`;
            const json = await fetchUrl(url);
            if (json.cod !== '200') continue;
            const city = json.city.name;
            const forecasts = json.list.slice(0, 4).map(f => {
                const time = new Date(f.dt * 1000).toLocaleTimeString('en-US', { hour: 'numeric', hour12: true });
                const temp = Math.round(f.main.temp);
                const desc = f.weather[0].description;
                return `${time}: ${temp} degrees, ${desc}`;
            });
            return `Forecast for ${city}: ${forecasts.join('. ')}.`;
        } catch (e) {
            continue;
        }
    }

    return `I couldn't find a forecast for "${location}".`;
}

async function getRaw(location) {
    if (!WEATHER_API_KEY) return null;
    const queries = [location.trim(), normalizeLocation(location)];
    for (const query of queries) {
        try {
            const url = `https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(query)}&appid=${WEATHER_API_KEY}&units=imperial`;
            const json = await fetchUrl(url);
            if (json.cod === 200) return json;
        } catch (e) { continue; }
    }
    return null;
}

module.exports = { getWeather, getForecast, getRaw };
