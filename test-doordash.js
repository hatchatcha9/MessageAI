require('dotenv').config();
const doordash = require('./doordash');
const db = require('./db');

(async () => {
    try {
        console.log('Starting DoorDash search test...');
        const credentials = {
            email: process.env.DOORDASH_EMAIL,
            password: process.env.DOORDASH_PASSWORD
        };
        const address = process.env.DELIVERY_ADDRESS;

        if (!credentials.email || !credentials.password || !address) {
            console.error('Set DOORDASH_EMAIL, DOORDASH_PASSWORD, and DELIVERY_ADDRESS in .env');
            process.exit(1);
        }

        const result = await doordash.searchRestaurantsNearAddress(credentials, address, 'mexican');
        console.log('Result:', JSON.stringify(result, null, 2));
    } catch (err) {
        console.error('CAUGHT ERROR:', err);
    }
    process.exit(0);
})();
