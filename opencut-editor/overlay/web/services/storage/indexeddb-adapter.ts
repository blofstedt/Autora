import { store } from "../../../autora/bridge";
import type { StorageAdapter } from "./types";

/**
 * OpenCut keeps projects and media records in IndexedDB. A frame with no
 * origin has none, and Autora keeps them on its server anyway (so the agent can
 * see them): the same adapter, answered over the window's bridge.
 */
export class IndexedDBAdapter<T> implements StorageAdapter<T> {
	private ns: string;

	constructor({
		dbName,
		storeName,
	}: {
		dbName: string;
		storeName: string;
		version?: number;
	}) {
		this.ns = `${dbName}/${storeName}`;
	}

	async get(key: string): Promise<T | null> {
		return store<T | null>({ op: "get", ns: this.ns, key });
	}

	async set({ key, value }: { key: string; value: T }): Promise<void> {
		await store({ op: "set", ns: this.ns, key, value: { id: key, ...value } });
	}

	async remove(key: string): Promise<void> {
		await store({ op: "remove", ns: this.ns, key });
	}

	async list(): Promise<string[]> {
		return store<string[]>({ op: "list", ns: this.ns });
	}

	async getAll(): Promise<T[]> {
		return store<T[]>({ op: "all", ns: this.ns });
	}

	async clear(): Promise<void> {
		await store({ op: "clear", ns: this.ns });
	}
}

export async function deleteDatabase({ dbName }: { dbName: string }): Promise<void> {
	await store({ op: "clear", ns: `${dbName}/*` });
}
