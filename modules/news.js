const https = require('https');

const NEWS_API_KEY = process.env.NEWS_API_KEY;

async function getHeadlines(category = 'general') {
    if (!NEWS_API_KEY) {
        return 'News is not configured. Add NEWS_API_KEY to your .env file. Get a free key at newsapi.org.';
    }

    return new Promise((resolve) => {
        const url = `https://newsapi.org/v2/top-headlines?country=us&category=${category}&pageSize=5&apiKey=${NEWS_API_KEY}`;
        const options = { headers: { 'User-Agent': 'PiAI/1.0' } };

        https.get(url, options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    if (json.status !== 'ok' || !json.articles.length) {
                        resolve('No headlines available right now.');
                        return;
                    }
                    const headlines = json.articles
                        .slice(0, 5)
                        .map((a, i) => `${i + 1}. ${a.title}`)
                        .join('. ');
                    resolve(`Here are today's top headlines. ${headlines}.`);
                } catch (e) {
                    resolve('Error reading news data.');
                }
            });
        }).on('error', () => resolve('Could not reach the news service.'));
    });
}

module.exports = { getHeadlines };
