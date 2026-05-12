const express = require('express');
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const app = express();
app.use(express.json());

const BOT_EMAIL = process.env.BOT_EMAIL;
const BOT_PASSWORD = process.env.BOT_PASSWORD;
const HEADLESS = process.env.HEADLESS === 'true';
const { v4: uuidv4 } = require("uuid");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* =========================================================
   DEBUG HELPERS
========================================================= */

async function saveDebug(page, name) {
    const dir = './debug';

    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }

    try {
        await page.screenshot({
            path: path.join(dir, `${name}.png`),
            fullPage: true
        });

        const html = await page.content();

        fs.writeFileSync(
            path.join(dir, `${name}.html`),
            html
        );

        console.log(`Saved debug: ${name}`);
    } catch (err) {
        console.log('Failed saving debug:', err.message);
    }
}

async function bodyText(page) {
    try {
        return await page.evaluate(() =>
            document.body?.innerText?.toLowerCase() || ''
        );
    } catch {
        return '';
    }
}

async function logState(page, label = '') {
    console.log('\n==============================');
    console.log('STATE:', label);
    console.log('URL:', page.url());

    const txt = await bodyText(page);

    console.log(
        'BODY:',
        txt.substring(0, 500).replace(/\n/g, ' ')
    );

    console.log('==============================\n');
}

/* =========================================================
   GENERIC HELPERS
========================================================= */

async function clickByText(page, possibleTexts) {
    const texts = possibleTexts.map((t) => t.toLowerCase());

    return await page.evaluate((texts) => {
        const normalize = (s) =>
            (s || '')
                .replace(/\s+/g, ' ')
                .trim()
                .toLowerCase();

        const els = Array.from(
            document.querySelectorAll(
                `
                button,
                a,
                [role="button"],
                input[type="submit"],
                input[type="button"]
                `
            )
        );

        for (const el of els) {
            const text = normalize(
                el.innerText ||
                el.textContent ||
                el.value
            );

            if (!text) continue;

            const disabled =
                el.disabled ||
                el.getAttribute('aria-disabled') === 'true';

            if (disabled) continue;

            if (texts.some((t) => text.includes(t))) {
                el.click();
                return text;
            }
        }

        return null;
    }, texts);
}

async function typeFirst(page, selectors, value) {
    for (const sel of selectors) {
        try {
            const el = await page.$(sel);

            if (!el) continue;

            await el.click({ clickCount: 3 });
            await page.keyboard.press('Backspace');

            await el.type(value, { delay: 20 });

            return sel;
        } catch { }
    }

    return null;
}

async function waitForPageStabilize(page) {
    try {
        await Promise.race([
            page.waitForNavigation({
                waitUntil: 'networkidle2',
                timeout: 10000
            }),
            sleep(4000)
        ]);
    } catch { }
}

/* =========================================================
   PAGE DETECTION
========================================================= */
async function detectState(page) {
    const txt = await bodyText(page);
    const url = page.url().toLowerCase();

    // CAPTCHA

    if (
        txt.includes('captcha') ||
        txt.includes('verify you are human')
    ) {
        return 'CAPTCHA';
    }

    // <-- ADDED: RESET PASSWORD DETECTION
    // Detect reset password page – even if the text is 'can't log in?'
    // RESET PASSWORD – only when actually needed
    if (
        url.includes('resetpassword') ||
        txt.includes('reset password') ||
        txt.includes('recovery link') ||
        txt.includes('new password') ||
        txt.includes('confirm password')
    ) {
        return 'RESET_PASSWORD';
    }
    // ATLASSIAN LOGIN PAGE

    if (
        url.includes('id.atlassian.com') ||
        txt.includes('log in to continue') ||
        txt.includes('one account for trello')
    ) {
        return 'ATLASSIAN_LOGIN';
    }

    // LOGIN CHOICE PAGE

    const looksLikeLoginChoice =
        (
            txt.includes('log in') ||
            txt.includes('sign in')
        ) &&
        (
            txt.includes('shared') ||
            txt.includes('join') ||
            txt.includes('invited')
        );

    if (looksLikeLoginChoice) {
        return 'LOGIN_CHOICE';
    }

    // JOIN PAGE

    if (
        txt.includes('join board') ||
        txt.includes('accept invitation') ||
        txt.includes('join workspace')
    ) {
        return 'JOIN_PAGE';
    }

    // ---------------------------------------------------
    // REAL BOARD PAGE
    // ---------------------------------------------------

    const boardIndicators = [
        'board switcher',
        'add a list',
        'share',
        'inbox',
        'planner',
        'switch boards',
        'skip to: board'
    ];

    const isBoard =
        (
            url.includes('/b/')
        ) &&
        boardIndicators.some(x => txt.includes(x));

    if (isBoard) {
        return 'BOARD';
    }

    return 'UNKNOWN';
}

