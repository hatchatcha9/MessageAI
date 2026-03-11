require('dotenv').config();
const doordash = require('./doordash');

(async () => {
    console.log('Opening DoorDash in browser - log in manually, then close this script (Ctrl+C) when done.');
    const result = await doordash.openForManualLogin();
    console.log('Done:', result);
    process.exit(0);
})();
