const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { executablePath } = require('puppeteer');
const XLSX = require('xlsx');
const path = require('path');
const fs = require('fs');

puppeteer.use(StealthPlugin());

const app = express();
app.use(cors());
app.use(express.json());

app.get("/hello", (req, res) => { res.send("Hello World"); });

// Create uploads directory if it doesn't exist
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir);
}

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const cleanText = (text) => {
    if (!text) return null;
    return text.replace(/\s+/g, ' ').trim();
};

// Keep track of active scraping sessions
const activeSessions = new Map();

const scrapeGoogleMaps = async (keyword, location, res, sessionId) => {
    let browser = null;
    let page = null;
    let batchResults = [];

    // Define sendUpdate function at the beginning
    const sendUpdate = (results, total, message, isComplete = false, filename = null) => {
        const session = activeSessions.get(sessionId);
        if (!session || !session.isActive) {
            throw new Error('CANCELLED');
        }

        const update = {
            results: results || [],
            total: total || 0,
            message: message || 'Processing...',
            isComplete: isComplete
        };

        if (filename) {
            update.filename = filename;
        }

        res.write(JSON.stringify(update) + '\n');
    };

    try {
        // Check if session is still active
        const session = activeSessions.get(sessionId);
        if (!session || !session.isActive) {
            throw new Error('CANCELLED');
        }

        console.log(`Searching for ${keyword} in ${location}`);

        // Initial update
        sendUpdate([], 0, 'Starting search...');

        const browser = await puppeteer.launch({
            headless: false, // Headless mode off for debugging
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });

        page = await browser.newPage();
        await page.setUserAgent(
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        );

        console.log('Opening Google Maps...');
        await page.goto('https://www.google.com/maps', {
            waitUntil: 'networkidle2',
            timeout: 60000
        });

        try {
            // Check if Google Maps asked for consent (GDPR page)
            if (await page.$('form[action*="consent"]')) {
                console.log('Consent form detected. Accepting...');
                await page.click('form[action*="consent"] button[type="submit"]');
                await page.waitForTimeout(5000); // Wait for redirection
            }

            console.log('Waiting for search box...');
            await page.waitForSelector('#searchboxinput', { timeout: 60000 });
            console.log('Search box found! Typing location...');
            
            const searchQuery = location ? `${keyword} in ${location}` : keyword;
            await page.type('#searchboxinput', searchQuery, { delay: 100 });
            await page.keyboard.press('Enter');

            console.log('Waiting for location to load...');
            await page.waitForTimeout(5000);

            // Wait for results to load with multiple possible selectors
            console.log('Waiting for results...');
            try {
                await Promise.race([
                    page.waitForSelector('.section-result', { visible: true, timeout: 10000 }),
                    page.waitForSelector('.Nv2PK', { visible: true, timeout: 10000 }),
                    page.waitForSelector('div[role="article"]', { visible: true, timeout: 10000 }),
                    page.waitForSelector('a[href^="/maps/place/"]', { visible: true, timeout: 10000 })
                ]);
            } catch (error) {
                console.log('Timeout waiting for initial results');
            }

            // Wait a bit for all results to populate
            await delay(3000);

            // Scroll to load more results
            console.log('Scrolling for more results...');
            let totalScrolls = 0;
            let lastResultCount = 0;

            while (totalScrolls < 20) {
                // Check if session is still active before each iteration
                const session = activeSessions.get(sessionId);
                if (!session || !session.isActive) {
                    // Generate Excel file before stopping
                    const wb = XLSX.utils.book_new();
                    const ws = XLSX.utils.json_to_sheet(batchResults);
                    XLSX.utils.book_append_sheet(wb, ws, "Results");

                    const filename = `results_${Date.now()}.xlsx`;
                    const filepath = path.join(__dirname, 'uploads', filename);
                    XLSX.writeFile(wb, filepath);

                    // Send the current results before stopping with filename
                    sendUpdate(batchResults, batchResults.length,
                        `Extraction stopped. Found ${batchResults.length} results`,
                        true, filename);
                    return; // Exit the function gracefully
                }

                // Extract current visible results
                const currentBatch = await page.evaluate(() => {
                    const items = document.querySelectorAll('div[role="article"], div.Nv2PK, .section-result');
                    console.log('Total items found:', items.length);

                    // Get all results, not just the new ones
                    const results = Array.from(items).map(item => {
                        try {
                            const result = {
                                title: item.querySelector('div.qBF1Pd, div.fontHeadlineSmall, h3.fontHeadlineSmall, div[role="heading"]')?.textContent?.trim(),
                                rating: item.querySelector('span.MW4etd')?.textContent,
                                reviews: item.querySelector('span.UY7F9, span[aria-label*="reviews"], span.fontBodyMedium span:not([class])')?.textContent,
                                website: item.querySelector('a[data-item-id*="authority"], a[href^="http"]:not([href*="google"])')?.href,
                                address: item.querySelector('div.W4Efsd:last-child')?.textContent,
                                phone: null,
                                countryCode: null,
                                //category: item.querySelector('div.W4Efsd span.DkEaL')?.textContent
                                category: null,
                            };

                            const categorySelectors = [
                                'div.W4Efsd span.DkEaL',
                                'div.W4Efsd span:first-of-type',
                                'div[jsaction*="placeCard"] span.DkEaL',
                                'div.W4Efsd > span:first-child',
                                'button[jsaction*="category"]',
                                'div.W4Efsd span.W4Efsd'
                            ];

                            for (const selector of categorySelectors) {
                                const elements = item.querySelectorAll(selector);
                                for (const element of elements) {
                                    const text = element.textContent.trim();
                                    if (text && !text.includes('stars') && !text.includes('reviews') && !text.match(/^\d/) &&
                                        !text.includes('Open') && !text.includes('Closed') && text.length > 1) {
                                        result.category = text.split('·')[0].trim(); // Get first part of category text
                                        break;
                                    }
                                }
                                if (result.category) break;
                            }




                            // Get phone number - try multiple methods
                            const phoneElement = item.querySelector('span.Usd1K');
                            if (phoneElement && phoneElement.textContent) {
                                result.phone = phoneElement.textContent;
                            }

                            if (!result.phone) {
                                const spans = item.querySelectorAll('span');
                                for (const span of spans) {
                                    const text = span.textContent;
                                    if (text && text.match(/^\+?[\d\s-]{10,}$/)) {
                                        result.phone = text;
                                        break;
                                    }
                                }
                            }

                            if (!result.phone) {
                                const lastDiv = item.querySelector('div.W4Efsd:last-child');
                                if (lastDiv) {
                                    const text = lastDiv.textContent;
                                    const phoneMatch = text.match(/[\d\s-]{10,}/);
                                    if (phoneMatch) {
                                        result.phone = phoneMatch[0];
                                    }
                                }
                            }

                            // Extract country code if phone exists
                            if (result.phone) {
                                const digits = result.phone.replace(/\D/g, '');
                                if (digits.startsWith('1')) result.countryCode = '+1';    // USA/Canada
                                else if (digits.startsWith('44')) result.countryCode = '+44';  // UK
                                else if (digits.startsWith('0')) result.countryCode = '+91';  // India
                                else if (digits.startsWith('61')) result.countryCode = '+61';  // Australia
                                else if (digits.startsWith('86')) result.countryCode = '+86';  // China
                                else if (digits.startsWith('49')) result.countryCode = '+49';  // Germany
                                else if (digits.startsWith('33')) result.countryCode = '+33';  // France
                                else if (digits.startsWith('81')) result.countryCode = '+81';  // Japan
                                else if (digits.startsWith('82')) result.countryCode = '+82';  // South Korea
                                else if (digits.startsWith('34')) result.countryCode = '+34';  // Spain
                                else if (digits.startsWith('39')) result.countryCode = '+39';  // Italy
                                else if (digits.startsWith('7')) result.countryCode = '+7';    // Russia
                                else if (digits.startsWith('55')) result.countryCode = '+55';  // Brazil
                                else if (digits.startsWith('52')) result.countryCode = '+52';  // Mexico
                            }

                            // Only return if we have at least a title
                            if (result.title) {
                                return result;
                            }
                            return null;
                        } catch (error) {
                            console.error('Error processing item:', error);
                            return null;
                        }
                    }).filter(Boolean);

                    console.log('Processed results:', results.length);
                    return results;
                });

                // Update batchResults with all current results
                batchResults = currentBatch;
                const total = batchResults.length;
                console.log(`Found ${total} results`);

                // Send progress update to frontend with ALL results
                sendUpdate(batchResults, total, `Found ${total} results...`);

                // Scroll logic
                await page.evaluate(async () => {
                    const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
                    const containers = [
                        'div[role="feed"]',
                        'div.m6QErb[aria-label]',
                        'div.m6QErb div[role="region"]',
                        'div.m6QErb',
                        '#QA0Szd'
                    ];

                    let resultPane = null;
                    for (const selector of containers) {
                        resultPane = document.querySelector(selector);
                        if (resultPane) break;
                    }

                    if (resultPane) {
                        const scrollHeight = resultPane.scrollHeight;
                        resultPane.scrollTo(0, scrollHeight);
                        await sleep(500);
                    }
                });

                await delay(2000);

                const currentResults = await page.evaluate(() => {
                    const items = document.querySelectorAll('div[role="article"], div.Nv2PK, .section-result');
                    return items.length;
                });

                console.log(`Current results count: ${currentResults}`);

                if (currentResults === lastResultCount) {
                    // Try clicking "Show more" button
                    try {
                        const hasMore = await page.evaluate(() => {
                            const showMoreButton = Array.from(document.querySelectorAll('button')).find(
                                button => button.textContent.includes('Show more')
                            );
                            if (showMoreButton) {
                                showMoreButton.click();
                                return true;
                            }
                            return false;
                        });

                        if (!hasMore) {
                            console.log('No more results to load');
                            break;
                        }
                        await delay(2000);
                    } catch (error) {
                        console.log('No "Show more" button found');
                        break;
                    }
                }

                lastResultCount = currentResults;
                totalScrolls++;
                await delay(2000); // Add a delay between scrolls
            }

            // Generate Excel file
            const wb = XLSX.utils.book_new();
            const ws = XLSX.utils.json_to_sheet(batchResults);
            XLSX.utils.book_append_sheet(wb, ws, "Results");

            const filename = `results_${Date.now()}.xlsx`;
            const filepath = path.join(__dirname, 'uploads', filename);
            XLSX.writeFile(wb, filepath);

            // For the final update:
            sendUpdate(batchResults, batchResults.length,
                `Completed! Found ${batchResults.length} results`,
                true, filename);

        } catch (error) {
            console.error('Error occurred while scraping:', error);
            throw error;
        }
    } catch (error) {
        if (error.message === 'CANCELLED') {
            // Generate Excel file when cancelled
            const wb = XLSX.utils.book_new();
            const ws = XLSX.utils.json_to_sheet(batchResults);
            XLSX.utils.book_append_sheet(wb, ws, "Results");

            const filename = `results_${Date.now()}.xlsx`;
            const filepath = path.join(__dirname, 'uploads', filename);
            XLSX.writeFile(wb, filepath);

            // Send the current results when cancelled with filename
            sendUpdate(batchResults, batchResults.length,
                `Extraction stopped. Found ${batchResults.length} results`,
                true, filename);
        } else {
            console.error('Error occurred while scraping:', error);
            throw error;
        }
    } finally {
        if (page) await page.close().catch(() => { });
        if (browser) await browser.close().catch(() => { });
    }
};

