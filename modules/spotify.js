const SpotifyWebApi = require('spotify-web-api-node');

const CLIENT_ID     = process.env.SPOTIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.SPOTIFY_REFRESH_TOKEN;

// Returns a configured SpotifyWebApi instance with a fresh access token,
// or null if credentials are missing.
let _api = null;
let _tokenExpiresAt = 0;

function isConfigured() {
    return !!(CLIENT_ID && CLIENT_SECRET && REFRESH_TOKEN);
}

async function getApi() {
    if (!isConfigured()) return null;

    if (!_api) {
        _api = new SpotifyWebApi({
            clientId:     CLIENT_ID,
            clientSecret: CLIENT_SECRET,
            redirectUri:  'http://localhost:3000',
        });
        _api.setRefreshToken(REFRESH_TOKEN);
    }

    // Refresh the access token if it has expired (or will expire in <60s)
    if (Date.now() >= _tokenExpiresAt - 60000) {
        try {
            const data = await _api.refreshAccessToken();
            _api.setAccessToken(data.body.access_token);
            _tokenExpiresAt = Date.now() + data.body.expires_in * 1000;
        } catch (err) {
            console.error('[Spotify] Token refresh failed:', err.message);
            return null;
        }
    }

    return _api;
}

// Returns "Playing <Track> by <Artist>" or "Nothing is playing."
async function getCurrentTrack() {
    if (!isConfigured()) return 'Spotify not configured.';

    try {
        const api = await getApi();
        if (!api) return 'Spotify not configured.';

        const res = await api.getMyCurrentPlaybackState();
        if (!res.body || !res.body.is_playing || !res.body.item) {
            return 'Nothing is playing.';
        }

        const track   = res.body.item.name;
        const artists = res.body.item.artists.map(a => a.name).join(', ');
        return `Playing ${track} by ${artists}.`;
    } catch (err) {
        console.error('[Spotify] getCurrentTrack error:', err.message);
        return 'I had trouble checking Spotify.';
    }
}

// Search for a track/artist/playlist and start playing.
// Returns a spoken confirmation.
async function play(query) {
    if (!isConfigured()) return 'Spotify not configured.';
    if (!query || !query.trim()) return 'What would you like to play?';

    try {
        const api = await getApi();
        if (!api) return 'Spotify not configured.';

        // Search tracks first, then artists as fallback
        const results = await api.searchTracks(query, { limit: 1 });
        const tracks  = results.body.tracks && results.body.tracks.items;

        if (tracks && tracks.length > 0) {
            const track   = tracks[0];
            const artists = track.artists.map(a => a.name).join(', ');
            await api.play({ uris: [track.uri] });
            return `Playing ${track.name} by ${artists}.`;
        }

        // Fall back to artist radio if no track matched
        const artistRes = await api.searchArtists(query, { limit: 1 });
        const artists   = artistRes.body.artists && artistRes.body.artists.items;
        if (artists && artists.length > 0) {
            const artist = artists[0];
            await api.play({ context_uri: artist.uri });
            return `Playing music by ${artist.name}.`;
        }

        return `I couldn't find anything matching "${query}" on Spotify.`;
    } catch (err) {
        console.error('[Spotify] play error:', err.message);
        // A 403 usually means no active device; give a user-friendly message.
        if (err.statusCode === 403 || err.statusCode === 404) {
            return 'No active Spotify device found. Open Spotify on a device first.';
        }
        return 'I had trouble playing that on Spotify.';
    }
}

// Pause playback.
async function pause() {
    if (!isConfigured()) return 'Spotify not configured.';

    try {
        const api = await getApi();
        if (!api) return 'Spotify not configured.';
        await api.pause();
        return 'Paused.';
    } catch (err) {
        console.error('[Spotify] pause error:', err.message);
        return 'I had trouble pausing Spotify.';
    }
}

// Skip to the next track.
async function skip() {
    if (!isConfigured()) return 'Spotify not configured.';

    try {
        const api = await getApi();
        if (!api) return 'Spotify not configured.';
        await api.skipToNext();

        // Brief pause to let Spotify start the next track before we read its name
        await new Promise(r => setTimeout(r, 800));
        return getCurrentTrack();
    } catch (err) {
        console.error('[Spotify] skip error:', err.message);
        return 'I had trouble skipping the track.';
    }
}

// Set playback volume (0–100).
async function setVolume(pct) {
    if (!isConfigured()) return 'Spotify not configured.';

    const volume = Math.max(0, Math.min(100, Math.round(Number(pct))));
    if (isNaN(volume)) return 'Please give me a volume between 0 and 100.';

    try {
        const api = await getApi();
        if (!api) return 'Spotify not configured.';
        await api.setVolume(volume);
        return `Volume set to ${volume} percent.`;
    } catch (err) {
        console.error('[Spotify] setVolume error:', err.message);
        return 'I had trouble changing the volume.';
    }
}

module.exports = { getCurrentTrack, play, pause, skip, setVolume };
