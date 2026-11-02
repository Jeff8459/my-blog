import fs from 'node:fs/promises';
import { atomicWrite } from './atomic.mjs';

export class HistoryStore {
	constructor(filePath) {
		this.filePath = filePath;
	}

	async read() {
		try {
			const parsed = JSON.parse(await fs.readFile(this.filePath, 'utf8'));
			return Array.isArray(parsed) ? parsed : [];
		} catch (error) {
			if (error.code === 'ENOENT') return [];
			throw error;
		}
	}

	async append(record) {
		const records = await this.read();
		records.unshift(record);
		await atomicWrite(this.filePath, JSON.stringify(records.slice(0, 100), null, 2));
		return record;
	}

	async updateDeployment(commit, deployment) {
		const records = await this.read();
		const record = records.find((item) => item.commit === commit);
		if (!record) return null;
		record.deployment = { ...deployment, checkedAt: new Date().toISOString() };
		await atomicWrite(this.filePath, JSON.stringify(records, null, 2));
		return record;
	}
}