/* =========================================================
   ACTIONS
========================================================= */
async function handleAtlassianLogin(page) {

    console.log('Handling ATLASSIAN_LOGIN');

    // -------------------------------------------------
    // STEP 1
    // Fill email IF empty
    // -------------------------------------------------

    const emailInput =
        await page.$('#username') ||
        await page.$('input[name="username"]') ||
        await page.$('input[type="email"]');

    if (emailInput) {

        const currentValue = await page.evaluate(
            el => el.value || '',
            emailInput
        );

        if (!currentValue.includes(BOT_EMAIL)) {

            await emailInput.click({ clickCount: 3 });
            await page.keyboard.press('Backspace');

            await emailInput.type(
                BOT_EMAIL,
                { delay: 20 }
            );

            console.log('Typed email');

            // Continue button

            const continueClicked =
                await clickByText(page, [
                    'continue',
                    'next'
                ]);

            console.log(
                'Clicked continue:',
                continueClicked
            );

            await sleep(3000);
        }
    }

    // -------------------------------------------------
    // STEP 2
    // Wait for password field
    // -------------------------------------------------

    await page.waitForSelector(
        '#password, input[type="password"], input[name="password"]',
        { timeout: 15000 }
    );

    const passwordInput =
        await page.$('#password') ||
        await page.$('input[name="password"]') ||
        await page.$('input[type="password"]');

    if (!passwordInput) {
        throw new Error(
            'Password field never appeared'
        );
    }

    // -------------------------------------------------
    // STEP 3
    // Fill password
    // -------------------------------------------------

    await passwordInput.click({ clickCount: 3 });
    await page.keyboard.press('Backspace');

    await passwordInput.type(
        BOT_PASSWORD,
        { delay: 20 }
    );

    console.log('Typed password');

    // -------------------------------------------------
    // STEP 4
    // ACTUAL LOGIN BUTTON
    // VERY IMPORTANT:
    // must NOT click continue again
    // -------------------------------------------------

    const loginClicked = await page.evaluate(() => {
        const normalize = (s) => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
        const buttons = Array.from(document.querySelectorAll('button, a, [role="button"], input[type="submit"]'));
        for (const btn of buttons) {
            const text = normalize(btn.innerText || btn.textContent || btn.value);
            // Must contain 'log in' or 'login' but NOT contain 'can\'t' or 'reset'
            if ((text.includes('log in') || text === 'login') && !text.includes('can\'t') && !text.includes('reset')) {
                btn.click();
                return text;
            }
        }
        return null;
    });
    console.log(
        'Clicked login:',
        loginClicked
    );

    if (!loginClicked) {
        await page.keyboard.press('Enter');
    }

    await waitForPageStabilize(page);

    console.log(
        'AFTER LOGIN URL:',
        page.url()
    );
}

async function handleLoginChoice(page) {
    console.log('Handling LOGIN_CHOICE state');

    const clicked = await page.evaluate(() => {

        const normalize = (s) =>
            (s || '')
                .replace(/\s+/g, ' ')
                .trim()
                .toLowerCase();

        const els = Array.from(
            document.querySelectorAll(
                'button, a, [role="button"], span'
            )
        );

        for (const el of els) {

            const text = normalize(
                el.innerText ||
                el.textContent
            );

            if (
                text === 'log in' ||
                text === 'login' ||
                text.includes('sign in')
            ) {
                el.click();
                return text;
            }
        }

        return null;

    });

    console.log('Clicked login button:', clicked);

    if (!clicked) {
        throw new Error(
            'Could not find login button on invite page'
        );
    }

    await waitForPageStabilize(page);
    console.log('NEW URL:', page.url());
}

async function handleJoin(page) {

    console.log('Handling JOIN_PAGE state');

    const clicked = await page.evaluate(() => {

        const normalize = (s) =>
            (s || '')
                .replace(/\s+/g, ' ')
                .trim()
                .toLowerCase();

        const els = Array.from(
            document.querySelectorAll(
                'button, a, [role="button"]'
            )
        );

        for (const el of els) {

            const text = normalize(
                el.innerText ||
                el.textContent
            );

            if (
                text === 'join board' ||
                text === 'join workspace' ||
                text === 'accept invitation'
            ) {
                el.click();
                return text;
            }
        }

        return null;

    });

    console.log('Clicked join:', clicked);

    if (!clicked) {
        throw new Error(
            'Could not find join button'
        );
    }

    await waitForPageStabilize(page);

    console.log('NEW URL:', page.url());
}

