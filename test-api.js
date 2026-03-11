require('dotenv').config();
const doordashApi = require('./doordash-api');

(async () => {
    try {
        console.log('Testing DoorDash API search...');
        const credentials = {
            email: process.env.DOORDASH_EMAIL,
            password: process.env.DOORDASH_PASSWORD
        };
        const address = process.env.DELIVERY_ADDRESS;

        if (!credentials.email || !credentials.password || !address) {
            console.error('Set DOORDASH_EMAIL, DOORDASH_PASSWORD, and DELIVERY_ADDRESS in .env');
            process.exit(1);
        }

        const result = await doordashApi.searchRestaurantsNearAddress(credentials, address, 'mexican');
        console.log('Result:', JSON.stringify(result, null, 2));
    } catch (err) {
        console.error('Error:', err);
    }
    process.exit(0);
})();