// Add new endpoint to create Excel file from current results
app.post('/create-excel', async (req, res) => {
    try {
        const { results } = req.body;

        // Generate Excel file
        const wb = XLSX.utils.book_new();
        const ws = XLSX.utils.json_to_sheet(results);
        XLSX.utils.book_append_sheet(wb, ws, "Results");

        const filename = `results_${Date.now()}.xlsx`;
        const filepath = path.join(__dirname, 'uploads', filename);
        XLSX.writeFile(wb, filepath);

        res.json({ filename });
    } catch (error) {
        console.error('Error creating Excel file:', error);
        res.status(500).json({ error: 'Failed to create Excel file' });
    }
});

// Update the download endpoint to handle immediate downloads
app.get("/download/:filename", (req, res) => {
    const filePath = path.join(__dirname, 'uploads', req.params.filename);

    // Check if file exists
    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ message: "File not found" });
    }

    res.download(filePath, (err) => {
        if (err) {
            res.status(500).send({
                message: "Could not download the file. " + err,
            });
        }
        // Delete file after download
        fs.unlink(filePath, (err) => {
            if (err) console.error('Error deleting file:', err);
        });
    });
});

app.post("/scrape", async (req, res) => {
    const { keyword, location } = req.body;
    if (!keyword) {
        res.status(400).json({ error: 'Keyword is required' });
        return;
    }

    const sessionId = Date.now().toString();

    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Transfer-Encoding', 'chunked');

    activeSessions.set(sessionId, { res, isActive: true });

    try {
        res.write(JSON.stringify({
            sessionId,
            message: 'Started scraping...',
            results: [],
            total: 0
        }) + '\n');

        await scrapeGoogleMaps(keyword, location, res, sessionId);

    } catch (error) {
        const errorResponse = {
            isComplete: true,
            results: [],
            message: error.message === 'CANCELLED'
                ? 'Scraping cancelled'
                : 'Error occurred during scraping',
            error: error.message
        };
        res.write(JSON.stringify(errorResponse) + '\n');
        res.end();
    } finally {
        activeSessions.delete(sessionId);
    }
});

// Add new endpoint to handle stop requests
app.post('/stop-scraping/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    const session = activeSessions.get(sessionId);

    if (session) {
        session.isActive = false;
        // Don't end the response here, let the scraping function send the final results
        res.json({ message: 'Scraping will stop after current batch' });
    } else {
        res.status(404).json({ message: 'Session not found' });
    }
});

app.use(express.static(path.join(__dirname, 'dist')));
app.get('*', (req, res) => { res.sendFile(path.join(__dirname, 'dist', 'index.html')); });

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