async function handleResetPassword(page, originalInviteUrl, attemptCount) {
    console.log('Handling RESET_PASSWORD state (attempt', attemptCount, ')');
    // Directly reload the original invite URL to restart the flow cleanly
    console.log('Reloading original invite URL to restart login');
    await page.goto(originalInviteUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(2000);
}

/* =========================================================
   VERIFY ACTUAL BOARD JOIN
========================================================= */

async function verifyActuallyJoined(page) {

    const txt = await bodyText(page);
    const url = page.url().toLowerCase();

    // MUST be real board URL

    if (!url.includes('/b/')) {
        return false;
    }

    // Cannot still be invite/login page

    if (
        txt.includes('join board') ||
        txt.includes('accept invitation') ||
        txt.includes('log in')
    ) {
        return false;
    }

    // Positive board indicators

    const indicators = [
        'board switcher',
        'add a list',
        'share',
        'switch boards',
        'skip to: board'
    ];

    return indicators.some(x => txt.includes(x));
}

/* =========================================================
   MAIN STATE MACHINE
========================================================= */

async function processInvite(page, inviteUrl) {
    await page.goto(inviteUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 30000
    });

    await sleep(2000);

    const MAX_STEPS = 25;
    let resetPasswordAttempts = 0;               // <-- ADDED
    const MAX_RESET_ATTEMPTS = 3;                // <-- ADDED

    for (let i = 0; i < MAX_STEPS; i++) {
        const state = await detectState(page);

        await logState(page, state);

        switch (state) {
            case 'ATLASSIAN_LOGIN':
                await handleAtlassianLogin(page);
                break;

            case 'LOGIN_CHOICE':
                await handleLoginChoice(page);
                break;

            case 'JOIN_PAGE':
                await handleJoin(page);
                break;

            // <-- ADDED: handle reset password gracefully
            case 'RESET_PASSWORD':
                resetPasswordAttempts++;
                if (resetPasswordAttempts > MAX_RESET_ATTEMPTS) {
                    throw new Error('Exceeded max reset password attempts');
                }
                await handleResetPassword(page, inviteUrl, resetPasswordAttempts);
                break;

            case 'BOARD': {

                const joined =
                    await verifyActuallyJoined(page);

                if (joined) {

                    console.log(
                        'SUCCESSFULLY VERIFIED BOARD JOIN'
                    );

                    await saveDebug(
                        page,
                        'joined_successfully'
                    );

                    return true;
                }

                break;
            }

            case 'CAPTCHA':
                await saveDebug(page, 'captcha');
                throw new Error(
                    'Captcha encountered'
                );

            case 'UNKNOWN':
                console.log(
                    'Unknown page state, waiting...'
                );

                await sleep(3000);
                break;

            default:
                break;
        }

        await sleep(1500);
    }

    await saveDebug(page, 'failed_final_state');

    throw new Error(
        'State machine exceeded max steps without joining'
    );
}

/* =========================================================
   API
========================================================= */

app.post('/join-board', async (req, res) => {
    const { inviteUrl } = req.body;

    if (!inviteUrl) {
        return res.status(400).json({
            success: false,
            error: 'Missing inviteUrl'
        });
    }

    let browser;

    try {
        browser = await puppeteer.launch({
            headless: true,

            userDataDir: `./chrome-profile-${uuidv4()}`,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu'
            ]
        });

        const page = await browser.newPage();

        await page.setViewport({
            width: 1400,
            height: 900
        });

        await page.setUserAgent(
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
        );

        const success = await processInvite(
            page,
            inviteUrl
        );

        if (!success) {
            throw new Error(
                'Could not verify board join'
            );
        }

        console.log('SUCCESSFULLY JOINED BOARD');

        res.json({
            success: true,
            message: 'Bot joined board successfully'
        });

    } catch (err) {
        console.error('ERROR:', err);

        try {
            if (browser) {
                const pages = await browser.pages();

                if (pages.length > 0) {
                    await saveDebug(
                        pages[0],
                        'error_state'
                    );
                }
            }
        } catch { }

        res.status(500).json({
            success: false,
            error: err.message
        });

    } finally {
        // Keep browser open for debugging:
        // comment this out if you want auto-close

        /*
        if (browser) {
            await browser.close();
        }
        */
    }
});

const PORT = 3000;

app.listen(PORT, () => {
    console.log(
        `Trello joiner running on port ${PORT}`
    );
});