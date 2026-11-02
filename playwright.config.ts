import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';

const systemChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

export default defineConfig({
	testDir: './tests',
	fullyParallel: false,
	workers: 1,
	reporter: 'list',
	use: {
		baseURL: process.env.TEST_BASE_URL || 'http://127.0.0.1:4321',
		viewport: { width: 1440, height: 1000 },
		launchOptions: {
			executablePath: process.env.CHROME_PATH || (existsSync(systemChrome) ? systemChrome : undefined),
		},
	},
});
