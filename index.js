import fs from 'fs/promises';
import axios from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';
import chalk from 'chalk';
import { banner } from './banner.js';

const API_ENDPOINT = 'https://m8k9mykqqj.us-east-1.awsapprunner.com/api/harvest-data';
const DASHBOARD_API = 'https://api.dashboard.3dos.io/api/profile/me';
const DELAY_SECONDS = 60;
const HARVEST_FILE = 'harvest.json';
const SECRETS_FILE = 'secret.txt';
const TOKENS_FILE = 'token.txt';
const PROXY_FILE = 'proxy.txt';

const delay = (seconds) => new Promise(resolve => setTimeout(resolve, seconds * 1000));

async function readFileLines(filePath) {
    try {
        const content = await fs.readFile(filePath, 'utf8');
        return content.split('\n').filter(line => line.trim());
    } catch (error) {
        if (error.code === 'ENOENT') {
            return [];
        }
        throw error;
    }
}

async function readProxies() {
    const proxies = await readFileLines(PROXY_FILE);
    return proxies.filter(proxy => proxy.trim());
}

async function readSecrets() {
    return await readFileLines(SECRETS_FILE);
}

async function readTokens() {
    return await readFileLines(TOKENS_FILE);
}

async function readHarvestData() {
    try {
        const data = await fs.readFile(HARVEST_FILE, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        console.error(chalk.red(`Error reading harvest file: ${error.message}`));
        process.exit(1);
    }
}

function createProxyAgent(proxyUrl) {
    try {
        if (!proxyUrl) return null;
        
        if (proxyUrl.startsWith('socks4://') || proxyUrl.startsWith('socks5://')) {
            return new SocksProxyAgent(proxyUrl);
        } else {
            // Handle HTTP/HTTPS proxies
            if (!proxyUrl.startsWith('http://') && !proxyUrl.startsWith('https://')) {
                proxyUrl = `http://${proxyUrl}`;
            }
            return new HttpsProxyAgent(proxyUrl);
        }
    } catch (error) {
        console.error(chalk.red(`Error creating proxy agent: ${error.message}`));
        return null;
    }
}

function createAxiosInstance(proxyUrl = null) {
    const config = {
        headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
            'Accept': '*/*',
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept-Encoding': 'gzip, deflate, br',
            'Connection': 'keep-alive'
        },
        timeout: 30000, // 30 second timeout
        maxRetries: 3,
        retryDelay: 1000
    };

    if (proxyUrl) {
        const proxyAgent = createProxyAgent(proxyUrl);
        if (proxyAgent) {
            config.httpsAgent = proxyAgent;
            config.httpAgent = proxyAgent;
        }
    }

    const instance = axios.create(config);

    // Add retry logic
    instance.interceptors.response.use(undefined, async (err) => {
        const config = err.config;
        if (!config || !config.maxRetries) return Promise.reject(err);

        config.retryCount = config.retryCount ?? 0;
        if (config.retryCount >= config.maxRetries) {
            return Promise.reject(err);
        }

        config.retryCount += 1;
        const delay = config.retryDelay * config.retryCount;
        await new Promise(resolve => setTimeout(resolve, delay));
        return instance(config);
    });

    return instance;
}

async function getEarningsData(bearerToken, axiosInstance) {
    try {
        const response = await axiosInstance.post(DASHBOARD_API, {}, {
            headers: {
                'Authorization': `Bearer ${bearerToken}`,
                'Origin': 'https://dashboard.3dos.io',
                'Referer': 'https://dashboard.3dos.io/'
            }
        });

        if (response.data.data) {
            return {
                todaysEarning: response.data.data.todays_earning,
                loyaltyPoints: response.data.data.loyalty_points,
                username: response.data.data.username,
                currentTier: response.data.data.tier.tier_name
            };
        }
        throw new Error('Invalid response structure');
    } catch (error) {
        const errorMessage = error.response?.data?.message || error.message;
        console.error(chalk.red(`Error fetching earnings data: ${errorMessage}`));
        return null;
    }
}

async function sendHarvestedData(apiSecret, url, harvestedData, axiosInstance) {
    try {
        const response = await axiosInstance.post(API_ENDPOINT, {
            apiSecret,
            url,
            harvestedData
        });
        return response.data;
    } catch (error) {
        const errorMessage = error.response?.data?.message || error.message;
        console.error(chalk.red(`Error sending data: ${errorMessage}`));
        return null;
    }
}

function displayEarnings(earningsData, accountIndex) {
    if (earningsData) {
        const { todaysEarning, loyaltyPoints, username, currentTier } = earningsData;
        console.log(chalk.cyan(`\n[Account ${accountIndex + 1}]`));
        console.log(chalk.cyan(`Username: ${chalk.bold(username)} (${currentTier})`));
        console.log(chalk.cyan(`Today's Earnings: ${chalk.bold(todaysEarning.tpoints)} points (${todaysEarning.date})`));
        console.log(chalk.cyan(`Total Loyalty Points: ${chalk.bold(loyaltyPoints)}`));
    }
}

async function harvestAccount(accountIndex, secret, token, harvestData, proxy) {
    try {
        const axiosInstance = createAxiosInstance(proxy);
        console.log(chalk.yellow(`[Account ${accountIndex + 1}] Using proxy: ${proxy || 'Direct connection'}`));
        
        const harvestResult = await sendHarvestedData(secret, harvestData.url, harvestData.harvestedData, axiosInstance);
        if (harvestResult) {
            console.log(chalk.green(`✓ Account ${accountIndex + 1}: Harvest data sent successfully`));
            const earningsData = await getEarningsData(token, axiosInstance);
            displayEarnings(earningsData, accountIndex);
        }
    } catch (error) {
        console.error(chalk.red(`[Account ${accountIndex + 1}] Error: ${error.message}`));
    }
}

async function continuousHarvest() {
    try {
        console.log(banner);
        
        const secrets = await readSecrets();
        const tokens = await readTokens();
        const proxies = await readProxies();
        
        if (secrets.length === 0 || tokens.length === 0) {
            throw new Error('No secrets or tokens found. Please check your configuration files.');
        }
        
        if (secrets.length !== tokens.length) {
            throw new Error('Number of secrets and tokens must match.');
        }
        
        console.log(chalk.bold(`\nStarting continuous harvest for ${secrets.length} accounts with ${DELAY_SECONDS} seconds delay...`));
        console.log(chalk.bold(`Loaded ${proxies.length} proxies`));
        
        while (true) {
            const timestamp = new Date().toLocaleString();
            console.log(chalk.yellow('\n═══════════════════════════════════════════'));
            console.log(chalk.bold(`[${timestamp}] Starting harvest cycle`));
            
            const harvestData = await readHarvestData();
            
            for (let i = 0; i < secrets.length; i++) {
                const proxy = proxies.length > 0 ? proxies[i % proxies.length] : null;
                await harvestAccount(i, secrets[i].trim(), tokens[i].trim(), harvestData, proxy);
                
                // Add small delay between accounts
                if (i < secrets.length - 1) {
                    await delay(5);
                }
            }
            
            console.log(chalk.yellow(`\nWaiting ${DELAY_SECONDS} seconds before next harvest...`));
            await delay(DELAY_SECONDS);
        }
    } catch (error) {
        console.error(chalk.red(`Fatal error: ${error.message}`));
        process.exit(1);
    }
}

process.on('SIGINT', () => {
    console.log(chalk.bold('\nGracefully shutting down...'));
    process.exit(0);
});

continuousHarvest();